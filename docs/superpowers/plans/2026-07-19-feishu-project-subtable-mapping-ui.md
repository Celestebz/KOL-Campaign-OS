# Feishu Project Subtable Mapping UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the handwritten Feishu project-subtable mapping text with a validated row editor bound to existing system campaigns, and remove the default-table fallback from synchronization.

**Architecture:** Keep the persisted `campaign_subtable_map` setting and existing settings API unchanged. Add pure frontend parsing/serialization helpers plus a focused Ant Design editor component; new writes serialize a JSON object keyed by campaign ID. Move backend target-table selection into a pure utility so missing mappings can be tested without calling Feishu.

**Tech Stack:** React 18, Ant Design 5, Jest/Testing Library, Express, Node.js built-in test runner.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-19-feishu-project-subtable-mapping-ui-design.md`.
- Use Chinese for user-facing copy and implementation handoff.
- Do not delete user data files.
- Preserve all unrelated existing working-tree changes; do not format or edit unrelated files.
- Do not modify `client/src/pages/KolStrategy.js`, `client/src/pages/RawCandidates.js`, `server/routes/finderTasks.js`, `server/routes/finderTasks.test.js`, `client/src/pages/RawCandidates.test.js`, `outputs/`, or existing migration files.
- Use test-driven development: add a failing focused test, run it, implement the minimum behavior, and rerun it.
- Do not add dependencies or database migrations.
- Do not expose or log Feishu App Secret or tokens.

---

### Task 1: Mapping parser and serializer

**Files:**
- Create: `client/src/pages/settings/feishuSubtableMappings.js`
- Create: `client/src/pages/settings/feishuSubtableMappings.test.js`

**Interfaces:**
- Produces: `parseCampaignSubtableMap(value, campaigns) -> { rows, unresolved }`.
- Produces: `serializeCampaignSubtableRows(rows) -> string`.
- A row has `{ campaign_id: number, table_id: string }`.
- An unresolved item has `{ key: string, table_id: string }`.

- [ ] **Step 1: Write failing parser tests**

Cover these exact cases:

```js
const campaigns = [{ id: 7, name: 'Vivatrees EverJoy' }, { id: 9, name: 'Summer Launch' }];

expect(parseCampaignSubtableMap('{"7":"tblOne"}', campaigns)).toEqual({
  rows: [{ campaign_id: 7, table_id: 'tblOne' }],
  unresolved: []
});

expect(parseCampaignSubtableMap('Vivatrees EverJoy=tblLegacy', campaigns)).toEqual({
  rows: [{ campaign_id: 7, table_id: 'tblLegacy' }],
  unresolved: []
});

expect(parseCampaignSubtableMap('{"Unknown":"tblLost"}', campaigns)).toEqual({
  rows: [],
  unresolved: [{ key: 'Unknown', table_id: 'tblLost' }]
});
```

Also assert that empty input returns empty arrays and that name-keyed JSON resolves by exact campaign name.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
cd client && CI=true npm test -- --runInBand --watchAll=false src/pages/settings/feishuSubtableMappings.test.js
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement tolerant parsing**

Implement parsing in this order:

1. Empty input → empty result.
2. Plain object input → key/value entries.
3. JSON object text → key/value entries.
4. Otherwise split text on newlines or commas and parse the first `=` in each entry.

For every entry, trim key and Table ID. Resolve a positive integer key against `campaign.id`; otherwise resolve the key by exact `campaign.name`. Put unmatched non-empty entries into `unresolved`. Never throw for malformed saved settings.

- [ ] **Step 4: Add failing serializer tests**

```js
expect(serializeCampaignSubtableRows([
  { campaign_id: 9, table_id: ' tblTwo ' },
  { campaign_id: 7, table_id: 'tblOne' }
])).toBe('{"7":"tblOne","9":"tblTwo"}');
```

Also assert that incomplete rows are omitted and an empty list serializes to `'{}'`.

- [ ] **Step 5: Implement stable serialization and rerun tests**

Normalize campaign IDs to positive integers, trim Table IDs, sort by numeric campaign ID, build an object, and return `JSON.stringify(object)`.

Run the focused test again. Expected: PASS.

- [ ] **Step 6: Commit the parser unit**

```bash
git add client/src/pages/settings/feishuSubtableMappings.js client/src/pages/settings/feishuSubtableMappings.test.js
git commit -m "feat: parse Feishu project subtable mappings"
```

---

### Task 2: Compact project mapping row editor

**Files:**
- Create: `client/src/pages/settings/FeishuSubtableMappings.js`
- Create: `client/src/pages/settings/FeishuSubtableMappings.test.js`
- Modify: `client/src/pages/Settings.css`

**Interfaces:**
- Consumes: `campaigns: Array<{ id: number, name: string }>`.
- Consumes: Ant Design controlled-field props `value` and `onChange`, where `value` is the row array from Task 1.
- Consumes: `disabled` and `loadError`.
- Produces: `onChange(nextRows)` after add, edit, or delete.

- [ ] **Step 1: Write failing interaction tests**

Render the component with two campaigns and one existing row. Assert:

- The existing campaign and Table ID render.
- Clicking `添加项目映射` adds a row.
- A campaign already selected in another row is disabled in the new row dropdown.
- Clicking the row delete button removes only that row.
- `loadError` renders a warning and disables `添加项目映射`.

Use accessible labels `系统项目`, `飞书子表 ID`, `删除项目映射`, and button name `添加项目映射` so tests do not depend on DOM classes.

- [ ] **Step 2: Run the component test and confirm failure**

```bash
cd client && CI=true npm test -- --runInBand --watchAll=false src/pages/settings/FeishuSubtableMappings.test.js
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the minimal controlled component**

Use Ant Design `Select`, `Input`, `Button`, `Alert`, and `Empty`/secondary text. Each row must have a stable client-only key for React rendering, but the emitted value must remain `{ campaign_id, table_id }`. Do not permit free text in the project selector.

Validation rules on the form controls:

```text
请选择系统项目
请输入飞书子表 ID
Table ID 必须以 tbl 开头
同一项目只能配置一次
```

The Table ID check is `/^tbl\S+$/` after trimming. Preserve the user's current input while showing validation errors.

- [ ] **Step 4: Add compact responsive styling**

Add scoped classes to `Settings.css`:

- Desktop row: project selector, flexible Table ID input, icon/delete action in one grid row.
- Mobile row below 768px: stack selector and input, keep delete action visible.
- Match existing `--settings-border`, muted text, spacing, and card background; do not introduce a new visual theme.

- [ ] **Step 5: Rerun the focused component test**

Expected: PASS with no React key or `act()` warnings introduced by this component.

- [ ] **Step 6: Commit the editor unit**

```bash
git add client/src/pages/settings/FeishuSubtableMappings.js client/src/pages/settings/FeishuSubtableMappings.test.js client/src/pages/Settings.css
git commit -m "feat: add Feishu project mapping editor"
```

---

### Task 3: Integrate campaigns and legacy mappings into Settings

**Files:**
- Modify: `client/src/pages/Settings.js`
- Modify: `client/src/pages/Settings.test.js`
- Modify: `client/src/pages/settings/settingsContract.js`

**Interfaces:**
- Consumes Task 1 helpers and Task 2 editor.
- Fetches `/api/settings` and `/api/campaigns` independently so a campaign-list failure does not hide the rest of settings.
- Keeps the persisted API payload at `settings.cloudStorage.feishu.campaign_subtable_map` as a JSON string.

- [ ] **Step 1: Add failing Settings integration tests**

Extend the Axios mock so `/api/campaigns` returns:

```js
{ data: { success: true, data: [{ id: 7, name: 'Vivatrees EverJoy' }] } }
```

Add tests that:

1. Open `云端存储` and render a legacy `Vivatrees EverJoy=tbliXAzgY46zjt3U` mapping as a selected project row.
2. Confirm the old `默认项目 KOL 子表` input and raw `项目子表映射` textarea are absent.
3. Change the Table ID, save, and assert the posted value is `'{"7":"tblChanged"}'`.
4. Return an unknown legacy mapping and assert a warning names the unresolved key and saving does not overwrite it.
5. Reject `/api/campaigns`, assert settings still render, and assert the mapping editor reports project-loading failure.

- [ ] **Step 2: Run Settings tests and confirm failure**

```bash
cd client && CI=true npm test -- --runInBand --watchAll=false src/pages/Settings.test.js
```

Expected: the new assertions fail against the text area and default-table input.

- [ ] **Step 3: Load campaigns without coupling settings availability**

Add state for `campaigns`, campaign load error, and unresolved mappings. Fetch campaigns with its own error handling. A campaign failure must not set the existing general settings `loadError`.

After both settings and the current campaign result are available, call `parseCampaignSubtableMap`. Put `rows` into the form-only value and retain `unresolved` separately. Avoid mutating the object stored in `settings`.

- [ ] **Step 4: Replace the storage controls**

Remove the visible `campaign_kol_table_id` Form.Item and raw mapping TextArea. Render `FeishuSubtableMappings` as the controlled field for `campaign_subtable_map`. Show an `Alert` for unresolved legacy keys and explain that the user must create/select a current project mapping before the configuration can be saved.

Remove `campaign_kol_table_id` from `DEFAULT_SETTINGS` so new clients do not present it as an active setting. Do not add server-side deletion of an already persisted value.

- [ ] **Step 5: Serialize only at the save boundary**

In `saveSection`, clone the current form settings, replace the row-array value with `serializeCampaignSubtableRows(rows)`, and then call the existing `persistSettings`. If unresolved entries exist, display an error and return without posting. Do not serialize or mark the form dirty merely because settings loaded.

- [ ] **Step 6: Rerun Settings tests**

Expected: all Settings tests PASS, including the pre-existing provider drawer and dirty-state tests.

- [ ] **Step 7: Commit the Settings integration**

```bash
git add client/src/pages/Settings.js client/src/pages/Settings.test.js client/src/pages/settings/settingsContract.js
git commit -m "feat: configure Feishu subtables per project"
```

---

### Task 4: Remove backend default-table fallback

**Files:**
- Create: `server/utils/feishuSubtableMapping.js`
- Create: `server/utils/feishuSubtableMapping.test.js`
- Modify: `server/routes/sync.js`

**Interfaces:**
- Produces: `getCampaignKolTableId(config, row) -> string`.
- Produces: `missingCampaignSubtableError(row) -> Error` with exact Chinese copy.
- `config.campaign_subtable_map` remains an object after existing config parsing.

- [ ] **Step 1: Write failing backend utility tests**

```js
const config = {
  campaign_subtable_map: { '7': 'tblById', 'Old Name': 'tblByName' },
  campaign_kol_table_id: 'tblDefault'
};

assert.equal(getCampaignKolTableId(config, { campaign_id: 7, campaign_name: 'New Name' }), 'tblById');
assert.equal(getCampaignKolTableId(config, { campaign_id: 8, campaign_name: 'Old Name' }), 'tblByName');
assert.equal(getCampaignKolTableId(config, { campaign_id: 99, campaign_name: 'Missing' }), '');
assert.equal(missingCampaignSubtableError({ campaign_name: 'Missing' }).message,
  '项目“Missing”尚未配置飞书 KOL 子表');
```

The third assertion proves `campaign_kol_table_id` is ignored.

- [ ] **Step 2: Run the focused backend test and confirm failure**

```bash
cd server && node --test utils/feishuSubtableMapping.test.js
```

Expected: FAIL because the utility does not exist.

- [ ] **Step 3: Implement and integrate the pure utility**

Move target-table selection out of `sync.js`. Check numeric ID key, string ID key, then legacy campaign-name key; return `''` if none match. In `syncCampaignKols`, throw `missingCampaignSubtableError(row)` when the returned ID is empty.

Keep reading an existing `campaign_kol_table_id` in settings for non-destructive compatibility, but never use it for selection.

- [ ] **Step 4: Rerun focused and existing server tests**

```bash
cd server && node --test utils/feishuSubtableMapping.test.js
cd server && npm test
```

Expected: PASS. Existing unrelated tests must remain unchanged.

- [ ] **Step 5: Commit backend behavior**

```bash
git add server/utils/feishuSubtableMapping.js server/utils/feishuSubtableMapping.test.js server/routes/sync.js
git commit -m "fix: require Feishu subtable mapping per project"
```

---

### Task 5: Full verification and handoff

**Files:**
- Modify only if a failure is directly caused by Tasks 1–4.

**Interfaces:**
- Consumes all completed frontend and backend units.
- Produces verified build and test evidence.

- [ ] **Step 1: Run focused frontend tests together**

```bash
cd client && CI=true npm test -- --runInBand --watchAll=false \
  src/pages/settings/feishuSubtableMappings.test.js \
  src/pages/settings/FeishuSubtableMappings.test.js \
  src/pages/Settings.test.js
```

Expected: PASS.

- [ ] **Step 2: Run the complete backend suite**

```bash
cd server && npm test
```

Expected: PASS. If an unrelated pre-existing failure occurs, record it without modifying unrelated files.

- [ ] **Step 3: Run the production build**

```bash
npm run build
```

Expected: `Compiled successfully` and exit code 0.

- [ ] **Step 4: Inspect scope and diff hygiene**

```bash
git status --short
git diff --check
git diff -- client/src/pages/Settings.js client/src/pages/Settings.css \
  client/src/pages/Settings.test.js client/src/pages/settings/feishuSubtableMappings.js \
  client/src/pages/settings/FeishuSubtableMappings.js server/routes/sync.js \
  server/utils/feishuSubtableMapping.js
```

Confirm no user-owned unrelated file was overwritten and no credential value appears in the diff.

- [ ] **Step 5: Final handoff**

Report:

- UI and compatibility changes made;
- exact test/build commands and results;
- any unresolved legacy mapping behavior;
- any pre-existing unrelated failures;
- files changed by this feature.
