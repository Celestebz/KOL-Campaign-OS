const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateDraft, RISK_CODES } = require('./emailRiskRules');

const base = {
  customer: { id: 1, name: 'Alice', email: 'a@x.com', country_region: 'US' },
  strategy: { target_market: 'US' },
  bodyText: 'Hi, loved your video "Mower test" with 100K views. We offer a free unit plus 5% commission, no fixed fee, one video within 30 days.',
  citedVideoIds: ['v1'],
  evidenceVideos: [{ youtube_video_id: 'v1', title: 'Mower test', play_count: 100000 }],
  snapshotDate: new Date().toISOString(),
  hasEmail: true
};

test('clean draft gets risk none', () => {
  const { riskLevel, riskReasons } = evaluateDraft(base);
  assert.equal(riskLevel, 'none');
  assert.deepEqual(riskReasons, []);
});

test('fabricated video id is high risk', () => {
  const { riskLevel, riskReasons } = evaluateDraft({ ...base, citedVideoIds: ['nope'] });
  assert.equal(riskLevel, 'high');
  assert.ok(riskReasons.some((r) => r.code === 'FABRICATED_EVIDENCE'));
});

test('price commitment and no email are high risk', () => {
  const { riskReasons } = evaluateDraft({ ...base, bodyText: base.bodyText + ' We can pay $500 per video.' });
  assert.ok(riskReasons.some((r) => r.code === 'PRICE_COMMITMENT'));
  const noEmail = evaluateDraft({ ...base, hasEmail: false });
  assert.equal(noEmail.riskLevel, 'high');
  assert.ok(noEmail.riskReasons.some((r) => r.code === 'NO_EMAIL'));
});

test('market mismatch is high, stale snapshot and missing video reference are low', () => {
  const mm = evaluateDraft({ ...base, customer: { ...base.customer, country_region: 'GB' } });
  assert.ok(mm.riskReasons.some((r) => r.code === 'MARKET_MISMATCH' && mm.riskLevel === 'high'));
  const stale = evaluateDraft({ ...base, snapshotDate: '2026-07-01' });
  assert.ok(stale.riskReasons.some((r) => r.code === 'STALE_SNAPSHOT'));
  assert.equal(stale.riskLevel, 'low');
  const noRef = evaluateDraft({ ...base, citedVideoIds: [] });
  assert.ok(noRef.riskReasons.some((r) => r.code === 'MISSING_VIDEO_REFERENCE'));
});

test('metric mismatch detects wrong view counts in body', () => {
  const wrong = evaluateDraft({ ...base, bodyText: base.bodyText.replace('100K', '1.2M') });
  assert.ok(wrong.riskReasons.some((r) => r.code === 'METRIC_MISMATCH'));
});

test('missing required terms is low risk', () => {
  const missing = evaluateDraft({ ...base, kind: 'follow_up', bodyText: 'Hi, your content is great. Want to try our product?' });
  assert.ok(missing.riskReasons.some((r) => r.code === 'MISSING_REQUIRED_TERM'));
});

test('first touch does not require commission or fee terms', () => {
  const result = evaluateDraft({ ...base, kind: 'first_touch', bodyText: 'Hi, your content is great. Would you be interested in learning more?' });
  assert.ok(!result.riskReasons.some((r) => r.code === 'MISSING_REQUIRED_TERM'));
});

test('negated contract and fixed fee language is not a price commitment', () => {
  const result = evaluateDraft({ ...base, kind: 'follow_up', bodyText: 'We offer 5% commission. There is no contract or fixed fee.' });
  assert.ok(!result.riskReasons.some((r) => r.code === 'PRICE_COMMITMENT'));
  assert.ok(!result.riskReasons.some((r) => r.code === 'MISSING_REQUIRED_TERM'));
});

test('RISK_CODES covers all emitted codes', () => {
  assert.equal(RISK_CODES.NO_EMAIL, 'high');
  assert.equal(RISK_CODES.STALE_SNAPSHOT, 'low');
});
