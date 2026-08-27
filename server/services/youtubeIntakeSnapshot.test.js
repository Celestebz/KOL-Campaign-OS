const assert = require('node:assert/strict');
const test = require('node:test');
const { durationSeconds, median, scIdentityFromLookup, latestLongVideoItems } = require('./youtubeIntakeSnapshot');

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

test('latestLongVideoItems 按发布时间取最近 10 条长视频并排除 Shorts 和直播', () => {
  const item = (id, day, seconds = 600, live = false) => ({
    id,
    snippet: { publishedAt: `2026-08-${String(day).padStart(2, '0')}T00:00:00Z`, liveBroadcastContent: live ? 'live' : 'none' },
    contentDetails: { duration: `PT${seconds}S` },
    ...(live ? { liveStreamingDetails: {} } : {})
  });
  const items = [item('short', 27, 60), item('live', 26, 600, true)];
  for (let day = 1; day <= 12; day += 1) items.push(item(`long-${day}`, day));

  const selected = latestLongVideoItems(items);
  assert.equal(selected.length, 10);
  assert.deepEqual(selected.map((entry) => entry.id), [
    'long-12', 'long-11', 'long-10', 'long-9', 'long-8',
    'long-7', 'long-6', 'long-5', 'long-4', 'long-3'
  ]);
});
