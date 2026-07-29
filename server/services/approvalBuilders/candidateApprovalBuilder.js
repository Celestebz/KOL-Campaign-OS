// 候选达人审核 builder：campaign_kols status='candidate'。
const { dbOperations } = require('../../database');
const { clean, truncate, iso, openAction, parseJson } = require('./shared');

async function buildCandidateItems() {
  const rows = await dbOperations.query(
    `SELECT ck.id, ck.campaign_id, ck.customer_id, ck.target_platform,
            ck.kol_name_snapshot, ck.country_region_snapshot,
            ck.youtube_followers_snapshot, ck.instagram_followers_snapshot, ck.tiktok_followers_snapshot,
            ck.median_views_30d_snapshot, ck.posts_30d_snapshot, ck.evidence_summary,
            ck.priority_level, ck.candidate_priority_score, ck.updated_at,
            c.name AS campaign_name, k.name AS kol_name
     FROM campaign_kols ck
     LEFT JOIN campaigns c ON c.id = ck.campaign_id
     LEFT JOIN customers k ON k.id = ck.customer_id
     WHERE ck.status = 'candidate' AND c.status = 'active'
     ORDER BY ck.candidate_priority_score DESC, ck.updated_at DESC`
  );
  return rows.map((row) => {
    const kolName = clean(row.kol_name) || clean(row.kol_name_snapshot) || `达人 #${row.customer_id}`;
    const evidence = parseJson(row.evidence_summary, null);
    const facts = [`达人：${kolName}`];
    if (clean(row.target_platform)) facts.push(`平台：${clean(row.target_platform)}`);
    const followers = clean(row.youtube_followers_snapshot)
      || clean(row.instagram_followers_snapshot)
      || clean(row.tiktok_followers_snapshot);
    if (followers) facts.push(`粉丝数：${followers}`);
    if (row.median_views_30d_snapshot != null) facts.push(`近30天播放中位数：${row.median_views_30d_snapshot}`);
    const matchReason = clean(evidence?.match_reason || evidence?.reason || evidence?.summary);
    if (matchReason) facts.push(`匹配理由：${truncate(matchReason, 120)}`);

    const risks = [];
    const videoCount = Array.isArray(evidence?.videos) ? evidence.videos.length : null;
    if (videoCount !== null && videoCount < 3) risks.push(`相关视频样本较少（仅 ${videoCount} 条）`);
    if (row.median_views_30d_snapshot == null) risks.push('近 30 天播放数据不完整');
    if (!clean(row.target_platform)) risks.push('目标平台未明确');

    return {
      id: `candidate:${row.id}`,
      type: 'candidate',
      subject_type: 'campaign_kol',
      subject_id: row.id,
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${kolName} · 候选达人待审核`,
      dedupe_key: `candidate:campaign_kol:${row.id}`,
      risk_level: risks.length ? 'low' : 'none',
      facts,
      opinion: '',
      risks,
      actions: openAction('/campaign-kols'),
      updated_at: iso(row.updated_at)
    };
  });
}

module.exports = { buildCandidateItems };
