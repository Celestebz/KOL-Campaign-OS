# YouTube 关联推荐扩展路线（V1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 KOL Finder 新增独立发现路线 `youtube_watch_next_expansion`：关键词产种子 → watchNextVideos 关联扩展 → 预过滤 → 复用 preflight → 选择性二跳，产出进入现有候选管道。

**Architecture:** 纯函数层（`server/utils/scrapecreatorsYoutubeSearch.js` 新增 `extractWatchNext`/`graphScore`）+ 适配器（`server/routes/finderTasks.js` 新增 `youtubeWatchNextAdapter`，复用 SC 服务层、`preflightScYoutubeCandidates`、台账、缓存、checkpoint），路由经 `createFinderTask` 可选 `searchSource` 参数暴露。

**Tech Stack:** Node.js 原生 fetch、node:test + supertest（server `npm test`）、react-scripts test（client）。无新依赖。

**设计依据:** `docs/superpowers/specs/2026-08-06-youtube-watch-next-expansion-design.md`（两轮评审修订版）。

## Global Constraints

- 不引入新 npm 依赖；产出走现有"证据导入 → AI 分析 → Raw Candidates"管道；不新增排序系统（图谱强度只写 `raw_data.graph_signal` 与 `reason`）。
- 命名统一：search_source / 返回 provider / 台账 provider 全部 `youtube_watch_next_expansion`；缓存层 `provider='scrapecreators', platform='youtube', variant='watchnext'`（page_token 存 seed video id）。
- 常量：`MAX_SEED_QUERIES=12`、`MAX_SEED_VIDEOS=12`、`MAX_WATCH_NEXT_PER_SEED=20`、`MAX_DEPTH_2_SEEDS=10`、`MAX_ENRICHED_CHANNELS=120`；预算复用 `SC_FINDER_REQUEST_BUDGET=200`。
- 时长阈值统一：`effectiveMinSeconds = 策略 minimum_video_duration_seconds（或从 required_evidence 解析）> 0 时取之，否则 181`，种子与预过滤同口径。
- 播放量预过滤门槛：`max(1000, floor(minimum_median_views × 0.25))`；viewCountInt 缺失放行。
- 顺序硬约束：先聚合推荐关系，再判"频道是否已富化"。
- 停止三级：种子批次重复率>70%（样本≥10）停当前种子；连续 20 唯一频道无合格（跨种子累计）停当前 depth；预算耗尽停全任务。
- 重跑幂等：checkpoint 键 `watch_next` = `{ expanded_seed_ids: [], enriched_channel_ids: [] }`，复用 `readTaskCheckpoint/saveTaskCheckpoint`。
- 测试命令：server 在 `server/` 下 `node --test <file>`；client 在 `client/` 下 `CI=true node node_modules/react-scripts/scripts/test.js --watchAll=false`（不要用 npx，会卡）。
- 每任务结束按步骤 commit（执行前取得用户确认）。

---

### Task 1: 纯函数 extractWatchNext + graphScore

**Files:**
- Modify: `server/utils/scrapecreatorsYoutubeSearch.js`（文件末尾 exports 前追加）
- Test: `server/utils/scrapecreatorsYoutubeSearch.test.js`（追加）

**Interfaces:**
- Produces（Task 2 依赖）:
  - `extractWatchNext(data) -> [{ id, title, views, lengthSeconds, publishedTime, channel: { id, title, handle }, videoUrl }]`（position 由调用方按下标赋）
  - `positionWeight(position) -> 20 | 12 | 5 | 0`（1 起）
  - `graphScore(positions) -> number`（纯位置权重求和，positions 为数字数组）

- [ ] **Step 1: 写失败测试**

`server/utils/scrapecreatorsYoutubeSearch.test.js` 末尾追加：

```js
const { extractWatchNext, positionWeight, graphScore } = require('./scrapecreatorsYoutubeSearch');

test('extractWatchNext 提取关联视频并兜底空值', () => {
  const out = extractWatchNext({
    watchNextVideos: [
      { id: 'a', title: 'T1', viewCountInt: 1000, lengthInSeconds: 300, publishedTime: '2026-01-01T00:00:00Z', channel: { id: 'UC1', title: 'C1', handle: 'c1' }, videoUrl: 'https://www.youtube.com/watch?v=a' },
      { id: 'b', title: 'T2', channel: { id: 'UC2' } },
      { title: 'no id' },
      { id: 'c', title: 'no channel' }
    ]
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: 'a', title: 'T1', views: 1000, lengthSeconds: 300, publishedTime: '2026-01-01T00:00:00Z', channel: { id: 'UC1', title: 'C1', handle: 'c1' }, videoUrl: 'https://www.youtube.com/watch?v=a' });
  assert.deepEqual(out[1], { id: 'b', title: 'T2', views: null, lengthSeconds: 0, publishedTime: '', channel: { id: 'UC2', title: '', handle: '' }, videoUrl: 'https://www.youtube.com/watch?v=b' });
  assert.deepEqual(extractWatchNext({}), []);
  assert.deepEqual(extractWatchNext(null), []);
});

test('positionWeight 分段', () => {
  assert.equal(positionWeight(1), 20);
  assert.equal(positionWeight(5), 20);
  assert.equal(positionWeight(6), 12);
  assert.equal(positionWeight(10), 12);
  assert.equal(positionWeight(11), 5);
  assert.equal(positionWeight(20), 5);
  assert.equal(positionWeight(21), 0);
});

test('graphScore 纯位置权重求和（不乘种子数）', () => {
  assert.equal(graphScore([3, 8]), 32);
  assert.equal(graphScore([1]), 20);
  assert.equal(graphScore([]), 0);
  assert.equal(graphScore([1, 1, 1]), 60);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test utils/scrapecreatorsYoutubeSearch.test.js`
Expected: FAIL（`extractWatchNext is not a function` 或解构 undefined）

- [ ] **Step 3: 实现**

`server/utils/scrapecreatorsYoutubeSearch.js` 的 `module.exports` 之前追加：

```js
// 关联推荐扩展（watchNextVideos）纯函数。position 由调用方按下标（1 起）赋。
function extractWatchNext(data = {}) {
  const list = Array.isArray(data?.watchNextVideos) ? data.watchNextVideos : [];
  const out = [];
  for (const entry of list) {
    if (!entry?.id || !entry?.channel?.id) continue;
    out.push({
      id: entry.id,
      title: clean(entry.title),
      views: entry.viewCountInt != null ? Number(entry.viewCountInt) : null,
      lengthSeconds: Number(entry.lengthInSeconds ?? entry.lengthSeconds) || 0,
      publishedTime: clean(entry.publishedTime),
      channel: {
        id: clean(entry.channel.id),
        title: clean(entry.channel.title),
        handle: clean(entry.channel.handle).replace(/^@/, '')
      },
      videoUrl: clean(entry.videoUrl) || `https://www.youtube.com/watch?v=${entry.id}`
    });
  }
  return out;
}

function positionWeight(position) {
  const p = Number(position) || 0;
  if (p >= 1 && p <= 5) return 20;
  if (p >= 6 && p <= 10) return 12;
  if (p >= 11 && p <= 20) return 5;
  return 0;
}

function graphScore(positions) {
  return (Array.isArray(positions) ? positions : []).reduce((sum, p) => sum + positionWeight(p), 0);
}
```

并把 `extractWatchNext, positionWeight, graphScore` 加入 `module.exports`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test utils/scrapecreatorsYoutubeSearch.test.js`
Expected: 全部 PASS（含原有用例）

- [ ] **Step 5: Commit**

```bash
git add server/utils/scrapecreatorsYoutubeSearch.js server/utils/scrapecreatorsYoutubeSearch.test.js
git commit -m "feat(finder): add watchNext extraction and graph scoring utils"
```

---

### Task 2: watchNext 适配器主体

**Files:**
- Modify: `server/routes/finderTasks.js`（常量区、`recordScYoutubeQueryLedger` 泛化、`preflightScYoutubeCandidates` 之后新增函数、文件末尾 exports）
- Test: `server/routes/finderWatchNext.test.js`（新建）

**Interfaces:**
- Consumes: Task 1 的 `extractWatchNext/positionWeight/graphScore`；`scYoutube.search/channel/channelVideos/video`（Task 2 只用 search/channel/video）；`scYt.buildYoutubeSearchUrl/toV3SearchItems/toV3ChannelItem`；finderTasks 内部 `rankedKeywordQueries/youtubePreflightConfig/preflightScYoutubeCandidates/youtubeItemsToCandidates/loadYoutubeExclusionSet/isExcludedYoutubeCreator/finderScanLimit/getCachedPlatformSearch/savePlatformSearchCache/readTaskCheckpoint/saveTaskCheckpoint/parseList/clean`。
- Produces: `youtubeWatchNextAdapter(request)`（返回契约同 youtubeScrapeCreatorsAdapter）；常量 `WATCH_NEXT_LIMITS = { MAX_SEED_QUERIES: 12, MAX_SEED_VIDEOS: 12, MAX_WATCH_NEXT_PER_SEED: 20, MAX_DEPTH_2_SEEDS: 10, MAX_ENRICHED_CHANNELS: 120 }`；`recordScYoutubeQueryLedger` 增加可选 `provider` 参数（默认 `'scrapecreators_youtube'`，不破坏既有调用）。

**实现要点（写代码前必读，全部来自 spec 评审定稿）:**

- 种子查询词：`parseList(handoff.required_keywords)` 优先 + `parseList(handoff.competitor_keywords)` 补足，经 `rankedKeywordQueries` 排序后截 MAX_SEED_QUERIES。handoff 无关键词时回退 `keywordQueries(request)`。
- `effectiveMinSeconds = youtubePreflightConfig(request).minimumLongSeconds > 0 ? minimumLongSeconds : 181`；`minRecommendedViews = Math.max(1000, Math.floor(config.minimumMedianViews * 0.25))`。
- 种子：每词最多 1 条（过滤时长/排除词/排除集后取 viewCountInt 最高），全局按频道去重、同词回补，截 MAX_SEED_VIDEOS。种子本身也入候选池（作为 depth 0 推荐源频道走富化+preflight）。
- 每种子：`scYoutube.video(setting, seedUrl)` → `extractWatchNext` → 前 MAX_WATCH_NEXT_PER_SEED 条按下标赋 position。
- **先聚合后判重**：每条推荐先记视频层 `(seedIds[], positions[])` 与频道层聚合，再决定是否需富化。已富化频道只更新聚合。
- 预过滤五条件（时长/排除词/排除集/已见频道标记/播放量门槛），见 spec §4.3。
- 富化+preflight：逐频道 `scYoutube.channel` → `scYt.toV3ChannelItem` → `youtubeItemsToCandidates`（需把该频道任一推荐视频构造成 v3 search item 作为代表证据）→ 攒批后 `preflightScYoutubeCandidates`（直接传 setting 与剩余预算）。总富化数 ≤ MAX_ENRICHED_CHANNELS。
- 二跳：一跳视频按 `position_score 降 → seed 数降 → views 降` 排序，每频道限 1 条、不足回补，取 MAX_DEPTH_2_SEEDS 条做 depth=2 同样扩展。
- 停止三级：见 Global Constraints；连续无新增计数器跨种子累计、depth 切换时清零。
- checkpoint：开始读 `readTaskCheckpoint(task).watch_next`（无则空）；每完成一个种子的展开与每完成一个频道富化后 `saveTaskCheckpoint(taskId, { ...checkpoint, watch_next: { expanded_seed_ids, enriched_channel_ids } })`。`request.finder_task_id` 为空时跳过 checkpoint（测试/直调场景）。
- 台账：每次外部调用记 ledger（`query_text` 分别为 `seed-search:<query>`、`seed:<videoId>`、`enrich:<channelId>`），provider 传 `'youtube_watch_next_expansion'`。
- 返回契约：`{ provider: 'youtube_watch_next_expansion', endpoint, candidates, preflight_rejected, scanned_channel_count, target_qualified_count, max_scanned_channels, external_request_count, cache_hit_count }`。

- [ ] **Step 1: 写失败测试**

创建 `server/routes/finderWatchNext.test.js`：

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

function scVideoWithWatchNext(recIds) {
  return {
    id: 'seedvid', title: 'seed', type: 'video',
    watchNextVideos: recIds.map((id, i) => ({
      id, title: 'rec ' + id, videoUrl: 'https://www.youtube.com/watch?v=' + id,
      viewCountInt: 5000, lengthInSeconds: 700, publishedTime: '2026-02-01T00:00:00Z',
      channel: { id: 'UC' + id, title: 'Chan ' + id, handle: 'h' + id }
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
    if (u.includes('/v1/youtube/video?')) return scOk(scVideoWithWatchNext(['r1', 'r2']));
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
      return scOk({
        id: 'seedvid', title: 'seed', type: 'video',
        watchNextVideos: [
          { id: 'short1', title: 'short', viewCountInt: 99999, lengthInSeconds: 30, channel: { id: 'UCshort', title: 'Shorts Chan' } },
          { id: 'low1', title: 'low', viewCountInt: 10, lengthInSeconds: 700, channel: { id: 'UClow', title: 'Low Chan' } },
          { id: 'noviews', title: 'no views', lengthInSeconds: 700, channel: { id: 'UCnoviews', title: 'NoViews Chan' } }
        ]
      });
    }
    if (u.includes('/v1/youtube/channel-videos')) return scOk(scChannelVideosPass());
    if (u.includes('/v1/youtube/channel')) {
      const m = u.match(/channelId=([^&]+)/);
      enriched.push(m[1]);
      return scOk(scChannel(m[1], 'Chan ' + m[1]));
    }
    throw new Error('unexpected url ' + u);
  });
  await youtubeWatchNextAdapter(REQUEST);
  restore();
  assert.ok(enriched.includes('UCnoviews')); // 缺失播放量的放行
  assert.ok(!enriched.includes('UCshort')); // 30s 被时长剔除
  assert.ok(!enriched.includes('UClow')); // 10 播放被门槛剔除
});

test('同频道多条视频被不同种子推荐时聚合为频道级 graph_signal 且不重复富化', async () => {
  await resetTestDatabase();
  await dbOperations.run("INSERT INTO api_settings (provider, api_key, created_at, updated_at) VALUES ('youtube.scrapecreators', 'test-key', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");
  const request = {
    ...REQUEST,
    strategy: { ...REQUEST.strategy, finder_handoff: { ...REQUEST.strategy.finder_handoff, required_keywords: ['flail mower', 'brush hog'] } }
  };
  let channelCalls = 0;
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes('/v1/youtube/search')) {
      const q = decodeURIComponent(u.match(/query=([^&]+)/)[1]);
      return scOk(scSearchWithSeed('UCseed' + (q.includes('brush') ? '2' : '1'), 'seedvid' + (q.includes('brush') ? '2' : '1')));
    }
    if (u.includes('/v1/youtube/video?')) {
      const vid = decodeURIComponent(u.match(/url=([^&]+)/)[1]);
      const rec = vid.includes('2') ? 'sharedB' : 'sharedA';
      return scOk(scVideoWithWatchNext([rec]));
    }
    if (u.includes('/v1/youtube/channel-videos')) return scOk(scChannelVideosPass());
    if (u.includes('/v1/youtube/channel')) { channelCalls += 1; const m = u.match(/channelId=([^&]+)/); return scOk(scChannel(m[1], 'Chan ' + m[1])); }
    throw new Error('unexpected url ' + u);
  });
  const result = await youtubeWatchNextAdapter(request);
  restore();
  const shared = result.candidates.find((c) => c.profile_url.includes('UCsharedA') || c.profile_url.includes('UCsharedB'));
  // sharedA/sharedB 是同一频道两条不同视频（测试构造同频道不同 video id）
  assert.ok(shared, '应产出共享频道候选');
  assert.ok(shared.raw_data.graph_signal.channel_seed_count >= 2, '应聚合到 2 条种子');
  const sharedEnrichCalls = channelCalls; // UCshared 只富化一次（外加两个种子频道各一次）
  assert.ok(sharedEnrichCalls <= 3, `频道富化调用应去重，实际 ${channelCalls}`);
});
```

注：第三个测试构造里 `scVideoWithWatchNext(['sharedA'])` 与 `['sharedB']` 的频道 id 由 `scVideoWithWatchNext` 生成为 `UCsharedA`/`UCsharedB`——为了让两条视频同频道，把 `scVideoWithWatchNext` 改为支持传入固定 channelId（例如第二个参数 `channelId`），或用 `scVideoWithWatchNext(['sharedA']).watchNextVideos[0].channel.id` 统一改写为 `'UCshared'`。实现时以"两条推荐视频 channel.id 相同"为准调整 mock，不断言具体 id 拼写。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test routes/finderWatchNext.test.js`
Expected: FAIL（`youtubeWatchNextAdapter is not a function`）

- [ ] **Step 3: 实现**

3a. `recordScYoutubeQueryLedger` 泛化（finderTasks.js）：函数签名改为 `recordScYoutubeQueryLedger({ ..., provider = 'scrapecreators_youtube' })`，SQL 中硬编码的 `'scrapecreators_youtube'` 改为 `?` 并把 `provider` 加入参数数组。

3b. 常量区追加：

```js
const WATCH_NEXT_LIMITS = {
  MAX_SEED_QUERIES: 12,
  MAX_SEED_VIDEOS: 12,
  MAX_WATCH_NEXT_PER_SEED: 20,
  MAX_DEPTH_2_SEEDS: 10,
  MAX_ENRICHED_CHANNELS: 120
};
```

3c. 在 `preflightScYoutubeCandidates` 之后新增（完整实现按上方"实现要点"，骨架如下，函数体需写全）：

```js
// 关联推荐扩展发现路线（youtube_watch_next_expansion）。
// 关键词产种子 → watchNextVideos 一跳全抓 → 廉价预过滤 → 富化+preflight → 二跳 Top N。
async function youtubeWatchNextAdapter(request) {
  const setting = await scYoutube.getYoutubeScrapeCreatorsSetting();
  if (!setting?.api_key) throw new Error('ScrapeCreators API Key 未配置');
  const config = youtubePreflightConfig(request);
  const effectiveMinSeconds = config.minimumLongSeconds > 0 ? config.minimumLongSeconds : 181;
  const minRecommendedViews = Math.max(1000, Math.floor((config.minimumMedianViews || 0) * 0.25));
  const targetQualifiedCount = Math.max(1, Math.min(Number(request.limit || 10), 50));
  const maxScannedChannels = finderScanLimit(request, targetQualifiedCount);
  const exclusions = await loadYoutubeExclusionSet();
  const handoff = request.strategy?.finder_handoff || {};
  const exclusionTerms = parseList(handoff.exclusion_keywords).map((t) => t.toLowerCase());
  // …（种子查询词：required_keywords 优先、competitor_keywords 补足，rankedKeywordQueries 排序截 MAX_SEED_QUERIES；空则 keywordQueries(request)）
  // …（checkpoint 读回 watch_next；无 finder_task_id 时用内存态）
  // …（collectSeedVideos → 每种子 scYoutube.video + extractWatchNext → 先聚合后判重 → 预过滤 → 富化+preflightScYoutubeCandidates → 二跳 → 三级停止 → 台账）
  // 返回契约见"实现要点"末尾
}
```

3d. 文件末尾 exports 追加：

```js
module.exports.youtubeWatchNextAdapter = youtubeWatchNextAdapter;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test routes/finderWatchNext.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 回归 + Commit**

Run: `cd server && node --test routes/finderScrapeCreatorsYoutube.test.js routes/videosScrapeCreators.test.js`
Expected: PASS（`recordScYoutubeQueryLedger` 泛化未破坏既有调用）

```bash
git add server/routes/finderTasks.js server/routes/finderWatchNext.test.js
git commit -m "feat(finder): add youtube watch-next expansion discovery adapter"
```

---

### Task 3: 路由与任务创建入口

**Files:**
- Modify: `server/routes/finderTasks.js`（`runProvider` :2337 附近、`createFinderTask` :3494、POST `/` 路由调用处）

**Interfaces:**
- Consumes: Task 2 的 `youtubeWatchNextAdapter`。
- Produces: `createFinderTask({ strategyId, targetPlatform, limit, notes, searchSource })`（searchSource 可选，校验白名单）；runProvider 新分支。

- [ ] **Step 1: 写失败测试**

`server/routes/finderWatchNext.test.js` 追加：

```js
test('runProvider 分发 youtube_watch_next_expansion；非 youtube 平台报错', async () => {
  await resetTestDatabase();
  // 非 youtube：直接拒绝
  const { runVideoEvidenceDiscovery } = require('./finderTasks');
  await assert.rejects(
    () => runVideoEvidenceDiscovery({ finder_task_id: null, target_platform: 'instagram', search_source: 'youtube_watch_next_expansion', discovery: { keywords: 'x' }, campaign: {}, strategy: {} }),
    /youtube/i
  );
});
```

（`runProvider` 未导出，经已导出的 `runVideoEvidenceDiscovery`（= processVideoEvidenceTask）验证分发；若该入口包裹层级过深，也可只测 `createFinderTask` 的 searchSource 透传 + 直接单测 runProvider 导出补充。实现时二选一并在测试注释中说明。）

另加 createFinderTask 透传测试：

```js
test('createFinderTask 透传显式 search_source 并校验非法值', async () => {
  await resetTestDatabase();
  await initDatabase();
  // 需要 seedBaseData 等辅助；若引入 finderTasks.test.js 的辅助成本过高，
  // 可将 createFinderTask 白名单校验逻辑抽出为纯函数 validateSearchSource(platform, source) 单测。
  const { createFinderTask, validateSearchSource } = require('./finderTasks');
  assert.equal(validateSearchSource('youtube', 'youtube_watch_next_expansion'), 'youtube_watch_next_expansion');
  assert.throws(() => validateSearchSource('instagram', 'youtube_watch_next_expansion'), /youtube/i);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test routes/finderWatchNext.test.js`
Expected: FAIL（`validateSearchSource` 未导出）

- [ ] **Step 3: 实现**

3a. finderTasks.js 新增并导出：

```js
const SEARCH_SOURCES_BY_PLATFORM = {
  youtube: ['maton_agent', 'google_web', 'youtube_search', 'scrapecreators_youtube', 'youtube_watch_next_expansion'],
  instagram: ['instagram_search'],
  tiktok: ['tiktok_search']
};

function validateSearchSource(platform, source) {
  const allowed = SEARCH_SOURCES_BY_PLATFORM[platform] || [];
  if (!allowed.includes(source)) {
    throw new Error(`search_source ${source} is not available for platform ${platform}`);
  }
  return source;
}
```

3b. `runProvider` 主分支追加（在 `source === 'maton_agent' || source === 'google_web'` 之前）：

```js
    if (source === 'youtube_watch_next_expansion') {
      if (request.target_platform !== 'youtube') {
        throw new Error('youtube_watch_next_expansion is only available for target_platform=youtube');
      }
      maton = await youtubeWatchNextAdapter(request);
    } else if (source === 'maton_agent' || source === 'google_web') {
```

3c. `createFinderTask` 签名与路由：

```js
async function createFinderTask({ strategyId, targetPlatform, limit = 10, notes = '', searchSource = '' } = {}) {
  // ...TARGET_PLATFORMS 校验之后：
  const resolvedSearchSource = searchSource
    ? validateSearchSource(targetPlatform, searchSource)
    : await preferredSearchSourceForTargetPlatform(targetPlatform);
  // 后续所有使用 searchSource 的地方改用 resolvedSearchSource
}
```

POST `/` 路由调用处把 `req.body.search_source` 传入（`searchSource: clean(req.body?.search_source)`）。确认 `processVideoEvidenceTask`（:2728 附近）里 `request.search_source` 来自 raw_request/任务字段，createFinderTask 的 rawRequest 增加 `search_source: resolvedSearchSource`，且 `search_sources` 列写 `JSON.stringify([resolvedSearchSource])`。检查 processVideoEvidenceTask 构造 request 时读取 search_source 的字段名并保持一致（finderTasks.js:1140 处 `search_source: searchSource` 是 buildEvidenceDiscoveryRequest 的参数——createFinderTask 调用链如果走该函数，把 resolvedSearchSource 传进去）。

3d. exports 追加：

```js
module.exports.validateSearchSource = validateSearchSource;
module.exports.createFinderTask = createFinderTask;
```

（若 createFinderTask 已导出则只加 validateSearchSource。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test routes/finderWatchNext.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 回归 + Commit**

Run: `cd server && node --test routes/finderTasks.test.js routes/finderWatchNext.test.js`
Expected: 46 + 新增全 PASS，无回归（重点：createFinderTask 默认 searchSource 行为不变）

```bash
git add server/routes/finderTasks.js server/routes/finderWatchNext.test.js
git commit -m "feat(finder): route youtube_watch_next_expansion through task creation and runProvider"
```

---

### Task 4: 前端入口 + 收尾验证

**Files:**
- Modify: `client/src/pages/finderTaskContract.js:11`（buildFinderTaskRequest）、`client/src/pages/RawCandidates.js`（任务创建表单，:394 附近）
- Test: `client/src/pages/finderTaskContract.test.js`（追加）、`client/src/pages/RawCandidates.test.js`（如覆盖创建表单则追加）

**Interfaces:**
- Consumes: Task 3 的 `search_source` 请求字段。
- Produces: `buildFinderTaskRequest({ strategyId, targetPlatform, limit, searchSource })` — searchSource 非空时才写入 body。

- [ ] **Step 1: 实现 contract 改动 + 测试**

`finderTaskContract.js`：

```js
export const buildFinderTaskRequest = ({ strategyId, targetPlatform, limit = 10, searchSource = '' }) => ({
  strategy_id: strategyId,
  target_platform: targetPlatform,
  limit,
  ...(searchSource ? { search_source: searchSource } : {})
});
```

`finderTaskContract.test.js` 追加：

```js
test('buildFinderTaskRequest 仅在显式给出时携带 search_source', () => {
  expect(buildFinderTaskRequest({ strategyId: 1, targetPlatform: 'youtube' })).not.toHaveProperty('search_source');
  expect(buildFinderTaskRequest({ strategyId: 1, targetPlatform: 'youtube', searchSource: 'youtube_watch_next_expansion' }).search_source).toBe('youtube_watch_next_expansion');
});
```

- [ ] **Step 2: RawCandidates.js 创建表单加来源下拉**

在创建任务表单（:394 提交处对应的 UI）的目标平台选择旁加：

```js
// 仅 youtube 时展示；默认值 '' 表示跟随系统数据源设置
<Select
  allowClear
  placeholder="发现方式（默认跟随数据源设置）"
  style={{ width: 240 }}
  options={[{ value: 'youtube_watch_next_expansion', label: '关联推荐扩展（YouTube）' }]}
  value={searchSource}
  onChange={setSearchSource}
/>
```

提交时把 `searchSource` 传给 `buildFinderTaskRequest`。仅当 targetPlatform === 'youtube' 时展示该 Select；切换平台时清空。state 命名沿用文件内既有风格。

- [ ] **Step 3: 跑 client 测试**

Run: `cd client && CI=true node node_modules/react-scripts/scripts/test.js --watchAll=false --testPathPattern "finderTaskContract|RawCandidates"`
Expected: 全部 PASS

- [ ] **Step 4: 全量回归**

Run: `cd server && npm test`（若 20 分钟内未完，至少跑 `node --test routes/*.test.js utils/*.test.js services/*.test.js` 中受影响文件：`finderTasks.test.js finderWatchNext.test.js finderScrapeCreatorsYoutube.test.js videosScrapeCreators.test.js settings.test.js`）
Run: `cd client && CI=true node node_modules/react-scripts/scripts/test.js --watchAll=false`
Expected: server 无新增失败（基线已全绿）；client 99+ 全绿

- [ ] **Step 5: 真机冒烟（可选，需用户确认后执行）**

用 TMB-1404 策略在**本地服务**创建一个 search_source=youtube_watch_next_expansion、limit=3 的 finder 任务，确认产出候选且台账 provider 为 `youtube_watch_next_expansion`。注意会产生 60-94 credits 真实消耗。

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/finderTaskContract.js client/src/pages/finderTaskContract.test.js client/src/pages/RawCandidates.js client/src/pages/RawCandidates.test.js
git commit -m "feat(client): expose watch-next expansion as finder discovery option"
```

---

## 收尾清单

- [ ] server 测试全绿（含既有 46 个 finderTasks 用例）
- [ ] client 测试全绿
- [ ] 真机冒烟结果记录（候选数 / credit 消耗 / 台账 provider）
- [ ] spec 状态改为"已实现"
