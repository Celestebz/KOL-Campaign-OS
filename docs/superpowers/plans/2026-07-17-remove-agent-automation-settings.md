# Remove Agent Automation Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `youtube.maton_gateway` the only active Maton configuration, remove Agent Automation settings, and safely migrate then delete legacy `agent.*` provider records.

**Architecture:** Add one forward migration that copies `agent.maton_gateway` only when the canonical YouTube row is absent, then removes obsolete automation rows. Settings and Finder become consumers of platform-provider configuration only; the external-agent access token remains separate under `agent.external_api`.

**Tech Stack:** Node.js, Express, Sequelize/Umzug, MySQL 8, React, Ant Design, Node test runner, React Testing Library.

## Global Constraints

- Existing `youtube.maton_gateway` values must never be overwritten.
- If canonical configuration is absent, copy legacy Maton values before deleting the legacy row.
- Delete only obsolete automation keys: `agent.maton_gateway`, `agent.browseract`, `agent.playwright_local`, and `agent.custom_tool_gateway`.
- Preserve `agent.external_api`; it is the external-agent access credential.
- Finder must never read `agent.maton_gateway` after this change.
- Do not delete business data or user data files.

---

### Task 1: Migrate Legacy Agent Provider Configuration

**Files:**
- Create: `server/migrations/20260717000001-remove-agent-automation-settings.js`
- Create: `server/routes/agentAutomationMigration.test.js`

**Interfaces:**
- Consumes: Sequelize `queryInterface` and the existing `api_settings(provider, api_key, base_url, model, extra_config)` table.
- Produces: migration exports `up(queryInterface)` and `down()`; canonical row key is `youtube.maton_gateway`.

- [ ] **Step 1: Write failing migration tests**

Create tests using the project test database that prove:

```js
test('copies legacy Maton config only when canonical YouTube config is missing', async () => {
  await ApiSetting.create({ provider: 'agent.maton_gateway', api_key: 'legacy-key', base_url: 'https://legacy.example' });
  await migration.up(sequelize.getQueryInterface());
  const canonical = await ApiSetting.findOne({ where: { provider: 'youtube.maton_gateway' } });
  assert.equal(canonical.api_key, 'legacy-key');
  assert.equal(await ApiSetting.count({ where: { provider: 'agent.maton_gateway' } }), 0);
});

test('preserves canonical Maton config and deletes legacy automation rows', async () => {
  await ApiSetting.bulkCreate([
    { provider: 'youtube.maton_gateway', api_key: 'canonical-key' },
    { provider: 'agent.maton_gateway', api_key: 'legacy-key' },
    { provider: 'agent.browseract', api_key: 'browser-key' },
    { provider: 'agent.external_api', api_key: 'access-token' }
  ]);
  await migration.up(sequelize.getQueryInterface());
  const canonical = await ApiSetting.findOne({ where: { provider: 'youtube.maton_gateway' } });
  assert.equal(canonical.api_key, 'canonical-key');
  assert.equal(await ApiSetting.count({ where: { provider: 'agent.maton_gateway' } }), 0);
  assert.equal(await ApiSetting.count({ where: { provider: 'agent.browseract' } }), 0);
  assert.equal(await ApiSetting.count({ where: { provider: 'agent.external_api' } }), 1);
});
```

- [ ] **Step 2: Run migration tests and verify RED**

Run: `cd server && node --test routes/agentAutomationMigration.test.js`

Expected: FAIL because the migration module does not exist.

- [ ] **Step 3: Implement the forward migration**

Use a transaction. Lock/read both Maton keys, insert canonical values only when no canonical row exists, then delete only the four obsolete automation keys. Make `down()` a documented no-op because deleted duplicate settings cannot be reconstructed safely.

- [ ] **Step 4: Run migration tests and verify GREEN**

Run: `cd server && node --test routes/agentAutomationMigration.test.js`

Expected: 2 tests pass, 0 fail.

- [ ] **Step 5: Commit Task 1**

```bash
git add server/migrations/20260717000001-remove-agent-automation-settings.js server/routes/agentAutomationMigration.test.js
git commit -m "refactor: migrate legacy agent provider settings"
```

### Task 2: Remove Agent Providers From Settings and Finder

**Files:**
- Modify: `server/routes/settings.js`
- Modify: `server/routes/settings.test.js`
- Modify: `server/routes/finderTasks.js`
- Modify: `server/routes/finderTasks.test.js`

**Interfaces:**
- Consumes: `system.provider_selection.platforms.youtube.primary` and `youtube.maton_gateway`.
- Produces: settings payload without `agents`; Finder Maton adapter reads the canonical platform key only.

- [ ] **Step 1: Add failing settings contract tests**

Add assertions:

```js
assert.equal(Object.prototype.hasOwnProperty.call(data, 'agents'), false);
assert.equal(JSON.stringify(data).includes('browseract'), false);
```

For POST settings, submit an `agents` object and assert no write parameter starts with `agent.` except the preserved `agent.external_api` write.

- [ ] **Step 2: Add a failing Finder canonical-key test**

Configure only `youtube.maton_gateway`, select it as YouTube primary, intercept the provider lookup, and assert Finder never requests `agent.maton_gateway`.

- [ ] **Step 3: Run focused route tests and verify RED**

Run: `cd server && node --test routes/settings.test.js routes/finderTasks.test.js`

Expected: FAIL because settings still expose/write `agents` and Finder still requests `agent.maton_gateway` first.

- [ ] **Step 4: Remove server Agent Automation configuration**

Delete `AGENT_PROVIDERS`, `DEFAULT_SELECTION.agents`, settings response `agents`, POST selection `agents`, provider read/write loops, and health-check `agent`. Preserve all `agent.external_api` handling.

- [ ] **Step 5: Make Finder read canonical Maton configuration**

Change Maton lookup to:

```js
const setting = await getSetting(providerKey('youtube', 'maton_gateway'));
```

Remove the `scope === 'agent'` Maton legacy-key branch. Keep platform selection mapping from `maton_gateway` to the internal search-source label if that label is still required by task records.

- [ ] **Step 6: Run focused route tests and verify GREEN**

Run: `cd server && node --test routes/settings.test.js routes/finderTasks.test.js`

Expected: all focused tests pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add server/routes/settings.js server/routes/settings.test.js server/routes/finderTasks.js server/routes/finderTasks.test.js
git commit -m "refactor: remove agent automation provider runtime"
```

### Task 3: Remove Agent Automation UI

**Files:**
- Modify: `client/src/pages/Settings.js`
- Create: `client/src/pages/Settings.test.js`

**Interfaces:**
- Consumes: settings response containing `platforms`, `aiModels`, `externalAgent`, `cloudStorage`, and `fallbackStrategy`.
- Produces: Settings UI without Agent Automation controls; External Agent API remains visible for later Agent Access redesign.

- [ ] **Step 1: Write the failing UI test**

Mock `GET /api/settings`, render Settings, and assert:

```js
expect(screen.queryByText('Agent 自动化')).not.toBeInTheDocument();
expect(screen.queryByText(/BrowserAct/)).not.toBeInTheDocument();
expect(screen.queryByText(/Playwright Local/)).not.toBeInTheDocument();
expect(screen.getByText('External Agent API')).toBeInTheDocument();
expect(screen.getByText('Maton Gateway')).toBeInTheDocument();
```

- [ ] **Step 2: Run the UI test and verify RED**

Run: `cd client && CI=true npm test -- --runInBand Settings.test.js`

Expected: FAIL because Agent Automation is rendered.

- [ ] **Step 3: Remove Agent Automation form state and markup**

Delete `AGENT_OPTIONS`, `DEFAULT_SETTINGS.agents`, Agent-only provider labels, and the entire Agent Automation card. Keep Maton under YouTube `PLATFORM_OPTIONS` and keep External Agent API unchanged.

- [ ] **Step 4: Run the UI test and build**

Run: `cd client && CI=true npm test -- --runInBand Settings.test.js`

Expected: test passes.

Run: `npm run build`

Expected: production build succeeds with no compilation errors.

- [ ] **Step 5: Run full server regression tests**

Run: `cd server && npm test`

Expected: all server tests pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add client/src/pages/Settings.js client/src/pages/Settings.test.js
git commit -m "refactor: remove agent automation settings UI"
```

### Task 4: Verify Migration Against Local Configuration

**Files:**
- No code changes expected.

**Interfaces:**
- Consumes: local MySQL `api_settings` rows.
- Produces: evidence that canonical Maton remains configured and obsolete agent automation rows are absent.

- [ ] **Step 1: Record non-secret pre-migration state**

Query provider names and booleans indicating whether credentials exist. Do not print credential values.

- [ ] **Step 2: Run project migrations**

Run: `cd server && npm run db:migrate`

Expected: migration succeeds.

- [ ] **Step 3: Verify non-secret post-migration state**

Confirm:

```text
youtube.maton_gateway exists and remains configured
agent.maton_gateway does not exist
agent.browseract does not exist
agent.playwright_local does not exist
agent.custom_tool_gateway does not exist
agent.external_api remains unchanged
```

- [ ] **Step 4: Final verification**

Run focused tests, full server tests, client test, client build, `git diff --check`, and inspect `git status` to ensure unrelated user changes remain untouched.
