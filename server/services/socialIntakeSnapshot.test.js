const assert = require('node:assert/strict');
const test = require('node:test');
const { median, publishedAtDate, profileHandle, instagramVideo, tiktokVideo } = require('./socialIntakeSnapshot');

test('median calculates odd and even platform exposure values', () => {
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(median([]), null);
});

test('publishedAtDate converts ISO timestamps to a MySQL-bindable Date', () => {
  const value = publishedAtDate('2026-08-22T16:34:12.000Z');
  assert.ok(value instanceof Date);
  assert.equal(value.toISOString(), '2026-08-22T16:34:12.000Z');
  assert.equal(publishedAtDate('not-a-date'), null);
  assert.equal(publishedAtDate(null), null);
});

test('profileHandle normalizes Instagram and TikTok profile URLs', () => {
  assert.equal(profileHandle('instagram', 'https://www.instagram.com/demo.creator/'), 'demo.creator');
  assert.equal(profileHandle('tiktok', 'https://www.tiktok.com/@demo_creator'), 'demo_creator');
});

test('instagramVideo maps Reels and rejects image posts', () => {
  assert.equal(instagramVideo({ code: 'IMAGE', media_type: 1 }, 'demo'), null);
  assert.deepEqual(instagramVideo({
    code: 'REEL1', media_type: 2, created_at: '2026-08-20T00:00:00Z',
    play_count: 1234, like_count: 50, comment_count: 6, caption: { text: 'Demo reel' }
  }, 'demo'), {
    id: 'REEL1', title: 'Demo reel', url: 'https://www.instagram.com/reel/REEL1/',
    publishedAt: '2026-08-20T00:00:00Z', views: 1234, likes: 50, comments: 6, handle: 'demo'
  });
});

test('tiktokVideo maps videos and rejects photo posts', () => {
  assert.equal(tiktokVideo({ aweme_id: '1', content_type: 'multi_photo' }, 'demo'), null);
  assert.deepEqual(tiktokVideo({
    aweme_id: '123', desc: 'Demo TikTok', create_time: 1787184000,
    statistics: { play_count: 2000, digg_count: 90, comment_count: 8 }
  }, 'demo'), {
    id: '123', title: 'Demo TikTok', url: 'https://www.tiktok.com/@demo/video/123',
    publishedAt: new Date(1787184000 * 1000).toISOString(), views: 2000, likes: 90, comments: 8, handle: 'demo'
  });
});
