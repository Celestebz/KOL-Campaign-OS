// AI 邮件起草：快照检查 → 组装上下文 → AI 生成 → 风险校验 → 落库。
// 平台支持：YouTube 走快照回抓 + kol_youtube_snapshot_videos；Instagram/TikTok 无回抓服务，
// 证据直接取 finder_video_evidence（Finder 发现时已沉淀）。
const { dbOperations } = require('../database');
const aiClient = require('./aiClient');
const { evaluateDraft } = require('./emailRiskRules');
const youtubeIntakeSnapshot = require('./youtubeIntakeSnapshot');

const PROMPT_VERSION = 'p1.0';
const SNAPSHOT_STALE_DAYS = 7;
// IG/TT 证据没有快照回抓，新鲜度以证据视频最新发布日期衡量，阈值 30 天
const FINDER_EVIDENCE_STALE_DAYS = 30;
const FINDER_EVIDENCE_RECENT_DAYS = 30;
const MAX_EVIDENCE_VIDEOS = 10;
const DRAFT_CONCURRENCY = 3;

const PLATFORM_LABELS = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok' };
const SUPPORTED_PLATFORMS = Object.keys(PLATFORM_LABELS);

const SYSTEM_PROMPT = 'You are an outreach copywriter for a brand marketing team. Write personalized first-touch emails to content creators. Return valid JSON only. No Markdown, no explanations.';

function buildUserPrompt({ customer, campaign, strategy, styleGuide, videos, feedback, platform = 'youtube', followers = null }) {
  const videoLines = videos.map((v) =>
    `- [${v.video_id ?? v.youtube_video_id}] "${v.title}" | ${Number(v.play_count || 0).toLocaleString()} views | published ${v.published_at ? new Date(v.published_at).toISOString().slice(0, 10) : 'unknown'}`
  ).join('\n');
  const platformLabel = PLATFORM_LABELS[platform] || platform;
  const followerCount = followers ?? customer.youtube_followers;
  return `Write a first-touch outreach email (JSON: {"subject": "...", "body_text": "...", "cited_video_ids": ["..."], "personalization_note": "..."}).

Creator: ${customer.name} (${customer.country_region || 'unknown region'}), ${platformLabel} followers: ${followerCount || 'unknown'}.
Recent real videos (ONLY these may be cited):
${videoLines || '(no videos available)'}

Campaign: ${campaign.name}. Product context: ${strategy?.product_context || campaign.product || ''}.
Writing rules (must follow strictly):
${styleGuide}
${feedback ? `\nHuman feedback on previous version (address it): ${feedback}` : ''}

Requirements: cite 1-2 videos from the list above by their exact titles; keep body under 120 English words; write in English.`;
}

// 平台判定：campaign_kols.target_platform 优先，其次 customers 的平台主页 url，再次 customers.platform + profile_url
function detectPlatform(customer, campaignKol) {
  const target = String(campaignKol?.target_platform || '').toLowerCase();
  if (SUPPORTED_PLATFORMS.includes(target)) return target;
  for (const platform of SUPPORTED_PLATFORMS) {
    if (customer[`${platform}_url`]) return platform;
  }
  const selfPlatform = String(customer.platform || '').toLowerCase();
  if (SUPPORTED_PLATFORMS.includes(selfPlatform) && customer.profile_url) return selfPlatform;
  return null;
}

// 该达人在某平台上的主页 url 与粉丝数（customers 当前值优先，campaign_kols 快照兜底）
function platformProfile(customer, campaignKol, platform) {
  const urls = [
    customer[`${platform}_url`],
    campaignKol?.[`${platform}_url_snapshot`],
    String(customer.platform || '').toLowerCase() === platform ? customer.profile_url : null
  ].filter(Boolean);
  const followers = customer[`${platform}_followers`] || campaignKol?.[`${platform}_followers_snapshot`] || null;
  return { urls, followers };
}

async function ensureFreshSnapshot(customerId) {
  const customer = await dbOperations.get('SELECT * FROM customers WHERE id = ?', [customerId]);
  if (!customer) throw new Error('达人不存在');
  const snapshotAt = customer.youtube_snapshot_updated_at;
  const ageDays = snapshotAt ? (Date.now() - new Date(snapshotAt).getTime()) / 86400000 : Infinity;
  if (ageDays > SNAPSHOT_STALE_DAYS) {
    await youtubeIntakeSnapshot.runYoutubeIntakeSnapshot(customerId); // 失败会抛错，由调用方记为该达人失败
  }
  return dbOperations.get('SELECT * FROM customers WHERE id = ?', [customerId]);
}

// 证据视频：快照中 included_in_aggregate=1 的行即"近 30 天长视频"（快照写入时已按 30 天/时长过滤并清旧）。
async function loadEvidenceVideos(customerId) {
  return dbOperations.query(
    `SELECT youtube_video_id, title, play_count, published_at, snapshot_at
     FROM kol_youtube_snapshot_videos
     WHERE customer_id = ? AND included_in_aggregate = 1
     ORDER BY snapshot_at DESC, play_count DESC
     LIMIT ?`,
    [customerId, MAX_EVIDENCE_VIDEOS]
  );
}

// IG/TT 证据视频：finder_video_evidence 中该达人该平台的行。
// 匹配字段：video_sources.author_profile_url 与达人主页 url 归一化后相等（去尾部斜杠、小写），
// 或 kol_name/author_name 与达人姓名精确相等（小写）。近 30 天发布优先，其余按播放数排序，最多 10 条。
// 播放数取 video_snapshots 最新快照，缺失时回退解析 raw_data（IG: video_play_count，TT: statistics.play_count）。
async function loadFinderEvidenceVideos({ customer, campaignKol, platform }) {
  const { urls } = platformProfile(customer, campaignKol, platform);
  const names = [...new Set([customer.name, campaignKol?.kol_name_snapshot].filter(Boolean))];
  if (!urls.length && !names.length) return [];

  const conditions = [];
  const params = [platform];
  if (urls.length) {
    conditions.push(`LOWER(TRIM(TRAILING '/' FROM vs.author_profile_url)) IN (${urls.map(() => "LOWER(TRIM(TRAILING '/' FROM ?))").join(', ')})`);
    params.push(...urls);
  }
  if (names.length) {
    conditions.push(`LOWER(vs.kol_name) IN (${names.map(() => 'LOWER(?)').join(', ')})`);
    conditions.push(`LOWER(vs.author_name) IN (${names.map(() => 'LOWER(?)').join(', ')})`);
    params.push(...names, ...names);
  }

  const recentCutoff = new Date(Date.now() - FINDER_EVIDENCE_RECENT_DAYS * 86400000).toISOString();
  return dbOperations.query(
    `SELECT vs.platform_video_id AS video_id, vs.title, vs.published_at,
            COALESCE(vsnap.play_count,
              CASE WHEN JSON_VALID(fve.raw_data) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(fve.raw_data, '$.data.raw_data.video_play_count')) AS UNSIGNED) END,
              CASE WHEN JSON_VALID(fve.raw_data) THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(fve.raw_data, '$.data.raw_data.statistics.play_count')) AS UNSIGNED) END
            ) AS play_count
     FROM video_sources vs
     JOIN finder_video_evidence fve ON fve.id = (
       SELECT MIN(f2.id) FROM finder_video_evidence f2
       WHERE f2.video_source_id = vs.id AND f2.evidence_platform = ?
     )
     LEFT JOIN video_snapshots vsnap ON vsnap.id = vs.latest_snapshot_id
     WHERE ${conditions.join(' OR ')}
     ORDER BY (vs.published_at >= ?) DESC, play_count DESC, vs.published_at DESC
     LIMIT ?`,
    [...params, recentCutoff, MAX_EVIDENCE_VIDEOS]
  );
}

// avg/median/posts_30d 从证据视频计算；数据不足算不出则为 null，不编造
function computeFinderMetrics(videos) {
  const cutoff = Date.now() - FINDER_EVIDENCE_RECENT_DAYS * 86400000;
  const anyDated = videos.some((v) => v.published_at && !Number.isNaN(new Date(v.published_at).getTime()));
  const recent = videos.filter((v) => v.published_at && new Date(v.published_at).getTime() >= cutoff);
  const counts = recent.map((v) => Number(v.play_count)).filter((n) => Number.isFinite(n) && n > 0);
  const avg = counts.length ? Math.round(counts.reduce((a, b) => a + b, 0) / counts.length) : null;
  return {
    avg_views_30d: avg,
    median_views_30d: counts.length ? youtubeIntakeSnapshot.median(counts) : null,
    posts_30d: anyDated ? recent.length : null
  };
}

// 证据新鲜度：证据视频中最新的发布日期
function latestEvidenceDate(videos) {
  const timestamps = videos
    .map((v) => (v.published_at ? new Date(v.published_at).getTime() : NaN))
    .filter((t) => !Number.isNaN(t));
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

// 完整起草一个达人；任何失败都返回 { ok:false, error }，不抛出。
async function draftForCustomer({ campaignId, customerId, kind = 'first_touch', sourceReplyId = null, feedback = null, draftId = null }) {
  try {
    const campaign = await dbOperations.get('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    if (!campaign) return { ok: false, customer_id: customerId, error: '项目不存在' };

    const baseCustomer = await dbOperations.get('SELECT * FROM customers WHERE id = ?', [customerId]);
    if (!baseCustomer) return { ok: false, customer_id: customerId, error: '达人不存在' };
    const campaignKol = await dbOperations.get(
      'SELECT * FROM campaign_kols WHERE campaign_id = ? AND customer_id = ? ORDER BY id DESC LIMIT 1',
      [campaignId, customerId]
    );
    const platform = detectPlatform(baseCustomer, campaignKol);
    if (!platform) {
      return { ok: false, customer_id: customerId, error: '达人缺少 YouTube/Instagram/TikTok 主页信息，无法识别平台' };
    }

    let customer; let videos; let snapshotDate; let staleDays; let metrics; let followers;
    if (platform === 'youtube') {
      customer = await ensureFreshSnapshot(customerId);
      videos = await loadEvidenceVideos(customerId);
      snapshotDate = customer.youtube_snapshot_updated_at;
      staleDays = SNAPSHOT_STALE_DAYS;
      followers = customer.youtube_followers;
      metrics = {
        followers: customer.youtube_followers || null,
        avg_views_30d: customer.youtube_avg_views_30d ?? null,
        median_views_30d: customer.youtube_median_views_30d ?? null,
        posts_30d: customer.youtube_posts_30d ?? null
      };
    } else {
      // IG/TT：无快照回抓服务，证据直接取 finder_video_evidence
      customer = baseCustomer;
      videos = await loadFinderEvidenceVideos({ customer, campaignKol, platform });
      if (!videos.length) {
        return { ok: false, customer_id: customerId, error: `该达人暂无 ${PLATFORM_LABELS[platform]} 视频证据，请先运行 Finder 发现视频` };
      }
      const profile = platformProfile(customer, campaignKol, platform);
      followers = profile.followers;
      metrics = { followers: profile.followers, ...computeFinderMetrics(videos) };
      snapshotDate = latestEvidenceDate(videos);
      staleDays = FINDER_EVIDENCE_STALE_DAYS;
    }

    const toAddress = customer.email;
    const strategy = await dbOperations.get(
      'SELECT * FROM kol_strategies WHERE campaign_id = ? ORDER BY updated_at DESC LIMIT 1',
      [campaignId]
    );
    const styleGuide = await dbOperations.get(
      "SELECT * FROM email_templates WHERE kind = 'style_guide' ORDER BY id LIMIT 1"
    );

    const userPrompt = buildUserPrompt({
      customer, campaign, strategy,
      styleGuide: styleGuide?.body_html || '',
      videos, feedback, platform, followers
    });
    const { parsed, model } = await aiClient.callActiveAi(SYSTEM_PROMPT, userPrompt);

    const subject = String(parsed?.subject || '').trim();
    const bodyText = String(parsed?.body_text || '').trim();
    if (!subject || !bodyText) return { ok: false, customer_id: customerId, error: 'AI 未返回有效主题或正文' };

    const citedVideoIds = Array.isArray(parsed?.cited_video_ids) ? parsed.cited_video_ids.map(String) : [];
    const { riskLevel, riskReasons } = evaluateDraft({
      customer, strategy, bodyText, citedVideoIds,
      evidenceVideos: videos,
      snapshotDate,
      hasEmail: Boolean(toAddress),
      staleDays
    });

    const evidence = JSON.stringify({
      platform,
      snapshot_date: snapshotDate,
      videos: videos.map((v) => ({
        video_id: String(v.video_id ?? v.youtube_video_id),
        // YouTube 路径保留原键名，兼容历史证据数据与消费方
        ...(v.youtube_video_id ? { youtube_video_id: v.youtube_video_id } : {}),
        title: v.title,
        views: Number(v.play_count || 0),
        published_at: v.published_at ? new Date(v.published_at).toISOString().slice(0, 10) : null
      })),
      match_reason: parsed?.personalization_note || '',
      metrics
    });

    let id = draftId;
    if (draftId) {
      // 重新生成：旧版本已在调用方存档
      await dbOperations.run(
        `UPDATE email_drafts SET subject=?, body_text=?, risk_level=?, risk_reasons=?, evidence=?,
         prompt_version=?, ai_model=?, generated_at=NOW(), updated_at=NOW() WHERE id=?`,
        [subject, bodyText, riskLevel, JSON.stringify(riskReasons), evidence, PROMPT_VERSION, model || null, draftId]
      );
    } else {
      const result = await dbOperations.run(
        `INSERT INTO email_drafts
         (campaign_id, customer_id, kind, subject, body_text, status, risk_level, risk_reasons, evidence,
          source_reply_id, template_id, prompt_version, ai_model, generated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
        [campaignId, customerId, kind, subject, bodyText, riskLevel, JSON.stringify(riskReasons), evidence,
         sourceReplyId, styleGuide?.id || null, PROMPT_VERSION, model || null]
      );
      id = result.id;
      await dbOperations.run(
        `INSERT INTO email_draft_versions (draft_id, subject, body_text, source, feedback, created_at)
         VALUES (?, ?, ?, 'ai', ?, NOW())`,
        [id, subject, bodyText, feedback]
      );
    }
    return { ok: true, customer_id: customerId, draftId: id, riskLevel };
  } catch (error) {
    console.error(`起草失败 (customer ${customerId}):`, error.message);
    return { ok: false, customer_id: customerId, error: error.message };
  }
}

// 批量起草，并发 ≤ DRAFT_CONCURRENCY，单达人失败隔离
async function draftBatch(items) {
  const results = [];
  for (let i = 0; i < items.length; i += DRAFT_CONCURRENCY) {
    const chunk = items.slice(i, i + DRAFT_CONCURRENCY);
    results.push(...await Promise.all(chunk.map((item) => draftForCustomer(item))));
  }
  return results;
}

module.exports = {
  draftForCustomer, draftBatch, buildUserPrompt, detectPlatform,
  loadFinderEvidenceVideos, computeFinderMetrics, PROMPT_VERSION,
  FINDER_EVIDENCE_STALE_DAYS
};
