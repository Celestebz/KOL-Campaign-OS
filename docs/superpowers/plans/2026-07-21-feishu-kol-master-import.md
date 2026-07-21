# Feishu KOL Master Table Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import records from the configured Feishu KOL master table into the local `customers` table, updating existing KOLs and creating missing ones, triggered by a「从飞书导入」button on the KOL management page.

**Architecture:** Reuse the existing Feishu config, token, and fetch helpers in `server/routes/sync.js`. Add pure field-extraction and record-matching helpers in a new `server/utils/feishuKolImport.js` so the merge logic is testable without network. Add `POST /api/sync/feishu/pull` to the sync router. On the client, add a button plus result messaging to `client/src/pages/Customers.js`.

**Tech Stack:** Express, Node.js built-in test runner, React 18, Ant Design 5, Jest/Testing Library.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-21-feishu-kol-master-import-design.md`.
- Use Chinese for user-facing copy and implementation handoff.
- Do not delete user data files.
- Preserve all unrelated existing working-tree changes; do not format or edit unrelated files.
- Do not modify `client/src/pages/KolStrategy.js`, `client/src/pages/RawCandidates.js`, `server/routes/finderTasks.js`, `server/routes/finderTasks.test.js`, `client/src/pages/RawCandidates.test.js`, `outputs/`, or existing migration files.
- Use test-driven development: add a failing focused test, run it, implement the minimum behavior, and rerun it.
- Do not add dependencies or database migrations.
- Do not expose or log Feishu App Secret or tokens.
- Do not change the existing push sync behavior or its tests.

---

### Task 1: Feishu record field extraction and KOL mapping

**Files:**
- Create: `server/utils/feishuKolImport.js`
- Create: `server/utils/feishuKolImport.test.js`

**Interfaces:**
- Produces: `feishuFieldToText(value) -> string`.
- Produces: `mapFeishuRecordToKol(record) -> object` mapping `record.fields` to `customers` column values plus `feishu_record_id` from `record.record_id`.

- [ ] **Step 1: Write failing extraction tests**

Cover these exact cases:

```js
assert.equal(feishuFieldToText('Alice'), 'Alice');
assert.equal(feishuFieldToText([{ text: 'Ali' }, { text: 'ce' }]), 'Alice');
assert.equal(feishuFieldToText({ link: 'https://x.com/a', text: 'https://x.com/a' }), 'https://x.com/a');
assert.equal(feishuFieldToText(12300), '12300');
assert.equal(feishuFieldToText(null), '');
assert.equal(feishuFieldToText(undefined), '');
```

- [ ] **Step 2: Write failing mapping tests**

A record with fields `'KOL名称'`, `'平台'`, `creator_id`, `'联系人'`, `'YouTube主页'` (hyperlink object), `'YouTube粉丝量'` (number), `'Instagram主页'`, `'Instagram粉丝量'`, `'TikTok主页'`, `'TikTok粉丝量'`, `Email`, `'国家地区'`, `'内容类型'`, `'备注'` maps to:

```js
{
  feishu_record_id: 'rec1',
  name: 'Alice',
  platform: 'YouTube',
  creator_id: 'alice01',
  contact_name: 'Alice Manager',
  youtube_url: 'https://youtube.com/@alice',
  youtube_followers: '12300',
  instagram_url: 'https://instagram.com/alice',
  instagram_followers: '8900',
  tiktok_url: '',
  tiktok_followers: '',
  email: 'alice@example.com',
  country_region: 'UK',
  creator_type: 'KOL',
  notes: '重点推荐'
}
```

Assert missing fields map to `''` rather than throwing.

- [ ] **Step 3: Run the focused test and confirm failure**

```bash
cd server && node --test utils/feishuKolImport.test.js
```

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement extraction and mapping**

`feishuFieldToText`: strings pass through trimmed; numbers stringify; arrays concatenate each item's `text` (or string) segment; objects prefer `link`, then `text`; everything else returns `''`. Never throw.

`mapFeishuRecordToKol` reads the exact Feishu field names listed in the spec table and applies `feishuFieldToText` to each.

- [ ] **Step 5: Rerun the focused test**

Expected: PASS.

- [ ] **Step 6: Commit the mapping unit**

```bash
git add server/utils/feishuKolImport.js server/utils/feishuKolImport.test.js
git commit -m "feat: map Feishu KOL records to customers"
```

---

### Task 2: Local customer matching

**Files:**
- Modify: `server/utils/feishuKolImport.js`
- Modify: `server/utils/feishuKolImport.test.js`

**Interfaces:**
- Produces: `findMatchingCustomer(kol, customers) -> customer | null` implementing the spec priority: `feishu_record_id`, then non-empty `creator_id`, then `name` + non-empty `platform`.

- [ ] **Step 1: Write failing matching tests**

```js
const customers = [
  { id: 1, feishu_record_id: 'rec_keep', creator_id: 'other', name: 'Alice', platform: 'YouTube' },
  { id: 2, feishu_record_id: null, creator_id: 'alice01', name: 'Renamed', platform: 'TikTok' },
  { id: 3, feishu_record_id: null, creator_id: '', name: 'Bob', platform: 'YouTube' }
];

// record id wins over every other key
assert.equal(findMatchingCustomer({ feishu_record_id: 'rec_keep', creator_id: 'alice01', name: 'Bob', platform: 'YouTube' }, customers).id, 1);
// creator_id beats name+platform
assert.equal(findMatchingCustomer({ feishu_record_id: 'rec_new', creator_id: 'alice01', name: 'Bob', platform: 'YouTube' }, customers).id, 2);
// name + platform match when ids are absent
assert.equal(findMatchingCustomer({ feishu_record_id: 'rec_new', creator_id: '', name: 'Bob', platform: 'YouTube' }, customers).id, 3);
// empty platform never matches by name alone
assert.equal(findMatchingCustomer({ feishu_record_id: 'rec_new', creator_id: '', name: 'Bob', platform: '' }, customers), null);
// no match
assert.equal(findMatchingCustomer({ feishu_record_id: 'rec_new', creator_id: '', name: 'Carol', platform: 'YouTube' }, customers), null);
```

- [ ] **Step 2: Run and confirm failure, implement, rerun**

```bash
cd server && node --test utils/feishuKolImport.test.js
```

Compare keys after trimming; treat `null`/`undefined` as `''`. Expected: FAIL before implementation, PASS after.

- [ ] **Step 3: Commit the matching unit**

```bash
git add server/utils/feishuKolImport.js server/utils/feishuKolImport.test.js
git commit -m "feat: match Feishu records to local KOLs"
```

---

### Task 3: Pull route `POST /api/sync/feishu/pull`

**Files:**
- Modify: `server/routes/sync.js`
- Modify: `server/routes/sync.test.js`

**Interfaces:**
- Consumes Task 1–2 helpers and existing `getFeishuConfig`, `requireFeishuConfig`, `getTenantAccessToken`, `fetchJson`.
- Produces response `{ success: true, data: { fetched, created, updated, skipped, failed, errors } }`; 400 with `{ success: false, error }` when config is missing.

- [ ] **Step 1: Write failing route tests**

Follow the existing `sync.test.js` harness (`findHandler`, `callHandler`, stubbed `dbOperations` and `global.fetch`). Stub the token endpoint and the records endpoint:

```text
GET {base}/open-apis/bitable/v1/apps/base-token/tables/tbl_kol_master/records?page_size=100
```

Return two pages: page 1 with `has_more: true, page_token: 'p2'` and one record that matches an existing local customer by `creator_id`; page 2 with one new record and one record missing `'KOL名称'`.

Assert:

1. Both pages are requested; the second request carries `page_token=p2`.
2. The matched customer gets an `UPDATE customers SET ... feishu_record_id ... 'synced'` write with mapped values, and the update does not touch unmapped columns such as `cooperation_status`.
3. The new record produces an `INSERT INTO customers` with `feishu_record_id` and `sync_status = 'synced'`.
4. The nameless record is counted in `skipped`, not inserted.
5. Response counts: `fetched: 3, created: 1, updated: 1, skipped: 1, failed: 0`.

Add a second test where one `INSERT` throws (simulated Email unique conflict) and assert `failed: 1`, the error text lands in `errors`, and the remaining record still imports.

Add a third test with no saved Feishu config row and assert status 400 and an error naming the missing items.

- [ ] **Step 2: Run the route tests and confirm failure**

```bash
cd server && node --test routes/sync.test.js
```

Expected: FAIL because `/feishu/pull` does not exist. Existing push tests must still PASS unmodified.

- [ ] **Step 3: Implement the pull route**

In `server/routes/sync.js`:

1. `listBitableRecords(config, token, tableId)`: loop `GET .../records?page_size=100` plus `&page_token=` when the previous page returned `has_more`; collect `data.items` into one array.
2. `router.post('/feishu/pull', ...)`: load config, `requireFeishuConfig`, get token, list KOL master records, load all local customers with `SELECT * FROM customers`, then for each record: `mapFeishuRecordToKol` → skip when `name` is empty → `findMatchingCustomer` → UPDATE mapped columns plus `feishu_record_id`, `sync_status = 'synced'`, `last_synced_at = CURRENT_TIMESTAMP`, `updated_at = CURRENT_TIMESTAMP`, or INSERT the mapped columns plus the same sync fields. Wrap each write in try/catch and collect `{ record_id, error }` into `errors`.

Keep the UPDATE column list identical to the mapped keys; never write `id`, `cooperation_status`, `group_id`, or price columns.

- [ ] **Step 4: Rerun focused and full server tests**

```bash
cd server && node --test routes/sync.test.js
cd server && npm test
```

Expected: PASS.

- [ ] **Step 5: Commit the pull route**

```bash
git add server/routes/sync.js server/routes/sync.test.js
git commit -m "feat: import KOLs from Feishu master table"
```

---

### Task 4: KOL page import button

**Files:**
- Modify: `client/src/pages/Customers.js`
- Create: `client/src/pages/Customers.test.js`

**Interfaces:**
- Consumes `POST /api/sync/feishu/pull`.
- Produces antd `message` feedback and a list refresh.

- [ ] **Step 1: Write failing interaction tests**

Mock `axios` and antd `message` following the style of `client/src/pages/CampaignKols.test.js`. Stub `/api/customers`, `/api/groups`, `/api/campaigns`, and `/api/customers/filter-options` GET responses with minimal payloads.

Assert:

1. Clicking the button named `从飞书导入` posts to `/api/sync/feishu/pull` with no body payload requirements.
2. On `{ success: true, data: { created: 2, updated: 3, skipped: 1, failed: 0 } }`, `message.success` receives `从飞书导入完成：新增 2，更新 3，跳过 1，失败 0` and `/api/customers` is refetched.
3. When the response data has `failed > 0`, `message.warning` is used with the same counts.
4. On a rejected request with `response.data.error = 'Feishu Bitable is not configured: App ID'`, `message.warning` shows that error text.

- [ ] **Step 2: Run the component test and confirm failure**

```bash
cd client && CI=true npm test -- --runInBand --watchAll=false src/pages/Customers.test.js
```

Expected: FAIL because the button does not exist.

- [ ] **Step 3: Implement the button and handler**

In `client/src/pages/Customers.js`:

- Add `CloudDownloadOutlined` to the icon imports and a `pulling` state.
- Add `handleFeishuPull`: set loading, post to `/api/sync/feishu/pull`, on success pick `message.success` or `message.warning` by `failed > 0` with the exact copy `从飞书导入完成：新增 X，更新 Y，跳过 Z，失败 N`, then `fetchKols()`; on error `message.warning(error.response?.data?.error || '从飞书导入失败，本地数据未变化')`; always clear loading.
- Render `<Button icon={<CloudDownloadOutlined />} loading={pulling} onClick={handleFeishuPull}>从飞书导入</Button>` in the toolbar `Space` between「批量导入」and「新增 KOL」.

- [ ] **Step 4: Rerun the component test**

Expected: PASS with no new `act()` warnings.

- [ ] **Step 5: Commit the UI unit**

```bash
git add client/src/pages/Customers.js client/src/pages/Customers.test.js
git commit -m "feat: import KOLs from Feishu on the KOL page"
```

---

### Task 5: Full verification and handoff

**Files:**
- Modify only if a failure is directly caused by Tasks 1–4.

**Interfaces:**
- Consumes all completed frontend and backend units.
- Produces verified build and test evidence.

- [ ] **Step 1: Run the complete backend suite**

```bash
cd server && npm test
```

Expected: PASS. If an unrelated pre-existing failure occurs, record it without modifying unrelated files.

- [ ] **Step 2: Run focused frontend tests together**

```bash
cd client && CI=true npm test -- --runInBand --watchAll=false src/pages/Customers.test.js
```

Expected: PASS.

- [ ] **Step 3: Run the production build**

```bash
npm run build
```

Expected: `Compiled successfully` and exit code 0.

- [ ] **Step 4: Inspect scope and diff hygiene**

```bash
git status --short
git diff --check
git diff -- server/routes/sync.js server/utils/feishuKolImport.js client/src/pages/Customers.js
```

Confirm no user-owned unrelated file was overwritten and no credential value appears in the diff.

- [ ] **Step 5: Final handoff**

Report:

- the new pull API and its counts semantics;
- matching and overwrite behavior in one short paragraph;
- exact test/build commands and results;
- any pre-existing unrelated failures;
- files changed by this feature.
