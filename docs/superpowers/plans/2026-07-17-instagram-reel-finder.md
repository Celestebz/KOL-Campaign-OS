# Instagram Reel Finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Instagram Profile Search with public Reel keyword search so Instagram evidence can reuse the existing YouTube-style Finder pipeline through Raw Candidates.

**Architecture:** Add a small pure Instagram Reel response mapper under `server/utils` so third-party response handling can be tested without a database or network. Update only the Instagram branch of the existing ScrapeCreators Finder adapter to call `/v2/instagram/reels/search`; keep TikTok, task creation, evidence persistence, AI scoring, author aggregation, and approval behavior unchanged.

**Tech Stack:** Node.js 18+, CommonJS, Express, native `fetch`, Node test runner, Supertest, MySQL/Sequelize integration tests.

## Global Constraints

- First version supports public Instagram Reels only.
- Do not call Instagram Profile Search.
- Do not add ordinary Instagram Post search or Profile-to-content enrichment.
- Do not modify YouTube or TikTok discovery behavior.
- Do not change Finder request fields, scoring thresholds, Raw Candidate generation, or human approval behavior.
- Profile URLs are author identity only and must never be used as `video_url`.
- Do not invent author, follower, country, engagement, or contact data when provider fields are absent.
- Do not delete user data or historical Finder records.
- Preserve all unrelated pre-existing working-tree changes, especially overlapping edits in `server/routes/finderTasks.js` and `server/routes/finderTasks.test.js`.

---

## File Structure

- Create `server/utils/instagramReelSearch.js`: pure URL builder, response extraction, and Reel-to-Finder-candidate mapping.
- Create `server/utils/instagramReelSearch.test.js`: fast unit contract for endpoint construction, field mapping, missing fields, and invalid records.
- Modify `server/routes/finderTasks.js`: route the Instagram ScrapeCreators branch through Reel Search and the pure mapper; leave TikTok branch intact.
- Modify `server/routes/finderTasks.test.js`: add an Instagram downstream regression proving a mapped Reel remains valid evidence and produces one author-level candidate.

### Task 1: Pure Instagram Reel Search Contract

**Files:**
- Create: `server/utils/instagramReelSearch.js`
- Create: `server/utils/instagramReelSearch.test.js`

**Interfaces:**
- Consumes: ScrapeCreators response shape `{ reels: Array<object> }` and the existing Finder request shape `{ discovery, strategy }`.
- Produces: `buildInstagramReelSearchUrl(baseUrl, query): string`, `extractInstagramReels(data): object[]`, and `instagramReelToCandidate(reel, request): object | null`.

- [ ] **Step 1: Write failing unit tests for endpoint and mapping**

Create `server/utils/instagramReelSearch.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildInstagramReelSearchUrl,
  extractInstagramReels,
  instagramReelToCandidate
} = require('./instagramReelSearch');

const request = {
  discovery: { keywords: 'vocal processor' },
  strategy: { persona_config: { primary_persona: '现场演出型 KOL' } }
};

test('builds the public Instagram Reel keyword-search endpoint', () => {
  assert.equal(
    buildInstagramReelSearchUrl('https://api.scrapecreators.com/v1', 'vocal processor'),
    'https://api.scrapecreators.com/v2/instagram/reels/search?query=vocal+processor'
  );
});

test('maps a public Reel and its owner to existing Finder candidate fields', () => {
  const reel = {
    id: '3723045213787686915',
    shortcode: 'DOq6eV6iIgD',
    url: 'https://www.instagram.com/reel/DOq6eV6iIgD/',
    caption: 'Live vocal processor demo',
    play_count: 12000,
    owner: {
      id: '12345',
      username: 'demo_creator',
      full_name: 'Demo Creator',
      follower_count: 188406
    }
  };

  assert.deepEqual(instagramReelToCandidate(reel, request), {
    platform: 'instagram',
    kol_name: 'Demo Creator',
    profile_url: 'https://www.instagram.com/demo_creator/',
    followers: '188406',
    avg_views: '12000',
    email: '',
    country_region: '',
    matched_keywords: 'vocal processor',
    matched_persona: '现场演出型 KOL',
    representative_video_url: 'https://www.instagram.com/reel/DOq6eV6iIgD/',
    representative_video_title: 'Live vocal processor demo',
    evidence_url: 'https://www.instagram.com/reel/DOq6eV6iIgD/',
    evidence_title: 'Live vocal processor demo',
    evidence_type: 'video',
    source_query: 'vocal processor',
    reason: 'Matched Instagram Reel search: vocal processor',
    raw_data: reel
  });
});

test('extracts only the documented reels array', () => {
  const reel = { url: 'https://www.instagram.com/reel/abc/' };
  assert.deepEqual(extractInstagramReels({ reels: [reel] }), [reel]);
  assert.deepEqual(extractInstagramReels({ users: [reel] }), []);
  assert.deepEqual(extractInstagramReels(null), []);
});

test('rejects profile URLs and records without an identifiable owner', () => {
  assert.equal(instagramReelToCandidate({
    url: 'https://www.instagram.com/demo_creator/',
    owner: { username: 'demo_creator' }
  }, request), null);
  assert.equal(instagramReelToCandidate({
    url: 'https://www.instagram.com/reel/abc/'
  }, request), null);
});

test('leaves unavailable public metadata empty instead of inventing it', () => {
  const result = instagramReelToCandidate({
    url: 'https://www.instagram.com/reel/abc/',
    caption: 'Demo',
    user: { username: 'minimal_creator' }
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
cd server && node --test utils/instagramReelSearch.test.js
```

Expected: FAIL with `Cannot find module './instagramReelSearch'`.

- [ ] **Step 3: Implement the pure mapper**

Create `server/utils/instagramReelSearch.js`:

```js
function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function buildInstagramReelSearchUrl(baseUrl, query) {
  const root = clean(baseUrl)
    .replace(/\/$/, '')
    .replace(/\/v[12]$/, '');
  const url = new URL(`${root}/v2/instagram/reels/search`);
  url.searchParams.set('query', clean(query));
  return url.toString();
}

function extractInstagramReels(data) {
  return Array.isArray(data?.reels) ? data.reels : [];
}

function isInstagramReelUrl(value) {
  try {
    const url = new URL(clean(value));
    return /(^|\.)instagram\.com$/i.test(url.hostname) && /^\/reel\/[^/]+/i.test(url.pathname);
  } catch (error) {
    return false;
  }
}

function instagramReelToCandidate(reel, request) {
  const owner = reel?.owner || reel?.user || reel?.author || {};
  const username = clean(owner.username || owner.handle || reel?.username);
  const videoUrl = clean(reel?.url || reel?.video_url || reel?.post_url);
  if (!isInstagramReelUrl(videoUrl) || !username) return null;

  const title = clean(reel?.caption || reel?.title || reel?.description);
  const query = clean(request?.discovery?.keywords);
  return {
    platform: 'instagram',
    kol_name: clean(owner.full_name || owner.name || username),
    profile_url: `https://www.instagram.com/${username}/`,
    followers: clean(owner.follower_count || owner.followers_count || owner.followers),
    avg_views: clean(reel?.play_count || reel?.view_count || reel?.views),
    email: '',
    country_region: clean(owner.country || owner.region),
    matched_keywords: query,
    matched_persona: clean(request?.strategy?.persona_config?.primary_persona),
    representative_video_url: videoUrl,
    representative_video_title: title,
    evidence_url: videoUrl,
    evidence_title: title,
    evidence_type: 'video',
    source_query: query,
    reason: `Matched Instagram Reel search: ${query}`,
    raw_data: reel
  };
}

module.exports = {
  buildInstagramReelSearchUrl,
  extractInstagramReels,
  instagramReelToCandidate
};
```

- [ ] **Step 4: Run unit tests and verify they pass**

Run:

```bash
cd server && node --test utils/instagramReelSearch.test.js
```

Expected: 5 tests pass, 0 fail.

- [ ] **Step 5: Commit the pure contract**

```bash
git add server/utils/instagramReelSearch.js server/utils/instagramReelSearch.test.js
git commit -m "test: define Instagram Reel search contract"
```

### Task 2: Wire Reel Search into the Existing Finder Adapter

**Files:**
- Modify: `server/routes/finderTasks.js:1-10`
- Modify: `server/routes/finderTasks.js:1058-1111`

**Interfaces:**
- Consumes: Task 1 exports `buildInstagramReelSearchUrl`, `extractInstagramReels`, and `instagramReelToCandidate`.
- Produces: the existing `scrapeCreatorsFinderAdapterV2(request): Promise<{ provider, endpoint, candidates }>` contract with video-backed Instagram candidates.

- [ ] **Step 1: Add a regression assertion that the old Profile Search path is absent**

Extend `server/utils/instagramReelSearch.test.js`:

```js
test('never constructs the legacy Instagram Profile Search endpoint', () => {
  const url = buildInstagramReelSearchUrl('https://api.scrapecreators.com', 'creator tools');
  assert.equal(url.includes('/instagram/search/profiles'), false);
  assert.equal(url.includes('/v2/instagram/reels/search'), true);
});
```

- [ ] **Step 2: Run the focused test before adapter wiring**

Run:

```bash
cd server && node --test utils/instagramReelSearch.test.js
```

Expected: 6 tests pass. This locks the endpoint contract before modifying the shared route file.

- [ ] **Step 3: Import the mapper into the Finder route**

At the top of `server/routes/finderTasks.js`, add:

```js
const {
  buildInstagramReelSearchUrl,
  extractInstagramReels,
  instagramReelToCandidate
} = require('../utils/instagramReelSearch');
```

- [ ] **Step 4: Replace only the Instagram branch in `scrapeCreatorsFinderAdapterV2`**

Preserve the existing TikTok code. Inside the keyword loop, use this branch before the current TikTok endpoint list:

```js
if (request.target_platform === 'instagram') {
  const endpoint = buildInstagramReelSearchUrl(baseUrl, query);
  const data = await fetchJson(endpoint, { headers });
  lastEndpoint = endpoint;
  const mapped = extractInstagramReels(data)
    .map((reel) => instagramReelToCandidate(reel, {
      ...request,
      discovery: { ...request.discovery, keywords: query }
    }))
    .filter(Boolean);
  candidates.push(...mapped.slice(0, maxResults - candidates.length));
  continue;
}

const endpoints = [
  buildUrl(baseUrl, '/v1/tiktok/search', { query, limit: maxResults }),
  buildUrl(baseUrl, '/v1/tiktok/users/search', { query, limit: maxResults }),
  buildUrl(baseUrl, '/v1/tiktok/user/search', { query, limit: maxResults })
];
```

Keep the existing TikTok mapping below that branch. Update the zero-result message so Instagram reports `ScrapeCreators returned 0 usable Instagram Reels. Try shorter Strategy keywords.` and TikTok retains its existing meaning.

- [ ] **Step 5: Run focused and syntax checks**

Run:

```bash
cd server && node --check routes/finderTasks.js
cd server && node --test utils/instagramReelSearch.test.js
```

Expected: syntax check exits 0; 6 unit tests pass.

- [ ] **Step 6: Commit adapter wiring**

Before staging, inspect the overlapping user edits:

```bash
git diff -- server/routes/finderTasks.js
```

Stage only the intended import and Instagram adapter hunks, preserving unrelated changes:

```bash
git add -p server/routes/finderTasks.js
git commit -m "fix: discover Instagram Reel evidence"
```

### Task 3: Prove Instagram Evidence Reuses the Existing Downstream Pipeline

**Files:**
- Modify: `server/routes/finderTasks.test.js`

**Interfaces:**
- Consumes: existing `POST /api/finder-tasks/:id/video-evidence/import`, `POST /api/finder-tasks/:id/evidence-analysis`, and `POST /api/finder-tasks/:id/generate-candidates-from-evidence` endpoints.
- Produces: regression coverage that one Instagram author with duplicate-equivalent Reel evidence generates one Raw Candidate containing both Profile and Reel identity.

- [ ] **Step 1: Add the Instagram end-to-end regression**

Add a test beside the existing YouTube video-evidence end-to-end test in `server/routes/finderTasks.test.js`:

```js
test('Instagram Reel evidence reuses the existing analysis and candidate pipeline', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  await models.KolStrategy.update(
    { primary_platform: 'instagram' },
    { where: { id: strategy.id } }
  );
  const { server: mockServer, port } = await startMockAiServer();
  await seedMockAiSettings(port);

  try {
    const createRes = await request.post('/api/finder-tasks').send({
      strategy_id: strategy.id,
      target_platform: 'instagram'
    });
    const taskId = createRes.body.data.id;
    const profileUrl = 'https://www.instagram.com/demo_creator/';

    const importRes = await request
      .post(`/api/finder-tasks/${taskId}/video-evidence/import`)
      .send({ evidence: [{
        video_url: 'https://www.instagram.com/reel/DOq6eV6iIgD/',
        title: 'Live vocal processor demo',
        author_name: 'Demo Creator',
        author_profile_url: profileUrl,
        source_query: 'vocal processor'
      }] });
    assert.equal(importRes.status, 200);
    assert.equal(importRes.body.data.inserted, 1);

    const analyzeRes = await request
      .post(`/api/finder-tasks/${taskId}/evidence-analysis`)
      .send({});
    assert.equal(analyzeRes.status, 200);
    assert.equal(analyzeRes.body.data.success_count, 1);

    const generateRes = await request
      .post(`/api/finder-tasks/${taskId}/generate-candidates-from-evidence`)
      .send({});
    assert.equal(generateRes.status, 200);
    assert.equal(generateRes.body.data.inserted_count, 1);

    const candidates = await models.RawCandidate.findAll();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].platform, 'instagram');
    assert.equal(candidates[0].profile_url, profileUrl);
    assert.equal(candidates[0].video_url, 'https://www.instagram.com/reel/DOq6eV6iIgD/');
  } finally {
    mockServer.close();
  }
});
```

- [ ] **Step 2: Run the new integration test**

Run:

```bash
cd server && node --test --test-name-pattern="Instagram Reel evidence" routes/finderTasks.test.js
```

Expected: the new Instagram test passes. If MySQL is unavailable, start the existing test database with `npm run db:up` from the repository root and rerun; do not replace the database-backed test with mocks.

- [ ] **Step 3: Run Finder route regression tests**

Run:

```bash
cd server && node --test routes/finderTasks.test.js
```

Expected: all Finder route tests pass, including existing YouTube coverage.

- [ ] **Step 4: Run the complete server suite**

Run:

```bash
cd server && npm test
```

Expected: all server route tests pass with 0 failures.

- [ ] **Step 5: Inspect the final diff for scope and user-change preservation**

Run:

```bash
git diff --check
git status --short
git diff -- server/utils/instagramReelSearch.js server/utils/instagramReelSearch.test.js server/routes/finderTasks.js server/routes/finderTasks.test.js
```

Expected: no whitespace errors; only Instagram Reel discovery, its mapper, and its tests are part of this work. Pre-existing unrelated changes remain present and unmodified.

- [ ] **Step 6: Commit the downstream regression separately**

Stage only the new Instagram test hunk because `server/routes/finderTasks.test.js` already contains user changes:

```bash
git add -p server/routes/finderTasks.test.js
git commit -m "test: cover Instagram Reel Finder pipeline"
```

## Final Verification

- [ ] Confirm `rg -n "instagram/search/profiles" server/routes/finderTasks.js` returns no active Instagram Finder endpoint.
- [ ] Confirm `rg -n "v2/instagram/reels/search" server/routes/finderTasks.js server/utils/instagramReelSearch.js` finds the new endpoint contract.
- [ ] Confirm a Raw Candidate produced from Instagram evidence contains both `profile_url` and `video_url`.
- [ ] Confirm existing YouTube Finder tests still pass.
- [ ] Confirm no Profile URL can enter `video_url`.
- [ ] Confirm no user data, migration, UI, TikTok adapter, or approval route changed.
