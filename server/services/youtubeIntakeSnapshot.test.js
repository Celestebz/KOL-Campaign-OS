const assert = require('node:assert/strict');
const test = require('node:test');
const { durationSeconds, median, scIdentityFromLookup } = require('./youtubeIntakeSnapshot');

test('durationSeconds parses YouTube ISO durations', () => {
  assert.equal(durationSeconds('PT29S'), 29);
  assert.equal(durationSeconds('PT12M51S'), 771);
  assert.equal(durationSeconds('PT1H2M3S'), 3723);
});

test('median handles odd and even view counts', () => {
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(median([]), null);
});

test('scIdentityFromLookup 把 v3 lookup 映射为 SC identity', () => {
  assert.deepEqual(scIdentityFromLookup({ id: 'UC1' }), { channelId: 'UC1' });
  assert.deepEqual(scIdentityFromLookup({ forHandle: 'mrbeast' }), { handle: 'mrbeast' });
  assert.deepEqual(scIdentityFromLookup({ forUsername: 'olduser' }), { handle: 'olduser' });
  assert.throws(() => scIdentityFromLookup({ videoId: 'abc' }));
});
