# ScrapeCreators YouTube Provider 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ScrapeCreators 接入为 YouTube 的正式数据源，覆盖 Finder 发现、视频详情+评论、30 天 intake 快照三处，通用品类（查询词与阈值全部由策略驱动）。

**Architecture:** 纯函数映射层（`server/utils/scrapecreatorsYoutubeSearch.js`，SC 响应 → YouTube v3 形状，零 HTTP）+ HTTP 服务层（`server/services/scrapecreatorsYoutube.js`，配置解析 + 超时/重试/402 处理 + 5 个端点封装），三处消费点（finderTasks.js / videos.js / youtubeIntakeSnapshot.js）通过映射层复用现有 v3 语义的 gate 与归一化代码。

**Tech Stack:** Node.js 原生 fetch、node:test + supertest（server，`npm test` = `node --test routes/*.test.js utils/*.test.js middleware/*.test.js services/*.test.js`）、react-scripts test（client）。无新依赖。

**设计依据:** `docs/superpowers/specs/2026-08-04-scrapecreators-youtube-provider-design.md`（含六轮试跑验证的端点/字段/空值怪癖清单）。

## Global Constraints

- 不引入新 npm 依赖；不改 TikTok/IG 侧现有逻辑；不改 emails/approvals/Feishu 模块。
- SC 请求全部 30s AbortController 超时；402 不重试直接报"额度耗尽"；401 报 key 无效；429/5xx/网络错误指数退避重试 2 次（250ms → 1s）。
- key 读取顺序：`youtube.scrapecreators` → legacy `scrapecreators` → `instagram.scrapecreators` → `tiktok.scrapecreators`。
- 空值兜底：country null 放行；publishedTime null 视为空串（排序最旧）；handle 为 `channel/<id>` 形式时归一化为 channelId；subscriberCount 取整；SC email 字段不可用，候选 email 一律留空。
- Finder 预算常量 `SC_FINDER_REQUEST_BUDGET = 200`（credits/任务，只计真实外部调用，缓存命中不计）。
- 测试命令：server 在 `server/` 下 `npm test`；client 在 `client/` 下 `CI=true npx react-scripts test --watchAll=false`。
- 每个 Task 结束按步骤 commit（执行前先取得用户确认）。

---

### Task 1: SC YouTube 纯函数映射层

**Files:**
- Create: `server/utils/scrapecreatorsYoutubeSearch.js`
- Test: `server/utils/scrapecreatorsYoutubeSearch.test.js`

**Interfaces:**
- Produces（后续所有 Task 依赖这些签名）:
  - `buildYoutubeSearchUrl(baseUrl, query, continuationToken = '') -> string`
  - `buildYoutubeChannelUrl(baseUrl, identity) -> string`；identity 为 `{channelId}|{handle}|{url}` 之一
  - `buildYoutubeChannelVideosUrl(baseUrl, identity) -> string`（固定 `includeExtras=true`）
  - `buildYoutubeVideoUrl(baseUrl, url) -> string`
  - `buildYoutubeCommentsUrl(baseUrl, url, continuationToken = '') -> string`
  - `normalizeScHandle(rawHandle, channelId) -> {handle}|{channelId}|{}`
  - `secondsToIsoDuration(seconds) -> string`（'PT1H2M3S'，0 -> 'PT0S'）
  - `toV3SearchItems(data) -> v3 形状数组`（供 `youtubeItemsToCandidates` 复用）
  - `toV3ChannelItem(data) -> v3 channel 形状`（供 `looksLikeExcludedYoutubeAccount`/候选富化复用）
  - `toV3VideoItems(data) -> v3 video 形状数组`（供 `evaluateYoutubePreflight` 与快照复用）
  - `scVideoDetailToNormalized(data, url) -> object`（videos.js 归一化基础结构，不含 exposure/comments/raw）
  - `scCommentsToNormalized(data, limit = 100) -> array`

- [ ] **Step 1: 写失败测试**

创建 `server/utils/scrapecreatorsYoutubeSearch.test.js`：

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildYoutubeSearchUrl,
  buildYoutubeChannelUrl,
  buildYoutubeChannelVideosUrl,
  normalizeScHandle,
  secondsToIsoDuration,
  toV3SearchItems,
  toV3ChannelItem,
  toV3VideoItems,
  scVideoDetailToNormalized,
  scCommentsToNormalized
} = require('./scrapecreatorsYoutubeSearch');

test('buildYoutubeSearchUrl 拼接 query 与 continuationToken', () => {
  assert.equal(
    buildYoutubeSearchUrl('https://api.scrapecreators.com', 'flail mower', 'tok 1'),
    'https://api.scrapecreators.com/v1/youtube/search?query=flail%20mower&continuationToken=tok%201'
  );
  assert.equal(
    buildYoutubeSearchUrl(undefined, 'brush hog'),
    'https://api.scrapecreators.com/v1/youtube/search?query=brush%20hog'
  );
});

test('buildYoutubeChannelUrl 支持三种 identity', () => {
  assert.equal(buildYoutubeChannelUrl('https://api.scrapecreators.com', { channelId: 'UC1' }),
    'https://api.scrapecreators.com/v1/youtube/channel?channelId=UC1');
  assert.equal(buildYoutubeChannelUrl('https://api.scrapecreators.com', { handle: 'mrbeast' }),
    'https://api.scrapecreators.com/v1/youtube/channel?handle=mrbeast');
  assert.equal(buildYoutubeChannelUrl('https://api.scrapecreators.com', { url: 'https://www.youtube.com/@mrbeast' }),
    'https://api.scrapecreators.com/v1/youtube/channel?url=https%3A%2F%2Fwww.youtube.com%2F%40mrbeast');
  assert.throws(() => buildYoutubeChannelUrl('https://api.scrapecreators.com', {}));
});

test('buildYoutubeChannelVideosUrl 固定 includeExtras', () => {
  assert.equal(buildYoutubeChannelVideosUrl('https://api.scrapecreators.com', { channelId: 'UC1' }),
    'https://api.scrapecreators.com/v1/youtube/channel-videos?channelId=UC1&includeExtras=true');
});

test('normalizeScHandle 归一化 channel/<id> 形式与 @ 前缀', () => {
  assert.deepEqual(normalizeScHandle('channel/UCabc', 'UCabc'), { channelId: 'UCabc' });
  assert.deepEqual(normalizeScHandle('@MrBeast', 'UCx'), { handle: 'MrBeast' });
  assert.deepEqual(normalizeScHandle('', 'UCx'), { channelId: 'UCx' });
  assert.deepEqual(normalizeScHandle('', ''), {});
});

test('secondsToIsoDuration', () => {
  assert.equal(secondsToIsoDuration(0), 'PT0S');
  assert.equal(secondsToIsoDuration(254), 'PT4M14S');
  assert.equal(secondsToIsoDuration(3723), 'PT1H2M3S');
  assert.equal(secondsToIsoDuration(null), 'PT0S');
});

test('toV3SearchItems 汇总 videos/shorts/lives 并跳过缺 channel 的条目', () => {
  const items = toV3SearchItems({
    videos: [{ id: 'v1', title: 'A', publishedTime: '2026-01-01T00:00:00Z', channel: { id: 'UC1', title: 'Chan' } }],
    shorts: [{ id: 's1', title: 'B', publishedTime: null, channel: { id: 'UC1', title: 'Chan' } }],
    lives: [{ id: 'l1', title: 'C', channel: { id: 'UC2', title: 'Other' } }],
    channels: [{ id: 'nope' }]
  });
  assert.equal(items.length, 3);
  assert.deepEqual(items[0].id, { videoId: 'v1', kind: 'youtube#video' });
  assert.equal(items[0].snippet.channelId, 'UC1');
  assert.equal(items[1].snippet.publishedAt, '');
  assert.equal(items[2]._scType, 'live');
});

test('toV3ChannelItem 映射为 v3 channel 形状并取整订阅数', () => {
  const item = toV3ChannelItem({
    channelId: 'UC1', name: 'Chan', description: 'd', country: 'United States',
    subscriberCount: 65099.99, videoCount: 30, handle: '@chan', links: ['https://x.com/a']
  });
  assert.equal(item.id, 'UC1');
  assert.equal(item.snippet.country, 'United States');
  assert.equal(item.statistics.subscriberCount, '65100');
  assert.equal(item._sc.handle, 'chan');
});

test('toV3VideoItems 映射时长/统计，lives 标记 liveBroadcastContent', () => {
  const items = toV3VideoItems({
    videos: [{ id: 'v1', title: 'A', publishedTime: '2026-01-01T00:00:00Z', lengthSeconds: 484, viewCountInt: 29382, likeCountInt: 100, commentCountInt: 9, channel: { id: 'UC1', title: 'C' } }],
    shorts: [{ id: 's1', title: 'S', lengthSeconds: 44, viewCountInt: 5, channel: { id: 'UC1' } }],
    lives: [{ id: 'l1', title: 'L', lengthSeconds: 3600, viewCountInt: 7, channel: { id: 'UC1' } }]
  });
  assert.equal(items.length, 3);
  assert.equal(items[0].contentDetails.duration, 'PT8M4S');
  assert.equal(items[0].statistics.viewCount, '29382');
  assert.equal(items[1].snippet.liveBroadcastContent, 'none');
  assert.equal(items[2].snippet.liveBroadcastContent, 'live');
});

test('scVideoDetailToNormalized 产出 videos.js 归一化基础结构', () => {
  const n = scVideoDetailToNormalized({
    id: 'abc', title: 'T', type: 'video', publishDate: '2019-02-22T03:19:54-08:00',
    viewCountInt: 372864, likeCountInt: 4043, commentCountInt: 358,
    channel: { title: 'Chan' }
  }, 'https://www.youtube.com/watch?v=abc');
  assert.equal(n.platform, 'youtube');
  assert.equal(n.platform_video_id, 'abc');
  assert.equal(n.kol_name, 'Chan');
  assert.equal(n.content_type, 'video');
  assert.deepEqual(n.metrics, { play_count: 372864, like_count: 4043, comment_count: 358, collect_count: 0, share_count: null });
  const short = scVideoDetailToNormalized({ id: 'x', type: 'short', channel: {} }, 'https://www.youtube.com/watch?v=x');
  assert.equal(short.content_type, 'short');
  const byUrl = scVideoDetailToNormalized({ id: 'y', channel: {} }, 'https://www.youtube.com/shorts/y');
  assert.equal(byUrl.content_type, 'short');
});

test('scCommentsToNormalized 截取前 100 条并映射作者/点赞', () => {
  const comments = Array.from({ length: 120 }, (_, i) => ({
    id: `c${i}`, content: `text ${i}`, publishedTime: '2026-01-01T00:00:00Z',
    author: { name: '@user' }, engagement: { likes: i }
  }));
  const out = scCommentsToNormalized({ comments }, 100);
  assert.equal(out.length, 100);
  assert.deepEqual(out[1], {
    id: 'c1', parent_id: null, user_name: '@user', content: 'text 1',
    like_count: 1, commented_at: '2026-01-01T00:00:00Z', raw: out[1].raw
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx node --test utils/scrapecreatorsYoutubeSearch.test.js`
Expected: FAIL（`Cannot find module './scrapecreatorsYoutubeSearch'`）

- [ ] **Step 3: 实现映射模块**

创建 `server/utils/scrapecreatorsYoutubeSearch.js`：

```js
// ScrapeCreators YouTube 响应 → 内部结构的纯函数映射（无 HTTP，便于单测）。
// v3 映射目标：finderTasks 的 youtubeItemsToCandidates / evaluateYoutubePreflight、
// youtubeIntakeSnapshot 的快照映射可直接复用。
function clean(value) {
  return String(value ?? '').trim();
}

function buildBase(baseUrl) {
  return String(baseUrl || 'https://api.scrapecreators.com').replace(/\/+$/, '').replace(/\/v1$/, '');
}

function buildYoutubeSearchUrl(baseUrl, query, continuationToken = '') {
  const token = clean(continuationToken);
  return `${buildBase(baseUrl)}/v1/youtube/search?query=${encodeURIComponent(query)}${token ? `&continuationToken=${encodeURIComponent(token)}` : ''}`;
}

function channelIdentityParam(identity = {}) {
  if (identity.channelId) return `channelId=${encodeURIComponent(identity.channelId)}`;
  if (identity.handle) return `handle=${encodeURIComponent(identity.handle)}`;
  if (identity.url) return `url=${encodeURIComponent(identity.url)}`;
  throw new Error('ScrapeCreators channel 端点需要 channelId / handle / url 之一');
}

function buildYoutubeChannelUrl(baseUrl, identity) {
  return `${buildBase(baseUrl)}/v1/youtube/channel?${channelIdentityParam(identity)}`;
}

function buildYoutubeChannelVideosUrl(baseUrl, identity) {
  return `${buildBase(baseUrl)}/v1/youtube/channel-videos?${channelIdentityParam(identity)}&includeExtras=true`;
}

function buildYoutubeVideoUrl(baseUrl, url) {
  return `${buildBase(baseUrl)}/v1/youtube/video?url=${encodeURIComponent(url)}`;
}

function buildYoutubeCommentsUrl(baseUrl, url, continuationToken = '') {
  const token = clean(continuationToken);
  return `${buildBase(baseUrl)}/v1/youtube/video/comments?url=${encodeURIComponent(url)}${token ? `&continuationToken=${encodeURIComponent(token)}` : ''}`;
}

// SC 在 handle 缺失时返回 'channel/<channelId>' 形式；统一归一化为可用 identity。
function normalizeScHandle(rawHandle, channelId) {
  const h = clean(rawHandle).replace(/^@/, '');
  if (!h) return clean(channelId) ? { channelId: clean(channelId) } : {};
  if (/^channel\//i.test(h)) return { channelId: h.split('/')[1] || clean(channelId) };
  return { handle: h };
}

function secondsToIsoDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const body = `${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s ? `${s}S` : ''}`;
  return `PT${body || '0S'}`;
}

const GROUP_KIND = { videos: 'video', shorts: 'short', lives: 'live' };

function toV3SearchItems(data = {}) {
  const items = [];
  for (const [group, kind] of Object.entries(GROUP_KIND)) {
    for (const entry of data[group] || []) {
      if (!entry?.id || !entry?.channel?.id) continue;
      items.push({
        id: { videoId: entry.id, kind: `youtube#${kind}` },
        snippet: {
          channelId: clean(entry.channel.id),
          channelTitle: clean(entry.channel.title),
          title: clean(entry.title),
          description: clean(entry.description),
          publishedAt: clean(entry.publishedTime)
        },
        _scType: clean(entry.type) || kind
      });
    }
  }
  return items;
}

function toV3ChannelItem(data = {}) {
  return {
    id: clean(data.channelId),
    snippet: {
      title: clean(data.name),
      description: clean(data.description),
      country: clean(data.country)
    },
    statistics: {
      subscriberCount: String(Math.round(Number(data.subscriberCount) || 0)),
      videoCount: data.videoCount != null ? String(Math.round(Number(data.videoCount))) : undefined
    },
    _sc: {
      handle: clean(data.handle).replace(/^@/, ''),
      links: Array.isArray(data.links) ? data.links : [],
      email: data.email || null
    }
  };
}

function toV3VideoItems(data = {}) {
  const mapEntry = (entry, isLive) => {
    if (!entry?.id) return null;
    return {
      id: entry.id,
      snippet: {
        title: clean(entry.title),
        publishedAt: clean(entry.publishedTime),
        channelId: clean(entry.channel?.id),
        channelTitle: clean(entry.channel?.title),
        liveBroadcastContent: isLive ? 'live' : 'none'
      },
      statistics: {
        viewCount: String(Number(entry.viewCountInt) || 0),
        likeCount: entry.likeCountInt != null ? String(Number(entry.likeCountInt)) : undefined,
        commentCount: entry.commentCountInt != null ? String(Number(entry.commentCountInt)) : undefined
      },
      contentDetails: { duration: secondsToIsoDuration(entry.lengthSeconds ?? entry.lengthInSeconds) },
      _scType: clean(entry.type) || (isLive ? 'live' : 'video')
    };
  };
  return [
    ...(data.videos || []).map((e) => mapEntry(e, false)),
    ...(data.shorts || []).map((e) => mapEntry(e, false)),
    ...(data.lives || []).map((e) => mapEntry(e, true))
  ].filter(Boolean);
}

// videos.js 归一化基础结构；exposure/comments/raw 由 videos.js 补充（buildExposure 在其内部）。
function scVideoDetailToNormalized(data = {}, url = '') {
  const type = clean(data.type).toLowerCase();
  const contentType = type === 'short' || type === 'live'
    ? type
    : (/youtube\.com\/shorts\//i.test(url) ? 'short' : 'video');
  return {
    platform: 'youtube',
    platform_video_id: clean(data.id),
    kol_name: clean(data.channel?.title),
    title: clean(data.title),
    author_name: clean(data.channel?.title),
    content_type: contentType,
    published_at: clean(data.publishDate || data.publishedTime),
    metrics: {
      play_count: Number(data.viewCountInt) || 0,
      like_count: Number(data.likeCountInt) || 0,
      comment_count: Number(data.commentCountInt) || 0,
      collect_count: 0,
      share_count: null
    }
  };
}

function scCommentsToNormalized(data = {}, limit = 100) {
  return (Array.isArray(data.comments) ? data.comments : []).slice(0, limit).map((comment) => ({
    id: clean(comment.id),
    parent_id: null,
    user_name: clean(comment.author?.name),
    content: clean(comment.content),
    like_count: Number(comment.engagement?.likes) || 0,
    commented_at: clean(comment.publishedTime),
    raw: comment
  }));
}

module.exports = {
  buildYoutubeSearchUrl,
  buildYoutubeChannelUrl,
  buildYoutubeChannelVideosUrl,
  buildYoutubeVideoUrl,
  buildYoutubeCommentsUrl,
  normalizeScHandle,
  secondsToIsoDuration,
  toV3SearchItems,
  toV3ChannelItem,
  toV3VideoItems,
  scVideoDetailToNormalized,
  scCommentsToNormalized
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx node --test utils/scrapecreatorsYoutubeSearch.test.js`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add server/utils/scrapecreatorsYoutubeSearch.js server/utils/scrapecreatorsYoutubeSearch.test.js
git commit -m "feat(youtube): add ScrapeCreators response mapping utils"
```

---

### Task 2: SC YouTube HTTP 服务层

**Files:**
- Create: `server/services/scrapecreatorsYoutube.js`
- Test: `server/services/scrapecreatorsYoutube.test.js`

**Interfaces:**
- Consumes: Task 1 的 URL builders；`aiClient` 的 `getSetting / providerKey / legacyKeysFor`。
- Produces:
  - `getYoutubeScrapeCreatorsSetting() -> Promise<setting|null>`（按 Global Constraints 的 key 顺序）
  - `fetchScJson(url, setting) -> Promise<object>`（超时/重试/402/401 语义）
  - `search(setting, query, continuationToken = '') / channel(setting, identity) / channelVideos(setting, identity) / video(setting, url) / videoComments(setting, url, continuationToken = '') -> Promise<object>`（SC 原始 JSON）

- [ ] **Step 1: 写失败测试**

创建 `server/services/scrapecreatorsYoutube.test.js`（不依赖 DB，stub `globalThis.fetch`）：

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchScJson } = require('./scrapecreatorsYoutube');

const SETTING = { api_key: 'k', base_url: 'https://api.scrapecreators.com' };

function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

test('未配置 key 时直接报错', async () => {
  await assert.rejects(() => fetchScJson('https://x.test/v1/youtube/search', null), /未配置/);
});

test('402 报额度耗尽且不重试', async () => {
  let calls = 0;
  const restore = stubFetch(async () => { calls += 1; return { status: 402, json: async () => ({}) }; });
  await assert.rejects(() => fetchScJson('https://x.test/v1/youtube/search', SETTING), /额度耗尽/);
  assert.equal(calls, 1);
  restore();
});

test('401 报 key 无效且不重试', async () => {
  let calls = 0;
  const restore = stubFetch(async () => { calls += 1; return { status: 401, json: async () => ({}) }; });
  await assert.rejects(() => fetchScJson('https://x.test/v1/youtube/search', SETTING), /无效|未配置/);
  assert.equal(calls, 1);
  restore();
});

test('500 重试 2 次后抛出 HTTP 错误', async () => {
  let calls = 0;
  const restore = stubFetch(async () => { calls += 1; return { status: 500, json: async () => ({ message: 'boom' }) }; });
  await assert.rejects(() => fetchScJson('https://x.test/v1/youtube/search', SETTING), /HTTP 500/);
  assert.equal(calls, 3);
  restore();
});

test('首次 500 后 200 成功返回', async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    return calls === 1
      ? { status: 500, json: async () => ({}) }
      : { status: 200, json: async () => ({ success: true }) };
  });
  const data = await fetchScJson('https://x.test/v1/youtube/search', SETTING);
  assert.equal(data.success, true);
  assert.equal(calls, 2);
  restore();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx node --test services/scrapecreatorsYoutube.test.js`
Expected: FAIL（`Cannot find module './scrapecreatorsYoutube'`）

- [ ] **Step 3: 实现服务模块**

创建 `server/services/scrapecreatorsYoutube.js`：

```js
// ScrapeCreators YouTube HTTP 服务层：配置解析 + 超时/重试 + 端点封装。
// 纯映射见 utils/scrapecreatorsYoutubeSearch.js。
const { getSetting, providerKey, legacyKeysFor } = require('./aiClient');
const {
  buildYoutubeSearchUrl,
  buildYoutubeChannelUrl,
  buildYoutubeChannelVideosUrl,
  buildYoutubeVideoUrl,
  buildYoutubeCommentsUrl
} = require('../utils/scrapecreatorsYoutubeSearch');

const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;

// key 读取顺序：youtube.scrapecreators → legacy scrapecreators → instagram/tiktok 共享 key
async function getYoutubeScrapeCreatorsSetting() {
  const direct = await getSetting(providerKey('youtube', 'scrapecreators'), legacyKeysFor('youtube', 'scrapecreators'));
  if (direct?.api_key) return direct;
  for (const scope of ['instagram', 'tiktok']) {
    const shared = await getSetting(providerKey(scope, 'scrapecreators'), legacyKeysFor(scope, 'scrapecreators'));
    if (shared?.api_key) return shared;
  }
  return direct || null;
}

async function fetchScJson(url, setting) {
  if (!setting?.api_key) {
    throw new Error('ScrapeCreators API Key 未配置（youtube/instagram/tiktok.scrapecreators 均无可用 key）');
  }
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'x-api-key': setting.api_key }, signal: ctrl.signal });
      const data = await res.json().catch(() => ({}));
      if (res.status === 402) throw Object.assign(new Error('ScrapeCreators 额度耗尽（402），请充值后重试'), { noRetry: true });
      if (res.status === 401) throw Object.assign(new Error('ScrapeCreators API Key 无效或未配置（401）'), { noRetry: true });
      if (!res.ok) throw new Error(`ScrapeCreators HTTP ${res.status}${data.message || data.error ? `: ${data.message || data.error}` : ''}`);
      return data;
    } catch (error) {
      lastError = error;
      if (error.noRetry || attempt >= MAX_RETRIES) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * 4 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError?.name === 'AbortError') throw new Error('ScrapeCreators 请求超时（30s）');
  throw lastError;
}

async function search(setting, query, continuationToken = '') {
  return fetchScJson(buildYoutubeSearchUrl(setting.base_url, query, continuationToken), setting);
}

async function channel(setting, identity) {
  return fetchScJson(buildYoutubeChannelUrl(setting.base_url, identity), setting);
}

async function channelVideos(setting, identity) {
  return fetchScJson(buildYoutubeChannelVideosUrl(setting.base_url, identity), setting);
}

async function video(setting, url) {
  return fetchScJson(buildYoutubeVideoUrl(setting.base_url, url), setting);
}

async function videoComments(setting, url, continuationToken = '') {
  return fetchScJson(buildYoutubeCommentsUrl(setting.base_url, url, continuationToken), setting);
}

module.exports = {
  REQUEST_TIMEOUT_MS,
  getYoutubeScrapeCreatorsSetting,
  fetchScJson,
  search,
  channel,
  channelVideos,
  video,
  videoComments
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx node --test services/scrapecreatorsYoutube.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 线上实测补齐两个未验证点（结果写回 spec）**

用项目试跑脚本的 key 读取方式跑一次真实调用（参照 `scripts/_sc_probe.cjs` 的 key 获取，绝不打印 key）：

```bash
cd server && node -e "
const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'kol_user', password: 'kol_password', database: 'kol_campaign_os' });
  const [rows] = await conn.query(\"SELECT api_key FROM api_settings WHERE provider LIKE '%scrapecreators%' AND api_key IS NOT NULL AND api_key <> '' LIMIT 1\");
  await conn.end();
  const key = rows[0].api_key;
  const h = { 'x-api-key': key };
  const j = async (u) => (await fetch(u, { headers: h })).json();
  // 1) channel-videos 翻页
  const p1 = await j('https://api.scrapecreators.com/v1/youtube/channel-videos?handle=mrbeast&includeExtras=true');
  console.log('channel-videos videos:', (p1.videos||[]).length, 'continuationToken:', Boolean(p1.continuationToken));
  if (p1.continuationToken) {
    const p2 = await j('https://api.scrapecreators.com/v1/youtube/channel-videos?handle=mrbeast&includeExtras=true&continuationToken=' + encodeURIComponent(p1.continuationToken));
    console.log('page2 videos:', (p2.videos||[]).length, 'page2 first id differs:', (p2.videos||[])[0]?.id !== (p1.videos||[])[0]?.id);
  }
  // 2) comments 单页条数
  const c = await j('https://api.scrapecreators.com/v1/youtube/video/comments?url=' + encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
  console.log('comments per page:', (c.comments||[]).length, 'has continuation:', Boolean(c.continuationToken));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
"
```

Expected: 输出三个实测值。把结果追加到 `docs/superpowers/specs/2026-08-04-scrapecreators-youtube-provider-design.md` 第 1 节"待实施期实测确认的点"下方（如实记录，翻页不可用时 Task 5 按"最多取最近 30 条"降级）。

- [ ] **Step 6: Commit**

```bash
git add server/services/scrapecreatorsYoutube.js server/services/scrapecreatorsYoutube.test.js docs/superpowers/specs/2026-08-04-scrapecreators-youtube-provider-design.md
git commit -m "feat(youtube): add ScrapeCreators HTTP service layer"
```

---

### Task 3: videos.js 视频详情 + 评论适配

**Files:**
- Modify: `server/routes/videos.js`（`fetchWithProvider` :421、`fetchVideoData` :480 附近、文件头部 require 区）
- Test: `server/routes/videosScrapeCreators.test.js`（新建，node:test，stub `globalThis.fetch`，不需要 app/DB）

**Interfaces:**
- Consumes: Task 2 的 `search/channel/video/videoComments/getYoutubeScrapeCreatorsSetting`；Task 1 的 `scVideoDetailToNormalized / scCommentsToNormalized`；videos.js 现有 `parseYouTubeVideoId / buildExposure / normalizeCount`。
- Produces: `fetchYouTubeScrapeCreators(url, setting)` — 返回与 `normalizeYouTubeItem` 相同结构 + `raw`；`fetchWithProvider` 新增 youtube+scrapecreators 分支（Task 4 不依赖本 Task，可并行）。

- [ ] **Step 1: 写失败测试**

创建 `server/routes/videosScrapeCreators.test.js`：

```js
const assert = require('node:assert/strict');
const test = require('node:test');

// fetchWithProvider 不导出，通过 rewire 方式不可行；直接 stub fetch 后 require 被测模块内部函数。
// videos.js 只导出 router，因此这里经由模块导出补充（见 Step 3 的 module.exports 追加）。
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx node --test routes/videosScrapeCreators.test.js`
Expected: FAIL（`fetchYouTubeScrapeCreators` 未导出 / is not a function）

- [ ] **Step 3: 实现 videos.js 改动**

3a. 文件头部 require 区（`} = require('../services/aiClient');` 之后）追加：

```js
const scYoutube = require('../services/scrapecreatorsYoutube');
const { scVideoDetailToNormalized, scCommentsToNormalized } = require('../utils/scrapecreatorsYoutubeSearch');
```

3b. 在 `fetchYouTubeMaton` 之后新增：

```js
async function fetchYouTubeScrapeCreators(url, setting) {
  if (!setting?.api_key) throw new Error('ScrapeCreators API Key 未配置');

  const videoId = parseYouTubeVideoId(url);
  if (!videoId) throw new Error('无法识别 YouTube 视频 ID');

  const data = await scYoutube.video(setting, url);
  if (!data || !data.id) throw new Error('ScrapeCreators 未返回该 YouTube 视频数据');

  const normalized = scVideoDetailToNormalized(data, url);
  normalized.platform_video_id = normalized.platform_video_id || videoId;
  normalized.exposure = buildExposure('youtube', normalized.content_type, normalized.metrics);
  try {
    const commentsData = await scYoutube.videoComments(setting, url);
    normalized.comments = scCommentsToNormalized(commentsData, 100);
  } catch (error) {
    normalized.comments = [];
  }
  normalized.raw = data;
  return normalized;
}
```

3c. `fetchWithProvider`（videos.js:421）在 maton_gateway 分支后加一行：

```js
  if (platform === 'youtube' && provider === 'scrapecreators') return fetchYouTubeScrapeCreators(url, setting);
```

3d. `fetchVideoData` 的 provider 循环中，youtube+scrapecreators 允许复用 IG/TikTok 共享 key。把 videos.js:480 附近的：

```js
    const key = providerKey(platform, provider);
    const setting = await getSetting(key, legacyKeysFor(platform, provider));
```

改为：

```js
    const key = providerKey(platform, provider);
    const setting = platform === 'youtube' && provider === 'scrapecreators'
      ? await scYoutube.getYoutubeScrapeCreatorsSetting()
      : await getSetting(key, legacyKeysFor(platform, provider));
```

3e. 文件末尾导出（供单测；router 导出保持不变）：

```js
module.exports.fetchYouTubeScrapeCreators = fetchYouTubeScrapeCreators;
```

（若文件末尾是 `module.exports = router;`，改为：

```js
module.exports = router;
module.exports.fetchYouTubeScrapeCreators = fetchYouTubeScrapeCreators;
```

）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx node --test routes/videosScrapeCreators.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 回归 videos 相关测试 + Commit**

Run: `cd server && npm test`
Expected: 全部 PASS（无回归）

```bash
git add server/routes/videos.js server/routes/videosScrapeCreators.test.js
git commit -m "feat(youtube): fetch video detail and comments via ScrapeCreators"
```

---

### Task 4: Finder 发现适配器 + 主备切换

**Files:**
- Modify: `server/routes/finderTasks.js`（常量区 :31-33、`runProvider` :2165-2220、文件末尾 exports :3392-3401、头部 require 区）
- Test: `server/routes/finderScrapeCreatorsYoutube.test.js`（新建）

**Interfaces:**
- Consumes: Task 2 的 `getYoutubeScrapeCreatorsSetting / search / channel / channelVideos`；Task 1 的 `toV3SearchItems / toV3ChannelItem / toV3VideoItems`；finderTasks.js 内部现成的 `rankedKeywordQueries / finderScanLimit / youtubePreflightConfig / evaluateYoutubePreflight / looksLikeExcludedYoutubeAccount / youtubeChannelIdentity / youtubeItemsToCandidates / loadYoutubeExclusionSet / isExcludedYoutubeCreator / getCachedPlatformSearch / savePlatformSearchCache / appendProviderErrorAttempts / providerErrorWithAttempts / keywordQueries`（均保持原签名）；`aiClient.getSelection`。
- Produces: `youtubeScrapeCreatorsAdapter(request)` — 返回 `{provider:'scrapecreators_youtube', endpoint, candidates, preflight_rejected, scanned_channel_count, target_qualified_count, max_scanned_channels, external_request_count, cache_hit_count}`；常量 `SC_FINDER_REQUEST_BUDGET = 200`；runProvider 的 youtube fallback 链（maton 失败 → 按 `provider_selection.platforms.youtube.fallbacks` 顺序尝试 scrapecreators / google_official，无 selection 时维持原 google 兜底）。

- [ ] **Step 1: 写失败测试**

创建 `server/routes/finderScrapeCreatorsYoutube.test.js`。adapter 内部依赖 `getCachedPlatformSearch`（DB）与 `loadYoutubeExclusionSet`（DB），因此用 `node --test` + 真实 test DB（复用 `finderTasks.test.js` 的 resetTestDatabase 模式），fetch 全部 stub：

```js
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

test('adapter 产出契约结构并通过 preflight 过滤低播放频道', async () => {
  await resetTestDatabase();
  await dbOperations.run(
    "INSERT INTO api_settings (provider, api_key, created_at, updated_at) VALUES ('youtube.scrapecreators', 'test-key', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
  );
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('/v1/youtube/search')) return { status: 200, json: async () => scSearchResponse('UCgood', 'Good Channel') };
    if (u.includes('/v1/youtube/channel-videos')) return { status: 200, json: async () => scChannelVideosResponse([1000, 2000, 3000, 4000]) };
    if (u.includes('/v1/youtube/channel')) return { status: 200, json: async () => scChannelResponse('UCgood', 'Good Channel', 50000, 'United States') };
    if (u.includes('feeds/videos.xml')) return { ok: false, status: 404, text: async () => '' };
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
  assert.equal(c.country_region, 'United States');
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
    if (u.includes('feeds/videos.xml')) return { ok: false, status: 404, text: async () => '' };
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
```

注意：`api_settings` 表结构若与 INSERT 列不匹配（如缺 `provider` 唯一键外的必填列），按 `server/routes/settings.test.js` 中现有的 api_settings 插入方式调整。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx node --test routes/finderScrapeCreatorsYoutube.test.js`
Expected: FAIL（`youtubeScrapeCreatorsAdapter` 未导出）

- [ ] **Step 3: 实现 finderTasks.js 改动**

3a. 头部 require 区追加（`} = require('../services/aiClient');` 之后）：

```js
const scYoutube = require('../services/scrapecreatorsYoutube');
const scYt = require('../utils/scrapecreatorsYoutubeSearch');
```

3b. 常量区（:31-33 附近）追加：

```js
const SC_FINDER_REQUEST_BUDGET = 200;
```

3c. 在 `youtubeMatonGatewayAdapter` 之后新增 SC 台账函数与适配器：

```js
async function recordScYoutubeQueryLedger({ taskId, query, pageToken, cacheHit, returned, excluded, newChannels, requestCost, status = 'success', error = '' }) {
  await dbOperations.run(
    `INSERT INTO finder_query_ledger
     (finder_task_id, provider, platform, query_text, query_hash, page_token, cache_hit,
      returned_count, excluded_count, new_channel_count, request_cost, status, error_message, created_at)
     VALUES (?, 'scrapecreators_youtube', 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [taskId || null, clean(query), finderQueryHash(query), clean(pageToken), cacheHit ? 1 : 0,
      Number(returned || 0), Number(excluded || 0), Number(newChannels || 0), Number(requestCost || 0), status, clean(error)]
  );
}

async function youtubeScrapeCreatorsAdapter(request) {
  const setting = await scYoutube.getYoutubeScrapeCreatorsSetting();
  if (!setting?.api_key) throw new Error('ScrapeCreators API Key 未配置');
  const targetQualifiedCount = Math.max(1, Math.min(Number(request.limit || 10), 50));
  const maxScannedChannels = finderScanLimit(request, targetQualifiedCount);
  const candidates = [];
  const exclusions = await loadYoutubeExclusionSet();
  const seenChannelIds = new Set();
  const maxSearchPages = Math.max(2, Math.min(20, Math.ceil(maxScannedChannels / 5) * 3));
  let searchedPages = 0;
  let externalRequestCount = 0;
  let cacheHitCount = 0;
  let lastEndpoint = '';
  for (const query of await rankedKeywordQueries(request)) {
    let continuationToken = '';
    do {
      const remaining = maxScannedChannels - candidates.length;
      if (remaining <= 0 || searchedPages >= maxSearchPages || externalRequestCount >= SC_FINDER_REQUEST_BUDGET) break;
      lastEndpoint = scYt.buildYoutubeSearchUrl(setting.base_url, query, continuationToken);
      const currentToken = continuationToken;
      let searchData = await getCachedPlatformSearch('scrapecreators', 'youtube', query, currentToken);
      let searchRequestCost = 0;
      if (searchData) {
        cacheHitCount += 1;
      } else {
        try {
          searchData = await scYoutube.search(setting, query, currentToken);
          externalRequestCount += 1;
          searchRequestCost = 1;
          await savePlatformSearchCache('scrapecreators', 'youtube', query, searchData, currentToken);
        } catch (error) {
          await recordScYoutubeQueryLedger({
            taskId: request.finder_task_id, query, pageToken: currentToken, cacheHit: false,
            requestCost: 1, status: 'failed', error: error.message
          });
          throw error;
        }
      }
      searchedPages += 1;
      continuationToken = clean(searchData.continuationToken);
      const returnedItems = scYt.toV3SearchItems(searchData);
      const items = returnedItems.filter((item) => {
        const channelId = clean(item.snippet?.channelId);
        if (!channelId || seenChannelIds.has(channelId.toLowerCase())) return false;
        seenChannelIds.add(channelId.toLowerCase());
        return !isExcludedYoutubeCreator(exclusions, channelId, item.snippet?.channelTitle);
      }).slice(0, remaining);
      // SC 无批量频道查询：每频道 1 次调用；单频道失败不阻断（留空 channel，由 gate 处理）
      const channels = {};
      let channelRequestCost = 0;
      for (const item of items) {
        if (externalRequestCount >= SC_FINDER_REQUEST_BUDGET) break;
        const channelId = item.snippet.channelId;
        try {
          const channelData = await scYoutube.channel(setting, { channelId });
          externalRequestCount += 1;
          channelRequestCost += 1;
          channels[channelId] = scYt.toV3ChannelItem(channelData);
        } catch (error) {
          // 单个频道富化失败不阻断整批
        }
      }
      candidates.push(...youtubeItemsToCandidates(items, channels, { ...request, discovery: { ...request.discovery, keywords: query } }, `Matched ScrapeCreators YouTube search: ${query}`));
      await recordScYoutubeQueryLedger({
        taskId: request.finder_task_id,
        query,
        pageToken: currentToken,
        cacheHit: Boolean(searchData && searchRequestCost === 0),
        returned: returnedItems.length,
        excluded: returnedItems.length - items.length,
        newChannels: items.length,
        requestCost: searchRequestCost + channelRequestCost
      });
    } while (continuationToken && candidates.length < maxScannedChannels && searchedPages < maxSearchPages);
    if (candidates.length >= maxScannedChannels || searchedPages >= maxSearchPages || externalRequestCount >= SC_FINDER_REQUEST_BUDGET) break;
  }
  if (!candidates.length) throw new Error('ScrapeCreators 已连通，但 YouTube 搜索返回 0 条候选；请检查 Finder 策略关键词或改用更短的策略词。');
  const preflight = await preflightScYoutubeCandidates(
    candidates.slice(0, maxScannedChannels),
    request,
    setting,
    Math.max(0, SC_FINDER_REQUEST_BUDGET - externalRequestCount)
  );
  externalRequestCount += preflight.requestCount;
  return {
    provider: 'scrapecreators_youtube',
    endpoint: lastEndpoint,
    candidates: preflight.candidates.slice(0, targetQualifiedCount),
    preflight_rejected: preflight.rejected,
    scanned_channel_count: candidates.length,
    target_qualified_count: targetQualifiedCount,
    max_scanned_channels: maxScannedChannels,
    external_request_count: externalRequestCount,
    cache_hit_count: cacheHitCount
  };
}

// SC 版 preflight：channel-videos 一次调用取齐近 ~30 条（含时长/播放/发布时间），
// 阈值判定复用 evaluateYoutubePreflight（v3 形状由 toV3VideoItems 提供）。
async function preflightScYoutubeCandidates(candidates, request, setting, requestBudget) {
  const config = youtubePreflightConfig(request);
  if (!config.enabled || !candidates.length) return { candidates, rejected: [], requestCount: 0 };
  let requestCount = 0;
  const passed = [];
  const rejected = [];
  for (const candidate of candidates) {
    const country = clean(candidate.country_region || candidate.raw_data?.channel?.snippet?.country).toUpperCase();
    const marketBlocked = (config.targetMarket.includes('united states') || config.targetMarket === 'us') && country && country !== 'US';
    if (marketBlocked || looksLikeExcludedYoutubeAccount(candidate, config)) {
      rejected.push({
        kol_name: candidate.kol_name,
        profile_url: candidate.profile_url,
        passed: false,
        reason: marketBlocked ? 'market_mismatch' : 'strategy_excluded_account',
        country
      });
      continue;
    }
    let videos = [];
    const channelId = youtubeChannelIdentity(candidate.profile_url).channelId;
    if (requestCount < requestBudget && channelId) {
      try {
        const data = await scYoutube.channelVideos(setting, { channelId });
        requestCount += 1;
        videos = scYt.toV3VideoItems(data);
      } catch (error) {
        videos = [];
      }
    }
    const result = evaluateYoutubePreflight(candidate, videos, config);
    const enriched = {
      ...candidate,
      avg_views: result.medianViews ? String(Math.round(result.medianViews)) : candidate.avg_views,
      raw_data: { ...(candidate.raw_data || {}), preflight: result }
    };
    if (result.passed) passed.push(enriched);
    else rejected.push({ kol_name: candidate.kol_name, profile_url: candidate.profile_url, ...result });
  }
  return { candidates: passed, rejected, requestCount };
}
```

3d. `runProvider`（:2165）的 youtube fallback 改为按 selection 顺序的链式尝试。把 :2203-2219 的整个第二个 try 块替换为：

```js
  // youtube fallback：按 provider_selection.platforms.youtube.fallbacks 顺序尝试
  // scrapecreators / google_official；无 selection 时保持原有 google 兜底。
  // 非 youtube 平台保持原 scrapeCreatorsFinderAdapterV2 兜底。
  if (request.target_platform === 'youtube') {
    const selection = await getSelection();
    const order = (selection.platforms?.youtube?.fallbacks || [])
      .filter((p) => ['scrapecreators', 'google_official'].includes(p));
    if (!order.includes('google_official')) order.push('google_official');
    let lastError = null;
    for (const provider of order) {
      try {
        const fallback = provider === 'scrapecreators'
          ? await youtubeScrapeCreatorsAdapter({ ...request, search_source: 'scrapecreators_youtube' })
          : await youtubeSearchAdapter({ ...request, search_source: 'youtube_search' });
        attempts.push(...(fallback.attempts || []));
        attempts.push({ search_source: fallback.provider, provider: fallback.provider, ok: true, endpoint: fallback.endpoint });
        return { ...fallback, attempts };
      } catch (error) {
        lastError = error;
        appendProviderErrorAttempts(attempts, error, {
          search_source: provider === 'scrapecreators' ? 'scrapecreators_youtube' : 'youtube_search',
          provider
        });
      }
    }
    throw providerErrorWithAttempts(lastError || new Error('YouTube 全部数据源均失败'), attempts);
  }

  try {
    const fallback = await scrapeCreatorsFinderAdapterV2({
      ...request,
      search_source: request.target_platform === 'instagram' ? 'instagram_search' : 'tiktok_search'
    });
    attempts.push(...(fallback.attempts || []));
    attempts.push({ search_source: fallback.provider, provider: fallback.provider, ok: true, endpoint: fallback.endpoint });
    return { ...fallback, attempts };
  } catch (error) {
    appendProviderErrorAttempts(attempts, error, {
      search_source: `${request.target_platform}_search`,
      provider: 'scrapecreators'
    });
    throw providerErrorWithAttempts(error, attempts);
  }
```

（注意保持外层的 `if (!allowFallback || source !== 'maton_agent' || externalAgentRoute) throw ...` 逻辑不变；上面的代码只替换原第二个 try 块。）

3e. 文件末尾 exports 追加：

```js
module.exports.youtubeScrapeCreatorsAdapter = youtubeScrapeCreatorsAdapter;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx node --test routes/finderScrapeCreatorsYoutube.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 全量回归 + Commit**

Run: `cd server && npm test`
Expected: 全部 PASS（重点确认 finderTasks.test.js 无回归——runProvider 非 youtube 分支与 youtube 默认 google 兜底行为未变）

```bash
git add server/routes/finderTasks.js server/routes/finderScrapeCreatorsYoutube.test.js
git commit -m "feat(finder): add ScrapeCreators YouTube discovery adapter with median-views preflight"
```

---

### Task 5: Intake 快照 SC 分支

**Files:**
- Modify: `server/services/youtubeIntakeSnapshot.js`（`youtubeConfig` :30-47、`runYoutubeIntakeSnapshot` :62-189 的取数段）
- Test: `server/services/youtubeIntakeSnapshot.test.js`（追加纯函数测试）

**Interfaces:**
- Consumes: Task 2 的 `getYoutubeScrapeCreatorsSetting / video / channel / channelVideos`；Task 1 的 `toV3ChannelItem / toV3VideoItems`。
- Produces: `scIdentityFromLookup(lookup) -> {channelId}|{handle}`（导出供测试）；`youtubeConfig()` 返回联合类型 `{mode:'v3', endpoint, options} | {mode:'scrapecreators', setting}`；`runYoutubeIntakeSnapshot` 行为不变（v3 路径零改动）。

- [ ] **Step 1: 写失败测试**

在 `server/services/youtubeIntakeSnapshot.test.js` 末尾追加：

```js
const { scIdentityFromLookup } = require('./youtubeIntakeSnapshot');

test('scIdentityFromLookup 把 v3 lookup 映射为 SC identity', () => {
  assert.deepEqual(scIdentityFromLookup({ id: 'UC1' }), { channelId: 'UC1' });
  assert.deepEqual(scIdentityFromLookup({ forHandle: 'mrbeast' }), { handle: 'mrbeast' });
  assert.deepEqual(scIdentityFromLookup({ forUsername: 'olduser' }), { handle: 'olduser' });
  assert.throws(() => scIdentityFromLookup({ videoId: 'abc' }));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx node --test services/youtubeIntakeSnapshot.test.js`
Expected: FAIL（`scIdentityFromLookup` 未导出）

- [ ] **Step 3: 实现快照 SC 分支**

3a. 文件顶部 require 之后、常量区追加：

```js
const scYoutube = require('./scrapecreatorsYoutube');
const { toV3ChannelItem, toV3VideoItems } = require('../utils/scrapecreatorsYoutubeSearch');

function scIdentityFromLookup(lookup = {}) {
  if (lookup.id) return { channelId: lookup.id };
  if (lookup.forHandle) return { handle: lookup.forHandle };
  if (lookup.forUsername) return { handle: lookup.forUsername };
  throw new Error('ScrapeCreators 快照需要频道 ID 或 Handle（视频链接请先解析为频道）');
}
```

3b. `youtubeConfig`（:30-47）改为：google 与 maton 分支返回值各加 `mode: 'v3'`；maton 缺失时不再直接 throw，改为尝试 SC：

```js
async function youtubeConfig() {
  const google = await dbOperations.get('SELECT api_key, base_url, extra_config FROM api_settings WHERE provider = ?', [GOOGLE_PROVIDER]);
  if (google?.api_key) {
    return {
      mode: 'v3',
      endpoint(path, params) { return `${String(google.base_url || 'https://www.googleapis.com').replace(/\/$/, '')}/youtube/v3/${path}?${params}&key=${encodeURIComponent(google.api_key)}`; },
      options: {}
    };
  }
  const maton = await dbOperations.get('SELECT api_key, base_url, extra_config FROM api_settings WHERE provider = ?', [MATON_PROVIDER]);
  if (maton?.api_key) {
    const extra = parseJson(maton.extra_config);
    const headers = { Authorization: `Bearer ${maton.api_key}` };
    if (extra.connection_id) headers['Maton-Connection'] = extra.connection_id;
    return {
      mode: 'v3',
      endpoint(path, params) { return `${String(maton.base_url || 'https://api.maton.ai').replace(/\/$/, '')}/youtube/youtube/v3/${path}?${params}`; },
      options: { headers }
    };
  }
  const scSetting = await scYoutube.getYoutubeScrapeCreatorsSetting();
  if (scSetting?.api_key) return { mode: 'scrapecreators', setting: scSetting };
  throw new Error('Google Official / Maton Gateway / ScrapeCreators 均未配置');
}
```

3c. `runYoutubeIntakeSnapshot` 取数段（:79-126，从 `let lookup = channelLookup(profileUrl);` 到 `const videosData = { items: videoItems };`）替换为：

```js
    let channel;
    let videoItems;
    if (config.mode === 'scrapecreators') {
      let lookup = channelLookup(profileUrl);
      if (lookup.videoId) {
        const videoData = await scYoutube.video(config.setting, profileUrl);
        const channelId = videoData.channel?.id;
        if (!channelId) throw new Error('无法从 YouTube 视频链接识别所属频道');
        lookup = { id: channelId };
      }
      const identity = scIdentityFromLookup(lookup);
      const channelData = await scYoutube.channel(config.setting, identity);
      channel = toV3ChannelItem(channelData);
      if (!channel.id) throw new Error('YouTube 未找到对应频道');
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const videosData = await scYoutube.channelVideos(config.setting, identity);
      // SC channel-videos 单页 ~30 条；30 天窗口超出部分按"最多取最近 30 条"降级
      videoItems = toV3VideoItems(videosData).filter((item) => {
        const published = new Date(item.snippet.publishedAt || 0).getTime();
        return published >= cutoff;
      });
    } else {
      let lookup = channelLookup(profileUrl);
      if (lookup.videoId) {
        const videoData = await fetchJson(
          config.endpoint('videos', `part=snippet&id=${encodeURIComponent(lookup.videoId)}`),
          config.options
        );
        const channelId = videoData.items?.[0]?.snippet?.channelId;
        if (!channelId) throw new Error('无法从 YouTube 视频链接识别所属频道');
        lookup = { id: channelId };
      }
      const lookupParam = Object.entries(lookup).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
      const channelData = await fetchJson(config.endpoint('channels', `part=contentDetails,statistics&${lookupParam}`), config.options);
      channel = channelData.items?.[0];
      if (!channel) throw new Error('YouTube 未找到对应频道');
      const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) throw new Error('YouTube 频道没有 uploads 播放列表');

      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const playlistItems = [];
      let pageToken = '';
      for (let page = 0; page < 10; page += 1) {
        const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
        const playlistData = await fetchJson(
          config.endpoint('playlistItems', `part=snippet,contentDetails&playlistId=${encodeURIComponent(uploads)}&maxResults=50${tokenParam}`),
          config.options
        );
        const items = playlistData.items || [];
        playlistItems.push(...items);
        const reachedCutoff = items.some((item) => {
          const publishedAt = item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt;
          return publishedAt && new Date(publishedAt).getTime() < cutoff;
        });
        pageToken = playlistData.nextPageToken || '';
        if (reachedCutoff || !pageToken) break;
      }
      const recent = playlistItems.filter((item) => new Date(item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt).getTime() >= cutoff);
      const ids = recent.map((item) => item.contentDetails?.videoId).filter(Boolean);
      // videos.list accepts at most 50 ids per call; chunk to avoid invalidFilters on busy channels.
      videoItems = [];
      for (let offset = 0; offset < ids.length; offset += 50) {
        const chunk = ids.slice(offset, offset + 50);
        const chunkData = await fetchJson(
          config.endpoint('videos', `part=snippet,statistics,contentDetails,liveStreamingDetails&id=${encodeURIComponent(chunk.join(','))}`),
          config.options
        );
        videoItems.push(...(chunkData.items || []));
      }
    }
    const videosData = { items: videoItems };
```

其后的 `videos` 映射（:128 起，`durationSeconds(item.contentDetails?.duration)`、`liveBroadcastContent` 判断）与 DB 写入段**保持不变**——`toV3VideoItems` 产出的 v3 形状直接兼容。

3d. 文件末尾导出追加：

```js
module.exports = { runYoutubeIntakeSnapshot, durationSeconds, median, scIdentityFromLookup };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx node --test services/youtubeIntakeSnapshot.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 全量回归 + Commit**

Run: `cd server && npm test`
Expected: 全部 PASS

```bash
git add server/services/youtubeIntakeSnapshot.js server/services/youtubeIntakeSnapshot.test.js
git commit -m "feat(youtube): support ScrapeCreators in 30d intake snapshot"
```

---

### Task 6: 设置页转正 + 端到端验证

**Files:**
- Modify: `client/src/pages/settings/settingsContract.js:27`
- Test: `client/src/pages/settings/settingsContract.test.js`、`client/src/pages/Settings.test.js`（按实际断言更新）

**Interfaces:**
- Consumes: 无（前置 Task 均独立）。
- Produces: youtube 的 `scrapecreators` provider 定义从 `{ reserved: true }` 变为默认 fields `['api_key', 'base_url']`、required `['api_key']` 的正式 provider。

- [ ] **Step 1: settingsContract.js:27 修改**

把：

```js
      provider('scrapecreators', 'ScrapeCreators', { reserved: true }),
```

改为：

```js
      provider('scrapecreators', 'ScrapeCreators'),
```

（仅 youtube 段这一处；instagram/tiktok 段本就不是 reserved，brightdata/custom 保持 reserved。）

- [ ] **Step 2: 跑 client 测试，按失败断言更新**

Run: `cd client && CI=true npx react-scripts test --watchAll=false`
Expected: 若有测试断言"youtube scrapecreators 为 reserved / 不可见"，更新为正式 provider 的断言（可见、可配置、字段为 api_key+base_url）。`settingsContract.test.js:28-39` 的 reserved fixture 测试用的是虚构 `browseract`，不受影响。

- [ ] **Step 3: 端到端手动验证（真实服务 + 真实 key）**

```bash
# 1. 启动服务后确认配置状态
curl -s http://localhost:5001/api/health
# 2. 在设置页 YouTube 标签把 ScrapeCreators 加为 fallback 并启用 fallback 策略（或直接用 scripts/_agent_http.js 调 /api/settings）
# 3. 健康检查应显示 youtube fallbacks scrapecreators configured: true
cd scripts && MSYS_NO_PATHCONV=1 node _agent_http.js GET /api/settings/health/config
# 4. 视频详情：抓一条 YouTube 视频（主源 maton 正常时走 maton；把主源临时切为 scrapecreators 验证 SC 路径）
# 5. 快照：对一个已入库 YouTube KOL 触发 30 天快照刷新，确认 youtube_median_views_30d 更新
# 6. Finder：用 TMB-1404 策略（strategy #8）跑一个 limit=3 的 youtube finder task，主源断开（或直接把 scrapecreators 设为 primary）验证 SC 发现链路产出候选
```

验证要点逐项核对：① 详情返回结构含 metrics/exposure/comments；② 快照聚合值与 SC 数据一致；③ finder 候选含 `raw_data.preflight` 且 `provider: scrapecreators_youtube`；④ 台账 `finder_query_ledger` 有 scrapecreators_youtube 记录。

- [ ] **Step 4: 更新 AGENTS.md / spec 状态 + Commit**

若项目根或 `server/` 存在 AGENTS.md 且其中有数据源/provider 相关描述，补充一行 youtube.scrapecreators 已可用；把 spec 文档状态从"已确认"改为"已实现"。

```bash
git add client/src/pages/settings/settingsContract.js client/src/pages/settings/settingsContract.test.js client/src/pages/Settings.test.js docs/superpowers/specs/2026-08-04-scrapecreators-youtube-provider-design.md
git commit -m "feat(settings): enable ScrapeCreators as YouTube provider"
```

---

## 收尾回归清单

- [ ] `cd server && npm test` 全绿
- [ ] `cd client && CI=true npx react-scripts test --watchAll=false` 全绿
- [ ] Task 6 Step 3 的端到端验证 6 项全部通过
