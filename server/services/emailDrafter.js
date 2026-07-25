// AI 邮件起草：快照检查 → 组装上下文 → AI 生成 → 风险校验 → 落库。
const { dbOperations } = require('../database');
const { callActiveAi } = require('./aiClient');
const { evaluateDraft } = require('./emailRiskRules');
const { runYoutubeIntakeSnapshot } = require('./youtubeIntakeSnapshot');

const PROMPT_VERSION = 'p1.0';
const SNAPSHOT_STALE_DAYS = 7;
const MAX_EVIDENCE_VIDEOS = 10;
const DRAFT_CONCURRENCY = 3;

const SYSTEM_PROMPT = 'You are an outreach copywriter for a brand marketing team. Write personalized first-touch emails to content creators. Return valid JSON only. No Markdown, no explanations.';

function buildUserPrompt({ customer, campaign, strategy, styleGuide, videos, feedback }) {
  const videoLines = videos.map((v) =>
    `- [${v.youtube_video_id}] "${v.title}" | ${Number(v.play_count || 0).toLocaleString()} views | published ${v.published_at ? new Date(v.published_at).toISOString().slice(0, 10) : 'unknown'}`
  ).join('\n');
  return `Write a first-touch outreach email (JSON: {"subject": "...", "body_text": "...", "cited_video_ids": ["..."], "personalization_note": "..."}).

Creator: ${customer.name} (${customer.country_region || 'unknown region'}), YouTube followers: ${customer.youtube_followers || 'unknown'}.
Recent real videos (ONLY these may be cited):
${videoLines || '(no videos available)'}

Campaign: ${campaign.name}. Product context: ${strategy?.product_context || campaign.product || ''}.
Writing rules (must follow strictly):
${styleGuide}
${feedback ? `\nHuman feedback on previous version (address it): ${feedback}` : ''}

Requirements: cite 1-2 videos from the list above by their exact titles; keep body under 120 English words; write in English.`;
}

async function ensureFreshSnapshot(customerId) {
  const customer = await dbOperations.get('SELECT * FROM customers WHERE id = ?', [customerId]);
  if (!customer) throw new Error('达人不存在');
  const snapshotAt = customer.youtube_snapshot_updated_at;
  const ageDays = snapshotAt ? (Date.now() - new Date(snapshotAt).getTime()) / 86400000 : Infinity;
  if (ageDays > SNAPSHOT_STALE_DAYS) {
    await runYoutubeIntakeSnapshot(customerId); // 失败会抛错，由调用方记为该达人失败
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

// 完整起草一个达人；任何失败都返回 { ok:false, error }，不抛出。
async function draftForCustomer({ campaignId, customerId, kind = 'first_touch', sourceReplyId = null, feedback = null, draftId = null }) {
  try {
    const campaign = await dbOperations.get('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    if (!campaign) return { ok: false, customer_id: customerId, error: '项目不存在' };

    const customer = await ensureFreshSnapshot(customerId);
    const toAddress = customer.email;
    const strategy = await dbOperations.get(
      'SELECT * FROM kol_strategies WHERE campaign_id = ? ORDER BY updated_at DESC LIMIT 1',
      [campaignId]
    );
    const styleGuide = await dbOperations.get(
      "SELECT * FROM email_templates WHERE kind = 'style_guide' ORDER BY id LIMIT 1"
    );
    const videos = await loadEvidenceVideos(customerId);

    const userPrompt = buildUserPrompt({
      customer, campaign, strategy,
      styleGuide: styleGuide?.body_html || '',
      videos, feedback
    });
    const { parsed, model } = await callActiveAi(SYSTEM_PROMPT, userPrompt);

    const subject = String(parsed?.subject || '').trim();
    const bodyText = String(parsed?.body_text || '').trim();
    if (!subject || !bodyText) return { ok: false, customer_id: customerId, error: 'AI 未返回有效主题或正文' };

    const citedVideoIds = Array.isArray(parsed?.cited_video_ids) ? parsed.cited_video_ids.map(String) : [];
    const { riskLevel, riskReasons } = evaluateDraft({
      customer, strategy, bodyText, citedVideoIds,
      evidenceVideos: videos,
      snapshotDate: customer.youtube_snapshot_updated_at,
      hasEmail: Boolean(toAddress)
    });

    const evidence = JSON.stringify({
      snapshot_date: customer.youtube_snapshot_updated_at,
      videos: videos.map((v) => ({
        youtube_video_id: v.youtube_video_id, title: v.title,
        views: Number(v.play_count || 0),
        published_at: v.published_at ? new Date(v.published_at).toISOString().slice(0, 10) : null
      })),
      match_reason: parsed?.personalization_note || '',
      metrics: {
        followers: customer.youtube_followers || null,
        avg_views_30d: customer.youtube_avg_views_30d ?? null,
        median_views_30d: customer.youtube_median_views_30d ?? null,
        posts_30d: customer.youtube_posts_30d ?? null
      }
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
         source_reply_id, styleGuide?.id || null, PROMPT_VERSION, model || null]
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

module.exports = { draftForCustomer, draftBatch, buildUserPrompt, PROMPT_VERSION };
