// Recommendations come from product-fit evidence, not project membership.
function recommendationsFromFits(fits = []) {
  return fits.filter((fit) => !['rejected', 'excluded'].includes(fit.decision_status)
    && !['rejected', 'excluded'].includes(fit.candidate_status)).map((fit) => ({
    fit_id: fit.id,
    product_id: fit.product_id,
    campaign_product_id: fit.campaign_product_id,
    sku: fit.product_sku || null,
    product_name: fit.product_name || null,
    category: fit.product_category || null,
    score: fit.fit_score ?? null,
    decision: fit.decision_status || 'pending',
    evidence_summary: fit.evidence_summary || fit.ai_match_reason || null,
    evidence_url: fit.evidence_url || fit.video_url || null
  }));
}

function queryValues(value) {
  return (Array.isArray(value) ? value : value ? [value] : []).map(String);
}

function matchesRecommendations(customer, query = {}) {
  const categories = queryValues(query.recommended_category);
  const skus = queryValues(query.recommended_sku);
  if (!categories.length && !skus.length) return true;
  const fits = (customer.product_recommendations || []).filter((fit) => (
    !categories.length || categories.includes(fit.category)
  ));
  if (!skus.length) return fits.length > 0;
  return query.recommendation_match === 'all'
    ? skus.every((sku) => fits.some((fit) => fit.sku === sku))
    : fits.some((fit) => skus.includes(fit.sku));
}

function recommendationOptions(customers, query = {}) {
  const categories = new Map();
  const skus = new Map();
  const selectedCategories = queryValues(query.recommended_category);
  for (const customer of customers) {
    for (const fit of customer.product_recommendations || []) {
      if (fit.category) {
        if (!categories.has(fit.category)) categories.set(fit.category, new Set());
        categories.get(fit.category).add(customer.id);
      }
      if (fit.sku && (!selectedCategories.length || selectedCategories.includes(fit.category))) {
        if (!skus.has(fit.sku)) skus.set(fit.sku, new Set());
        skus.get(fit.sku).add(customer.id);
      }
    }
  }
  const entries = (map) => Array.from(map, ([value, ids]) => ({ value, count: ids.size }))
    .sort((a, b) => a.value.localeCompare(b.value));
  return { categories: entries(categories), skus: entries(skus) };
}

module.exports = { recommendationsFromFits, matchesRecommendations, recommendationOptions };
