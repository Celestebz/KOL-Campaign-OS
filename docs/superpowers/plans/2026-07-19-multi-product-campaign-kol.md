# Multi-Product Campaign and KOL Relationships Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable Product catalog, Campaign-to-Product associations, product-scoped Strategy/Finder execution, and product-level KOL matching while preserving one KOL identity and one cooperation workflow per Campaign.

**Architecture:** Add four relational resources without removing legacy product columns. New Strategies and Finder Tasks bind to exactly one active Campaign Product; candidate generation resolves the creator identity and upserts one product-fit record, while human approval reuses the global KOL and Campaign KOL before upserting one Campaign KOL Product. Existing routes remain compatible for historical reads, and new UI pages make Campaign/Product context explicit.

**Tech Stack:** Node.js, Express, MySQL, Sequelize/Umzug migrations, Node test runner, Supertest, React 18, Ant Design 5, Axios.

## Global Constraints

- Do not delete or overwrite existing Campaign, Strategy, Finder, Raw Candidate, KOL, evidence, or cooperation data.
- Keep `campaigns.product` and `kol_strategies.product` readable during the compatibility period.
- Each new Strategy and Finder Task targets exactly one `campaign_product_id`.
- Finder runs one Product at a time and never scans the complete KOL Master.
- Existing KOL history may inform evaluation only after normal video-evidence discovery identifies the creator.
- AI output cannot approve candidates or overwrite human decisions.
- Do not add budget allocation, ROI, commissions, multi-product Finder, or automatic KOL rescoring.
- Preserve unrelated dirty-worktree changes; stage only files listed by the active task.

---

## File Structure

**Create**

- `server/migrations/20260719000001-add-multi-product-campaign-relations.js` — additive schema and safe legacy backfill.
- `server/models/Product.js` — global Product model.
- `server/models/CampaignProduct.js` — Campaign-specific Product context.
- `server/models/RawCandidateProductFit.js` — pre-approval Product fit.
- `server/models/CampaignKolProduct.js` — approved Product cooperation.
- `server/routes/products.js` — Product CRUD/archive API.
- `server/routes/products.test.js` — Product and Campaign Product contracts.
- `client/src/pages/Products.js` — global Product catalog.
- `client/src/pages/Campaigns.js` — Campaign list/detail and Product associations.
- `client/src/pages/productCampaignContract.js` — pure client response normalization.
- `client/src/pages/productCampaignContract.test.js` — pure UI contract tests.

**Modify**

- `server/models/Campaign.js`, `KolStrategy.js`, `FinderTask.js`, `RawCandidate.js`, `CampaignKol.js` — associations and Product binding columns.
- `server/routes/campaigns.js` — Campaign Product APIs and dynamic counts.
- `server/routes/kolStrategies.js` — binding validation and normalized Product context.
- `server/routes/finderTasks.js` — inherited binding, AI context, identity resolution, and Product fit upsert.
- `server/routes/rawCandidates.js` — approval creates/reuses Product cooperation.
- `server/routes/campaignKols.js` — Product assignment list/update.
- `server/index.js` — mount Product routes.
- `server/routes/kolStrategies.test.js`, `finderTasks.test.js`, `rawCandidates.test.js` — route regressions.
- `client/src/App.js` — Campaign and Product navigation.
- `client/src/pages/KolStrategy.js` — Campaign Product selection.
- `client/src/pages/RawCandidates.js` — Product/identity context.
- `client/src/pages/CampaignKols.js` — Product assignments.

---

### Task 1: Additive schema, models, and safe legacy backfill

**Files:**
- Create: `server/migrations/20260719000001-add-multi-product-campaign-relations.js`
- Create: `server/models/Product.js`
- Create: `server/models/CampaignProduct.js`
- Create: `server/models/RawCandidateProductFit.js`
- Create: `server/models/CampaignKolProduct.js`
- Modify: `server/models/Campaign.js`
- Modify: `server/models/KolStrategy.js`
- Modify: `server/models/FinderTask.js`
- Modify: `server/models/RawCandidate.js`
- Modify: `server/models/CampaignKol.js`
- Test: `server/routes/finderTasks.test.js`

**Interfaces:**
- Produces: tables `products`, `campaign_products`, `raw_candidate_product_fits`, `campaign_kol_products`.
- Produces: nullable `kol_strategies.campaign_product_id` and `finder_tasks.campaign_product_id`.
- Produces: unique keys `campaign_products(campaign_id, product_id)`, `raw_candidate_product_fits(campaign_product_id, identity_key_hash)`, and `campaign_kol_products(campaign_kol_id, campaign_product_id)`.

- [ ] **Step 1: Write the failing migration preservation test**

Extend the existing migration test in `server/routes/finderTasks.test.js` to seed a legacy Campaign and Strategy, run the new migration, and assert:

```js
await multiProductMigration.up(sequelize.getQueryInterface(), Sequelize);

const product = await dbOperations.get(
  'SELECT * FROM products WHERE brand = ? AND name = ?',
  ['Test', 'Test']
);
assert.ok(product?.id);

const campaignProduct = await dbOperations.get(
  'SELECT * FROM campaign_products WHERE campaign_id = ? AND product_id = ?',
  [campaign.id, product.id]
);
assert.equal(campaignProduct.status, 'active');

const preserved = await models.Campaign.findByPk(campaign.id);
assert.equal(preserved.product, 'Test');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd server && node --test --test-name-pattern="multi-product migration" routes/finderTasks.test.js`

Expected: FAIL because the migration module and new tables do not exist.

- [ ] **Step 3: Implement the migration and models**

Use additive `createTable`, `addColumn`, indexes, and foreign keys. Backfill only non-empty legacy product values. Reuse a Product by exact normalized `brand + name`; insert one `campaign_products` row per Campaign with `status = 'active'` using `INSERT ... ON DUPLICATE KEY UPDATE updated_at = updated_at`. Bind a legacy Strategy only when its Campaign has exactly one matching Campaign Product. Do not implement a destructive `down`; make `down` throw an explicit preservation error.

Model associations must expose:

```js
Campaign.hasMany(models.CampaignProduct, { foreignKey: 'campaign_id' });
Product.hasMany(models.CampaignProduct, { foreignKey: 'product_id' });
CampaignProduct.belongsTo(models.Campaign, { foreignKey: 'campaign_id' });
CampaignProduct.belongsTo(models.Product, { foreignKey: 'product_id' });
CampaignProduct.hasMany(models.RawCandidateProductFit, { foreignKey: 'campaign_product_id' });
CampaignProduct.hasMany(models.CampaignKolProduct, { foreignKey: 'campaign_product_id' });
```

- [ ] **Step 4: Run migration test and model load verification**

Run: `cd server && node --test --test-name-pattern="multi-product migration" routes/finderTasks.test.js`

Expected: PASS with legacy rows preserved and all new tables present.

- [ ] **Step 5: Commit the schema slice**

```bash
git add server/migrations/20260719000001-add-multi-product-campaign-relations.js server/models/Product.js server/models/CampaignProduct.js server/models/RawCandidateProductFit.js server/models/CampaignKolProduct.js server/models/Campaign.js server/models/KolStrategy.js server/models/FinderTask.js server/models/RawCandidate.js server/models/CampaignKol.js server/routes/finderTasks.test.js
git commit -m "feat: add multi-product campaign schema"
```

### Task 2: Product catalog and Campaign Product APIs

**Files:**
- Create: `server/routes/products.js`
- Create: `server/routes/products.test.js`
- Modify: `server/routes/campaigns.js`
- Modify: `server/index.js`

**Interfaces:**
- Produces: `GET/POST /api/products`, `PUT /api/products/:id`, `POST /api/products/:id/archive`.
- Produces: `GET/POST /api/campaigns/:id/products`, `PUT /api/campaigns/:campaignId/products/:campaignProductId`, `POST .../archive`.
- Product response: `{ id, brand, name, sku, category, product_url, description, selling_points, status }`.
- Campaign Product response additionally contains `product`, `role`, `priority`, `campaign_brief`, and `status`.

- [ ] **Step 1: Write failing Product and association route tests**

Create tests that verify Product reuse across Campaigns, duplicate attachment rejection, active/total counts, and archive preservation:

```js
const created = await supertest(app).post('/api/products').send({
  brand: 'Vivatrees', name: 'Everglow', category: 'Artificial Christmas Tree',
  product_url: 'https://www.thevivatrees.com/products/everglow'
}).expect(200);

await supertest(app).post(`/api/campaigns/${campaignId}/products`).send({
  product_id: created.body.data.id,
  role: 'hero', status: 'active', campaign_brief: 'Premium lighting story'
}).expect(200);

await supertest(app).post(`/api/campaigns/${campaignId}/products`).send({
  product_id: created.body.data.id
}).expect(409);
```

- [ ] **Step 2: Run and verify RED**

Run: `cd server && node --test routes/products.test.js`

Expected: FAIL because `/api/products` and Campaign Product endpoints are absent.

- [ ] **Step 3: Implement minimal routes and validation**

Validate `name`, allowed Product statuses (`active`, `archived`), Campaign Product roles, and statuses. Archive by updating status; expose no physical DELETE endpoint. Add Campaign counts with conditional aggregation:

```sql
COUNT(cp.id) AS associated_product_count,
SUM(CASE WHEN cp.status = 'active' THEN 1 ELSE 0 END) AS active_product_count
```

Mount `app.use('/api/products', productRoutes)` in `server/index.js`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `cd server && node --test routes/products.test.js`

Expected: all Product API tests PASS.

- [ ] **Step 5: Commit the API slice**

```bash
git add server/routes/products.js server/routes/products.test.js server/routes/campaigns.js server/index.js
git commit -m "feat: manage products within campaigns"
```

### Task 3: Require Campaign Product on new Strategies

**Files:**
- Modify: `server/routes/kolStrategies.js`
- Modify: `server/routes/kolStrategies.test.js`

**Interfaces:**
- Consumes: `campaign_products.id`, `campaign_products.campaign_id`, `campaign_products.status`.
- Produces: `getCampaignProductForStrategy(campaignId, campaignProductId, { requireActive })`.
- Produces normalized Strategy fields `campaign_product_id`, `campaign_product_status`, `product_id`, and `product_name`.

- [ ] **Step 1: Write failing ownership and status tests**

Add tests for a valid active binding, another Campaign's Product, missing binding on new Strategy, and archived binding:

```js
await supertest(app).post('/api/kol-strategies').send({
  ...readyStrategyPayload(campaignId),
  campaign_product_id: campaignProductId
}).expect(200);

const invalid = await supertest(app).post('/api/kol-strategies').send({
  ...readyStrategyPayload(campaignId),
  campaign_product_id: otherCampaignProductId
}).expect(400);
assert.match(invalid.body.error, /不属于当前项目/);
```

- [ ] **Step 2: Run and verify RED**

Run: `cd server && node --test routes/kolStrategies.test.js`

Expected: new binding tests FAIL while legacy tests continue to run.

- [ ] **Step 3: Implement server-side binding validation**

Require `campaign_product_id` on POST. On PUT and mark-ready, validate the effective binding. Legacy rows with a null binding remain listable and return `product_binding_status: 'legacy_unassigned'`, but cannot be marked ready again until assigned.

- [ ] **Step 4: Run and verify GREEN**

Run: `cd server && node --test routes/kolStrategies.test.js`

Expected: all Strategy tests PASS.

- [ ] **Step 5: Commit the Strategy slice**

```bash
git add server/routes/kolStrategies.js server/routes/kolStrategies.test.js
git commit -m "feat: bind strategies to campaign products"
```

### Task 4: Inherit Product binding in Finder and create Product fits

**Files:**
- Modify: `server/routes/finderTasks.js`
- Modify: `server/routes/finderTasks.test.js`

**Interfaces:**
- Consumes: a Ready Strategy with an active `campaign_product_id`.
- Produces: Finder Task `campaign_product_id` inherited from Strategy.
- Produces: `buildCandidateIdentity(platform, profileUrl, authorName)` returning `{ identityKey, identityKeyHash }`.
- Produces: one `raw_candidate_product_fits` row per Campaign Product plus normalized identity.

- [ ] **Step 1: Write failing Finder binding tests**

Test that task creation inherits Product, rejects an archived Product, ignores a caller-supplied conflicting Product, and includes Product context in the AI prompt. Add a candidate-generation test that discovers the same profile twice and leaves one fit row:

```js
const taskRes = await supertest(app).post('/api/finder-tasks').send({
  strategy_id: strategy.id,
  campaign_product_id: conflictingCampaignProductId,
  execution_mode: 'video_evidence_finder',
  target_platforms: ['youtube']
}).expect(200);
assert.equal(taskRes.body.data.campaign_product_id, strategy.campaign_product_id);

const fits = await dbOperations.query(
  'SELECT * FROM raw_candidate_product_fits WHERE campaign_product_id = ?',
  [strategy.campaign_product_id]
);
assert.equal(fits.length, 1);
```

- [ ] **Step 2: Run and verify RED**

Run: `cd server && node --test --test-name-pattern="campaign product|product fit" routes/finderTasks.test.js`

Expected: FAIL because Finder does not inherit Product context or write fit rows.

- [ ] **Step 3: Implement binding, identity resolution, and fit upsert**

Load Campaign Product and Product with the Strategy. Add their context to the evidence-analysis prompt. After evidence aggregation, resolve `customers` and `kol_platform_accounts` by normalized profile identity; include only matched history/risk context. Upsert by `(campaign_product_id, identity_key_hash)` and preserve non-AI human states:

```sql
ON DUPLICATE KEY UPDATE
  latest_raw_candidate_id = VALUES(latest_raw_candidate_id),
  finder_task_id = VALUES(finder_task_id),
  fit_score = VALUES(fit_score),
  evidence_summary = VALUES(evidence_summary),
  analysis_version = analysis_version + 1,
  decision_status = CASE
    WHEN decision_status IN ('approved', 'rejected') THEN decision_status
    ELSE VALUES(decision_status)
  END
```

- [ ] **Step 4: Run focused and complete Finder tests**

Run: `cd server && node --test routes/finderTasks.test.js`

Expected: all Finder tests PASS, including existing provider/evidence tests.

- [ ] **Step 5: Commit the Finder slice**

```bash
git add server/routes/finderTasks.js server/routes/finderTasks.test.js
git commit -m "feat: scope finder results to campaign products"
```

### Task 5: Approve into one Campaign KOL with multiple Product assignments

**Files:**
- Modify: `server/routes/rawCandidates.js`
- Modify: `server/routes/rawCandidates.test.js`
- Modify: `server/routes/campaignKols.js`

**Interfaces:**
- Consumes: `raw_candidate_product_fits` selected by `campaign_product_id` and identity.
- Produces: approval response field `campaignKolProduct`.
- Produces: `GET /api/campaign-kols/:id/products` and `PUT /api/campaign-kols/:id/products/:campaignProductId`.

- [ ] **Step 1: Write failing approval and reuse tests**

Cover new identity, existing identity/new Product, same Product repeat, and cross-Campaign rejection:

```js
const first = await approveCandidate(everglowCandidateId, everglowCampaignProductId);
const second = await approveCandidate(evercrestCandidateId, evercrestCampaignProductId);

assert.equal(first.body.data.customer.id, second.body.data.customer.id);
assert.equal(first.body.data.campaignKol.id, second.body.data.campaignKol.id);

const assignments = await dbOperations.query(
  'SELECT * FROM campaign_kol_products WHERE campaign_kol_id = ?',
  [first.body.data.campaignKol.id]
);
assert.equal(assignments.length, 2);
```

- [ ] **Step 2: Run and verify RED**

Run: `cd server && node --test routes/rawCandidates.test.js`

Expected: FAIL because approval does not create Product assignments.

- [ ] **Step 3: Implement atomic approval and assignment updates**

Validate that Candidate, Product fit, Campaign Product, Strategy, and Campaign agree. Reuse the existing Customer/platform account and Campaign KOL. Upsert Campaign KOL Product without replacing manual `assignment_status`, `sample_status`, or `content_status`. Return the Product assignment in the approval response. Add list/update endpoints with allowed status enums.

- [ ] **Step 4: Run and verify GREEN**

Run: `cd server && node --test routes/rawCandidates.test.js`

Expected: all approval and Campaign KOL Product tests PASS.

- [ ] **Step 5: Commit the approval slice**

```bash
git add server/routes/rawCandidates.js server/routes/rawCandidates.test.js server/routes/campaignKols.js
git commit -m "feat: assign campaign kols to multiple products"
```

### Task 6: Product and Campaign management UI

**Files:**
- Create: `client/src/pages/productCampaignContract.js`
- Create: `client/src/pages/productCampaignContract.test.js`
- Create: `client/src/pages/Products.js`
- Create: `client/src/pages/Campaigns.js`
- Modify: `client/src/App.js`

**Interfaces:**
- Produces: `normalizeCampaign(row)` and `normalizeCampaignProduct(row)`.
- Consumes: Product and Campaign Product APIs from Task 2.

- [ ] **Step 1: Write failing client contract tests**

```js
expect(normalizeCampaign({ associated_product_count: '4', active_product_count: '2' }))
  .toMatchObject({ associatedProductCount: 4, activeProductCount: 2 });

expect(normalizeCampaignProduct({ status: 'active', product_name: 'Everglow' }))
  .toMatchObject({ status: 'active', productName: 'Everglow' });
```

- [ ] **Step 2: Run and verify RED**

Run: `cd client && CI=true npm test -- --runInBand src/pages/productCampaignContract.test.js`

Expected: FAIL because the contract module does not exist.

- [ ] **Step 3: Implement contracts and pages**

Add `/campaigns` and `/products` menu/routes. Products supports create/edit/archive. Campaigns shows project status, associated/active Product counts, and a detail drawer for adding an existing Product, creating and attaching a Product, editing role/priority/brief/status, and archiving the association. Never label the associated count as the brand's total Product count.

- [ ] **Step 4: Run contract tests and production build**

Run: `cd client && CI=true npm test -- --runInBand src/pages/productCampaignContract.test.js`

Run: `npm run build`

Expected: tests PASS and production build exits 0.

- [ ] **Step 5: Commit the management UI slice**

```bash
git add client/src/pages/productCampaignContract.js client/src/pages/productCampaignContract.test.js client/src/pages/Products.js client/src/pages/Campaigns.js client/src/App.js
git commit -m "feat: manage campaign products in the ui"
```

### Task 7: Product-scoped Strategy, Finder, Candidate, and Cooperation UI

**Files:**
- Modify: `client/src/pages/KolStrategy.js`
- Modify: `client/src/pages/RawCandidates.js`
- Modify: `client/src/pages/RawCandidates.test.js`
- Modify: `client/src/pages/CampaignKols.js`

**Interfaces:**
- Consumes: normalized Product fields from Tasks 2–5.
- Produces: Strategy selection sequence Campaign -> active Campaign Product.
- Produces: Raw Candidate identity labels and Campaign KOL Product assignment editor.

- [ ] **Step 1: Write failing UI behavior tests**

In `RawCandidates.test.js`, assert that a known KOL discovered for a new Product renders `已有 KOL · 新产品匹配`, shows Product name and fit score, and does not disable approval merely because identity exists:

```js
expect(await screen.findByText('已有 KOL · 新产品匹配')).toBeInTheDocument();
expect(screen.getByText('Evercrest')).toBeInTheDocument();
expect(screen.getByText('74')).toBeInTheDocument();
expect(screen.getByRole('button', { name: '通过' })).toBeEnabled();
```

- [ ] **Step 2: Run and verify RED**

Run: `cd client && CI=true npm test -- --runInBand src/pages/RawCandidates.test.js`

Expected: FAIL because Product fit and identity status are not rendered.

- [ ] **Step 3: Implement the scoped UI**

Strategy creation loads active Campaign Products after Campaign selection and sends `campaign_product_id`. Finder confirmation shows Campaign, Product, Strategy, and platform. Raw Candidates adds Product/identity filters and Product fit details. Campaign KOL detail renders all Product assignments and updates product-level statuses without duplicating shared contact fields.

- [ ] **Step 4: Run focused tests and build**

Run: `cd client && CI=true npm test -- --runInBand src/pages/RawCandidates.test.js src/pages/productCampaignContract.test.js`

Run: `npm run build`

Expected: focused tests PASS and build exits 0.

- [ ] **Step 5: Commit the workflow UI slice**

```bash
git add client/src/pages/KolStrategy.js client/src/pages/RawCandidates.js client/src/pages/RawCandidates.test.js client/src/pages/CampaignKols.js
git commit -m "feat: show product-scoped kol workflows"
```

### Task 8: Full regression and migration safety verification

**Files:**
- Modify only if a verified regression requires a focused fix and failing test.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified multi-product Campaign workflow with preserved legacy behavior.

- [ ] **Step 1: Run the complete server suite**

Run: `cd server && npm test`

Expected: exit 0 with zero failed tests.

- [ ] **Step 2: Run focused client tests**

Run: `cd client && CI=true npm test -- --runInBand src/pages/productCampaignContract.test.js src/pages/RawCandidates.test.js src/pages/finderTaskContract.test.js`

Expected: exit 0 with zero failed tests.

- [ ] **Step 3: Build the client**

Run: `npm run build`

Expected: production build exits 0 without compile errors.

- [ ] **Step 4: Check patch hygiene and protected data rules**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors; only intended task files are changed. Confirm no migration contains `DROP TABLE`, destructive deletion of user rows, or removal of legacy Product columns.

- [ ] **Step 5: Commit any verified regression-only corrections**

If Step 1–4 required changes, first add a failing regression test. Stage only
that named test file and the named implementation file changed to satisfy it,
then commit with message `fix: preserve multi-product workflow compatibility`.
If no changes were required, do not create an empty commit.
