const assert = require('node:assert/strict');
const test = require('node:test');

const { fetchYouTubeScrapeCreators } = require('./videos');

const SETTING = { api_key: 'k', base_url: 'https://api.scrapecreators.com' };
const VIDEO_URL = 'https://www.youtube.com/watch?v=abc123x yz'.replace(' ', '');

function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

test('youtube+scrapecreators 归一化视频详情与评论', async () => {
  const calls = [];
  const restore = stubFetch(async (url) => {
    calls.push(url);
    if (url.includes('/v1/youtube/video/comments')) {
      return { status: 200, json: async () => ({ comments: [{ id: 'c1', content: 'nice', publishedTime: '2026-01-01T00:00:00Z', author: { name: '@u' }, engagement: { likes: 3 } }] }) };
    }
    return {
      status: 200,
      json: async () => ({
        id: 'abc123xyz', title: 'Demo', type: 'video', publishDate: '2026-01-01T00:00:00Z',
        viewCountInt: 1000, likeCountInt: 50, commentCountInt: 5, channel: { title: 'Chan' }
      })
    };
  });
  const out = await fetchYouTubeScrapeCreators(VIDEO_URL, SETTING);
  restore();
  assert.equal(out.platform, 'youtube');
  assert.equal(out.platform_video_id, 'abc123xyz');
  assert.equal(out.kol_name, 'Chan');
  assert.equal(out.content_type, 'video');
  assert.deepEqual(out.metrics, { play_count: 1000, like_count: 50, comment_count: 5, collect_count: 0, share_count: null });
  assert.equal(out.comments.length, 1);
  assert.equal(out.comments[0].user_name, '@u');
  assert.ok(out.exposure);
  assert.equal(calls.length, 2);
});

test('评论接口失败时评论降级为空数组', async () => {
  const restore = stubFetch(async (url) => {
    if (url.includes('/video/comments')) return { status: 500, json: async () => ({}) };
    return { status: 200, json: async () => ({ id: 'abc123xyz', title: 'Demo', channel: { title: 'Chan' } }) };
  });
  const out = await fetchYouTubeScrapeCreators(VIDEO_URL, SETTING);
  restore();
  assert.deepEqual(out.comments, []);
});

test('无法识别视频 ID 时抛错', async () => {
  await assert.rejects(() => fetchYouTubeScrapeCreators('https://example.com/nope', SETTING), /视频 ID/);
});
