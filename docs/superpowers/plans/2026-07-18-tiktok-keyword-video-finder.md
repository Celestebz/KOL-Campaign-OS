# TikTok Keyword Video Finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace TikTok user/profile-oriented discovery with ScrapeCreators Keyword Search so TikTok videos enter the existing evidence-analysis and author-level Raw Candidate pipeline.

**Architecture:** Add a pure TikTok Keyword Search mapper beside the existing Instagram Reel mapper. The shared Finder route will call `/v1/tiktok/search/keyword`, map `search_item_list[].aweme_info` into the existing candidate contract, and reuse the current video persistence, snapshot, AI analysis, author aggregation, and review flow.

**Tech Stack:** Node.js 18+, CommonJS, Express, native `fetch`, Node test runner, Supertest, MySQL/Sequelize integration tests.

## Global Constraints

- First version supports public TikTok Keyword Search videos only.
- Do not call TikTok User Search, Hashtag Search, Top Search, Profile Videos, or Profile enrichment.
- Construct canonical evidence URLs from `aweme_id + author.unique_id`; do not use CDN, Profile, Photo Mode, or short-share URLs as evidence identity.
- Only HTTPS `www.tiktok.com/@handle/video/{numeric_id}` URLs may enter the evidence pipeline.
- Do not modify YouTube or Instagram discovery behavior.
- Do not change Finder request fields, scoring thresholds, Raw Candidate generation rules, or human approval behavior.
- Profile URLs are author identity only and must never be used as `video_url`.
- Do not invent author, follower, country, engagement, contact, or video data when provider fields are absent.
- Preserve legitimate numeric zero values.
- Distinguish missing configuration, upstream HTTP failure, zero videos, and all-invalid videos without exposing API keys.
- Do not add cursor pagination in this version.
- Do not delete user data or historical Finder records.
- Preserve all unrelated pre-existing working-tree changes in `server/routes/finderTasks.js`, `server/routes/finderTasks.test.js`, and other files.

---

## File Structure

- Create `server/utils/tiktokKeywordSearch.js`: pure endpoint builder, response extraction, canonical identity construction, validation, and candidate mapping.
- Create `server/utils/tiktokKeywordSearch.test.js`: fast unit contract based on the official `search_item_list[].aweme_info` response shape.
- Modify `server/routes/finderTasks.js`: replace only the TikTok ScrapeCreators branch with Keyword Search and preserve explicit failure reasons.
- Modify `server/routes/finderTasks.test.js`: exercise automatic TikTok discovery through evidence persistence, AI analysis, and author aggregation.
- Modify `server/package.json`: run all `utils/*.test.js` files in the standard server suite.

### Task 1: Pure TikTok Keyword Search Contract

**Files:**
- Create: `server/utils/tiktokKeywordSearch.js`
- Create: `server/utils/tiktokKeywordSearch.test.js`

**Interfaces:**
- Consumes: ScrapeCreators `{ search_item_list: [{ aweme_info }] }` and Finder `{ discovery, strategy }` request shapes.
- Produces: `buildTikTokKeywordSearchUrl(baseUrl, query): string`, `extractTikTokVideos(data): object[]`, and `tiktokVideoToCandidate(video, request): object | null`.

- [ ] **Step 1: Write the failing mapper tests**

Create `server/utils/tiktokKeywordSearch.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildTikTokKeywordSearchUrl,
  extractTikTokVideos,
  tiktokVideoToCandidate
} = require('./tiktokKeywordSearch');

const request = {
  discovery: { keywords: 'vocal processor' },
  strategy: { persona_config: { primary_persona: '现场演出型 KOL' } }
};

const officialVideo = {
  aweme_id: '7334621391758642478',
  desc: 'Live vocal processor demo',
  region: 'US',
  author: {
    unique_id: 'demo.creator',
    nickname: 'Demo Creator',
    follower_count: 0
  },
  statistics: { play_count: 0, digg_count: 45, comment_count: 4 }
};

test('builds only the TikTok Keyword Search endpoint', () => {
  const url = buildTikTokKeywordSearchUrl('https://api.scrapecreators.com/v1', 'vocal processor');
  assert.equal(url, 'https://api.scrapecreators.com/v1/tiktok/search/keyword?query=vocal+processor');
  assert.equal(url.includes('/users/search'), false);
  assert.equal(url.includes('/search/hashtag'), false);
  assert.equal(url.includes('/search/top'), false);
});

test('extracts only aweme_info video records', () => {
  assert.deepEqual(
    extractTikTokVideos({ search_item_list: [{ aweme_info: officialVideo }, { type: 1 }] }),
    [officialVideo]
  );
  assert.deepEqual(extractTikTokVideos({ users: [officialVideo] }), []);
  assert.deepEqual(extractTikTokVideos(null), []);
});

test('maps aweme id and author handle to canonical TikTok identities', () => {
  assert.deepEqual(tiktokVideoToCandidate(officialVideo, request), {
    platform: 'tiktok',
    kol_name: 'Demo Creator',
    profile_url: 'https://www.tiktok.com/@demo.creator',
    followers: '0',
    avg_views: '0',
    email: '',
    country_region: 'US',
    matched_keywords: 'vocal processor',
    matched_persona: '现场演出型 KOL',
    representative_video_url: 'https://www.tiktok.com/@demo.creator/video/7334621391758642478',
    representative_video_title: 'Live vocal processor demo',
    evidence_url: 'https://www.tiktok.com/@demo.creator/video/7334621391758642478',
    evidence_title: 'Live vocal processor demo',
    evidence_type: 'video',
    source_query: 'vocal processor',
    reason: 'Matched TikTok Keyword Search: vocal processor',
    raw_data: officialVideo
  });
});

test('rejects missing ids, missing handles, invalid handles, and photo mode', () => {
  assert.equal(tiktokVideoToCandidate({ ...officialVideo, aweme_id: '' }, request), null);
  assert.equal(tiktokVideoToCandidate({ ...officialVideo, author: {} }, request), null);
  assert.equal(tiktokVideoToCandidate({ ...officialVideo, author: { unique_id: '../bad' } }, request), null);
  assert.equal(tiktokVideoToCandidate({ ...officialVideo, image_infos: [{}] }, request), null);
});

test('leaves unavailable provider metadata empty', () => {
  const result = tiktokVideoToCandidate({
    aweme_id: '7334621391758642479',
    author: { unique_id: 'minimal_creator' }
  }, request);
  assert.equal(result.kol_name, 'minimal_creator');
  assert.equal(result.followers, '');
  assert.equal(result.avg_views, '');
  assert.equal(result.country_region, '');
  assert.equal(result.email, '');
});
```

- [ ] **Step 2: Run the unit test and verify it fails**

Run:

```bash
cd server && node --test utils/tiktokKeywordSearch.test.js
```

Expected: FAIL with `Cannot find module './tiktokKeywordSearch'`.

- [ ] **Step 3: Implement the pure TikTok mapper**

Create `server/utils/tiktokKeywordSearch.js`:

```js
function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function firstDefined(...values) {
  const value = values.find((item) => item !== undefined && item !== null && item !== '');
  return clean(value);
}

function buildTikTokKeywordSearchUrl(baseUrl, query) {
  const root = clean(baseUrl).replace(/\/$/, '').replace(/\/v[123]$/, '');
  const url = new URL(`${root}/v1/tiktok/search/keyword`);
  url.searchParams.set('query', clean(query));
  return url.toString();
}

function extractTikTokVideos(data) {
  if (!Array.isArray(data?.search_item_list)) return [];
  return data.search_item_list.map((item) => item?.aweme_info).filter(Boolean);
}

function validTikTokHandle(value) {
  const handle = clean(value);
  return /^[A-Za-z0-9._]{2,24}$/.test(handle)
    && !handle.startsWith('.')
    && !handle.endsWith('.')
    && !handle.includes('..');
}

function tiktokVideoToCandidate(video, request) {
  const videoId = clean(video?.aweme_id || video?.id);
  const author = video?.author || {};
  const handle = clean(author.unique_id || author.username);
  if (!/^\d+$/.test(videoId) || !validTikTokHandle(handle)) return null;
  if (Array.isArray(video?.image_infos) && video.image_infos.length) return null;
  if (clean(video?.content_type) === 'multi_photo') return null;

  const encodedHandle = encodeURIComponent(handle);
  const videoUrl = `https://www.tiktok.com/@${encodedHandle}/video/${videoId}`;
  const profileUrl = `https://www.tiktok.com/@${encodedHandle}`;
  const title = clean(video?.desc || video?.title);
  const query = clean(request?.discovery?.keywords);
  return {
    platform: 'tiktok',
    kol_name: clean(author.nickname || author.display_name || handle),
    profile_url: profileUrl,
    followers: firstDefined(author.follower_count, author.followers),
    avg_views: firstDefined(video?.statistics?.play_count, video?.stats?.play_count, video?.play_count),
    email: '',
    country_region: clean(video?.region || author?.region),
    matched_keywords: query,
    matched_persona: clean(request?.strategy?.persona_config?.primary_persona),
    representative_video_url: videoUrl,
    representative_video_title: title,
    evidence_url: videoUrl,
    evidence_title: title,
    evidence_type: 'video',
    source_query: query,
    reason: `Matched TikTok Keyword Search: ${query}`,
    raw_data: video
  };
}

module.exports = {
  buildTikTokKeywordSearchUrl,
  extractTikTokVideos,
  tiktokVideoToCandidate
};
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
cd server && node --test utils/tiktokKeywordSearch.test.js
```

Expected: 5 tests pass, 0 fail.

- [ ] **Step 5: Commit the pure contract**

```bash
git add server/utils/tiktokKeywordSearch.js server/utils/tiktokKeywordSearch.test.js
git commit -m "test: define TikTok keyword video contract"
```

### Task 2: Wire TikTok Keyword Search into Finder

**Files:**
- Modify: `server/routes/finderTasks.js:1-15`
- Modify: `server/routes/finderTasks.js:1027-1090`

**Interfaces:**
- Consumes: Task 1 exports `buildTikTokKeywordSearchUrl`, `extractTikTokVideos`, `tiktokVideoToCandidate`.
- Produces: existing `scrapeCreatorsFinderAdapterV2(request)` contract with video-backed TikTok candidates.

- [ ] **Step 1: Import the TikTok mapper**

Add beside the Instagram mapper import:

```js
const {
  buildTikTokKeywordSearchUrl,
  extractTikTokVideos,
  tiktokVideoToCandidate
} = require('../utils/tiktokKeywordSearch');
```

- [ ] **Step 2: Replace the old TikTok endpoint fallback block**

After the existing Instagram branch inside `scrapeCreatorsFinderAdapterV2`, replace the three TikTok user/search endpoints and profile mapping with:

```js
const endpoint = buildTikTokKeywordSearchUrl(baseUrl, query);
const data = await fetchJson(endpoint, { headers: { 'x-api-key': setting.api_key } });
lastEndpoint = endpoint;
const videos = extractTikTokVideos(data);
tiktokVideoCount += videos.length;
const mapped = videos
  .map((video) => tiktokVideoToCandidate(video, {
    ...request,
    discovery: { ...request.discovery, keywords: query }
  }))
  .filter(Boolean);
candidates.push(...mapped.slice(0, maxResults - candidates.length));
```

Initialize `let tiktokVideoCount = 0` beside `instagramReelCount`.

- [ ] **Step 3: Add explicit TikTok failure classification**

Replace the generic TikTok zero-candidate fallthrough with:

```js
if (!candidates.length && request.target_platform === 'tiktok') {
  if (tiktokVideoCount === 0) {
    throw new Error('TikTok Keyword Search returned 0 videos. Try shorter or broader Strategy keywords.');
  }
  throw new Error('TikTok Keyword Search returned videos, but none contained valid public video evidence with an identifiable author.');
}
```

Keep the existing Instagram error classification unchanged.

- [ ] **Step 4: Run syntax and focused mapper tests**

Run:

```bash
cd server && node --check routes/finderTasks.js
cd server && node --test utils/tiktokKeywordSearch.test.js utils/instagramReelSearch.test.js
```

Expected: syntax exits 0; 15 mapper tests pass after Task 3 adds five additional TikTok edge cases, or 15 total once the complete plan is implemented.

- [ ] **Step 5: Inspect and commit only intended route hunks**

```bash
git diff -- server/routes/finderTasks.js
git add -p server/routes/finderTasks.js
git commit -m "fix: discover TikTok keyword video evidence"
```

Do not stage pre-existing unrelated route changes.

### Task 3: Automatic Discovery, Error, and Standard-Suite Coverage

**Files:**
- Modify: `server/utils/tiktokKeywordSearch.test.js`
- Modify: `server/routes/finderTasks.test.js`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: `finderTaskRoutes.runVideoEvidenceDiscovery(taskId)` and existing mock ScrapeCreators/AI helpers.
- Produces: regression proof for automatic TikTok discovery through Raw Candidate generation and four explicit failure modes.

- [ ] **Step 1: Add mapper edge-case tests**

Extend `server/utils/tiktokKeywordSearch.test.js`:

```js
test('rejects ids and handles that cannot form canonical TikTok URLs', () => {
  for (const aweme_id of ['abc', '../123', '123?lang=en']) {
    assert.equal(tiktokVideoToCandidate({ ...officialVideo, aweme_id }, request), null);
  }
  for (const unique_id of ['.', '..', '.name', 'name.', 'name..x', 'bad/name', 'bad?name']) {
    assert.equal(tiktokVideoToCandidate({
      ...officialVideo,
      author: { ...officialVideo.author, unique_id }
    }, request), null);
  }
});

test('never trusts provider CDN or profile URLs as evidence identity', () => {
  const result = tiktokVideoToCandidate({
    ...officialVideo,
    url: 'https://v45.tiktokcdn.com/video.mp4',
    profile_url: 'https://www.tiktok.com/@wrong'
  }, request);
  assert.equal(result.representative_video_url, 'https://www.tiktok.com/@demo.creator/video/7334621391758642478');
  assert.equal(result.profile_url, 'https://www.tiktok.com/@demo.creator');
});

test('rejects Photo Mode response variants', () => {
  assert.equal(tiktokVideoToCandidate({ ...officialVideo, image_infos: [{}] }, request), null);
  assert.equal(tiktokVideoToCandidate({ ...officialVideo, content_type: 'multi_photo' }, request), null);
});

test('preserves provider metrics without inventing absent values', () => {
  const zero = tiktokVideoToCandidate(officialVideo, request);
  assert.equal(zero.followers, '0');
  assert.equal(zero.avg_views, '0');
});

test('uses the current query in every candidate reason and source field', () => {
  const result = tiktokVideoToCandidate(officialVideo, request);
  assert.equal(result.source_query, 'vocal processor');
  assert.equal(result.reason, 'Matched TikTok Keyword Search: vocal processor');
});
```

- [ ] **Step 2: Generalize the mock ScrapeCreators setting helper**

In `server/routes/finderTasks.test.js`, replace the Instagram-only helper with:

```js
async function seedMockScrapeCreatorsSettings(port, apiKey = 'scrape-test-key', platform = 'instagram') {
  await models.ApiSetting.create({
    provider: `${platform}.scrapecreators`,
    api_key: apiKey,
    base_url: `http://127.0.0.1:${port}`
  });
}
```

Existing Instagram calls require no change; TikTok tests pass `'tiktok'` as the third argument.

- [ ] **Step 3: Add the automatic TikTok success test**

Add beside the Instagram automatic test:

```js
test('TikTok automatic Keyword Search persists evidence, analyzes it, and aggregates by author', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  await strategy.update({ primary_platform: 'tiktok', product: 'vocal processor' });
  const scrapeApiKey = 'tiktok-test-key';
  const videoA = {
    aweme_id: '7334621391758642478',
    desc: 'Live vocal processor demo',
    region: 'US',
    author: { unique_id: 'demo.creator', nickname: 'Demo Creator', follower_count: 0 },
    statistics: { play_count: 0 }
  };
  const videoB = {
    aweme_id: '7334621391758642479',
    desc: 'Second demo',
    region: 'US',
    author: { unique_id: 'demo.creator', nickname: 'Demo Creator' },
    statistics: { play_count: 6400 }
  };
  const fixture = {
    search_item_list: [
      { aweme_info: videoA },
      { aweme_info: { ...videoA } },
      { aweme_info: videoB }
    ]
  };
  const { server: scrapeServer, port: scrapePort, requests } = await startMockScrapeCreatorsServer((req) => {
    const query = new URL(req.url, 'http://127.0.0.1').searchParams.get('query');
    return { body: query === 'vocal processor' ? fixture : { search_item_list: [] } };
  });
  const { server: aiServer, port: aiPort } = await startMockAiServer();
  await seedMockScrapeCreatorsSettings(scrapePort, scrapeApiKey, 'tiktok');
  await seedMockAiSettings(aiPort);

  try {
    const createRes = await request.post('/api/finder-tasks').send({
      strategy_id: strategy.id,
      target_platform: 'tiktok',
      limit: 10
    });
    const taskId = createRes.body.data.id;
    await finderTaskRoutes.runVideoEvidenceDiscovery(taskId);

    const task = await models.FinderTask.findByPk(taskId);
    assert.equal(task.status, 'success');
    assert.equal(task.success_count, 2);
    assert.equal(task.provider_attempts.includes(scrapeApiKey), false);
    assert.equal(task.raw_response_summary.includes(scrapeApiKey), false);
    for (const item of requests) {
      const url = new URL(item.url, 'http://127.0.0.1');
      assert.equal(url.pathname, '/v1/tiktok/search/keyword');
      assert.ok(url.searchParams.get('query'));
      assert.equal(item.headers['x-api-key'], scrapeApiKey);
      assert.equal(item.headers.authorization, undefined);
    }

    assert.equal(await models.VideoSource.count(), 2);
    assert.equal(await models.FinderVideoEvidence.count(), 2);
    const analyze = await request.post(`/api/finder-tasks/${taskId}/evidence-analysis`).send({});
    assert.equal(analyze.body.data.success_count, 2);
    const generate = await request.post(`/api/finder-tasks/${taskId}/generate-candidates-from-evidence`).send({});
    assert.equal(generate.body.data.inserted_count, 1);
    const candidates = await models.RawCandidate.findAll();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].platform, 'tiktok');
    assert.equal(candidates[0].profile_url, 'https://www.tiktok.com/@demo.creator');
    assert.match(candidates[0].video_url, /^https:\/\/www\.tiktok\.com\/@demo\.creator\/video\/\d+$/);
    assert.notEqual(candidates[0].profile_url, candidates[0].video_url);
    assert.equal(safeParseJson(candidates[0].scoring_breakdown).evidence_count, 2);
  } finally {
    scrapeServer.close();
    aiServer.close();
  }
});
```

- [ ] **Step 4: Add the four TikTok failure-mode tests**

Add this focused helper and four tests to `server/routes/finderTasks.test.js`:

```js
async function createAndRunTikTokTask() {
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  await strategy.update({ primary_platform: 'tiktok', product: 'vocal processor' });
  const createRes = await request.post('/api/finder-tasks').send({
    strategy_id: strategy.id,
    target_platform: 'tiktok'
  });
  const taskId = createRes.body.data.id;
  await finderTaskRoutes.runVideoEvidenceDiscovery(taskId);
  return models.FinderTask.findByPk(taskId);
}

test('TikTok automatic discovery preserves missing configuration errors', async () => {
  await resetTestDatabase();
  await initDatabase();
  const task = await createAndRunTikTokTask();
  assert.equal(task.status, 'failed');
  assert.match(task.error_message, /ScrapeCreators API Key is not configured/);
  assert.match(task.provider_attempts, /ScrapeCreators API Key is not configured/);
});

test('TikTok automatic discovery reports zero Keyword Search videos', async () => {
  await resetTestDatabase();
  await initDatabase();
  const { server, port } = await startMockScrapeCreatorsServer(() => ({
    body: { search_item_list: [] }
  }));
  try {
    await seedMockScrapeCreatorsSettings(port, 'scrape-test-key', 'tiktok');
    const task = await createAndRunTikTokTask();
    assert.equal(task.status, 'failed');
    assert.equal(task.error_message, 'TikTok Keyword Search returned 0 videos. Try shorter or broader Strategy keywords.');
  } finally {
    server.close();
  }
});

test('TikTok automatic discovery preserves upstream HTTP errors', async () => {
  await resetTestDatabase();
  await initDatabase();
  const { server, port } = await startMockScrapeCreatorsServer(() => ({
    status: 503,
    body: { message: 'ScrapeCreators upstream unavailable' }
  }));
  try {
    await seedMockScrapeCreatorsSettings(port, 'scrape-test-key', 'tiktok');
    const task = await createAndRunTikTokTask();
    assert.equal(task.status, 'failed');
    assert.equal(task.error_message, 'ScrapeCreators upstream unavailable');
    assert.match(task.raw_response_summary, /ScrapeCreators upstream unavailable/);
  } finally {
    server.close();
  }
});

test('TikTok automatic discovery reports videos that are all invalid', async () => {
  await resetTestDatabase();
  await initDatabase();
  const { server, port } = await startMockScrapeCreatorsServer(() => ({
    body: {
      search_item_list: [{
        aweme_info: { aweme_id: '7334621391758642478', author: {} }
      }]
    }
  }));
  try {
    await seedMockScrapeCreatorsSettings(port, 'scrape-test-key', 'tiktok');
    const task = await createAndRunTikTokTask();
    assert.equal(task.status, 'failed');
    assert.equal(
      task.error_message,
      'TikTok Keyword Search returned videos, but none contained valid public video evidence with an identifiable author.'
    );
  } finally {
    server.close();
  }
});
```

- [ ] **Step 5: Include all utility tests in the standard server suite**

Change `server/package.json`:

```json
"test": "node --test routes/*.test.js utils/*.test.js"
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd server && node --test utils/tiktokKeywordSearch.test.js
cd server && node --test --test-name-pattern="TikTok automatic" routes/finderTasks.test.js
```

Expected: 10 TikTok utility tests pass; 5 TikTok automatic/error tests pass.

- [ ] **Step 7: Run complete server regression**

Run:

```bash
cd server && npm test
```

Expected: all route, Instagram utility, and TikTok utility tests pass with 0 failures.

- [ ] **Step 8: Inspect and commit only intended test/script hunks**

```bash
git diff --check
git diff -- server/utils/tiktokKeywordSearch.test.js server/routes/finderTasks.test.js server/package.json
git add server/utils/tiktokKeywordSearch.test.js server/package.json
git add -p server/routes/finderTasks.test.js
git commit -m "test: cover TikTok keyword video pipeline"
```

Do not stage pre-existing unrelated test changes.

## Final Verification

- [ ] `rg -n "v1/tiktok/(users|user)/search|v1/tiktok/search[^/]" server/routes/finderTasks.js` finds no active TikTok Finder user/legacy search endpoint.
- [ ] `rg -n "v1/tiktok/search/keyword" server/routes/finderTasks.js server/utils/tiktokKeywordSearch.js` finds the new endpoint contract.
- [ ] A generated TikTok Raw Candidate contains distinct `profile_url` and canonical `video_url`.
- [ ] Duplicate `aweme_id` values create one video source; two distinct videos from one author generate one Raw Candidate.
- [ ] Missing configuration, upstream HTTP error, zero videos, and all-invalid responses remain distinguishable.
- [ ] Existing YouTube and Instagram tests continue to pass.
- [ ] No API keys appear in Finder task attempts, response summaries, logs, or test output.
- [ ] No user data, migration, UI, scoring, approval route, or pagination behavior changed.
