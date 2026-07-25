// 策略审核 builder：kol_strategies 待人工确认（status='draft'，人工 mark-ready 后才变 'ready'）。
const { dbOperations } = require('../../database');
const { clean, truncate, iso, openAction, parseJson, summarizeFinderHandoff } = require('./shared');

async function buildStrategyItems() {
  const rows = await dbOperations.query(
    `SELECT ks.id, ks.campaign_id, ks.name, ks.brand, ks.product, ks.category, ks.target_market,
            ks.language, ks.primary_platform, ks.campaign_goal, ks.finder_handoff,
            ks.source_material_summary, ks.updated_at, c.name AS campaign_name
     FROM kol_strategies ks
     LEFT JOIN campaigns c ON c.id = ks.campaign_id
     WHERE ks.status = 'draft'
     ORDER BY ks.updated_at DESC
     LIMIT 50`
  );
  return rows.map((row) => {
    const handoff = parseJson(row.finder_handoff, {});
    const facts = [];
    const productLabel = [clean(row.brand), clean(row.product)].filter(Boolean).join(' / ');
    if (productLabel) facts.push(`产品：${productLabel}`);
    if (clean(row.category)) facts.push(`品类：${clean(row.category)}`);
    if (clean(row.target_market)) facts.push(`目标市场：${clean(row.target_market)}`);
    const handoffSummary = summarizeFinderHandoff(handoff);
    if (handoffSummary) facts.push(`搜索条件：${handoffSummary}`);
    if (!facts.length) facts.push('策略草稿已生成，等待人工确认');
    return {
      id: `strategy:${row.id}`,
      type: 'strategy',
      subject_type: 'kol_strategy',
      subject_id: row.id,
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${clean(row.name) || '未命名策略'} · 策略待确认`,
      dedupe_key: `strategy:kol_strategy:${row.id}`,
      risk_level: 'none',
      facts,
      opinion: truncate(row.campaign_goal || row.source_material_summary, 200),
      risks: [],
      actions: openAction('/strategy'),
      updated_at: iso(row.updated_at)
    };
  });
}

module.exports = { buildStrategyItems };
