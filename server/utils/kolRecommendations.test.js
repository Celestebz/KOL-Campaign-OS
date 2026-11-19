const test = require('node:test');
const assert = require('node:assert/strict');
const { recommendationsFromFits, matchesRecommendations, recommendationOptions } = require('./kolRecommendations');

const customers = [
  { id: 1, product_recommendations: [
    { sku: 'A', category: '汽车' }, { sku: 'A', category: '汽车' },
    { sku: 'B', category: '林业' }
  ] },
  { id: 2, product_recommendations: [{ sku: 'A', category: '汽车' }] },
  { id: 3, historical_cooperation_skus: ['A'], product_recommendations: [] }
];

test('category and SKU must match the same recommendation', () => {
  assert.equal(matchesRecommendations(customers[0], { recommended_category: '汽车', recommended_sku: 'B' }), false);
  assert.equal(matchesRecommendations(customers[0], { recommended_category: '林业', recommended_sku: 'B' }), true);
  assert.equal(matchesRecommendations(customers[2], { recommended_sku: 'A' }), false);
});

test('multiple SKU selection supports any and all', () => {
  assert.equal(matchesRecommendations(customers[1], { recommended_sku: ['A', 'B'] }), true);
  assert.equal(matchesRecommendations(customers[1], { recommended_sku: ['A', 'B'], recommendation_match: 'all' }), false);
  assert.equal(matchesRecommendations(customers[0], { recommended_sku: ['A', 'B'], recommendation_match: 'all' }), true);
});

test('counts unique creators for each SKU and limits SKU options by category', () => {
  assert.deepEqual(recommendationOptions(customers).skus, [{ value: 'A', count: 2 }, { value: 'B', count: 1 }]);
  assert.deepEqual(recommendationOptions(customers, { recommended_category: '林业' }).skus, [{ value: 'B', count: 1 }]);
});

test('excluded fits do not become recommendations and source identities stay intact', () => {
  assert.deepEqual(recommendationsFromFits([{ decision_status: 'rejected' }, { candidate_status: 'rejected' }]), []);
  const result = recommendationsFromFits([{ id: 9, product_id: 2, campaign_product_id: 7, product_sku: 'A', fit_score: 0 }]);
  assert.equal(result[0].campaign_product_id, 7);
  assert.equal(result[0].score, 0);
});
