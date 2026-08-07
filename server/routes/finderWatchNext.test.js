const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
require('dotenv').config();

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'kol_campaign_os_test';

const { Sequelize } = require('sequelize');
const { initDatabase, dbOperations } = require('../database');
const { youtubeWatchNextAdapter } = require('./finderTasks');

async function resetTestDatabase() {
  const admin = new Sequelize('mysql', 'root', process.env.DB_ROOT_PASSWORD || 'root_password', {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    dialect: 'mysql',
    logging: false
  });
  await admin.query(`DROP DATABASE IF EXISTS ${process.env.DB_NAME}`);
  await admin.query(`CREATE DATABASE ${process.env.DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.query(`GRANT ALL PRIVILEGES ON ${process.env.DB_NAME}.* TO '${process.env.DB_USER || 'kol_user'}'@'%'`);
  await admin.query('FLUSH PRIVILEGES');
  await admin.close();
  await initDatabase();
}

function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

const REQUEST = {
  finder_task_id: null,
  target_platform: 'youtube',
  limit: 5,
  discovery: { keywords: 'flail mower' },
  campaign: { name: 'TMB-1404 | Flail Mower', product: '53-inch PTO Flail Mower', target_market: 'US' },
  strategy: {
    persona_config: {},
    finder_handoff: {
      required_keywords: ['flail mower'],
      minimum_followers: 1000,
      minimum_median_views: 100,
      minimum_video_duration_seconds: 181,
      minimum_recent_videos: 3
    }
  }
};

const scOk = (data) => ({ status: 200, json: async () => data });

function scSearchWithSeed(channelId, videoId) {
  return {
    videos: [{ type: 'video', id: videoId, title: 'flail mower work', url: `https://www.youtube.com/watch?v=${videoId}`, viewCountInt: 8000, publishedTime: '2026-01-01T00:00:00Z', lengthSeconds: 600, channel: { id: channelId, title: 'Seed Chan ' + channelId, handle: 'h' + channelId } }],
    shorts: [], lives: [], continuationToken: null
  };
}

// recEntries: [{ id, channelId?, views?, lengthSeconds? }]，channelId 缺省为 'UC' + id
function scVideoWithWatchNext(recEntries) {
  return {
    id: 'seedvid', title: 'seed', type: 'video',
    watchNextVideos: recEntries.map((e) => ({
      id: e.id, title: 'rec ' + e.id, videoUrl: 'https://www.youtube.com/watch?v=' + e.id,
      viewCountInt: e.views !== undefined ? e.views : 5000,
      lengthInSeconds: e.lengthSeconds !== undefined ? e.lengthSeconds : 700,
      publishedTime: '2026-02-01T00:00:00Z',
      channel: { id: e.channelId || 'UC' + e.id, title: 'Chan ' + (e.channelId || 'UC' + e.id), handle: 'h' + (e.channelId || e.id) }
    }))
  };
}

function scChannel(channelId, title) {
  return { channelId, name: title, subscriberCount: 50000, country: 'United States', handle: 'h' + channelId, links: [] };
}

function scChannelVideosPass() {
  return { videos: [1, 2, 3, 4].map((i) => ({ type: 'video', id: 'cv' + i, title: 'cv' + i, lengthSeconds: 600, viewCountInt: 1000 * i, publishedTime: '2026-06-01T00:00:00Z' })), shorts: [], lives: [] };
}

test('关联扩展：种子 → 一跳 → 富化 → preflight 全链路产出候选', async () => {
  await resetTestDatabase();
  await dbOperations.run("INSERT INTO api_settings (provider, api_key, created_at, updated_at) VALUES ('youtube.scrapecreators', 'test-key', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('/v1/youtube/search')) return scOk(scSearchWithSeed('UCseed', 'seedvid'));
    if (u.includes('/v1/youtube/video?')) return scOk(scVideoWithWatchNext([{ id: 'r1' }, { id: 'r2' }]));
    if (u.includes('/v1/youtube/channel-videos')) return scOk(scChannelVideosPass());
    if (u.includes('/v1/youtube/channel')) {
      const m = u.match(/channelId=([^&]+)/);
      return scOk(scChannel(m[1], 'Chan ' + m[1]));
    }
    throw new Error('unexpected url ' + u);
  });
  const result = await youtubeWatchNextAdapter(REQUEST);
  restore();
  assert.equal(result.provider, 'youtube_watch_next_expansion');
  assert.ok(result.candidates.length >= 2); // 种子频道 + 推荐频道
  for (const c of result.candidates) {
    assert.equal(c.platform, 'youtube');
    assert.ok(c.raw_data.preflight.passed);
    assert.ok(c.raw_data.graph_signal);
  }
  assert.ok(result.external_request_count > 0);
  const ledgers = await dbOperations.query("SELECT DISTINCT provider FROM finder_query_ledger WHERE provider = 'youtube_watch_next_expansion'");
  assert.equal(ledgers.length, 1);
});

test('预过滤剔除短视频与低播放，viewCountInt 缺失放行', async () => {
  await resetTestDatabase();
  await dbOperations.run("INSERT INTO api_settings (provider, api_key, created_at, updated_at) VALUES ('youtube.scrapecreators', 'test-key', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");
  const enriched = [];
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('/v1/youtube/search')) return scOk(scSearchWithSeed('UCseed', 'seedvid'));
    if (u.includes('/v1/youtube/video?')) {
      return scOk(scVideoWithWatchNext([
        { id: 'short1', views: 99999, lengthSeconds: 30 },
        { id: 'low1', views: 10, lengthSeconds: 700 },
        { id: 'noviews', views: null, lengthSeconds: 700 }
      ]));
    }
    if (u.includes('/v1/youtube/channel-videos')) return scOk(scChannelVideosPass());
    if (u.includes('/v1/youtube/channel')) {
      const m = u.match(/channelId=([^&]+)/);
      enriched.push(m[1]);
      return scOk(scChannel(m[1], 'Chan ' + m[1]));
    }
    throw new Error('unexpected url ' + u);
  });
  // noviews 的 views 需要真正缺失而不是 0：viewCountInt 字段不存在
  const result = await youtubeWatchNextAdapter(REQUEST);
  restore();
  assert.ok(enriched.includes('UCnoviews'), 'viewCountInt 缺失应放行');
  assert.ok(!enriched.includes('UCshort1'), '30s 应被时长剔除');
  assert.ok(!enriched.includes('UClow1'), '10 播放应被门槛剔除');
});

test('同频道多条视频被不同种子推荐时聚合为频道级 graph_signal 且不重复富化', async () => {
  await resetTestDatabase();
  await dbOperations.run("INSERT INTO api_settings (provider, api_key, created_at, updated_at) VALUES ('youtube.scrapecreators', 'test-key', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");
  const request = {
    ...REQUEST,
    strategy: { ...REQUEST.strategy, finder_handoff: { ...REQUEST.strategy.finder_handoff, required_keywords: ['flail mower', 'brush hog'] } }
  };
  const channelCalls = [];
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('/v1/youtube/search')) {
      const q = decodeURIComponent(u.match(/query=([^&]+)/)[1]);
      const suffix = q.includes('brush') ? '2' : '1';
      return scOk(scSearchWithSeed('UCseed' + suffix, 'seedvid' + suffix));
    }
    if (u.includes('/v1/youtube/video?')) {
      const vid = decodeURIComponent(u.match(/url=([^&]+)/)[1]);
      // 两个种子各推同一频道 UCshared 的不同视频
      const rec = vid.includes('seedvid2') ? { id: 'sharedB', channelId: 'UCshared' } : { id: 'sharedA', channelId: 'UCshared' };
      return scOk(scVideoWithWatchNext([rec]));
    }
    if (u.includes('/v1/youtube/channel-videos')) return scOk(scChannelVideosPass());
    if (u.includes('/v1/youtube/channel')) {
      const m = u.match(/channelId=([^&]+)/);
      channelCalls.push(m[1]);
      return scOk(scChannel(m[1], 'Chan ' + m[1]));
    }
    throw new Error('unexpected url ' + u);
  });
  const result = await youtubeWatchNextAdapter(request);
  restore();
  const shared = result.candidates.find((c) => c.profile_url.includes('UCshared'));
  assert.ok(shared, '应产出共享频道候选');
  assert.ok(shared.raw_data.graph_signal.channel_seed_count >= 2, '应聚合到 2 条种子');
  assert.ok(shared.raw_data.graph_signal.recommended_video_count >= 2, '应聚合 2 条推荐视频');
  const sharedCalls = channelCalls.filter((id) => id === 'UCshared').length;
  assert.equal(sharedCalls, 1, 'UCshared 只应富化一次');
});

test('validateSearchSource 白名单校验', () => {
  const { validateSearchSource } = require('./finderTasks');
  assert.equal(validateSearchSource('youtube', 'youtube_watch_next_expansion'), 'youtube_watch_next_expansion');
  assert.throws(() => validateSearchSource('instagram', 'youtube_watch_next_expansion'), /youtube_watch_next_expansion/);
  assert.throws(() => validateSearchSource('youtube', 'nope'), /not available/);
});
