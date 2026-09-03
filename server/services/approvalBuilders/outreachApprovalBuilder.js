// 触达邮件审核 builder：email_drafts status='pending_review'。
const { dbOperations } = require('../../database');
const { clean, truncate, iso, openAction, parseJson } = require('./shared');
const { requireCurrentUserId } = require('../../utils/requestContext');

async function buildOutreachItems() {
  const rows = await dbOperations.query(
    `SELECT d.id, d.campaign_id, d.customer_id, d.kind, d.subject,
            d.risk_level, d.risk_reasons, d.evidence, d.generated_at, d.updated_at,
            k.name AS kol_name, c.name AS campaign_name
     FROM email_drafts d
     LEFT JOIN customers k ON k.id = d.customer_id
     LEFT JOIN campaigns c ON c.id = d.campaign_id
     WHERE d.owner_user_id = ? AND d.status = 'pending_review' AND c.status = 'active'
     ORDER BY d.generated_at DESC`,
    [requireCurrentUserId()]
  );
  return rows.map((row) => {
    const kolName = clean(row.kol_name) || `达人 #${row.customer_id}`;
    const evidence = parseJson(row.evidence, null);
    const riskReasons = parseJson(row.risk_reasons, []);
    const facts = [];
    const metrics = evidence?.metrics || {};
    if (metrics.followers) facts.push(`粉丝数：${metrics.followers}`);
    if (metrics.avg_views_30d != null) facts.push(`近30天平均播放：${metrics.avg_views_30d}`);
    if (Array.isArray(evidence?.videos)) facts.push(`引用视频数：${evidence.videos.length}`);
    if (clean(evidence?.snapshot_date)) facts.push(`数据快照日期：${clean(evidence.snapshot_date)}`);
    if (!facts.length) facts.push('邮件草稿已生成，等待人工审批');
    const risks = (Array.isArray(riskReasons) ? riskReasons : [])
      .map((r) => clean(typeof r === 'object' ? r.message : r))
      .filter(Boolean);
    const opinionParts = [];
    if (clean(row.subject)) opinionParts.push(`主题：${clean(row.subject)}`);
    if (clean(evidence?.match_reason)) opinionParts.push(truncate(evidence.match_reason, 150));
    const riskLevel = ['none', 'low', 'high'].includes(row.risk_level) ? row.risk_level : 'none';
    return {
      id: `outreach:${row.id}`,
      type: 'outreach',
      subject_type: 'email_draft',
      subject_id: row.id,
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${kolName} · 触达邮件待审批`,
      dedupe_key: `outreach:email_draft:${row.id}`,
      risk_level: riskLevel,
      facts,
      opinion: opinionParts.join('；'),
      risks,
      actions: openAction('/emails'),
      updated_at: iso(row.generated_at || row.updated_at)
    };
  });
}

module.exports = { buildOutreachItems };
