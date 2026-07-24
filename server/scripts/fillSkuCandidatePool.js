const { initDatabase, dbOperations } = require('../database');

const APPLY = process.argv.includes('--apply');
const TARGETS = {
  'TMB-1401': { campaignId: 2, total: 45 },
  'TRA-0429': { campaignId: 3, total: 15 }
};

const normalize = (value) => String(value ?? '').toLowerCase();
const countMatches = (text, terms) => terms.reduce((sum, [term, weight]) => sum + (text.includes(term) ? weight : 0), 0);

function scoreCustomer(customer, sku) {
  const text = normalize([
    customer.name, customer.notes, customer.creator_type, customer.audience_fit,
    customer.company, customer.country_region
  ].filter(Boolean).join(' '));
  const direct = text.includes(sku.toLowerCase()) ? 45 : 0;
  const terms = sku === 'TMB-1401'
    ? [['finish mower', 45], ['tractor implement', 35], ['pto', 30], ['tractor', 25], ['mower', 22], ['farm', 15], ['homestead', 12], ['acreage', 10], ['lawn', 8], ['rural', 6]]
    : [['wood chipper', 45], ['chipper', 40], ['forestry', 30], ['arborist', 30], ['tree service', 28], ['logging', 25], ['wood processing', 25], ['firewood', 22], ['sawmill', 18], ['forest', 18], ['wood', 12], ['homestead', 6], ['outdoor', 5]];
  const relevance = direct + countMatches(text, terms);
  const hasYoutube = Boolean(customer.youtube_url || customer.profile_url);
  const hasContext = Boolean(customer.notes || customer.creator_type || customer.audience_fit);
  const score = Math.min(100, relevance + (hasYoutube ? 10 : 0) + (hasContext ? 5 : 0));
  const matched = terms.filter(([term]) => text.includes(term)).map(([term]) => term);
  if (direct) matched.unshift(sku);
  return { score, matched, hasYoutube };
}

async function main() {
  await initDatabase();
  const customers = await dbOperations.query(
    `SELECT c.*, COALESCE(kpa.profile_url, c.youtube_url, c.profile_url) youtube_profile,
       kpa.id platform_account_id
     FROM customers c
     LEFT JOIN kol_platform_accounts kpa ON kpa.id = (
       SELECT id FROM kol_platform_accounts WHERE customer_id = c.id AND LOWER(platform) = 'youtube' ORDER BY id LIMIT 1
     )
     WHERE COALESCE(c.cooperation_status, 'available') <> 'do_not_contact'
       AND COALESCE(kpa.profile_url, c.youtube_url, c.profile_url, '') <> ''`
  );
  const existingRows = await dbOperations.query(
    `SELECT ck.customer_id, ck.campaign_id FROM campaign_kols ck WHERE ck.campaign_id IN (2, 3)`
  );
  const assigned = new Set(existingRows.map((row) => Number(row.customer_id)));
  const existingCounts = Object.fromEntries(Object.entries(TARGETS).map(([sku, target]) => [
    sku, existingRows.filter((row) => Number(row.campaign_id) === target.campaignId).length
  ]));
  const ranked = [];
  for (const customer of customers) {
    if (assigned.has(Number(customer.id))) continue;
    const tmb = scoreCustomer(customer, 'TMB-1401');
    const tra = scoreCustomer(customer, 'TRA-0429');
    if (tmb.score === tra.score || Math.max(tmb.score, tra.score) < 60) continue;
    const sku = tmb.score > tra.score ? 'TMB-1401' : 'TRA-0429';
    const detail = sku === 'TMB-1401' ? tmb : tra;
    ranked.push({ customer, sku, ...detail });
  }

  const selected = [];
  for (const sku of ['TMB-1401', 'TRA-0429']) {
    const need = Math.max(0, TARGETS[sku].total - existingCounts[sku]);
    selected.push(...ranked.filter((item) => item.sku === sku).sort((a, b) => b.score - a.score).slice(0, need));
  }

  if (APPLY) {
    for (const item of selected) {
      const target = TARGETS[item.sku];
      const campaignProduct = await dbOperations.get(
        `SELECT cp.id FROM campaign_products cp JOIN products p ON p.id = cp.product_id
         WHERE cp.campaign_id = ? AND p.sku = ? ORDER BY cp.id LIMIT 1`,
        [target.campaignId, item.sku]
      );
      if (!campaignProduct) throw new Error(`Missing campaign product for ${item.sku}`);
      const reason = `KOL总表补充筛选；匹配关键词：${item.matched.join('、')}；自动匹配分：${item.score}`;
      const result = await dbOperations.run(
        `INSERT INTO campaign_kols
         (campaign_id, customer_id, platform_account_id, target_platform, source, project_status,
          priority_level, candidate_priority_score, evidence_summary, project_notes, sync_status, created_at, updated_at)
         VALUES (?, ?, ?, 'youtube', ?, 'pending_confirmation', ?, ?, ?, ?, 'sync_pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [target.campaignId, item.customer.id, item.customer.platform_account_id || null,
          `kol_master_backfill:${item.sku}`, item.score >= 85 ? 'T1' : item.score >= 75 ? 'T2' : 'T3',
          item.score, JSON.stringify({ summary: reason }), reason]
      );
      await dbOperations.run(
        `INSERT INTO campaign_kol_products
         (campaign_kol_id, campaign_product_id, fit_score, fit_status, evidence_summary, assignment_status, created_at, updated_at)
         VALUES (?, ?, ?, 'approved', ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [result.id, campaignProduct.id, item.score, JSON.stringify({ summary: reason })]
      );
    }
  }

  const available = {
    'TMB-1401': ranked.filter((item) => item.sku === 'TMB-1401').length,
    'TRA-0429': ranked.filter((item) => item.sku === 'TRA-0429').length
  };
  console.log(JSON.stringify({ apply: APPLY, existingCounts, available, selected: selected.map((item) => ({
    id: item.customer.id, name: item.customer.name, sku: item.sku, score: item.score, matched: item.matched
  })) }, null, 2));
  process.exit();
}

main().catch((error) => { console.error(error); process.exit(1); });
