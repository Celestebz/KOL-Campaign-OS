const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
require('dotenv').config();

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'kol_campaign_os_test';

const { Sequelize } = require('sequelize');
const { initDatabase, dbOperations } = require('../database');
const { youtubeScrapeCreatorsAdapter } = require('./finderTasks');

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
  finder_task_id: 1,
  target_platform: 'youtube',
  limit: 5,
  discovery: { keywords: 'flail mower' },
  campaign: { name: 'TMB-1404 | Flail Mower', product: '53-inch PTO Flail Mower', target_market: 'US' },
  strategy: {
    persona_config: {},
    finder_handoff: {
      minimum_followers: 1000,
      minimum_median_views: 100,
      minimum_video_duration_seconds: 181,
      minimum_recent_videos: 3
    }
  }
};

function scSearchResponse(channelId, title) {
  return {
    videos: [{ type: 'video', id: 'v-' + channelId, title: 'hit', url: 'https://www.youtube.com/watch?v=v-' + channelId, viewCountInt: 5000, publishedTime: '2026-01-01T00:00:00Z', lengthSeconds: 600, channel: { id: channelId, title, handle: 'h' + channelId } }],
    shorts: [], lives: [], continuationToken: null
  };
}

function scChannelResponse(channelId, title, subs, country) {
  return { channelId, name: title, subscriberCount: subs, country, handle: 'h' + channelId, links: [] };
}

function scChannelVideosResponse(viewsList) {
  return {
    videos: viewsList.map((v, i) => ({ type: 'video', id: `cv${i}`, title: `cv${i}`, lengthSeconds: 600, viewCountInt: v, publishedTime: '2026-06-01T00:00:00Z' })),
    shorts: [], lives: []
  };
}

test('adapter 产出契约结构并通过 preflight', async () => {
  await resetTestDatabase();
  await dbOperations.run(
    "INSERT INTO api_settings (provider, api_key, created_at, updated_at) VALUES ('youtube.scrapecreators', 'test-key', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
  );
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('/v1/youtube/search')) return { status: 200, json: async () => scSearchResponse('UCgood', 'Good Channel') };
    if (u.includes('/v1/youtube/channel-videos')) return { status: 200, json: async () => scChannelVideosResponse([1000, 2000, 3000, 4000]) };
    if (u.includes('/v1/youtube/channel')) return { status: 200, json: async () => scChannelResponse('UCgood', 'Good Channel', 50000, 'United States') };
    throw new Error('unexpected url ' + u);
  });
  const result = await youtubeScrapeCreatorsAdapter(REQUEST);
  restore();
  assert.equal(result.provider, 'scrapecreators_youtube');
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0];
  assert.equal(c.platform, 'youtube');
  assert.equal(c.kol_name, 'Good Channel');
  assert.equal(c.followers, '50000');
  assert.equal(c.country_region, 'US'); // SC 全名已归一化为 ISO
  assert.ok(c.profile_url.includes('UCgood'));
  assert.ok(c.raw_data.preflight.passed);
  assert.ok(c.avg_views); // preflight 中位数回填
  assert.equal(result.external_request_count, 3); // search + channel + channel-videos
});

test('中位播放不达标进 preflight_rejected', async () => {
  await resetTestDatabase();
  await dbOperations.run(
    "INSERT INTO api_settings (provider, api_key, created_at, updated_at) VALUES ('youtube.scrapecreators', 'test-key', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
  );
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('/v1/youtube/search')) return { status: 200, json: async () => scSearchResponse('UClow', 'Low Channel') };
    if (u.includes('/v1/youtube/channel-videos')) return { status: 200, json: async () => scChannelVideosResponse([1, 2, 3, 4]) };
    if (u.includes('/v1/youtube/channel')) return { status: 200, json: async () => scChannelResponse('UClow', 'Low Channel', 50000, 'United States') };
    throw new Error('unexpected url ' + u);
  });
  const result = await youtubeScrapeCreatorsAdapter(REQUEST);
  restore();
  assert.equal(result.candidates.length, 0);
  assert.equal(result.preflight_rejected.length, 1);
  assert.equal(result.preflight_rejected[0].reason, 'median_views_below_threshold');
});

test('key 未配置时抛出明确错误', async () => {
  await resetTestDatabase();
  await assert.rejects(() => youtubeScrapeCreatorsAdapter(REQUEST), /ScrapeCreators/);
});
