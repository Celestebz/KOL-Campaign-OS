const assert = require('node:assert/strict');
const test = require('node:test');
const { median, optionalNumber, aggregateSocialVideos, publishedAtDate, profileHandle, instagramFollowers, instagramVideo, tiktokVideo, socialProviderOrder } = require('./socialIntakeSnapshot');

test('socialProviderOrder respects primary, fallback toggle and deduplication', () => {
  const selection = {
    platforms: { instagram: { primary: 'scrapecreators', fallbacks: ['brightdata', 'scrapecreators'] } },
    fallbackStrategy: { enableFallback: true }
  };
  assert.deepEqual(socialProviderOrder(selection, 'instagram'), ['scrapecreators', 'brightdata']);

  const noFallback = { ...selection, fallbackStrategy: { enableFallback: false } };
  assert.deepEqual(socialProviderOrder(noFallback, 'instagram'), ['scrapecreators']);

  assert.deepEqual(socialProviderOrder({}, 'tiktok'), ['scrapecreators']);
});

test('median calculates odd and even platform exposure values', () => {
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(median([]), null);
});

test('optionalNumber distinguishes missing metrics from a real zero', () => {
  assert.equal(optionalNumber(undefined), null);
  assert.equal(optionalNumber(null), null);
  assert.equal(optionalNumber(''), null);
  assert.equal(optionalNumber('invalid'), null);
  assert.equal(optionalNumber(0), 0);
  assert.equal(optionalNumber('1234'), 1234);
});

test('aggregateSocialVideos excludes missing views without dropping the post count', () => {
  assert.deepEqual(aggregateSocialVideos([
    { views: null, likes: 100, comments: 10 },
    { views: 0, likes: 0, comments: 0 },
    { views: 200, likes: 20, comments: 4 }
  ]), {
    posts: 3,
    averageViews: 100,
    medianViews: 100,
    engagementRate: 0.12
  });
  assert.deepEqual(aggregateSocialVideos([
    { views: null, likes: 100, comments: 10 }
  ]), {
    posts: 1,
    averageViews: null,
    medianViews: null,
    engagementRate: null
  });
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

test('instagramFollowers reads the profile endpoint follower count', () => {
  assert.equal(instagramFollowers({ data: { user: { edge_followed_by: { count: 25116 } } } }), 25116);
  assert.equal(instagramFollowers({ data: { user: { follower_count: 0 } } }), 0);
  assert.equal(instagramFollowers({ data: { user: {} } }), null);
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

  assert.equal(instagramVideo({
    code: 'MISSING_VIEWS', media_type: 2, like_count: 50, comment_count: 6
  }, 'demo').views, null);
  assert.equal(instagramVideo({
    code: 'ZERO_VIEWS', media_type: 2, play_count: 0
  }, 'demo').views, 0);
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
