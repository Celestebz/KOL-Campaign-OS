// 预算审核 builder：campaign_kols budget_approval_status='pending'（取值见前端预算审批下拉：pending/approved/rejected）。
const { dbOperations } = require('../../database');
const { clean, truncate, iso, openAction } = require('./shared');

async function buildBudgetItems() {
  const rows = await dbOperations.query(
    `SELECT ck.id, ck.campaign_id, ck.customer_id, ck.kol_name_snapshot,
            ck.quoted_fee, ck.final_fee, ck.currency, ck.cooperation_type, ck.deliverables,
            ck.estimated_total_cost_usd, ck.expected_views, ck.estimated_cpm, ck.updated_at,
            c.name AS campaign_name, k.name AS kol_name
     FROM campaign_kols ck
     LEFT JOIN campaigns c ON c.id = ck.campaign_id
     LEFT JOIN customers k ON k.id = ck.customer_id
     WHERE ck.budget_approval_status = 'pending'
     ORDER BY ck.updated_at DESC
     LIMIT 100`
  );
  return rows.map((row) => {
    const kolName = clean(row.kol_name) || clean(row.kol_name_snapshot) || `达人 #${row.customer_id}`;
    const facts = [];
    const fee = clean(row.final_fee) || clean(row.quoted_fee);
    if (fee) facts.push(`报价：${fee}${clean(row.currency) ? ` ${clean(row.currency)}` : ''}`);
    if (clean(row.cooperation_type)) facts.push(`合作形式：${clean(row.cooperation_type)}`);
    if (row.estimated_total_cost_usd != null) facts.push(`总预计成本：${row.estimated_total_cost_usd} USD`);
    if (row.expected_views != null) facts.push(`预计合作曝光：${row.expected_views}`);
    if (row.estimated_cpm != null) facts.push(`预估 CPM：${row.estimated_cpm}`);
    if (clean(row.deliverables)) facts.push(`交付内容：${truncate(row.deliverables, 100)}`);
    if (!facts.length) facts.push('预算信息待补充');
    return {
      id: `budget:${row.id}`,
      type: 'budget',
      subject_type: 'campaign_kol',
      subject_id: row.id,
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${kolName} · 预算待审批`,
      dedupe_key: `budget:campaign_kol:${row.id}`,
      risk_level: 'none',
      facts,
      opinion: '',
      risks: [],
      actions: openAction('/campaign-kols'),
      updated_at: iso(row.updated_at)
    };
  });
}

module.exports = { buildBudgetItems };
