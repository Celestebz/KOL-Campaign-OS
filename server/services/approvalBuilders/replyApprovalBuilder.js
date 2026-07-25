// 达人回复审核 builder：email_replies confirm_status='pending'。
const { dbOperations } = require('../../database');
const { INTENT_LABELS, clean, truncate, iso, openAction } = require('./shared');

async function buildReplyItems() {
  const rows = await dbOperations.query(
    `SELECT er.id, er.campaign_id, er.customer_id, er.subject, er.body_text, er.received_at,
            er.ai_summary, er.ai_intent, er.updated_at,
            k.name AS kol_name, c.name AS campaign_name
     FROM email_replies er
     LEFT JOIN customers k ON k.id = er.customer_id
     LEFT JOIN campaigns c ON c.id = er.campaign_id
     WHERE er.confirm_status = 'pending'
     ORDER BY er.received_at DESC
     LIMIT 100`
  );
  return rows.map((row) => {
    const kolName = clean(row.kol_name) || `达人 #${row.customer_id}`;
    const facts = [`达人：${kolName}`];
    if (row.received_at) facts.push(`收到时间：${iso(row.received_at)}`);
    if (clean(row.body_text)) facts.push(`回复原文：${truncate(row.body_text, 120)}`);
    const opinionParts = [];
    if (clean(row.ai_summary)) opinionParts.push(truncate(row.ai_summary, 150));
    if (INTENT_LABELS[row.ai_intent]) opinionParts.push(`意向判断：${INTENT_LABELS[row.ai_intent]}`);
    return {
      id: `reply:${row.id}`,
      type: 'reply',
      subject_type: 'email_reply',
      subject_id: row.id,
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${kolName} · 回复待确认`,
      dedupe_key: `reply:email_reply:${row.id}`,
      risk_level: 'none',
      facts,
      opinion: opinionParts.join('；'),
      risks: [],
      actions: openAction('/emails'),
      updated_at: iso(row.received_at || row.updated_at)
    };
  });
}

module.exports = { buildReplyItems };
