const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTikTokHandle, median, getTikTokMedianExposure } = require('./tiktokCreatorMetrics');

test('normalizes escaped TikTok profile URLs', () => {
  assert.equal(normalizeTikTokHandle('https://www.tiktok.com/@jazmyn\\_amethyst'), 'jazmyn_amethyst');
  assert.equal(normalizeTikTokHandle('@creator.name'), 'creator.name');
});

test('calculates odd and even medians', () => {
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([1, 3, 8, 10]), 5.5);
  assert.equal(median([]), null);
});

test('fetches pages, deduplicates videos, and filters rolling 30 days', async () => {
  const nowMs = Date.parse('2026-08-26T00:00:00.000Z');
  const ts = (date) => Math.floor(Date.parse(date) / 1000);
  const pages = [
    { aweme_list: [
      { aweme_id: 'a', create_time: ts('2026-08-25T00:00:00Z'), statistics: { play_count: 100 } },
      { aweme_id: 'b', create_time: ts('2026-08-10T00:00:00Z'), statistics: { play_count: 300 } }
    ], has_more: true, max_cursor: 123 },
    { aweme_list: [
      { aweme_id: 'b', create_time: ts('2026-08-10T00:00:00Z'), statistics: { play_count: 300 } },
      { aweme_id: 'c', create_time: ts('2026-07-20T00:00:00Z'), statistics: { play_count: 999 } }
    ], has_more: false }
  ];
  const result = await getTikTokMedianExposure('jazmyn_amethyst', {
    nowMs,
    setting: { api_key: 'hidden', base_url: 'https://example.test' },
    fetchImpl: async () => ({ ok: true, json: async () => pages.shift() })
  });
  assert.equal(result.posts_30d, 2);
  assert.equal(result.median_views_30d, 200);
  assert.equal(result.average_views_30d, 200);
  assert.deepEqual(result.videos.map((video) => video.video_id), ['a', 'b']);
});
