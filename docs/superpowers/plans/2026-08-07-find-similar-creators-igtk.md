# 找相似达人 V2 第一期（IG/TK）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `similar_to_creator` 发现路线（第一期仅 instagram/tiktok）：种子达人 → AI 生成 Similarity Brief → 关键词注入现有 V2 适配器 → 现有候选管道。

**Architecture:** 新服务 `server/services/similarityBrief.js`（种子解析 + 资料拉取 + AI Brief 生成 + 缓存）；finderTasks.js 负责路由分发、任务创建校验、执行期注入；前端在任务弹窗加"找相似达人"入口、客户列表加行内按钮。

**Tech Stack:** Node.js 原生 fetch、node:test + supertest、react-scripts test。无新依赖。

**设计依据:** `docs/superpowers/specs/2026-08-07-find-similar-creators-design.md`（§8 分期：本期只做 IG/TK；YouTube creator 模式为第二期）。

## Global Constraints

- 无新 npm 依赖；产出走现有"证据导入 → AI 分析 → Raw Candidates"管道；候选标注 `similar_to:<种子达人名>`。
- 命名统一：search_source / provider / 台账 provider 全部 `similar_to_creator`；缓存层 `provider='scrapecreators', variant='similarity-brief'` 或 `'similar-seed-profile'`（page_token 存 channelId/handle）。
- 单平台单任务；种子平台与任务平台不一致直接报错。
- Brief 结构：`{ content_keywords, scene_keywords, style_keywords, competitor_keywords, negative_keywords, target_country }`，AI 失败即任务失败（不写兜底词）。
- Brief 与种子资料缓存 7 天（复用 finder_search_cache），重跑不重复调用。
- AI 调用走 `callAi(setting, provider, systemPrompt, userPrompt)`（`services/aiClient.js`），provider 取 `getSelection().aiModels.active`，setting 取 `getSetting(providerKey('ai', active), legacyKeysFor('ai', active))`。
- 测试命令：server `node --test <file>`；client `CI=true node node_modules/react-scripts/scripts/test.js --watchAll=false`（禁用 npx）。
- DB 测试文件使用独立库名（参照 finderWatchNext.test.js 的 `kol_campaign_os_test_wn` 模式，本计划用 `kol_campaign_os_test_sim`），防止并行竞态。
- 每任务结束按步骤 commit（执行前取得用户确认）。

---

### Task 1: similarityBrief 服务

**Files:**
- Create: `server/services/similarityBrief.js`
- Test: `server/services/similarityBrief.test.js`

**Interfaces:**
- Consumes: `aiClient` 的 `getSetting/getSelection/providerKey/legacyKeysFor/callAi`；`scrapecreatorsYoutube.js` 的 `fetchScJson`（复用超时/重试/402 语义）。
- Produces:
  - `resolveSeedCreator({ customer_id, url, platform }) -> { platform, handle, channelId, name, profileUrl, source: 'library'|'url' }`（库内查 customers + kol_platform_accounts；库外解析 URL 得到 handle；平台不符抛错）
  - `fetchSeedProfile(seed, scSetting) -> { bio, followers, recentTitles: [] }`（IG：`/v1/instagram/profile?handle=`；TK：`/v1/tiktok/profile?handle=` + `/v3/tiktok/profile/videos?handle=`；带缓存）
  - `generateSimilarityBrief(seed, profile) -> brief`（callAi + JSON 校验 + 缓存）
  - `parseSimilarityBrief(text) -> brief`（纯函数，剔除 ```json 围栏，校验必填数组字段）

- [ ] **Step 1: 写失败测试**

创建 `server/services/similarityBrief.test.js`（纯函数 + stub fetch/callAi 注入，不碰 DB）：

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseSimilarityBrief, buildSimilarityPrompt, resolveSeedUrl } = require('./similarityBrief');

test('parseSimilarityBrief 解析合法 JSON 并剔除围栏', () => {
  const brief = parseSimilarityBrief('```json\n{"content_keywords":["home decor"],"scene_keywords":["living room makeover"],"style_keywords":["vintage"],"competitor_keywords":["balsam hill"],"negative_keywords":["makeup"],"target_country":"US"}\n```');
  assert.equal(brief.target_country, 'US');
  assert.deepEqual(brief.style_keywords, ['vintage']);
});

test('parseSimilarityBrief 拒绝坏 JSON 与缺字段', () => {
  assert.throws(() => parseSimilarityBrief('not json'), /JSON|parse/i);
  assert.throws(() => parseSimilarityBrief('{"content_keywords": []}'), /scene_keywords|required/i);
});

test('buildSimilarityPrompt 包含多维要求与种子信息', () => {
  const p = buildSimilarityPrompt({ name: 'Lindsay', handle: 'hellolindsaymiller' }, { bio: 'home design, thrift', followers: 13500, recentTitles: ['Christmas decor haul'] });
  assert.match(p, /Lindsay/);
  assert.match(p, /content_keywords/);
  assert.match(p, /维度|dimension|场景|风格/i);
  assert.match(p, /Christmas decor haul/);
});

test('resolveSeedUrl 解析三平台链接并拒绝其他平台', () => {
  assert.deepEqual(resolveSeedUrl('https://www.tiktok.com/@hellolindsaymiller', 'tiktok'), { platform: 'tiktok', handle: 'hellolindsaymiller' });
  assert.deepEqual(resolveSeedUrl('https://www.instagram.com/hello.lindsay/', 'instagram'), { platform: 'instagram', handle: 'hello.lindsay' });
  assert.deepEqual(resolveSeedUrl('https://www.youtube.com/@ChanName', 'youtube'), { platform: 'youtube', handle: 'ChanName' });
  assert.throws(() => resolveSeedUrl('https://www.tiktok.com/@abc', 'instagram'), /平台|platform/i);
  assert.throws(() => resolveSeedUrl('https://example.com/x', 'tiktok'), /无法识别|unrecognized|platform/i);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test services/similarityBrief.test.js`
Expected: FAIL（`Cannot find module './similarityBrief'`）

- [ ] **Step 3: 实现**

创建 `server/services/similarityBrief.js`：

```js
// 找相似达人：种子解析、资料拉取、Similarity Brief 生成。
// 设计：docs/superpowers/specs/2026-08-07-find-similar-creators-design.md
const crypto = require('crypto');
const { dbOperations } = require('../database');
const { getSetting, getSelection, providerKey, legacyKeysFor, callAi, parseJson } = require('./aiClient');
const { fetchScJson } = require('./scrapecreatorsYoutube');

const BRIEF_CACHE_VARIANT = 'similarity-brief';
const PROFILE_CACHE_VARIANT = 'similar-seed-profile';
const CACHE_TTL_DAYS = 7;

function clean(value) {
  return String(value ?? '').trim();
}

function resolveSeedUrl(url, platform) {
  const text = clean(url);
  const patterns = {
    youtube: /youtube\.com\/@([A-Za-z0-9._-]+)/,
    instagram: /instagram\.com\/([A-Za-z0-9._]+)/,
    tiktok: /tiktok\.com\/@([A-Za-z0-9._]+)/
  };
  const matchedPlatform = Object.keys(patterns).find((p) => patterns[p].test(text));
  if (!matchedPlatform) throw new Error(`无法识别的达人链接（需要 ${platform} 主页链接）`);
  if (matchedPlatform !== platform) throw new Error(`种子达人平台（${matchedPlatform}）与任务平台（${platform}）不一致`);
  return { platform, handle: text.match(patterns[platform])[1] };
}

async function resolveSeedCreator({ customer_id, url, platform }) {
  if (customer_id) {
    const customer = await dbOperations.get('SELECT * FROM customers WHERE id = ?', [customer_id]);
    if (!customer) throw new Error('KOL 不存在');
    const urlColumn = `${platform}_url`;
    const profileUrl = clean(customer[urlColumn]);
    if (!profileUrl) throw new Error(`该 KOL 没有 ${platform} 主页链接`);
    const account = await dbOperations.get(
      'SELECT * FROM kol_platform_accounts WHERE customer_id = ? AND LOWER(platform) = ? ORDER BY id LIMIT 1',
      [customer_id, platform]
    );
    const handle = clean(account?.username).replace(/^@/, '') || resolveSeedUrl(profileUrl, platform).handle;
    return { platform, handle, channelId: '', name: customer.name, profileUrl, source: 'library', customer_id };
  }
  if (url) {
    const parsed = resolveSeedUrl(url, platform);
    return { ...parsed, channelId: '', name: parsed.handle, profileUrl: url, source: 'url' };
  }
  throw new Error('需要 customer_id 或 creator_url 之一');
}

function buildSimilarityPrompt(seed, profile) {
  const titles = (profile.recentTitles || []).slice(0, 30).map((t, i) => `${i + 1}. ${t}`).join('\n');
  return `你是一位 KOL 营销专家。根据下面这位达人的资料，生成用于寻找"相似达人"的搜索关键词（Similarity Brief）。

种子达人：${seed.name}（@${seed.handle}，平台 ${seed.platform}）
粉丝数：${profile.followers || '未知'}
Bio：${profile.bio || '无'}
近期内容标题：
${titles || '（无）'}

要求：
1. 从多个维度拆分关键词——内容类目、使用场景、风格调性、受众身份、相邻内容、相关产品，禁止只给同义词。
2. 所有关键词必须是目标平台上可搜索的英语短语。
3. negative_keywords 填与该达人内容明显无关的类目词。
4. 只返回 JSON，不要任何解释。

返回格式：
{"content_keywords": [...], "scene_keywords": [...], "style_keywords": [...], "competitor_keywords": [...], "negative_keywords": [...], "target_country": "US"}`;
}

function parseSimilarityBrief(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 未返回 JSON 格式的 Similarity Brief');
  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (error) {
    throw new Error(`Similarity Brief JSON 解析失败: ${error.message}`);
  }
  const required = ['content_keywords', 'scene_keywords', 'style_keywords', 'competitor_keywords', 'negative_keywords'];
  for (const key of required) {
    if (!Array.isArray(parsed[key]) || !parsed[key].length) {
      throw new Error(`Similarity Brief 缺少必填字段或为空: ${key}`);
    }
  }
  parsed.target_country = clean(parsed.target_country) || 'US';
  return parsed;
}

async function getCachedBrief(cacheKey) {
  const row = await dbOperations.get(
    'SELECT response_json FROM finder_search_cache WHERE cache_key = ? AND expires_at > CURRENT_TIMESTAMP LIMIT 1',
    [cacheKey]
  );
  return row ? parseJson(row.response_json, null) : null;
}

async function saveBriefCache(cacheKey, variant, seedKey, data) {
  const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
  await dbOperations.run(
    `INSERT INTO finder_search_cache
     (cache_key, provider, platform, query_text, page_token, max_results, response_json, result_count, hit_count, expires_at, created_at, updated_at)
     VALUES (?, 'scrapecreators', 'similarity', ?, ?, 0, ?, 0, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE response_json = VALUES(response_json), expires_at = VALUES(expires_at), updated_at = CURRENT_TIMESTAMP`,
    [cacheKey, variant, seedKey, JSON.stringify(data || {}), expiresAt]
  );
}

function briefCacheKey(variant, seed) {
  return crypto.createHash('sha256').update(['similar_to_creator', variant, seed.platform, seed.handle || seed.channelId].join('|')).digest('hex');
}

async function fetchSeedProfile(seed, scSetting) {
  const key = briefCacheKey(PROFILE_CACHE_VARIANT, seed);
  const cached = await getCachedBrief(key);
  if (cached) return cached;
  let profile;
  if (seed.platform === 'instagram') {
    const data = await fetchScJson(`https://api.scrapecreators.com/v1/instagram/profile?handle=${encodeURIComponent(seed.handle)}`, scSetting);
    const user = data.data?.user || data.data || {};
    profile = {
      bio: clean(user.biography),
      followers: user.follower_count ?? user.edge_followed_by?.count ?? null,
      recentTitles: []
    };
  } else if (seed.platform === 'tiktok') {
    const data = await fetchScJson(`https://api.scrapecreators.com/v1/tiktok/profile?handle=${encodeURIComponent(seed.handle)}`, scSetting);
    const user = data.user || data.data?.user || data.userInfo?.user || {};
    const stats = data.stats || data.data?.stats || data.userInfo?.stats || {};
    let recentTitles = [];
    try {
      const vids = await fetchScJson(`https://api.scrapecreators.com/v3/tiktok/profile/videos?handle=${encodeURIComponent(seed.handle)}`, scSetting);
      recentTitles = (vids.videos || vids.data || []).slice(0, 30).map((v) => clean(v.desc || v.title)).filter(Boolean);
    } catch (error) {
      recentTitles = [];
    }
    profile = { bio: clean(user.signature || user.bio), followers: stats.followerCount ?? stats.follower_count ?? null, recentTitles };
  } else {
    throw new Error(`similar_to_creator 第一期仅支持 instagram/tiktok，当前平台: ${seed.platform}`);
  }
  await saveBriefCache(key, PROFILE_CACHE_VARIANT, seed.handle, profile);
  return profile;
}

async function generateSimilarityBrief(seed, profile) {
  const key = briefCacheKey(BRIEF_CACHE_VARIANT, seed);
  const cached = await getCachedBrief(key);
  if (cached) return cached;
  const selection = await getSelection();
  const active = selection.aiModels?.active || 'deepseek';
  const setting = await getSetting(providerKey('ai', active), legacyKeysFor('ai', active));
  const answer = await callAi(setting, active, '你是 KOL 营销专家，只返回合法 JSON。', buildSimilarityPrompt(seed, profile));
  const brief = parseSimilarityBrief(typeof answer === 'string' ? answer : answer?.content || JSON.stringify(answer));
  await saveBriefCache(key, BRIEF_CACHE_VARIANT, seed.handle, brief);
  return brief;
}

module.exports = {
  resolveSeedUrl,
  resolveSeedCreator,
  fetchSeedProfile,
  generateSimilarityBrief,
  buildSimilarityPrompt,
  parseSimilarityBrief
};
```

注意：`callAi` 的返回形态若为对象，取 `.content`；实现时先 `node -e` 打印一次真实返回确认字段名（不同 provider 协议不同），必要时调整。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test services/similarityBrief.test.js`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/similarityBrief.js server/services/similarityBrief.test.js
git commit -m "feat(finder): add similarity brief service for find-similar creators"
```

---

### Task 2: finderTasks 路由 + 任务创建 + 执行注入

**Files:**
- Modify: `server/routes/finderTasks.js`（`validateSearchSource` 白名单、`runProvider` 分发、`createFinderTask`、`processVideoEvidenceTask`、exports）
- Test: `server/routes/finderSimilarCreator.test.js`（新建，独立测试库 `kol_campaign_os_test_sim`）

**Interfaces:**
- Consumes: Task 1 的 `resolveSeedCreator/fetchSeedProfile/generateSimilarityBrief`；`scYoutube.getYoutubeScrapeCreatorsSetting()`；现有 `scrapeCreatorsFinderAdapterV2(request)`。
- Produces:
  - `createFinderTask({ strategyId, targetPlatform, limit, notes, searchSource, similarCreator })`；`similarCreator = { customer_id } | { url }`
  - `runProvider` 分支：`source === 'similar_to_creator'` 且 platform ∈ {instagram, tiktok} → `scrapeCreatorsFinderAdapterV2`（Brief 关键词已注入 `request.discovery.keywords`，Brief 反向词并入 `request.discovery.exclusions`）
  - 候选 `raw_data.similarity = { seed_creator, seed_url, brief }`（由执行期注入 request 后，V2 适配器候选生成处透传——在 `instagramReelToCandidate`/`tiktokVideoToCandidate` 调用点之后统一补写，不改 utils 签名）

- [ ] **Step 1: 写失败测试**

创建 `server/routes/finderSimilarCreator.test.js`：

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
require('dotenv').config();

process.env.NODE_ENV = 'test';
process.env.DB_NAME = 'kol_campaign_os_test_sim';

const { Sequelize } = require('sequelize');
const { initDatabase, dbOperations } = require('../database');
const { validateSearchSource } = require('./finderTasks');
const { runSimilarCreatorPreflight } = require('./finderTasks');

async function resetTestDatabase() {
  const admin = new Sequelize('mysql', 'root', process.env.DB_ROOT_PASSWORD || 'root_password', {
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), dialect: 'mysql', logging: false
  });
  await admin.query(`DROP DATABASE IF EXISTS ${process.env.DB_NAME}`);
  await admin.query(`CREATE DATABASE ${process.env.DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.query(`GRANT ALL PRIVILEGES ON ${process.env.DB_NAME}.* TO '${process.env.DB_USER || 'kol_user'}'@'%'`);
  await admin.query('FLUSH PRIVILEGES');
  await admin.close();
  await initDatabase();
}

test('validateSearchSource 接受三平台 similar_to_creator', () => {
  assert.equal(validateSearchSource('instagram', 'similar_to_creator'), 'similar_to_creator');
  assert.equal(validateSearchSource('tiktok', 'similar_to_creator'), 'similar_to_creator');
  assert.equal(validateSearchSource('youtube', 'similar_to_creator'), 'similar_to_creator');
});

test('runSimilarCreatorPreflight 解析库内种子并拉资料', async () => {
  await resetTestDatabase();
  await dbOperations.run("INSERT INTO customers (name, tiktok_url, created_at, updated_at) VALUES ('Lindsay', 'https://www.tiktok.com/@hellolindsaymiller', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");
  const customerId = (await dbOperations.get('SELECT id FROM customers LIMIT 1')).id;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/v1/tiktok/profile?')) {
      return { status: 200, json: async () => ({ user: { nickname: 'Lindsay Miller', signature: 'home design, thrift' }, stats: { followerCount: 13500 } }) };
    }
    if (u.includes('/v3/tiktok/profile/videos')) {
      return { status: 200, json: async () => ({ videos: [{ desc: 'Christmas decor haul' }] }) };
    }
    throw new Error('unexpected ' + u);
  };
  const seed = await runSimilarCreatorPreflight({ customer_id: customerId }, 'tiktok', { api_key: 'k' });
  globalThis.fetch = originalFetch;
  assert.equal(seed.handle, 'hellolindsaymiller');
  assert.equal(seed.profile.followers, 13500);
  assert.deepEqual(seed.profile.recentTitles, ['Christmas decor haul']);
});

test('runSimilarCreatorPreflight 拒绝平台不一致', async () => {
  await resetTestDatabase();
  await assert.rejects(
    () => runSimilarCreatorPreflight({ url: 'https://www.tiktok.com/@abc' }, 'instagram', { api_key: 'k' }),
    /不一致|platform/i
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test routes/finderSimilarCreator.test.js`
Expected: FAIL（`runSimilarCreatorPreflight` 未导出）

- [ ] **Step 3: 实现**

3a. finderTasks.js 头部 require 追加：

```js
const { resolveSeedCreator, fetchSeedProfile, generateSimilarityBrief } = require('../services/similarityBrief');
```

3b. `SEARCH_SOURCES_BY_PLATFORM` 三平台数组各加 `'similar_to_creator'`。

3c. 新增预检函数并导出（供 createFinderTask 校验 + processVideoEvidenceTask 执行）：

```js
// 找相似达人：解析种子并拉取资料（任务创建时调用做快速校验）
async function runSimilarCreatorPreflight(similarCreator, platform, scSetting) {
  const seed = await resolveSeedCreator({ customer_id: similarCreator?.customer_id, url: similarCreator?.url, platform });
  const profile = await fetchSeedProfile(seed, scSetting);
  return { ...seed, profile };
}
```

3d. `runProvider` 主分支（在 `youtube_watch_next_expansion` 分支之前）追加：

```js
    if (source === 'similar_to_creator') {
      if (!['instagram', 'tiktok'].includes(request.target_platform)) {
        throw new Error('similar_to_creator 第一期仅支持 instagram/tiktok（YouTube 找相似为第二期）');
      }
      maton = await scrapeCreatorsFinderAdapterV2({ ...request, search_source: source });
    } else if (source === 'youtube_watch_next_expansion') {
```

3e. `createFinderTask` 签名与校验：

```js
async function createFinderTask({ strategyId, targetPlatform, limit = 10, notes = '', searchSource = '', similarCreator = null } = {}) {
  // …原有平台校验…
  if (searchSource === 'similar_to_creator') {
    if (!similarCreator || (!similarCreator.customer_id && !similarCreator.url)) {
      throw new Error('similar_to_creator 需要 similarCreator.customer_id 或 similarCreator.url');
    }
    // 创建时即解析种子（失败早暴露）；profile 拉取留到执行期
    await resolveSeedCreator({ customer_id: similarCreator.customer_id, url: similarCreator.url, platform: targetPlatform });
  }
  // resolvedSearchSource 逻辑不变；rawRequest 增加：
  //   similar_creator: similarCreator || undefined
}
```

rawRequest 增加 `similar_creator: similarCreator || undefined`；POST `/` 路由把 `req.body.similar_creator` 传入 `createFinderTask`。

3f. `processVideoEvidenceTask` 执行注入（在 `buildEvidenceDiscoveryRequest` 之后、`runProvider` 调用之前）：

```js
  if (searchSource === 'similar_to_creator') {
    const sim = rawRequest.similar_creator || {};
    const scSetting = await scYoutube.getYoutubeScrapeCreatorsSetting();
    const seed = await resolveSeedCreator({ customer_id: sim.customer_id, url: sim.url, platform: targetPlatform });
    const profile = await fetchSeedProfile(seed, scSetting);
    const brief = await generateSimilarityBrief(seed, profile);
    const briefKeywords = [...brief.content_keywords, ...brief.scene_keywords, ...brief.style_keywords, ...brief.competitor_keywords];
    request.discovery = {
      ...request.discovery,
      keywords: [...new Set(briefKeywords)].join(', ')
    };
    request.similarity_brief = brief;
    request.similar_seed = { platform: seed.platform, handle: seed.handle, name: seed.name, profile_url: seed.profileUrl };
  }
```

注意：`processVideoEvidenceTask` 里 `searchSource` 变量在 Task 3（watch-next）中已改为"优先读任务 search_sources"——直接在那一行之后追加本段即可。V2 适配器内部读取 `request.discovery.keywords` 作为查询词（`keywordQueries`），无需改动。

3g. 候选 similarity 标注：V2 适配器返回的候选在 runProvider 分发处补写：

```js
      if (request.similar_seed) {
        for (const c of maton.candidates || []) {
          c.raw_data = { ...(c.raw_data || {}), similarity: { seed_creator: request.similar_seed.name, seed_url: request.similar_seed.profile_url, brief: request.similarity_brief } };
          c.reason = `${c.reason || ''} 与 ${request.similar_seed.name} 相似（Similarity Brief 关键词命中）。`.trim();
        }
      }
```

（加在 `maton = await scrapeCreatorsFinderAdapterV2(...)` 之后、attempts push 之前。）

3h. exports 追加：

```js
module.exports.runSimilarCreatorPreflight = runSimilarCreatorPreflight;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test routes/finderSimilarCreator.test.js`
Expected: 全部 PASS

- [ ] **Step 5: 回归 + Commit**

Run: `cd server && node --test routes/finderTasks.test.js routes/finderWatchNext.test.js routes/finderSimilarCreator.test.js`
Expected: 50 + 3 全 PASS，无回归

```bash
git add server/routes/finderTasks.js server/routes/finderSimilarCreator.test.js
git commit -m "feat(finder): route similar_to_creator for instagram/tiktok with brief injection"
```

---

### Task 3: 前端入口 + 收尾

**Files:**
- Modify: `client/src/pages/finderTaskContract.js`、`client/src/pages/RawCandidates.js`、`client/src/pages/Customers.js`
- Test: `client/src/pages/finderTaskContract.test.js`（追加）

**Interfaces:**
- Produces: `buildFinderTaskRequest({ strategyId, targetPlatform, limit, searchSource, similarCreator })`——similarCreator 非空时写 `similar_creator`；`similar_to_creator` 时必须携带。

- [ ] **Step 1: contract 改动 + 测试**

`finderTaskContract.js`：

```js
export const buildFinderTaskRequest = ({ strategyId, targetPlatform, limit = 10, searchSource = '', similarCreator = null }) => ({
  strategy_id: strategyId,
  target_platform: targetPlatform,
  limit,
  ...(searchSource ? { search_source: searchSource } : {}),
  ...(similarCreator ? { similar_creator: similarCreator } : {})
});
```

`finderTaskContract.test.js` 追加：

```js
test('buildFinderTaskRequest 携带 similar_creator', () => {
  const req = buildFinderTaskRequest({ strategyId: 1, targetPlatform: 'tiktok', searchSource: 'similar_to_creator', similarCreator: { url: 'https://www.tiktok.com/@abc' } });
  expect(req.search_source).toBe('similar_to_creator');
  expect(req.similar_creator).toEqual({ url: 'https://www.tiktok.com/@abc' });
  expect(buildFinderTaskRequest({ strategyId: 1, targetPlatform: 'tiktok' })).not.toHaveProperty('similar_creator');
});
```

- [ ] **Step 2: RawCandidates 任务弹窗**

"发现方式"下拉扩展为三平台可选：

```js
const discoveryOptions = [
  { value: 'youtube_watch_next_expansion', label: '关联推荐扩展（YouTube）' },
  { value: 'similar_to_creator', label: '找相似达人' }
];
```

显示条件从 `watchedTaskPlatform === 'youtube'` 改为 youtube 显示两项、instagram/tiktok 只显示"找相似达人"。选中 `similar_to_creator` 时追加种子输入项：

```js
{watchedSearchSource === 'similar_to_creator' ? (
  <Form.Item label="种子达人" name="similar_creator_url" rules={[{ required: true, message: '请输入种子达人主页链接' }]}
    extra="粘贴目标平台的达人主页链接，例如 https://www.tiktok.com/@xxx">
    <Input placeholder="https://www.tiktok.com/@creator" />
  </Form.Item>
) : null}
```

用 `Form.useWatch('search_source', taskForm)` 拿 watchedSearchSource；提交时组装 `similarCreator: values.similar_creator_url ? { url: values.similar_creator_url } : undefined`。

- [ ] **Step 3: Customers 行内「找相似」**

在 `client/src/pages/Customers.js` 行操作区加按钮（位置参照现有操作按钮）：

```js
<Button type="link" size="small" onClick={() => openSimilarFinder(record)}>找相似</Button>
```

`openSimilarFinder` 跳转 `/raw-candidates?view=tasks&similar_customer_id=<id>`；RawCandidates 读取该 query 参数：存在时自动打开任务弹窗、预选"找相似达人"并把种子设为 `{ customer_id }`（库内种子优先于 URL 输入，URL 输入框此时隐藏或只读展示该达人名称）。若 Customers.js 行内按钮布局不允许加项，改为在详情抽屉里加入口——实现时以现有布局为准，并在 commit message 说明。

- [ ] **Step 4: client 测试 + 全量回归**

Run: `cd client && CI=true node node_modules/react-scripts/scripts/test.js --watchAll=false --testPathPattern "finderTaskContract|RawCandidates|Customers"`
Expected: 全部 PASS

Run: `cd client && CI=true node node_modules/react-scripts/scripts/test.js --watchAll=false`
Expected: 100+ 全绿

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/finderTaskContract.js client/src/pages/finderTaskContract.test.js client/src/pages/RawCandidates.js client/src/pages/Customers.js
git commit -m "feat(client): find-similar creators entry in finder modal and customer list"
```

---

## 收尾清单

- [ ] server 测试全绿（含既有 finderTasks 46 + watch-next 4 + similar 3）
- [ ] client 测试全绿
- [ ] spec 状态改为"第一期已实现"
- [ ] （可选，用户确认后）真机冒烟：用库内 TikTok 达人 + CTA-4049 TK 策略跑 limit=5 任务，验证 brief 落库与候选标注
