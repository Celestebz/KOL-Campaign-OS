const assert = require('node:assert/strict');
const test = require('node:test');

const { fetchYouTubeScrapeCreators, fetchScrapeCreators, crawlVideo } = require('./videos');
const { dbOperations } = require('../database');

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

test('TikTok missing or empty metadata can be normalized and saved without undefined SQL parameters', async (t) => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  t.after(() => {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  });
  const url = 'https://www.tiktok.com/@creator/video/7699367145284685069';
  for (const metadata of [{}, { desc: '', author: { username: '' } }, { desc: 'Caption', author: { username: 'creator' } }]) {
    const post = { aweme_id: '7699367145284685069', stats: { play_count: 36, digg_count: 5 }, ...metadata };
    const restore = stubFetch(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ aweme_detail: post }) }));
    try {
      const result = await fetchScrapeCreators('tiktok', url, SETTING);
      assert.equal(result.title, metadata.desc || '');
      assert.equal(result.author_name, metadata.author?.username || '');
      assert.equal(result.kol_name, metadata.author?.username || '');
      const writes = [];
      const getMock = t.mock.method(dbOperations, 'get', async (sql, params) => {
        if (sql.includes('video_sources')) return { id: 1, source_url: url, platform_video_id: post.aweme_id };
        if (params[0] === 'tiktok.scrapecreators') return SETTING;
        return null;
      });
      const runMock = t.mock.method(dbOperations, 'run', async (sql, params) => {
        assert.ok(params.every(value => value !== undefined), 'SQL parameters must not contain undefined');
        writes.push({ sql, params });
        return { id: 2 };
      });
      try {
        await crawlVideo(1, 3);
        const update = writes.find(write => write.sql.includes('SET platform ='));
        assert.equal(update.params[3], metadata.desc || '');
        assert.ok(writes.some(write => write.sql.includes('INSERT INTO video_snapshots')));
        assert.ok(writes.some(write => write.sql.includes('UPDATE analysis_job_items') && write.params[0] === 'success'));
      } finally {
        getMock.mock.restore();
        runMock.mock.restore();
      }
    } finally {
      restore();
    }
  }
});
