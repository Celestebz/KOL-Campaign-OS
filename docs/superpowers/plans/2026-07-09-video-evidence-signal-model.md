# Video Evidence Signal Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the C1-C7 execution model and make target-platform video evidence with multi-label AI signals the only Finder workflow.

**Architecture:** Replace Cycle-shaped strategy and task contracts at the API boundary, then remove their persistence and UI. Evidence analysis owns final `evidence_signals`; discovery provenance remains separate. A destructive forward migration clears business records while preserving runtime configuration.

**Tech Stack:** Node.js, Express, Sequelize/MySQL, React/Ant Design, Node test runner/Supertest.

---

### Task 1: Destructive schema replacement

**Files:**
- Create: `server/migrations/20260709000001-replace-cycles-with-evidence-signals.js`
- Modify: `server/models/KolStrategy.js`
- Modify: `server/models/FinderTask.js`
- Modify: `server/models/RawCandidate.js`
- Modify: `server/models/VideoAiAnalysisResult.js`
- Test: `server/routes/finderTasks.test.js`

- [ ] **Step 1: Write a migration test that seeds configuration and business rows**

Assert that `api_settings`, `prompt_templates`, and `customer_groups` survive while every business table is empty.

- [ ] **Step 2: Run the migration test and verify it fails**

Run: `cd server && node --test routes/finderTasks.test.js`
Expected: FAIL because the replacement migration and `evidence_signals` column do not exist.

- [ ] **Step 3: Add the forward migration**

The migration must disable foreign-key checks inside a guarded transaction, truncate:

```js
const BUSINESS_TABLES = [
  'analysis_job_items', 'analysis_jobs', 'campaign_kols', 'campaign_videos',
  'raw_candidates', 'finder_video_evidence', 'video_ai_analysis_results',
  'video_comments', 'video_snapshots', 'video_sources', 'finder_tasks',
  'kol_platform_accounts', 'customers', 'kol_strategies', 'campaigns'
];
```

Then drop `kol_strategies.search_strategy`, the four Cycle columns on
`finder_tasks`, and `raw_candidates.search_cycle`; add
`video_ai_analysis_results.evidence_signals LONGTEXT`.

- [ ] **Step 4: Remove dropped fields from Sequelize models**

Models must exactly match the migrated schema and must not expose compatibility
Cycle properties.

- [ ] **Step 5: Run the migration test**

Run: `cd server && node --test routes/finderTasks.test.js`
Expected: PASS for configuration preservation and empty business tables.

- [ ] **Step 6: Commit**

```text
git add server/migrations server/models server/routes/finderTasks.test.js
git commit -m "refactor: replace cycle persistence with evidence signals"
```

### Task 2: Replace the strategy contract

**Files:**
- Modify: `server/routes/kolStrategies.js`
- Modify: `server/routes/agent.js`
- Modify: `server/models/KolStrategy.js`
- Test: `server/routes/kolStrategies.test.js`

- [ ] **Step 1: Add failing strategy contract tests**

Test that a strategy accepts product/persona/scoring/Finder guidance without
`search_strategy`, and rejects payload keys `search_strategy`, `cycles`, and
`search_cycles` with HTTP 400.

- [ ] **Step 2: Run the tests and verify failure**

Run: `cd server && node --test routes/kolStrategies.test.js`
Expected: FAIL because the API still normalizes seven cycles.

- [ ] **Step 3: Remove Cycle normalization and persistence**

Delete `CYCLE_ORDER`, `DEFAULT_SEARCH_CYCLES`, `normalizeSearchStrategy`, and
`searchStrategyJson`. Add one shared guard:

```js
function rejectLegacyCycleFields(body = {}) {
  const legacy = ['search_strategy', 'cycles', 'search_cycles', 'search_intensity']
    .filter((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (legacy.length) {
    const error = new Error(`Legacy Cycle fields are no longer supported: ${legacy.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
}
```

Apply it to strategy and agent write endpoints.

- [ ] **Step 4: Run strategy tests**

Run: `cd server && node --test routes/kolStrategies.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```text
git add server/routes/kolStrategies.js server/routes/agent.js server/models/KolStrategy.js server/routes/kolStrategies.test.js
git commit -m "refactor: remove cycle strategy contract"
```

### Task 3: Make Video Evidence Finder the only task mode

**Files:**
- Modify: `server/routes/finderTasks.js`
- Modify: `server/routes/agent.js`
- Test: `server/routes/finderTasks.test.js`

- [ ] **Step 1: Add failing Finder contract tests**

Cover exactly one `target_platform`, rejection of arrays with multiple targets,
rejection of Cycle/intensity/route/subagent fields, platform-matched evidence,
and absence of Cycle task expansion.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd server && node --test routes/finderTasks.test.js`
Expected: FAIL on legacy field rejection and single-platform validation.

- [ ] **Step 3: Replace task creation**

The accepted body is:

```json
{
  "strategy_id": 1,
  "target_platform": "youtube",
  "limit": 10
}
```

Always start `processVideoEvidenceTask` with `targetPlatforms:
[targetPlatform]`. Remove `processTask`, Cycle selection, search intensity,
subagent hybrid, route matrices, C7 deferral, and direct Raw Candidate import
capabilities.

- [ ] **Step 4: Run Finder tests**

Run: `cd server && node --test routes/finderTasks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```text
git add server/routes/finderTasks.js server/routes/agent.js server/routes/finderTasks.test.js
git commit -m "refactor: make video evidence finder the only workflow"
```

### Task 4: Add multi-label AI evidence signals

**Files:**
- Modify: `server/routes/finderTasks.js`
- Modify: `server/models/VideoAiAnalysisResult.js`
- Test: `server/routes/finderTasks.test.js`

- [ ] **Step 1: Add failing multi-label tests**

Mock AI returning:

```json
{
  "evidence_signals": [
    {"signal": "competitor", "reason": "Compares a competing product"},
    {"signal": "feature", "reason": "Demonstrates the required feature"}
  ]
}
```

Assert both labels persist. Assert unknown labels are removed and duplicate
labels collapse to one.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd server && node --test routes/finderTasks.test.js`
Expected: FAIL because analysis does not normalize multi-label signals.

- [ ] **Step 3: Implement strict signal normalization**

```js
const EVIDENCE_SIGNALS = new Set(['competitor', 'category', 'use_case', 'feature', 'community']);

function normalizeEvidenceSignals(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const signal = clean(typeof item === 'string' ? item : item?.signal).toLowerCase();
    if (!EVIDENCE_SIGNALS.has(signal) || seen.has(signal)) return [];
    seen.add(signal);
    return [{ signal, reason: clean(item?.reason) }];
  });
}
```

Store the normalized array in `evidence_signals` and include it in evidence-list
responses and candidate evidence summaries.

- [ ] **Step 4: Run Finder tests**

Run: `cd server && node --test routes/finderTasks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```text
git add server/routes/finderTasks.js server/models/VideoAiAnalysisResult.js server/routes/finderTasks.test.js
git commit -m "feat: classify video evidence with multiple signals"
```

### Task 5: Remove the legacy UI

**Files:**
- Modify: `client/src/pages/KolStrategy.js`
- Modify: `client/src/pages/RawCandidates.js`
- Test: `client/src/pages/RawCandidates.test.js`

- [ ] **Step 1: Add UI tests for the simplified task form**

Assert the form contains strategy, one target platform, and limit; assert it
does not render Cycle, search intensity, C7, route, or execution-mode controls.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd client && npm test -- --watchAll=false`
Expected: FAIL because legacy controls are present.

- [ ] **Step 3: Simplify Strategy and Finder screens**

Remove seven-cycle JSON editing and all Cycle helpers. Post:

```js
await axios.post('/api/finder-tasks', {
  strategy_id: values.strategy_id,
  target_platform: values.target_platform,
  limit: Number(values.limit || 10)
});
```

Render `evidence_signals` as multiple tags on each evidence row.

- [ ] **Step 4: Run client tests and build**

Run: `cd client && npm test -- --watchAll=false`
Expected: PASS.

Run: `cd client && npm run build`
Expected: successful production build.

- [ ] **Step 5: Commit**

```text
git add client/src/pages/KolStrategy.js client/src/pages/RawCandidates.js client/src/pages/RawCandidates.test.js
git commit -m "refactor: remove cycle controls from finder UI"
```

### Task 6: Replace all active agent instructions

**Files:**
- Modify: `skills/kol-strategy/SKILL.md`
- Modify: `skills/kol-strategy/references/strategy-output-schema.md`
- Modify: `skills/kol-strategy/agents/openai.yaml`
- Modify: `skills/kol-finder/SKILL.md`
- Modify: `skills/kol-campaign-os-agent/SKILL.md`
- Modify: `skills/kol-campaign-os-agent/agents/openai.yaml`
- Delete: `server/scratch_db.js`
- Delete: `server/submit_candidates.js`

- [ ] **Step 1: Rewrite the strategy and Finder contracts**

Document only target-platform video discovery and post-analysis multi-label
signals. Remove all C1-C7, Cycle, route matrix, search intensity, hybrid, and
direct candidate-import instructions.

- [ ] **Step 2: Remove legacy scripts**

Delete scripts that bypass the evidence-first API workflow.

- [ ] **Step 3: Verify repository text**

Run:

```text
rg -n -i "C1|C2|C3|C4|C5|C6|C7|cycle|search_intensity|subagent_hybrid|cycle_multi_route" server client/src skills
```

Expected: no active workflow references; migration/spec/history references may
be explicitly allow-listed.

- [ ] **Step 4: Reinstall active skills**

Run:

```text
npm run install-skills -- --target C:\Users\USER\.codex\skills
npm run install-skills -- --target C:\Users\USER\.agents\skills
npm run install-skills -- --target C:\Users\USER\.config\agents\skills
```

Expected: all three installations complete successfully.

- [ ] **Step 5: Commit**

```text
git add skills server/scratch_db.js server/submit_candidates.js
git commit -m "docs: retire legacy cycle agent workflow"
```

### Task 7: Full verification and controlled business-data reset

**Files:**
- Modify only if verification exposes a defect in files already scoped above.

- [ ] **Step 1: Run all server tests**

Run: `cd server && npm test`
Expected: all tests pass.

- [ ] **Step 2: Run client tests and build**

Run: `cd client && npm test -- --watchAll=false`
Expected: all tests pass.

Run: `cd client && npm run build`
Expected: successful production build.

- [ ] **Step 3: Apply the reviewed migration**

Run: `cd server && npm run db:migrate` with the configured development
database.
Expected: replacement migration succeeds once and preserves configuration.

- [ ] **Step 4: Verify table counts**

Query all preserved and cleared tables. Expected: business tables contain zero
rows; `api_settings`, `prompt_templates`, and `customer_groups` retain their
pre-migration counts.

- [ ] **Step 5: Run a clean smoke flow**

Create one campaign and strategy, start one target-platform Finder task, import
one matching video, analyze it into at least two signals, and generate one Raw
Candidate. Expected: no request, response, UI, or database row contains Cycle
execution data.

- [ ] **Step 6: Commit verification fixes if any**

```text
git add <only files changed to resolve verification defects>
git commit -m "fix: complete video evidence workflow verification"
```
