const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const supertest = require('supertest');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
require('dotenv').config();

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME_TEST || 'kol_campaign_os_test';

const http = require('http');
const express = require('express');
const { initDatabase, sequelize, models, dbOperations, Sequelize } = require('../database');
const finderTaskRoutes = require('./finderTasks');
const finderSubtaskRoutes = require('./finderSubtasks');
const baselineMigration = require('../migrations/20260707000001-create-v2-core-tables');
const replaceCyclesMigration = require('../migrations/20260709000001-replace-cycles-with-evidence-signals');
const multiProductMigration = require('../migrations/20260719000001-add-multi-product-campaign-relations');
const { computeUrlHash } = require('../utils/videoUrlNormalizer');

async function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/finder-tasks', finderTaskRoutes);
  app.use('/api/finder-subtasks', finderSubtaskRoutes);
  return app;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resetTestDatabase() {
  const { Sequelize } = require('sequelize');
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
}

function safeParseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

async function createCampaignProduct(campaignId, {
  name = 'Finder Catalog Product',
  brand = 'Test Brand',
  campaignBrief = 'Finder-specific campaign product brief',
  status = 'active'
} = {}) {
  const product = await models.Product.create({
    brand,
    name,
    sku: `${name.replace(/\W+/g, '-').toUpperCase()}-${campaignId}`,
    category: 'Audio Gear',
    description: `${name} global product description`,
    selling_points: JSON.stringify(['Low latency', 'Studio-quality sound']),
    status: 'active',
    catalog_key_hash: crypto.createHash('sha256').update(`${campaignId}:${brand}:${name}`).digest('hex')
  });
  const campaignProduct = await models.CampaignProduct.create({
    campaign_id: campaignId,
    product_id: product.id,
    role: 'hero',
    priority: 7,
    campaign_brief: campaignBrief,
    status
  });
  return { product, campaignProduct };
}

async function seedBaseData() {
  const campaign = await models.Campaign.create({
    name: 'Test Campaign',
    brand: 'Test Brand',
    product: 'Test Product'
  });
  const { product, campaignProduct } = await createCampaignProduct(campaign.id);
  const strategy = await models.KolStrategy.create({
    campaign_id: campaign.id,
    campaign_product_id: campaignProduct.id,
    name: 'Test Strategy',
    brand: 'Test Brand',
    product: 'Test Product',
    primary_platform: 'youtube',
    status: 'ready'
  });
  return { campaign, product, campaignProduct, strategy };
}

test('migration replaces cycle schema without clearing business data', async () => {
  await resetTestDatabase();

  // Simulate the migration history table that Umzug normally maintains.
  await sequelize.getQueryInterface().createTable('sequelize_meta', {
    name: { type: Sequelize.STRING, allowNull: false, primaryKey: true }
  });
  await sequelize.query(
    `INSERT INTO sequelize_meta (name) VALUES ('20260707000001-create-v2-core-tables.js')`
  );

  // Run baseline migration to create V2 schema and seed configuration defaults.
  await baselineMigration.up(sequelize.getQueryInterface(), Sequelize);

  // Seed configuration rows that must survive the destructive migration.
  await models.ApiSetting.create({ provider: 'test-provider', api_key: 'test-key' });

  // Seed business rows that must survive until the final explicit reset.
  const campaign = await models.Campaign.create({ name: 'Migration Test Campaign', brand: 'Test', product: 'Test' });
  const strategy = await models.KolStrategy.create({
    campaign_id: campaign.id,
    name: 'Migration Test Strategy',
    brand: 'Test',
    product: 'Test',
    primary_platform: 'youtube',
    status: 'ready'
  });
  await models.FinderTask.create({
    campaign_id: campaign.id,
    strategy_id: strategy.id,
    name: 'Migration Test Task',
    platform: 'youtube',
    status: 'draft'
  });

  // Run the schema replacement migration.
  await replaceCyclesMigration.up(sequelize.getQueryInterface(), Sequelize);
  await sequelize.query(
    `INSERT INTO sequelize_meta (name) VALUES ('20260709000001-replace-cycles-with-evidence-signals.js')`
  );

  // Configuration tables must retain rows.
  assert.ok((await models.CustomerGroup.count()) > 0, 'customer_groups should retain rows');
  assert.ok((await models.PromptTemplate.count()) > 0, 'prompt_templates should retain rows');
  assert.ok((await models.ApiSetting.count()) > 0, 'api_settings should retain rows');

  const [{ metaCount }] = await sequelize.query(
    'SELECT COUNT(*) AS metaCount FROM sequelize_meta',
    { type: sequelize.QueryTypes.SELECT }
  );
  assert.ok(Number(metaCount) > 0, 'sequelize_meta should retain rows');

  assert.equal(await models.Campaign.count(), 2, 'campaigns must survive schema migration');
  assert.equal(await models.KolStrategy.count(), 1, 'strategies must survive schema migration');
  assert.equal(await models.FinderTask.count(), 1, 'finder tasks must survive schema migration');

  // Legacy cycle columns must be removed.
  const legacyColumns = [
    { table: 'kol_strategies', column: 'search_strategy' },
    { table: 'finder_tasks', column: 'search_cycles' },
    { table: 'finder_tasks', column: 'target_platforms' },
    { table: 'finder_tasks', column: 'current_cycle' },
    { table: 'finder_tasks', column: 'total_cycles' },
    { table: 'finder_tasks', column: 'completed_cycles' },
    { table: 'raw_candidates', column: 'search_cycle' }
  ];
  for (const { table, column } of legacyColumns) {
    const rows = await sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      { replacements: [table, column], type: sequelize.QueryTypes.SELECT }
    );
    assert.equal(rows.length, 0, `${table}.${column} should be removed`);
  }

  // New evidence_signals column must exist on video_ai_analysis_results.
  const evidenceRows = await sequelize.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'video_ai_analysis_results' AND COLUMN_NAME = 'evidence_signals'`,
    { type: sequelize.QueryTypes.SELECT }
  );
  assert.equal(evidenceRows.length, 1, 'video_ai_analysis_results.evidence_signals should exist');
});

test('multi-product migration preserves legacy campaign data', async () => {
  await resetTestDatabase();
  await baselineMigration.up(sequelize.getQueryInterface(), Sequelize);

  const campaign = await models.Campaign.create({
    name: 'Multi-product Migration Campaign',
    brand: 'Test',
    product: 'Test'
  });
  await models.KolStrategy.create({
    campaign_id: campaign.id,
    name: 'Multi-product Migration Strategy',
    brand: 'Test',
    product: 'Test',
    primary_platform: 'youtube',
    status: 'ready'
  });
  const duplicateCampaign = await models.Campaign.create({
    name: 'Normalized Duplicate Campaign',
    brand: ' test ',
    product: ' TEST '
  });
  const accentedCampaign = await models.Campaign.create({
    name: 'Accented Brand Campaign',
    brand: 'Tést',
    product: 'Test'
  });
  const blankCampaign = await models.Campaign.create({
    name: 'Blank Product Campaign',
    brand: 'Test',
    product: '   '
  });

  await multiProductMigration.up(sequelize.getQueryInterface(), Sequelize);
  await multiProductMigration.up(sequelize.getQueryInterface(), Sequelize);

  const queryInterface = sequelize.getQueryInterface();
  const tableNames = (await queryInterface.showAllTables()).map(table => (
    typeof table === 'string' ? table : table.tableName
  ));
  for (const table of [
    'products',
    'campaign_products',
    'raw_candidate_product_fits',
    'campaign_kol_products'
  ]) {
    assert.ok(tableNames.includes(table), `${table} should exist`);
  }

  const requiredColumns = {
    products: [
      'id', 'brand', 'name', 'sku', 'category', 'product_url', 'price', 'currency',
      'description', 'selling_points', 'status', 'catalog_key_hash', 'created_at', 'updated_at'
    ],
    campaign_products: [
      'id', 'campaign_id', 'product_id', 'role', 'priority', 'campaign_brief', 'status',
      'created_at', 'updated_at'
    ],
    raw_candidate_product_fits: [
      'id', 'latest_raw_candidate_id', 'existing_customer_id', 'campaign_product_id',
      'platform', 'identity_key_hash', 'strategy_id', 'finder_task_id', 'identity_status',
      'fit_score', 'matched_persona', 'evidence_summary', 'decision_status',
      'analysis_version', 'created_at', 'updated_at'
    ],
    campaign_kol_products: [
      'id', 'campaign_kol_id', 'campaign_product_id', 'source_raw_candidate_product_fit_id',
      'fit_score', 'fit_status', 'evidence_summary', 'assignment_status', 'quoted_fee',
      'sample_status', 'deliverables', 'content_status', 'result_summary',
      'created_at', 'updated_at'
    ]
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const description = await queryInterface.describeTable(table);
    for (const column of columns) {
      assert.ok(description[column], `${table}.${column} should exist`);
    }
  }
  const rawFitColumns = await queryInterface.describeTable('raw_candidate_product_fits');
  assert.equal(rawFitColumns.raw_candidate_id, undefined, 'legacy raw_candidate_id should not be created');

  const strategyColumns = await queryInterface.describeTable('kol_strategies');
  const finderTaskColumns = await queryInterface.describeTable('finder_tasks');
  assert.ok(strategyColumns.campaign_product_id, 'kol_strategies.campaign_product_id should exist');
  assert.ok(finderTaskColumns.campaign_product_id, 'finder_tasks.campaign_product_id should exist');

  async function assertIndex(table, name, fields, unique = false) {
    const indexes = await queryInterface.showIndex(table);
    const index = indexes.find(candidate => candidate.name === name);
    assert.ok(index, `${table}.${name} should exist`);
    assert.deepEqual(index.fields.map(field => field.attribute), fields);
    assert.equal(Boolean(index.unique), unique);
  }

  async function assertForeignKey(table, column, referencedTable) {
    const foreignKeys = await queryInterface.getForeignKeyReferencesForTable(table);
    assert.ok(
      foreignKeys.some(key => key.columnName === column && key.referencedTableName === referencedTable),
      `${table}.${column} should reference ${referencedTable}`
    );
  }

  await assertIndex('products', 'uq_products_catalog_key_hash', ['catalog_key_hash'], true);
  await assertIndex(
    'campaign_products',
    'uq_campaign_products_campaign_product',
    ['campaign_id', 'product_id'],
    true
  );
  await assertIndex(
    'raw_candidate_product_fits',
    'uq_raw_candidate_product_fits_identity',
    ['campaign_product_id', 'identity_key_hash'],
    true
  );
  await assertIndex(
    'campaign_kol_products',
    'uq_campaign_kol_products_campaign_kol_product',
    ['campaign_kol_id', 'campaign_product_id'],
    true
  );
  await assertIndex('kol_strategies', 'idx_kol_strategies_campaign_product', ['campaign_product_id']);
  await assertIndex('finder_tasks', 'idx_finder_tasks_campaign_product', ['campaign_product_id']);

  await assertForeignKey('campaign_products', 'campaign_id', 'campaigns');
  await assertForeignKey('campaign_products', 'product_id', 'products');
  await assertForeignKey('raw_candidate_product_fits', 'latest_raw_candidate_id', 'raw_candidates');
  await assertForeignKey('raw_candidate_product_fits', 'existing_customer_id', 'customers');
  await assertForeignKey('raw_candidate_product_fits', 'campaign_product_id', 'campaign_products');
  await assertForeignKey('raw_candidate_product_fits', 'strategy_id', 'kol_strategies');
  await assertForeignKey('raw_candidate_product_fits', 'finder_task_id', 'finder_tasks');
  await assertForeignKey('campaign_kol_products', 'campaign_kol_id', 'campaign_kols');
  await assertForeignKey('campaign_kol_products', 'campaign_product_id', 'campaign_products');
  await assertForeignKey(
    'campaign_kol_products',
    'source_raw_candidate_product_fit_id',
    'raw_candidate_product_fits'
  );
  await assertForeignKey('kol_strategies', 'campaign_product_id', 'campaign_products');
  await assertForeignKey('finder_tasks', 'campaign_product_id', 'campaign_products');

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
  assert.equal(campaignProduct.role, 'hero');

  const duplicateCampaignProduct = await dbOperations.get(
    'SELECT * FROM campaign_products WHERE campaign_id = ?',
    [duplicateCampaign.id]
  );
  assert.equal(duplicateCampaignProduct.product_id, product.id);
  assert.equal(duplicateCampaignProduct.role, 'hero');

  const primaryRole = await dbOperations.get(
    "SELECT COUNT(*) AS count FROM campaign_products WHERE role = 'primary'"
  );
  assert.equal(Number(primaryRole.count), 0, 'migration must not produce the unsupported primary role');

  const accentedCampaignProduct = await dbOperations.get(
    'SELECT * FROM campaign_products WHERE campaign_id = ?',
    [accentedCampaign.id]
  );
  assert.notEqual(accentedCampaignProduct.product_id, product.id);
  assert.equal(await models.Product.count(), 2, 'normalized duplicates should reuse one product');

  const blankCampaignProduct = await dbOperations.get(
    'SELECT * FROM campaign_products WHERE campaign_id = ?',
    [blankCampaign.id]
  );
  assert.equal(blankCampaignProduct, null, 'blank legacy products should not be backfilled');

  const preservedStrategy = await models.KolStrategy.findOne({
    where: { campaign_id: campaign.id }
  });
  assert.equal(preservedStrategy.campaign_product_id, campaignProduct.id);

  const preserved = await models.Campaign.findByPk(campaign.id);
  assert.equal(preserved.product, 'Test');
});

test('multi-product migration upgrades legacy raw candidate product fits safely', async () => {
  await resetTestDatabase();
  await baselineMigration.up(sequelize.getQueryInterface(), Sequelize);

  const queryInterface = sequelize.getQueryInterface();
  const campaign = await models.Campaign.create({
    name: 'Legacy Upgrade Campaign',
    brand: 'Test',
    product: 'Test'
  });
  const rawCandidate = await models.RawCandidate.create({
    campaign_id: campaign.id,
    platform: 'youtube',
    kol_name: 'Legacy Upgrade Creator'
  });

  await queryInterface.createTable('products', {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    brand: { type: Sequelize.STRING(255), allowNull: false, defaultValue: '' },
    name: { type: Sequelize.STRING(255), allowNull: false },
    created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
  });
  await queryInterface.addIndex('products', ['brand', 'name'], {
    name: 'uq_products_brand_name',
    unique: true
  });
  const productInsert = await dbOperations.run(
    `INSERT INTO products (brand, name, created_at, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ['Test', 'Test']
  );

  await queryInterface.createTable('campaign_products', {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    campaign_id: { type: Sequelize.INTEGER, allowNull: false },
    product_id: { type: Sequelize.INTEGER, allowNull: false },
    status: { type: Sequelize.STRING(50), allowNull: false, defaultValue: 'active' },
    created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
  });
  await queryInterface.addIndex('campaign_products', ['campaign_id', 'product_id'], {
    name: 'uq_campaign_products_campaign_product',
    unique: true
  });
  const campaignProductInsert = await dbOperations.run(
    `INSERT INTO campaign_products
       (campaign_id, product_id, status, created_at, updated_at)
     VALUES (?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [campaign.id, productInsert.id]
  );

  await queryInterface.createTable('raw_candidate_product_fits', {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    raw_candidate_id: { type: Sequelize.INTEGER, allowNull: false },
    campaign_product_id: { type: Sequelize.INTEGER, allowNull: false },
    identity_key_hash: { type: Sequelize.CHAR(64), allowNull: false },
    analysis_version: { type: Sequelize.STRING(100), allowNull: true },
    created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
  });
  await queryInterface.addConstraint('raw_candidate_product_fits', {
    fields: ['raw_candidate_id'],
    type: 'foreign key',
    name: 'fk_raw_candidate_product_fits_candidate',
    references: { table: 'raw_candidates', field: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'CASCADE'
  });
  await dbOperations.run(
    `INSERT INTO raw_candidate_product_fits
       (raw_candidate_id, campaign_product_id, identity_key_hash, analysis_version, created_at, updated_at)
     VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [rawCandidate.id, campaignProductInsert.id, 'a'.repeat(64)]
  );

  await multiProductMigration.up(queryInterface, Sequelize);

  const rawFitColumns = await queryInterface.describeTable('raw_candidate_product_fits');
  assert.equal(rawFitColumns.raw_candidate_id, undefined);
  assert.equal(rawFitColumns.latest_raw_candidate_id.allowNull, true);
  assert.match(rawFitColumns.analysis_version.type, /INT/i);
  assert.equal(rawFitColumns.analysis_version.allowNull, false);
  assert.equal(Number(rawFitColumns.analysis_version.defaultValue), 1);

  const foreignKeyRule = await dbOperations.get(
    `SELECT rc.DELETE_RULE AS delete_rule, rc.UPDATE_RULE AS update_rule
     FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
     JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
      AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
      AND kcu.TABLE_NAME = rc.TABLE_NAME
     WHERE rc.CONSTRAINT_SCHEMA = DATABASE()
       AND rc.TABLE_NAME = 'raw_candidate_product_fits'
       AND kcu.COLUMN_NAME = 'latest_raw_candidate_id'`
  );
  assert.equal(foreignKeyRule.delete_rule, 'SET NULL');
  assert.equal(foreignKeyRule.update_rule, 'CASCADE');

  const upgradedFit = await dbOperations.get(
    `SELECT analysis_version, analysis_version + 1 AS next_analysis_version
     FROM raw_candidate_product_fits
     WHERE latest_raw_candidate_id = ?`,
    [rawCandidate.id]
  );
  assert.equal(upgradedFit.analysis_version, 1);
  assert.equal(upgradedFit.next_analysis_version, 2);
});

async function startMockAiServer({ delayMs = 0, shouldFail = null } = {}) {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/chat/completions' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          requests.push(JSON.parse(body));
          if (shouldFail && shouldFail(requests.length, requests[requests.length - 1])) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'mock AI failure' } }));
            return;
          }
          const content = JSON.stringify({
            hard_filter: {
              passed: true,
              is_real_creator: true,
              target_platform_match: true,
              follower_range_match: true,
              market_language_match: 'certain',
              profile_accessible: true,
              hard_filter_notes: 'All hard filter checks passed'
            },
            signal_scores: {
              competitor_fit: 20,
              category_fit: 90,
              use_case_fit: 78,
              feature_fit: 60,
              community_fit: 70
            },
            evidence_signals: [
              { signal: 'competitor', reason: 'Compares a competing product' },
              { signal: 'feature', reason: 'Demonstrates the required feature' },
              { signal: 'feature', reason: 'Duplicate signal' },
              { signal: 'native_platform', reason: 'Legacy signal' }
            ],
            evidence_strength_score: 88,
            creator_profile_scores: {
              creator_tone_fit: 82,
              content_consistency: 76,
              posting_frequency: 68,
              traffic_quality: 74,
              audience_market_fit: 70,
              contactability: 50
            },
            risk: {
              risk_level: 'low',
              risk_notes: '',
              risk_deduction: 0
            },
            candidate_decision: {
              enter_raw_candidates: true,
              candidate_priority_score: 92,
              priority_level: 'high',
              recommended_status: 'new',
              reason: '该创作者发布过与品类和使用场景高度相关的视频，主页调性匹配，建议进入候选池。'
            }
          });
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content } }] }));
          }, delayMs);
        });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests });
    });
  });
}

async function startMockScrapeCreatorsServer(responder) {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url, headers: req.headers });
      const response = responder(req) || {};
      res.writeHead(response.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.body || {}));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests });
    });
  });
}

async function seedMockAiSettings(port) {
  await models.ApiSetting.create({
    provider: 'system.provider_selection',
    extra_config: JSON.stringify({ aiModels: { active: 'deepseek' } })
  });
  await models.ApiSetting.create({
    provider: 'ai.deepseek',
    api_key: 'test-key',
    base_url: `http://127.0.0.1:${port}`,
    model: 'deepseek-chat'
  });
}

async function seedMockScrapeCreatorsSettings(port, apiKey = 'scrape-test-key', platform = 'instagram') {
  await models.ApiSetting.create({
    provider: `${platform}.scrapecreators`,
    api_key: apiKey,
    base_url: `http://127.0.0.1:${port}`
  });
}

test('finder subtasks routes return 410 Gone', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);

  const res = await request.get('/api/finder-subtasks');
  assert.equal(res.status, 410);
  assert.equal(res.body.success, false);

  const res2 = await request.get('/api/finder-subtasks/1');
  assert.equal(res2.status, 410);

  const res3 = await request.post('/api/finder-subtasks');
  assert.equal(res3.status, 410);
});

test('finder task accepts one target platform and rejects legacy execution fields', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();

  const created = await request.post('/api/finder-tasks').send({
    strategy_id: strategy.id,
    target_platform: 'youtube',
    limit: 10
  });
  assert.equal(created.status, 200);
  const rawRequest = safeParseJson(created.body.data.raw_request);
  assert.equal(rawRequest.target_platform, 'youtube');
  assert.equal(Object.prototype.hasOwnProperty.call(rawRequest, 'cycles'), false);

  for (const legacyField of ['cycles', 'search_cycles', 'search_intensity', 'execution_mode', 'target_platforms']) {
    const response = await request.post('/api/finder-tasks').send({
      strategy_id: strategy.id,
      target_platform: 'youtube',
      [legacyField]: []
    });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /Legacy Finder fields are no longer supported/);
  }
});

test('finder task inherits its campaign product and ignores a conflicting caller product', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { campaign, campaignProduct, strategy } = await seedBaseData();
  const { campaignProduct: conflictingProduct } = await createCampaignProduct(campaign.id, {
    name: 'Conflicting Finder Product'
  });

  const created = await request.post('/api/finder-tasks').send({
    strategy_id: strategy.id,
    campaign_product_id: conflictingProduct.id,
    target_platform: 'youtube'
  });

  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.data.campaign_product_id, campaignProduct.id);
  assert.notEqual(created.body.data.campaign_product_id, conflictingProduct.id);
  assert.equal(safeParseJson(created.body.data.raw_request).campaign_product_id, campaignProduct.id);
});

test('finder task rejects an archived campaign product binding', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { campaignProduct, strategy } = await seedBaseData();
  await campaignProduct.update({ status: 'archived' });

  const response = await request.post('/api/finder-tasks').send({
    strategy_id: strategy.id,
    target_platform: 'youtube'
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /campaign product.*active/i);
  assert.equal(await models.FinderTask.count(), 0);
});

test('campaign product context and matched creator history are included in the evidence prompt', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { campaignProduct, product, strategy } = await seedBaseData();
  const normalizedProfileUrl = 'https://www.youtube.com/@known.creator';
  const wrongCustomer = await models.Customer.create({
    name: 'Known Creator',
    cooperation_status: 'do_not_contact',
    cooperation_risk_reason: 'Same display name but a different profile'
  });
  const matchedCustomer = await models.Customer.create({
    name: 'Matched Master Creator (private name)',
    cooperation_status: 'available',
    cooperation_risk_reason: 'Private free-text risk reason must never reach AI'
  });
  await models.KolPlatformAccount.create({
    customer_id: matchedCustomer.id,
    platform: 'youtube',
    username: 'known.creator',
    profile_url: normalizedProfileUrl,
    profile_url_hash: computeUrlHash(normalizedProfileUrl)
  });
  const { server: mockServer, port, requests } = await startMockAiServer();
  await seedMockAiSettings(port);

  try {
    const taskRes = await request.post('/api/finder-tasks').send({
      strategy_id: strategy.id,
      target_platform: 'youtube'
    });
    const importRes = await request
      .post(`/api/finder-tasks/${taskRes.body.data.id}/video-evidence/import`)
      .send({
        evidence: [{
          video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          title: 'Campaign product demo',
          author_name: 'Known Creator',
          author_profile_url: 'https://youtube.com/@Known.Creator/?view_as=subscriber'
        }]
      });
    const evidenceId = importRes.body.data.results[0].data.id;

    const analyzed = await request
      .post(`/api/finder-tasks/${taskRes.body.data.id}/evidence-analysis`)
      .send({ evidence_ids: [evidenceId] });

    assert.equal(analyzed.status, 200, JSON.stringify(analyzed.body));
    assert.equal(analyzed.body.data.success_count, 1, JSON.stringify(analyzed.body));
    const finalPrompt = requests[0].messages.find((message) => message.role === 'user').content;
    assert.match(finalPrompt, new RegExp(product.name));
    assert.match(finalPrompt, new RegExp(campaignProduct.campaign_brief));
    assert.match(finalPrompt, /"known_creator": true/);
    assert.match(finalPrompt, /"cooperation_status": "available"/);
    assert.doesNotMatch(finalPrompt, /"customer_id"|"customer_name"|"profile_url"|"cooperation_risk_reason"|"cooperation_history"/);
    assert.doesNotMatch(finalPrompt, /Matched Master Creator \(private name\)|Private free-text risk reason|https:\/\/www\.youtube\.com\/@known\.creator/);
  } finally {
    mockServer.close();
  }
});

test('AI binding race archives the campaign product without persisting analysis', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { campaignProduct, strategy } = await seedBaseData();
  const { server: mockServer, port } = await startMockAiServer({ delayMs: 120 });
  await seedMockAiSettings(port);
  try {
    const taskRes = await request.post('/api/finder-tasks').send({ strategy_id: strategy.id, target_platform: 'youtube' });
    const taskId = taskRes.body.data.id;
    const imported = await request.post(`/api/finder-tasks/${taskId}/video-evidence/import`).send({ evidence: [{
      video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', author_name: 'Race Creator', author_profile_url: 'https://youtube.com/@race.creator'
    }] });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const analysis = request.post(`/api/finder-tasks/${taskId}/evidence-analysis`).send({ evidence_ids: [imported.body.data.results[0].data.id] });
    await sleep(30);
    await campaignProduct.update({ status: 'archived' });
    const response = await analysis;
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(await models.VideoAiAnalysisResult.count(), 0);
    const task = await models.FinderTask.findByPk(taskId);
    assert.equal(task.status, 'failed');
    assert.match(task.error_message, /binding failed/i);
  } finally {
    mockServer.close();
  }
});

test('task binding guard rejects legacy tasks and a strategy rebound before import, analysis, or generation writes', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { campaign, campaignProduct, strategy } = await seedBaseData();
  const legacy = await models.FinderTask.create({ campaign_id: campaign.id, strategy_id: strategy.id, platform: 'youtube', status: 'draft' });
  const legacyGenerate = await request.post(`/api/finder-tasks/${legacy.id}/generate-candidates-from-evidence`).send({});
  assert.equal(legacyGenerate.status, 409);
  assert.equal(await models.RawCandidate.count(), 0);
  assert.equal(await models.RawCandidateProductFit.count(), 0);

  const taskRes = await request.post('/api/finder-tasks').send({ strategy_id: strategy.id, target_platform: 'youtube' });
  const taskId = taskRes.body.data.id;
  const { campaignProduct: reboundProduct } = await createCampaignProduct(campaign.id, { name: 'Rebound Product' });
  await strategy.update({ campaign_product_id: reboundProduct.id });
  const input = { evidence: [{ video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', author_name: 'Guarded', author_profile_url: 'https://youtube.com/@guarded' }] };
  for (const suffix of ['video-evidence/import', 'evidence-analysis', 'generate-candidates-from-evidence']) {
    const response = await request.post(`/api/finder-tasks/${taskId}/${suffix}`).send(input);
    assert.equal(response.status, 409, `${suffix}: ${JSON.stringify(response.body)}`);
  }
  assert.equal(await models.FinderVideoEvidence.count(), 0);
  assert.equal(await models.RawCandidate.count(), 0);
  assert.equal(await models.RawCandidateProductFit.count(), 0);
  assert.equal(campaignProduct.id, taskRes.body.data.campaign_product_id);
});

test('same-name creators with distinct profile identities produce distinct raw candidates', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  const taskRes = await request.post('/api/finder-tasks').send({ strategy_id: strategy.id, target_platform: 'youtube' });
  const taskId = taskRes.body.data.id;
  const imported = await request.post(`/api/finder-tasks/${taskId}/video-evidence/import`).send({ evidence: [
    { video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', author_name: 'Same Name', author_profile_url: 'https://youtube.com/@first-profile' },
    { video_url: 'https://www.youtube.com/watch?v=9bZkp7q19f0', author_name: 'Same Name', author_profile_url: 'https://youtube.com/@second-profile' }
  ] });
  for (const result of imported.body.data.results) {
    await models.VideoAiAnalysisResult.create({
      video_source_id: result.data.video_source_id, analysis_type: 'finder_evidence', analysis_scope_id: result.data.id,
      status: 'success', score: 80, summary: 'Distinct profile evidence',
      extra_data: JSON.stringify({ hard_filter: { passed: true, market_language_match: 'certain' }, signal_scores: { category_fit: 80 }, evidence_strength_score: 80, risk: { risk_level: 'low' }, candidate_decision: { enter_raw_candidates: true, candidate_priority_score: 80, recommended_status: 'manual_review' } })
    });
  }
  const generated = await request.post(`/api/finder-tasks/${taskId}/generate-candidates-from-evidence`).send({});
  assert.equal(generated.status, 200, JSON.stringify(generated.body));
  assert.equal(await models.RawCandidate.count(), 2);
  assert.equal(await models.RawCandidateProductFit.count(), 2);
});

test('profile username fallback excludes a creator already present in KOL Master', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { campaignProduct, strategy } = await seedBaseData();
  const customer = await models.Customer.create({ name: 'Private customer', cooperation_status: 'available' });
  await models.KolPlatformAccount.create({ customer_id: customer.id, platform: 'youtube', username: '@legacy.handle', profile_url: 'https://www.youtube.com/channel/legacy-channel-id', profile_url_hash: 'legacy-hash' });
  const taskRes = await request.post('/api/finder-tasks').send({ strategy_id: strategy.id, target_platform: 'youtube' });
  const imported = await request.post(`/api/finder-tasks/${taskRes.body.data.id}/video-evidence/import`).send({ evidence: [{ video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', author_name: 'Different display name', author_profile_url: 'https://youtube.com/@Legacy.Handle/?x=1' }] });
  const evidence = imported.body.data.results[0].data;
  await models.VideoAiAnalysisResult.create({ video_source_id: evidence.video_source_id, analysis_type: 'finder_evidence', analysis_scope_id: evidence.id, status: 'success', score: 90, summary: 'legacy', extra_data: JSON.stringify({ hard_filter: { passed: true, market_language_match: 'certain' }, signal_scores: { category_fit: 90 }, evidence_strength_score: 90, risk: { risk_level: 'low' }, candidate_decision: { enter_raw_candidates: true, candidate_priority_score: 90, recommended_status: 'manual_review' } }) });
  const generated = await request.post(`/api/finder-tasks/${taskRes.body.data.id}/generate-candidates-from-evidence`).send({}).expect(200);
  assert.equal(await models.RawCandidate.count(), 0);
  assert.equal(await models.RawCandidateProductFit.count({ where: { campaign_product_id: campaignProduct.id } }), 0);
  assert.equal(generated.body.data.skipped[0].master_duplicate, true);
  assert.equal(generated.body.data.skipped[0].customer_id, customer.id);
});

test('YouTube identity helpers normalize channel and handle URL variants', () => {
  assert.deepEqual(
    finderTaskRoutes.youtubeChannelIdentity('https://youtube.com/channel/UCAbCdEf1234567890123456/videos?x=1'),
    { channelId: 'UCAbCdEf1234567890123456', handle: '' }
  );
  assert.deepEqual(
    finderTaskRoutes.youtubeChannelIdentity('https://www.youtube.com/@ViceGripLodge/videos'),
    { channelId: '', handle: 'vicegriplodge' }
  );
  assert.equal(finderTaskRoutes.normalizeCreatorLabel(' Vice Grip Lodge '), 'vicegriplodge');
});

test('YouTube preflight rejects market, activity and median failures before AI analysis', () => {
  const parsedConfig = finderTaskRoutes.youtubePreflightConfig({
    campaign: { target_market: 'United States' },
    strategy: { finder_handoff: {
      minimum_avg_views: 'At least 20,000 median views across the latest 10 relevant long-form videos',
      required_evidence: ['At least 3 recent relevant long-form videos of 8 minutes or longer']
    } }
  });
  assert.equal(parsedConfig.minimumMedianViews, 20000);
  assert.equal(parsedConfig.minimumLongVideos, 3);
  assert.equal(finderTaskRoutes.finderScanLimit({
    campaign: { target_market: 'United States' },
    strategy: { finder_handoff: { minimum_avg_views: '15,353 median views' } }
  }, 20), 100);
  assert.equal(finderTaskRoutes.finderScanLimit({ campaign: {}, strategy: { finder_handoff: {} } }, 20), 20);
  const config = {
    enabled: true,
    targetMarket: 'united states',
    activityDays: 90,
    minimumLongVideos: 3,
    minimumLongSeconds: 480,
    minimumMedianViews: 15353
  };
  const now = new Date('2026-07-30T00:00:00Z');
  const video = (id, daysAgo, views, duration = 'PT10M') => ({
    id,
    snippet: { title: `Field test ${id}`, publishedAt: new Date(now.getTime() - daysAgo * 86400000).toISOString() },
    statistics: { viewCount: String(views) },
    contentDetails: { duration }
  });
  const creator = { kol_name: 'Independent Farm Creator', country_region: 'US', raw_data: { channel: { snippet: {} } } };
  const passing = finderTaskRoutes.evaluateYoutubePreflight(creator, [
    video('a', 10, 20000), video('b', 20, 18000), video('c', 30, 16000)
  ], config, now);
  assert.equal(passing.passed, true);
  assert.equal(passing.medianViews, 18000);

  assert.equal(finderTaskRoutes.evaluateYoutubePreflight(
    { ...creator, country_region: 'CA' }, [video('a', 10, 20000)], config, now
  ).reason, 'market_mismatch');
  assert.equal(finderTaskRoutes.evaluateYoutubePreflight(
    { ...creator, country_region: '' }, [video('a', 10, 20000)], config, now
  ).reason, 'market_unverified');
  assert.equal(finderTaskRoutes.evaluateYoutubePreflight(creator, [
    video('a', 120, 20000), video('b', 130, 20000), video('c', 140, 20000)
  ], config, now).reason, 'inactive_90d');
  assert.equal(finderTaskRoutes.evaluateYoutubePreflight(creator, [], config, now).reason, 'preflight_unavailable');
  assert.equal(finderTaskRoutes.evaluateYoutubePreflight(creator, [
    video('a', 10, 1000), video('b', 20, 2000), video('c', 30, 3000)
  ], config, now).reason, 'median_views_below_threshold');
  assert.equal(finderTaskRoutes.evaluateYoutubePreflight(
    { ...creator, kol_name: 'Example Tractor Ltd' }, [video('a', 10, 20000), video('b', 20, 20000), video('c', 30, 20000)], config, now
  ).reason, 'brand_or_dealer_account');
});

test('YouTube preflight uses uploads playlist and reuses channel cache without search.list', async () => {
  await resetTestDatabase();
  await initDatabase();
  const requestedPaths = [];
  const uniqueChannelId = `UCTestUploads${Date.now()}`;
  const uniqueUploadsId = `UUTestUploads${Date.now()}`;
  const publishedAt = new Date(Date.now() - 10 * 86400000).toISOString();
  const mockGateway = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requestedPaths.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/youtube/youtube/v3/playlistItems')) {
        res.end(JSON.stringify({
          items: ['one', 'two', 'three'].map((id) => ({
            contentDetails: { videoId: id },
            snippet: { publishedAt }
          }))
        }));
        return;
      }
      if (req.url.startsWith('/youtube/youtube/v3/videos')) {
        res.end(JSON.stringify({
          items: ['one', 'two', 'three'].map((id, index) => ({
            id,
            snippet: { title: `Farm test ${id}`, publishedAt },
            statistics: { viewCount: String(20000 + index * 1000) },
            contentDetails: { duration: 'PT12M' }
          }))
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'unexpected endpoint' } }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
  const requestConfig = {
    campaign: { target_market: 'United States' },
    strategy: { finder_handoff: {
      minimum_avg_views: '15,353 median views',
      required_evidence: ['At least 3 recent relevant long-form videos of 8 minutes or longer']
    } }
  };
  const candidates = [{
    kol_name: 'Independent Farm Creator',
    profile_url: `https://www.youtube.com/channel/${uniqueChannelId}`,
    country_region: 'US',
    raw_data: {
      channel: {
        snippet: { country: 'US' },
        contentDetails: { relatedPlaylists: { uploads: uniqueUploadsId } }
      }
    }
  }];
  try {
    const first = await finderTaskRoutes.preflightYoutubeCandidates(
      candidates, requestConfig, { api_key: 'token' }, `http://127.0.0.1:${mockGateway.port}`, 10, 1
    );
    assert.equal(first.candidates.length, 1);
    assert.equal(first.requestCount, 2);
    assert.equal(requestedPaths.filter((path) => path.includes('/search')).length, 0);
    assert.equal(requestedPaths.filter((path) => path.includes('/playlistItems')).length, 1);

    const second = await finderTaskRoutes.preflightYoutubeCandidates(
      candidates, requestConfig, { api_key: 'token' }, `http://127.0.0.1:${mockGateway.port}`, 10, 1
    );
    assert.equal(second.candidates.length, 1);
    assert.equal(second.requestCount, 0);
    assert.equal(requestedPaths.length, 2, 'cached preflight must not call Maton again');
    assert.equal(second.candidates[0].raw_data.preflight.cache_hit, true);
  } finally {
    await new Promise((resolve) => mockGateway.server.close(resolve));
  }
});

test('Maton 429 remains the primary error when Google fallback is not configured', async () => {
  await resetTestDatabase();
  await initDatabase();
  const mockGateway = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Maton daily quota exceeded' } }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
  try {
    await models.ApiSetting.destroy({
      where: { provider: ['system.provider_selection', 'youtube.maton_gateway'] }
    });
    await models.ApiSetting.create({
      provider: 'system.provider_selection',
      extra_config: JSON.stringify({ platforms: { youtube: { primary: 'maton_gateway', fallbacks: [] } } })
    });
    await models.ApiSetting.create({
      provider: 'youtube.maton_gateway',
      api_key: 'maton-token',
      base_url: `http://127.0.0.1:${mockGateway.port}`
    });
    await assert.rejects(
      finderTaskRoutes.runProvider({
        search_source: 'maton_agent',
        discovery_route: 'target_platform_first',
        target_platform: 'youtube',
        limit: 1,
        discovery: { keywords: 'tractor mower review' },
        campaign: { name: 'Mower', target_market: 'United States' },
        strategy: { finder_handoff: {}, persona_config: {} }
      }, true),
      (error) => {
        assert.match(error.message, /Maton daily quota exceeded/);
        assert.equal(error.attempts.length, 1);
        assert.equal(error.attempts[0].provider, 'maton_agent');
        return true;
      }
    );
  } finally {
    await new Promise((resolve) => mockGateway.server.close(resolve));
  }
});

test('Finder reuses a successful analysis for the same video and Strategy across tasks', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  const evidenceInput = {
    evidence: [{
      video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      author_name: 'Reusable Creator',
      author_profile_url: 'https://youtube.com/@reusable.creator'
    }]
  };

  const firstTask = await request.post('/api/finder-tasks').send({ strategy_id: strategy.id, target_platform: 'youtube' });
  const firstImport = await request.post(`/api/finder-tasks/${firstTask.body.data.id}/video-evidence/import`).send(evidenceInput);
  const firstEvidence = firstImport.body.data.results[0].data;
  const cached = await models.VideoAiAnalysisResult.create({
    video_source_id: firstEvidence.video_source_id,
    analysis_type: 'finder_evidence',
    analysis_scope_id: firstEvidence.id,
    status: 'success',
    model_name: 'MiniMax-M3',
    score: 88,
    summary: 'Reusable analysis',
    raw_result: JSON.stringify({ cached: true }),
    evidence_signals: JSON.stringify([{ type: 'category', score: 88 }]),
    final_prompt: 'cached prompt',
    extra_data: JSON.stringify({
      analysis_version: 'finder-evidence-v1',
      hard_filter: { passed: true, market_language_match: 'certain' },
      signal_scores: { category_fit: 88 },
      evidence_strength_score: 88,
      risk: { risk_level: 'low' },
      candidate_decision: { enter_raw_candidates: true, candidate_priority_score: 88, recommended_status: 'manual_review' }
    })
  });

  const secondTask = await request.post('/api/finder-tasks').send({ strategy_id: strategy.id, target_platform: 'youtube' });
  const secondImport = await request.post(`/api/finder-tasks/${secondTask.body.data.id}/video-evidence/import`).send(evidenceInput);
  const secondEvidence = secondImport.body.data.results[0].data;
  const analyzed = await request.post(`/api/finder-tasks/${secondTask.body.data.id}/evidence-analysis`).send({ evidence_ids: [secondEvidence.id] });

  assert.equal(analyzed.status, 200, JSON.stringify(analyzed.body));
  assert.equal(analyzed.body.data.success_count, 1);
  assert.equal(analyzed.body.data.results[0].reused, true);
  assert.equal(analyzed.body.data.results[0].reused_from_analysis_id, cached.id);
  const copied = await models.VideoAiAnalysisResult.findOne({ where: { analysis_scope_id: secondEvidence.id, analysis_type: 'finder_evidence' } });
  const copiedExtra = safeParseJson(copied.extra_data);
  assert.equal(copied.model_name, 'MiniMax-M3');
  assert.equal(copied.score, 88);
  assert.equal(copiedExtra.reused_from_analysis_id, cached.id);
  assert.equal(copiedExtra.analysis_version, 'finder-evidence-v1');
});

test('product fit identity normalizes profile variants and repeated discovery preserves a human decision', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { campaignProduct, strategy } = await seedBaseData();
  const normalizedProfileUrl = 'https://www.youtube.com/@product.creator';
  const firstIdentity = finderTaskRoutes.buildCandidateIdentity(
    'YouTube',
    'https://youtube.com/@Product.Creator/?view_as=subscriber',
    'Product Creator'
  );
  const secondIdentity = finderTaskRoutes.buildCandidateIdentity(
    'youtube',
    `${normalizedProfileUrl}/`,
    'Renamed Creator'
  );
  assert.deepEqual(firstIdentity, secondIdentity);
  assert.match(firstIdentity.identityKeyHash, /^[a-f0-9]{64}$/);

  const wrongCustomer = await models.Customer.create({
    name: 'Product Creator',
    cooperation_status: 'do_not_contact',
    profile_url: 'https://www.youtube.com/@different.creator'
  });
  const matchedCustomer = await models.Customer.create({
    name: 'Master Product Creator',
    cooperation_status: 'available'
  });
  await models.KolPlatformAccount.create({
    customer_id: matchedCustomer.id,
    platform: 'youtube',
    username: 'product.creator',
    profile_url: normalizedProfileUrl,
    profile_url_hash: computeUrlHash(normalizedProfileUrl)
  });

  const taskRes = await request.post('/api/finder-tasks').send({
    strategy_id: strategy.id,
    target_platform: 'youtube'
  });
  const taskId = taskRes.body.data.id;
  const importRes = await request
    .post(`/api/finder-tasks/${taskId}/video-evidence/import`)
    .send({
      evidence: [
        {
          video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          title: 'First product video',
          author_name: 'Product Creator',
          author_profile_url: 'https://youtube.com/@Product.Creator/?view_as=subscriber',
          source_query: 'first product signal'
        },
        {
          video_url: 'https://www.youtube.com/watch?v=9bZkp7q19f0',
          title: 'Second product video',
          author_name: 'Renamed Creator',
          author_profile_url: `${normalizedProfileUrl}/`,
          source_query: 'second product signal'
        }
      ]
    });
  assert.equal(importRes.body.data.inserted, 2, JSON.stringify(importRes.body));

  for (const [index, result] of importRes.body.data.results.entries()) {
    await models.VideoAiAnalysisResult.create({
      video_source_id: result.data.video_source_id,
      analysis_type: 'finder_evidence',
      analysis_scope_id: result.data.id,
      status: 'success',
      model_name: 'test-model',
      score: 80 + index,
      summary: `Product evidence ${index + 1}`,
      extra_data: JSON.stringify({
        hard_filter: { passed: true, market_language_match: 'certain' },
        signal_scores: { category_fit: 80 + index },
        evidence_strength_score: 80 + index,
        risk: { risk_level: 'low' },
        candidate_decision: {
          enter_raw_candidates: true,
          candidate_priority_score: 80 + index,
          recommended_status: 'new',
          reason: `第 ${index + 1} 条产品匹配证据`
        }
      })
    });
  }

  const firstGeneration = await request
    .post(`/api/finder-tasks/${taskId}/generate-candidates-from-evidence`)
    .send({});
  assert.equal(firstGeneration.status, 200, JSON.stringify(firstGeneration.body));
  assert.equal(firstGeneration.body.data.inserted_count, 1);
  assert.equal(await models.RawCandidate.count(), 1);
  let fits = await dbOperations.query(
    'SELECT * FROM raw_candidate_product_fits WHERE campaign_product_id = ?',
    [campaignProduct.id]
  );
  assert.equal(fits.length, 1);
  assert.equal(fits[0].existing_customer_id, matchedCustomer.id);
  assert.notEqual(fits[0].existing_customer_id, wrongCustomer.id);
  assert.equal(fits[0].identity_status, 'known_kol_new_product_fit');
  assert.equal(fits[0].decision_status, 'pending');
  assert.equal(fits[0].analysis_version, 1);
  assert.equal(safeParseJson(fits[0].evidence_summary).evidence_count, 2);

  await dbOperations.run(
    "UPDATE raw_candidate_product_fits SET decision_status = 'approved' WHERE id = ?",
    [fits[0].id]
  );
  const secondGeneration = await request
    .post(`/api/finder-tasks/${taskId}/generate-candidates-from-evidence`)
    .send({});
  assert.equal(secondGeneration.status, 200, JSON.stringify(secondGeneration.body));

  fits = await dbOperations.query(
    'SELECT * FROM raw_candidate_product_fits WHERE campaign_product_id = ?',
    [campaignProduct.id]
  );
  assert.equal(fits.length, 1);
  assert.equal(fits[0].decision_status, 'approved');
  assert.equal(fits[0].identity_status, 'existing_product_fit_updated');
  assert.equal(fits[0].analysis_version, 2);

  const nextTask = await request.post('/api/finder-tasks').send({ strategy_id: strategy.id, target_platform: 'youtube' });
  const nextImport = await request.post(`/api/finder-tasks/${nextTask.body.data.id}/video-evidence/import`).send({ evidence: [{
    video_url: 'https://www.youtube.com/watch?v=3JZ_D3ELwOQ', title: 'Third product video', author_name: 'Product Creator', author_profile_url: normalizedProfileUrl
  }] });
  const nextEvidence = nextImport.body.data.results[0].data;
  await models.VideoAiAnalysisResult.create({
    video_source_id: nextEvidence.video_source_id, analysis_type: 'finder_evidence', analysis_scope_id: nextEvidence.id,
    status: 'success', score: 88, summary: 'Product evidence 3',
    extra_data: JSON.stringify({ hard_filter: { passed: true, market_language_match: 'certain' }, signal_scores: { category_fit: 88 }, evidence_strength_score: 88, risk: { risk_level: 'low' }, candidate_decision: { enter_raw_candidates: true, candidate_priority_score: 88, recommended_status: 'manual_review' } })
  });
  const [parallelA, parallelB] = await Promise.all([
    request.post(`/api/finder-tasks/${nextTask.body.data.id}/generate-candidates-from-evidence`).send({}),
    request.post(`/api/finder-tasks/${nextTask.body.data.id}/generate-candidates-from-evidence`).send({})
  ]);
  assert.equal(parallelA.status, 200, JSON.stringify(parallelA.body));
  assert.equal(parallelB.status, 200, JSON.stringify(parallelB.body));
  assert.equal(await models.RawCandidate.count(), 1);
  fits = await dbOperations.query('SELECT * FROM raw_candidate_product_fits WHERE campaign_product_id = ?', [campaignProduct.id]);
  assert.equal(fits.length, 1);
  assert.equal(fits[0].decision_status, 'approved');
  const mergedSummary = safeParseJson(fits[0].evidence_summary);
  assert.equal(mergedSummary.evidence_count, 3);
  assert.equal(mergedSummary.evidence.length, 3);
  assert.ok(fits[0].analysis_version >= 4);
});

test('video evidence finder uses selected YouTube Maton Gateway provider', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();

  await models.ApiSetting.create({
    provider: 'system.provider_selection',
    extra_config: JSON.stringify({
      platforms: {
        youtube: { primary: 'maton_gateway', fallbacks: [] }
      }
    })
  });

  const res = await request
    .post('/api/finder-tasks')
    .send({
      strategy_id: strategy.id,
      target_platform: 'youtube',
      limit: 5
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(JSON.parse(res.body.data.search_sources), ['maton_agent']);
  assert.equal(JSON.parse(res.body.data.raw_request).target_platform, 'youtube');
});

test('video evidence finder reads only canonical YouTube Maton Gateway configuration', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  const providerLookups = [];
  const originalGet = dbOperations.get;
  const originalNodeEnv = process.env.NODE_ENV;
  const mockGateway = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/youtube/youtube/v3/search')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          items: [{
            id: { videoId: 'dQw4w9WgXcQ' },
            snippet: { channelId: 'maton-channel', channelTitle: 'Maton Creator', title: 'Battery review', description: '' }
          }]
        }));
        return;
      }
      if (req.url.startsWith('/youtube/youtube/v3/channels')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          items: [{ id: 'maton-channel', snippet: { title: 'Maton Creator' }, statistics: { subscriberCount: '1000', viewCount: '10000' } }]
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });

  try {
    await models.ApiSetting.create({
      provider: 'system.provider_selection',
      extra_config: JSON.stringify({
        platforms: { youtube: { primary: 'maton_gateway', fallbacks: [] } }
      })
    });
    await models.ApiSetting.create({
      provider: 'youtube.maton_gateway',
      api_key: 'maton-token',
      base_url: `http://127.0.0.1:${mockGateway.port}`
    });

    dbOperations.get = async (sql, params = []) => {
      if (String(sql).includes('FROM api_settings WHERE provider = ?')) providerLookups.push(params[0]);
      return originalGet(sql, params);
    };
    process.env.NODE_ENV = 'development';

    const created = await request.post('/api/finder-tasks').send({
      strategy_id: strategy.id,
      target_platform: 'youtube',
      limit: 1
    });
    assert.equal(created.status, 200);

    let task = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      task = await models.FinderTask.findByPk(created.body.data.id);
      if (task?.status !== 'draft' && task?.status !== 'running') break;
      await sleep(20);
    }

    assert.equal(task.status, 'success');
    assert.ok(providerLookups.includes('youtube.maton_gateway'));
    assert.equal(providerLookups.includes('agent.maton_gateway'), false);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    dbOperations.get = originalGet;
    await new Promise((resolve) => mockGateway.server.close(resolve));
  }
});

test('Maton discovery paginates past KOL Master duplicates and keeps one video per new channel', async () => {
  await resetTestDatabase();
  await initDatabase();
  await dbOperations.run('DELETE FROM finder_search_cache');
  await dbOperations.run('DELETE FROM finder_query_ledger');
  await models.ApiSetting.destroy({
    where: { provider: ['system.provider_selection', 'youtube.maton_gateway'] }
  });
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  await models.Customer.create({ name: 'Existing Creator', youtube_url: 'https://www.youtube.com/@ExistingCreator/videos' });
  const searchUrls = [];
  const mockGateway = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/youtube/youtube/v3/search')) {
        searchUrls.push(req.url);
        const secondPage = req.url.includes('pageToken=next-page');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(secondPage ? {
          items: [{ id: { videoId: 'newVideo0001' }, snippet: { channelId: 'UCNewChannel12345678901234', channelTitle: 'New Creator', title: 'New field test' } }]
        } : {
          nextPageToken: 'next-page',
          items: [{ id: { videoId: 'oldVideo0001' }, snippet: { channelId: 'UCExisting123456789012345', channelTitle: 'Existing Creator', title: 'Existing field test' } }]
        }));
        return;
      }
      if (req.url.startsWith('/youtube/youtube/v3/channels')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ id: 'UCNewChannel12345678901234', snippet: { title: 'New Creator', country: 'US' }, statistics: { subscriberCount: '12000' } }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });

  const originalNodeEnv = process.env.NODE_ENV;
  try {
    await models.ApiSetting.create({ provider: 'system.provider_selection', extra_config: JSON.stringify({ platforms: { youtube: { primary: 'maton_gateway', fallbacks: [] } } }) });
    await models.ApiSetting.create({ provider: 'youtube.maton_gateway', api_key: 'maton-token', base_url: `http://127.0.0.1:${mockGateway.port}` });
    process.env.NODE_ENV = 'development';
    const created = await request.post('/api/finder-tasks').send({ strategy_id: strategy.id, target_platform: 'youtube', limit: 1 });
    let task = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      task = await models.FinderTask.findByPk(created.body.data.id);
      if (task?.status !== 'draft' && task?.status !== 'running') break;
      await sleep(20);
    }
    assert.equal(task.status, 'success');
    assert.equal(task.result_count, 1);
    assert.equal(searchUrls.length, 2);
    assert.ok(searchUrls[1].includes('pageToken=next-page'));
    const evidence = await models.FinderVideoEvidence.findOne({ where: { finder_task_id: task.id } });
    const source = await models.VideoSource.findByPk(evidence.video_source_id);
    assert.equal(source.author_name, 'New Creator');

    const repeated = await request.post('/api/finder-tasks').send({ strategy_id: strategy.id, target_platform: 'youtube', limit: 1 });
    let repeatedTask = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      repeatedTask = await models.FinderTask.findByPk(repeated.body.data.id);
      if (repeatedTask?.status !== 'draft' && repeatedTask?.status !== 'running') break;
      await sleep(20);
    }
    assert.equal(repeatedTask.status, 'success');
    assert.equal(searchUrls.length, 2, 'the repeated Finder should reuse both cached search pages');
    const cacheStats = await dbOperations.get('SELECT COUNT(*) AS rows_count, SUM(hit_count) AS hit_count FROM finder_search_cache');
    assert.equal(Number(cacheStats.rows_count), 2);
    assert.ok(Number(cacheStats.hit_count) >= 2);
    const ledgerStats = await dbOperations.get('SELECT SUM(cache_hit) AS cache_hits, SUM(request_cost) AS request_cost FROM finder_query_ledger WHERE finder_task_id = ?', [repeatedTask.id]);
    assert.equal(Number(ledgerStats.cache_hits), 2);
    assert.equal(Number(ledgerStats.request_cost), 1, 'only the new-channel details call should consume Maton quota');

    for (const [query, returned, newChannels] of [['low yield', 10, 1], ['high yield', 10, 8]]) {
      await dbOperations.run(
        `INSERT INTO finder_query_ledger
         (provider, platform, query_text, query_hash, page_token, cache_hit, returned_count,
          excluded_count, new_channel_count, request_cost, status, created_at)
         VALUES ('maton_youtube_gateway', 'youtube', ?, ?, '', 0, ?, 0, ?, 1, 'success', CURRENT_TIMESTAMP)`,
        [query, crypto.createHash('sha256').update(query).digest('hex'), returned, newChannels]
      );
    }
    const ranked = await finderTaskRoutes.rankedKeywordQueries({
      discovery: { keywords: 'low yield, high yield, unseen query' },
      campaign: {}
    });
    assert.deepEqual(ranked, ['unseen query', 'high yield', 'low yield']);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    await new Promise((resolve) => mockGateway.server.close(resolve));
  }
});

test('video evidence finder default task saves single target-platform request fields', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();

  await strategy.update({
    search_strategy: JSON.stringify([
      { cycle: 'C1', name: 'Competitor Reviews', keywords: 'competitor battery review', target_count: 10 },
      { cycle: 'C2', name: 'Category Search', keywords: 'lifepo4 battery review', target_count: 10 },
      { cycle: 'C3', name: 'Use-case Search', keywords: 'campervan battery upgrade', target_count: 10 },
      { cycle: 'C4', name: 'Feature Search', keywords: 'bluetooth lifepo4 battery', target_count: 10 },
      { cycle: 'C5', name: 'Community Search', keywords: 'motorhome leisure battery advice', target_count: 10 },
      { cycle: 'C6', name: 'Platform Native Search', keywords: 'youtube lifepo4 campervan', target_count: 10 },
      { cycle: 'C7', name: 'Spider-web Expansion', keywords: 'related channels', target_count: 10 }
    ])
  });

  await models.ApiSetting.create({
    provider: 'system.provider_selection',
    extra_config: JSON.stringify({
      platforms: {
        youtube: { primary: 'maton_gateway', fallbacks: [] }
      }
    })
  });

  const res = await request
    .post('/api/finder-tasks')
    .send({
      strategy_id: strategy.id,
      target_platform: 'youtube',
      limit: 5
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.platform, 'youtube');
  assert.deepEqual(JSON.parse(res.body.data.search_sources), ['maton_agent']);
  assert.deepEqual(JSON.parse(res.body.data.discovery_routes), ['target_platform_first']);
  const rawRequest = JSON.parse(res.body.data.raw_request);
  assert.equal(rawRequest.target_platform, 'youtube');
  assert.equal(rawRequest.limit, 5);
  assert.equal(Object.prototype.hasOwnProperty.call(rawRequest, 'cycles'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.data, 'search_cycles'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.data, 'total_cycles'), false);
});

test('finder task preserves strategy id when it differs from campaign product id', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { campaign, campaignProduct } = await seedBaseData();
  const strategy = await models.KolStrategy.create({
    campaign_id: campaign.id,
    campaign_product_id: campaignProduct.id,
    name: 'Distinct Strategy Id',
    brand: 'Test Brand',
    product: 'Test Product',
    primary_platform: 'tiktok',
    status: 'ready'
  });

  assert.notEqual(strategy.id, campaignProduct.id);

  const res = await request
    .post('/api/finder-tasks')
    .send({ strategy_id: strategy.id, target_platform: 'tiktok', limit: 5 });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.strategy_id, strategy.id);
  assert.equal(JSON.parse(res.body.data.raw_request).strategy_id, strategy.id);
});

test('video evidence import preserves provider payloads larger than MySQL TEXT', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  const taskRes = await request
    .post('/api/finder-tasks')
    .send({ strategy_id: strategy.id, target_platform: 'tiktok', limit: 5 });
  const oversizedPayload = 'x'.repeat(70 * 1024);

  const importRes = await request
    .post(`/api/finder-tasks/${taskRes.body.data.id}/video-evidence/import`)
    .send({
      evidence: [{
        video_url: 'https://www.tiktok.com/@large.payload/video/7530000000000000001',
        author_profile_url: 'https://www.tiktok.com/@large.payload',
        raw_data: { provider_payload: oversizedPayload }
      }]
    });

  assert.equal(importRes.status, 200);
  assert.equal(importRes.body.data.inserted, 1);
  const evidence = await models.FinderVideoEvidence.findOne();
  assert.equal(JSON.parse(evidence.raw_data).provider_payload.length, oversizedPayload.length);
});

test('finder task -> video evidence -> video_sources reuse', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { campaign, strategy } = await seedBaseData();

  // Create finder task
  const createRes = await request
    .post('/api/finder-tasks')
    .send({
      strategy_id: strategy.id,
      target_platform: 'youtube'
    });
  assert.equal(createRes.status, 200);
  assert.equal(createRes.body.success, true);
  assert.ok(createRes.body.data.campaign_id);
  const taskId = createRes.body.data.id;

  // Import two pieces of video evidence pointing to the same canonical YouTube URL
  const videoUrl1 = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const videoUrl2 = 'https://youtu.be/dQw4w9WgXcQ';

  const importRes1 = await request
    .post(`/api/finder-tasks/${taskId}/video-evidence/import`)
    .send({
      evidence: [{
        video_url: videoUrl1,
        title: 'First Title',
        author_name: 'First Author',
        evidence_reason: 'test 1'
      }]
    });
  assert.equal(importRes1.status, 200);
  assert.equal(importRes1.body.data.inserted, 1);

  const importRes2 = await request
    .post(`/api/finder-tasks/${taskId}/video-evidence/import`)
    .send({
      evidence: [{
        video_url: videoUrl2,
        title: 'Second Title',
        author_name: 'Second Author',
        evidence_reason: 'test 2'
      }]
    });
  assert.equal(importRes2.status, 200);
  assert.equal(importRes2.body.data.updated, 1);

  // Verify only one video_source exists and it has the latest metadata
  const sources = await models.VideoSource.findAll();
  assert.equal(sources.length, 1);
  const source = sources[0];
  assert.equal(source.platform, 'youtube');
  assert.equal(source.platform_video_id, 'dQw4w9WgXcQ');
  assert.ok(source.canonical_url_hash);
  assert.equal(source.crawl_status, 'success');
  assert.ok(source.latest_snapshot_id);
  assert.ok(source.last_crawled_at);

  // Verify video_snapshot was created and linked
  const snapshots = await models.VideoSnapshot.findAll({ where: { video_source_id: source.id } });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].id, source.latest_snapshot_id);
  assert.equal(snapshots[0].play_count, 100000);

  // Verify campaign_videos link
  const campaignVideos = await models.CampaignVideo.findAll();
  assert.equal(campaignVideos.length, 1);
  assert.equal(campaignVideos[0].campaign_id, campaign.id);
  assert.equal(campaignVideos[0].video_source_id, source.id);

  // Verify finder_video_evidence rows (same task + same video_source = one evidence row)
  const evidenceRows = await models.FinderVideoEvidence.findAll();
  assert.equal(evidenceRows.length, 1);
  assert.equal(evidenceRows[0].video_source_id, source.id);

  // Verify video-evidence list returns flattened video_source fields
  const listRes = await request.get(`/api/finder-tasks/${taskId}/video-evidence`);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.success, true);
  assert.equal(listRes.body.data.length, 1);
  const first = listRes.body.data[0];
  assert.ok(first.video_url);
  assert.ok(first.title);
  assert.ok(first.author_name);
  assert.ok(first.crawl_status);
});

test('finder evidence analysis writes to video_ai_analysis_results', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { campaign, strategy } = await seedBaseData();

  // Create task and evidence
  const createRes = await request
    .post('/api/finder-tasks')
    .send({
      strategy_id: strategy.id,
      target_platform: 'youtube'
    });
  const taskId = createRes.body.data.id;

  const importRes = await request
    .post(`/api/finder-tasks/${taskId}/video-evidence/import`)
    .send({
      evidence: [{
        video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Analysis Title',
        author_name: 'Analysis Author',
        evidence_reason: 'analysis test'
      }]
    });

  const evidenceId = importRes.body.data.results[0].data.id;
  const videoSourceId = importRes.body.data.results[0].data.video_source_id;

  // Manually simulate a finder evidence analysis result (without calling real AI)
  await models.VideoAiAnalysisResult.create({
    video_source_id: videoSourceId,
    analysis_type: 'finder_evidence',
    analysis_scope_id: evidenceId,
    status: 'success',
    model_name: 'test-model',
    score: 85,
    summary: 'Great fit',
    extra_data: JSON.stringify({
      hard_filter: {
        passed: true,
        is_real_creator: true,
        target_platform_match: true,
        follower_range_match: true,
        market_language_match: 'certain',
        profile_accessible: true,
        hard_filter_notes: 'All checks passed'
      },
      signal_scores: {
        competitor_fit: 20,
        category_fit: 90,
        use_case_fit: 78,
        feature_fit: 60,
        community_fit: 70
      },
      evidence_strength_score: 80,
      creator_profile_scores: {
        creator_tone_fit: 82,
        content_consistency: 76,
        posting_frequency: 68,
        traffic_quality: 74,
        audience_market_fit: 70,
        contactability: 50
      },
      risk: {
        risk_level: 'low',
        risk_notes: '',
        risk_deduction: 0
      },
      candidate_decision: {
        enter_raw_candidates: true,
        candidate_priority_score: 85,
        priority_level: 'normal',
        recommended_status: 'new',
        reason: '该创作者发布过相关视频，主页调性匹配，建议进入候选池。'
      }
    })
  });

  const analyses = await models.VideoAiAnalysisResult.findAll({
    where: { analysis_type: 'finder_evidence' }
  });
  assert.equal(analyses.length, 1);
  assert.equal(analyses[0].analysis_scope_id, evidenceId);
  assert.equal(analyses[0].status, 'success');

  // Verify generate-candidates-from-evidence picks it up
  const genRes = await request
    .post(`/api/finder-tasks/${taskId}/generate-candidates-from-evidence`)
    .send({});
  assert.equal(genRes.status, 200);
  assert.equal(genRes.body.success, true);
  assert.equal(genRes.body.data.inserted_count, 1);

  const rawCandidates = await models.RawCandidate.findAll();
  assert.equal(rawCandidates.length, 1);
  assert.equal(rawCandidates[0].status, 'new');
  assert.equal(rawCandidates[0].matched_persona, '品类评测型 KOL');
});

test('generate candidates from evidence fills persona from strategy config', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();

  await models.KolStrategy.update(
    { persona_config: JSON.stringify({ primary_persona: '猫咪出行装备评测型 KOL' }) },
    { where: { id: strategy.id } }
  );

  const createRes = await request
    .post('/api/finder-tasks')
    .send({
      strategy_id: strategy.id,
      target_platform: 'youtube'
    });
  const taskId = createRes.body.data.id;

  const importRes = await request
    .post(`/api/finder-tasks/${taskId}/video-evidence/import`)
    .send({
      evidence: [{
        video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Cat Backpack Review',
        author_name: 'Persona Creator',
        evidence_reason: 'persona test',
        source_signal: 'category_fit'
      }]
    });

  const evidenceId = importRes.body.data.results[0].data.id;
  const videoSourceId = importRes.body.data.results[0].data.video_source_id;

  await models.VideoAiAnalysisResult.create({
    video_source_id: videoSourceId,
    analysis_type: 'finder_evidence',
    analysis_scope_id: evidenceId,
    status: 'success',
    model_name: 'test-model',
    score: 72,
    summary: 'Strong category fit',
    extra_data: JSON.stringify({
      signal_scores: {
        competitor_fit: 0,
        category_fit: 72,
        use_case_fit: 35,
        feature_fit: 20,
        community_fit: 10
      },
      evidence_strength_score: 72,
      risk: { risk_level: 'low' },
      candidate_decision: {
        enter_raw_candidates: true,
        candidate_priority_score: 72,
        priority_level: 'normal',
        recommended_status: 'manual_review',
        reason: '该创作者符合品类评测型画像，建议进入候选池。'
      }
    })
  });

  const genRes = await request
    .post(`/api/finder-tasks/${taskId}/generate-candidates-from-evidence`)
    .send({});

  assert.equal(genRes.status, 200);
  assert.equal(genRes.body.data.inserted_count, 1);

  const rawCandidate = await models.RawCandidate.findOne();
  assert.equal(rawCandidate.matched_persona, '猫咪出行装备评测型 KOL');
});

test('YouTube video evidence end-to-end: import -> analyze -> generate candidates', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { campaign, strategy } = await seedBaseData();
  const { server: mockServer, port } = await startMockAiServer();
  await seedMockAiSettings(port);

  try {
    // Create finder task
    const createRes = await request
      .post('/api/finder-tasks')
      .send({
        strategy_id: strategy.id,
        name: 'E2E Video Evidence Task',
        target_platform: 'youtube'
      });
    assert.equal(createRes.status, 200);
    const taskId = createRes.body.data.id;

    // Import YouTube video evidence using two canonical-equivalent URLs
    const importRes = await request
      .post(`/api/finder-tasks/${taskId}/video-evidence/import`)
      .send({
        evidence: [
          { video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'E2E Title', author_name: 'E2E Author' },
          { video_url: 'https://youtu.be/dQw4w9WgXcQ?si=extra', title: 'Duplicate', author_name: 'Duplicate' }
        ]
      });
    assert.equal(importRes.status, 200);
    assert.equal(importRes.body.data.inserted, 1);
    assert.equal(importRes.body.data.updated, 1);

    // Verify video_source deduplication
    const sources = await models.VideoSource.findAll();
    assert.equal(sources.length, 1);
    assert.equal(sources[0].platform, 'youtube');
    assert.equal(sources[0].platform_video_id, 'dQw4w9WgXcQ');

    // Run evidence analysis through the real endpoint
    const analyzeRes = await request
      .post(`/api/finder-tasks/${taskId}/evidence-analysis`)
      .send({});
    assert.equal(analyzeRes.status, 200);
    assert.equal(analyzeRes.body.data.success_count, 1, JSON.stringify(analyzeRes.body));
    assert.equal(analyzeRes.body.data.failed_count, 0);

    // Verify analysis result
    const analyses = await models.VideoAiAnalysisResult.findAll({
      where: { analysis_type: 'finder_evidence' }
    });
    assert.equal(analyses.length, 1);
    assert.equal(analyses[0].status, 'success');
    assert.equal(analyses[0].score, 92);
    const extra = safeParseJson(analyses[0].extra_data) || {};
    assert.equal(extra.candidate_decision.recommended_status, 'new');
    assert.equal(extra.candidate_decision.enter_raw_candidates, true);
    assert.equal(extra.hard_filter.passed, true);
    assert.deepEqual(safeParseJson(analyses[0].evidence_signals), [
      { signal: 'competitor', reason: 'Compares a competing product' },
      { signal: 'feature', reason: 'Demonstrates the required feature' }
    ]);

    const evidenceListRes = await request.get(`/api/finder-tasks/${taskId}/video-evidence`);
    assert.equal(evidenceListRes.status, 200);
    assert.deepEqual(safeParseJson(evidenceListRes.body.data[0].evidence_signals), [
      { signal: 'competitor', reason: 'Compares a competing product' },
      { signal: 'feature', reason: 'Demonstrates the required feature' }
    ]);
    // Generate raw candidates from scored evidence
    const genRes = await request
      .post(`/api/finder-tasks/${taskId}/generate-candidates-from-evidence`)
      .send({});
    assert.equal(genRes.status, 200);
    assert.equal(genRes.body.data.inserted_count, 1);

    const rawCandidates = await models.RawCandidate.findAll();
    assert.equal(rawCandidates.length, 1);
    assert.equal(rawCandidates[0].status, 'new');
    assert.equal(rawCandidates[0].video_url, 'https://youtu.be/dQw4w9WgXcQ?si=extra');
  } finally {
    mockServer.close();
  }
});

test('Instagram automatic Reel discovery persists evidence, analyzes it, and aggregates by author', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  await models.KolStrategy.update(
    { primary_platform: 'instagram', product: 'vocal processor' },
    { where: { id: strategy.id } }
  );
  const scrapeApiKey = 'scrape-test-key';
  const reelFixture = {
    reels: [
      {
        media_id: '3723045213787686915_12345',
        code: 'DOq6eV6iIgD',
        url: 'https://www.instagram.com/reel/DOq6eV6iIgD/?igsh=first',
        caption: 'Live vocal processor demo',
        video_play_count: 0,
        play_count: 12000,
        owner: {
          pk: '12345',
          username: 'demo_creator',
          full_name: 'Demo Creator',
          follower_count: 188406
        }
      },
      {
        media_id: '3723045213787686915_12345_duplicate',
        code: 'DOq6eV6iIgD',
        url: 'https://instagram.com/reel/DOq6eV6iIgD/?utm_source=copy_link',
        caption: 'Equivalent URL for the same Reel',
        video_play_count: 0,
        owner: { username: 'demo_creator', full_name: 'Demo Creator' }
      },
      {
        media_id: '3723045213787686916_12345',
        code: 'DOq6eV6iIgE',
        url: 'https://www.instagram.com/reel/DOq6eV6iIgE/',
        caption: 'Second demo from the same author',
        video_view_count: 6400,
        owner: { username: 'demo_creator', full_name: 'Demo Creator' }
      }
    ]
  };
  const { server: scrapeServer, port: scrapePort, requests: scrapeRequests } = await startMockScrapeCreatorsServer((req) => {
    const query = new URL(req.url, 'http://127.0.0.1').searchParams.get('query');
    return { body: query === 'vocal processor' ? reelFixture : { reels: [] } };
  });
  const { server: aiServer, port: aiPort } = await startMockAiServer();
  await seedMockScrapeCreatorsSettings(scrapePort, scrapeApiKey);
  await seedMockAiSettings(aiPort);

  try {
    const createRes = await request.post('/api/finder-tasks').send({
      strategy_id: strategy.id,
      target_platform: 'instagram',
      limit: 10
    });
    const taskId = createRes.body.data.id;

    await finderTaskRoutes.runVideoEvidenceDiscovery(taskId);

    const task = await models.FinderTask.findByPk(taskId);
    assert.equal(task.status, 'success');
    assert.equal(task.success_count, 2);
    assert.equal(task.provider_attempts.includes(scrapeApiKey), false);
    assert.equal(task.raw_response_summary.includes(scrapeApiKey), false);
    assert.ok(scrapeRequests.length > 0);
    for (const scrapeRequest of scrapeRequests) {
      const requestedUrl = new URL(scrapeRequest.url, 'http://127.0.0.1');
      assert.equal(scrapeRequest.method, 'GET');
      assert.equal(requestedUrl.pathname, '/v2/instagram/reels/search');
      assert.ok(requestedUrl.searchParams.get('query'));
      assert.equal(scrapeRequest.headers['x-api-key'], scrapeApiKey);
      assert.equal(scrapeRequest.headers.authorization, undefined);
    }

    const sources = await models.VideoSource.findAll();
    const evidence = await models.FinderVideoEvidence.findAll();
    assert.equal(sources.length, 2, 'canonical-equivalent Reel URLs should reuse one video source');
    assert.equal(evidence.length, 2, 'two distinct Reels should persist as two evidence rows');
    const extractedMetrics = evidence.map((row) => safeParseJson(row.raw_data)?.data?.avg_views);
    assert.ok(extractedMetrics.includes('0'), 'official video_play_count=0 should be preserved');

    const analyzeRes = await request
      .post(`/api/finder-tasks/${taskId}/evidence-analysis`)
      .send({});
    assert.equal(analyzeRes.status, 200);
    assert.equal(analyzeRes.body.data.success_count, 2);

    const generateRes = await request
      .post(`/api/finder-tasks/${taskId}/generate-candidates-from-evidence`)
      .send({});
    assert.equal(generateRes.status, 200);
    assert.equal(generateRes.body.data.inserted_count, 1);

    const candidates = await models.RawCandidate.findAll();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].platform, 'instagram');
    assert.equal(candidates[0].profile_url, 'https://www.instagram.com/demo_creator/');
    assert.match(candidates[0].video_url, /^https:\/\/(?:www\.)?instagram\.com\/reel\//);
    assert.notEqual(candidates[0].video_url, candidates[0].profile_url);
    assert.equal(safeParseJson(candidates[0].scoring_breakdown).evidence_count, 2);
    assert.equal(safeParseJson(candidates[0].raw_data).data.evidence_ids.length, 2);
  } finally {
    scrapeServer.close();
    aiServer.close();
  }
});

test('Instagram automatic discovery preserves missing configuration errors on the task', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  await strategy.update({ primary_platform: 'instagram' });

  const createRes = await request.post('/api/finder-tasks').send({
    strategy_id: strategy.id,
    target_platform: 'instagram'
  });
  const taskId = createRes.body.data.id;

  await finderTaskRoutes.runVideoEvidenceDiscovery(taskId);

  const task = await models.FinderTask.findByPk(taskId);
  assert.equal(task.status, 'failed');
  assert.match(task.error_message, /ScrapeCreators API Key is not configured/);
  assert.match(task.provider_attempts, /ScrapeCreators API Key is not configured/);
  assert.match(task.raw_response_summary, /ScrapeCreators API Key is not configured/);
});

test('Instagram automatic discovery reports an upstream success with zero Reels', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  await strategy.update({ primary_platform: 'instagram' });
  const { server, port } = await startMockScrapeCreatorsServer(() => ({ body: { reels: [] } }));

  try {
    await seedMockScrapeCreatorsSettings(port);
    const createRes = await request.post('/api/finder-tasks').send({
      strategy_id: strategy.id,
      target_platform: 'instagram'
    });
    const taskId = createRes.body.data.id;

    await finderTaskRoutes.runVideoEvidenceDiscovery(taskId);

    const task = await models.FinderTask.findByPk(taskId);
    assert.equal(task.status, 'failed');
    assert.equal(
      task.error_message,
      'ScrapeCreators returned 0 Instagram Reels. Try shorter or broader Strategy keywords.'
    );
  } finally {
    server.close();
  }
});

test('Instagram automatic discovery preserves a non-success upstream response', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  await strategy.update({ primary_platform: 'instagram' });
  const { server, port } = await startMockScrapeCreatorsServer(() => ({
    status: 503,
    body: { message: 'ScrapeCreators upstream unavailable' }
  }));

  try {
    await seedMockScrapeCreatorsSettings(port);
    const createRes = await request.post('/api/finder-tasks').send({
      strategy_id: strategy.id,
      target_platform: 'instagram'
    });
    const taskId = createRes.body.data.id;

    await finderTaskRoutes.runVideoEvidenceDiscovery(taskId);

    const task = await models.FinderTask.findByPk(taskId);
    assert.equal(task.status, 'failed');
    assert.equal(task.error_message, 'ScrapeCreators upstream unavailable');
    assert.match(task.provider_attempts, /ScrapeCreators upstream unavailable/);
    assert.match(task.raw_response_summary, /ScrapeCreators upstream unavailable/);
  } finally {
    server.close();
  }
});

test('Instagram automatic discovery reports Reels that are all invalid or unmappable', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  await strategy.update({ primary_platform: 'instagram' });
  const { server, port } = await startMockScrapeCreatorsServer(() => ({
    body: {
      reels: [{
        url: 'https://www.instagram.com/demo_creator/',
        owner: { username: 'demo_creator' }
      }]
    }
  }));

  try {
    await seedMockScrapeCreatorsSettings(port);
    const createRes = await request.post('/api/finder-tasks').send({
      strategy_id: strategy.id,
      target_platform: 'instagram'
    });
    const taskId = createRes.body.data.id;

    await finderTaskRoutes.runVideoEvidenceDiscovery(taskId);

    const task = await models.FinderTask.findByPk(taskId);
    assert.equal(task.status, 'failed');
    assert.equal(
      task.error_message,
      'ScrapeCreators returned Instagram Reels, but none contained valid public Reel evidence with an identifiable author.'
    );
  } finally {
    server.close();
  }
});

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

test('TikTok automatic discovery deduplicates aweme ids before applying the Finder limit', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  await strategy.update({ primary_platform: 'tiktok', product: 'duplicate limit query' });
  const firstVideo = {
    aweme_id: '7334621391758642478',
    desc: 'First result',
    author: { unique_id: 'first.creator' }
  };
  const secondVideo = {
    aweme_id: '7334621391758642479',
    desc: 'Second unique result',
    author: { unique_id: 'second.creator' }
  };
  const { server, port } = await startMockScrapeCreatorsServer(() => ({
    body: {
      search_item_list: [
        { aweme_info: firstVideo },
        { aweme_info: { ...firstVideo, desc: 'Duplicate in the first response page' } },
        { aweme_info: secondVideo }
      ]
    }
  }));

  try {
    await seedMockScrapeCreatorsSettings(port, 'dedupe-test-key', 'tiktok');
    const createRes = await request.post('/api/finder-tasks').send({
      strategy_id: strategy.id,
      target_platform: 'tiktok',
      limit: 2
    });
    await finderTaskRoutes.runVideoEvidenceDiscovery(createRes.body.data.id);

    const task = await models.FinderTask.findByPk(createRes.body.data.id);
    assert.equal(task.status, 'success');
    assert.equal(task.success_count, 2);
    assert.equal(await models.VideoSource.count(), 2);
    assert.equal(await models.FinderVideoEvidence.count(), 2);
  } finally {
    server.close();
  }
});

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

async function runTikTokMixedQueryScenario(queries) {
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  await strategy.update({
    primary_platform: 'tiktok',
    product: 'success-query',
    finder_handoff: JSON.stringify({ required_keywords: queries })
  });
  const apiKey = 'mixed-query-audit-key';
  const { server, port, requests } = await startMockScrapeCreatorsServer((req) => {
    const query = new URL(req.url, 'http://127.0.0.1').searchParams.get('query');
    if (query === 'failure-query') {
      return {
        status: 503,
        body: { message: `Temporary upstream failure for ${apiKey}` }
      };
    }
    return {
      body: {
        search_item_list: [{
          aweme_info: {
            aweme_id: '7334621391758642478',
            desc: 'Valid result from another query',
            author: { unique_id: 'mixed.query.creator' }
          }
        }]
      }
    };
  });

  try {
    await seedMockScrapeCreatorsSettings(port, apiKey, 'tiktok');
    const createRes = await request.post('/api/finder-tasks').send({
      strategy_id: strategy.id,
      target_platform: 'tiktok'
    });
    await finderTaskRoutes.runVideoEvidenceDiscovery(createRes.body.data.id);
    return {
      task: await models.FinderTask.findByPk(createRes.body.data.id),
      queries: requests.map((item) => new URL(item.url, 'http://127.0.0.1').searchParams.get('query')),
      apiKey
    };
  } finally {
    server.close();
  }
}

function assertTikTokFailedQueryAudit(task, apiKey) {
  const persistedAudit = [task.error_message, task.provider_attempts, task.raw_response_summary].join('\n');
  assert.equal(persistedAudit.includes(apiKey), false);
  const attempts = safeParseJson(task.provider_attempts) || [];
  const failedAttempt = attempts.find((attempt) => attempt.ok === false && attempt.query === 'failure-query');
  assert.ok(failedAttempt);
  assert.equal(failedAttempt.status, 503);
  assert.equal(failedAttempt.provider, 'scrapecreators');
  assert.match(task.raw_response_summary, /failure-query/);
  assert.match(task.raw_response_summary, /503/);
  assert.match(task.raw_response_summary, /scrapecreators/);
}

test('TikTok automatic discovery keeps success before a later 503 and audits the failed query', async () => {
  await resetTestDatabase();
  await initDatabase();
  const { task, queries, apiKey } = await runTikTokMixedQueryScenario(['success-query', 'failure-query']);

  assert.deepEqual(queries, ['success-query', 'failure-query']);
  assert.equal(task.status, 'success');
  assert.equal(task.success_count, 1);
  assert.equal(await models.VideoSource.count(), 1);
  assertTikTokFailedQueryAudit(task, apiKey);
});

test('TikTok automatic discovery continues after a 503 and keeps a later success', async () => {
  await resetTestDatabase();
  await initDatabase();
  const { task, queries, apiKey } = await runTikTokMixedQueryScenario(['failure-query', 'success-query']);

  assert.deepEqual(queries, ['failure-query', 'success-query']);
  assert.equal(task.status, 'success');
  assert.equal(task.success_count, 1);
  assert.equal(await models.VideoSource.count(), 1);
  assertTikTokFailedQueryAudit(task, apiKey);
});

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
  const apiKey = 'tiktok-upstream-audit-key';
  const { server, port } = await startMockScrapeCreatorsServer(() => ({
    status: 503,
    body: { message: `ScrapeCreators upstream unavailable for ${apiKey}` }
  }));
  try {
    await seedMockScrapeCreatorsSettings(port, apiKey, 'tiktok');
    const task = await createAndRunTikTokTask();
    assert.equal(task.status, 'failed');
    const persistedAudit = [task.error_message, task.provider_attempts, task.raw_response_summary].join('\n');
    assert.equal(persistedAudit.includes(apiKey), false);
    assert.match(task.error_message, /ScrapeCreators upstream unavailable/);
    assert.match(task.raw_response_summary, /ScrapeCreators upstream unavailable/);
    const attempts = safeParseJson(task.provider_attempts) || [];
    const failedAttempt = attempts.find((attempt) => attempt.ok === false);
    assert.ok(failedAttempt);
    assert.equal(failedAttempt.status, 503);
    assert.equal(failedAttempt.provider, 'scrapecreators');
    assert.equal(failedAttempt.query, 'vocal processor');
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

test('TikTok video source reuse prioritizes platform video id when the author handle changes', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  await strategy.update({ primary_platform: 'tiktok' });
  const firstTask = await request.post('/api/finder-tasks').send({
    strategy_id: strategy.id,
    target_platform: 'tiktok'
  });
  const secondTask = await request.post('/api/finder-tasks').send({
    strategy_id: strategy.id,
    target_platform: 'tiktok'
  });
  const videoId = '7334621391758642478';

  const firstImport = await request
    .post(`/api/finder-tasks/${firstTask.body.data.id}/video-evidence/import`)
    .send({
      evidence: [{
        video_url: `https://www.tiktok.com/@original.handle/video/${videoId}`,
        author_name: 'Original Handle'
      }]
    });
  const secondImport = await request
    .post(`/api/finder-tasks/${secondTask.body.data.id}/video-evidence/import`)
    .send({
      evidence: [{
        video_url: `https://www.tiktok.com/@renamed.handle/video/${videoId}`,
        author_name: 'Renamed Handle'
      }]
    });

  assert.equal(firstImport.status, 200);
  assert.equal(secondImport.status, 200);
  const sources = await models.VideoSource.findAll();
  const evidence = await models.FinderVideoEvidence.findAll();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].platform, 'tiktok');
  assert.equal(sources[0].platform_video_id, videoId);
  assert.equal(evidence.length, 2);
  assert.equal(new Set(evidence.map((item) => item.video_source_id)).size, 1);
});

test('video_source reuse and snapshot TTL across campaigns', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);

  // Create two campaigns and strategies
  const campaign1 = await models.Campaign.create({ name: 'Campaign 1', brand: 'Brand', product: 'Product' });
  const campaign2 = await models.Campaign.create({ name: 'Campaign 2', brand: 'Brand', product: 'Product' });
  const { campaignProduct: campaignProduct1 } = await createCampaignProduct(campaign1.id, { name: 'Campaign 1 Product' });
  const { campaignProduct: campaignProduct2 } = await createCampaignProduct(campaign2.id, { name: 'Campaign 2 Product' });
  const strategy1 = await models.KolStrategy.create({
    campaign_id: campaign1.id, campaign_product_id: campaignProduct1.id, name: 'Strategy 1', brand: 'Brand', product: 'Product',
    primary_platform: 'youtube', status: 'ready'
  });
  const strategy2 = await models.KolStrategy.create({
    campaign_id: campaign2.id, campaign_product_id: campaignProduct2.id, name: 'Strategy 2', brand: 'Brand', product: 'Product',
    primary_platform: 'youtube', status: 'ready'
  });

  const taskRes1 = await request.post('/api/finder-tasks').send({
    strategy_id: strategy1.id, target_platform: 'youtube'
  });
  const taskRes2 = await request.post('/api/finder-tasks').send({
    strategy_id: strategy2.id, target_platform: 'youtube'
  });

  const videoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  // Import into first task: should create video_source and snapshot
  const import1 = await request
    .post(`/api/finder-tasks/${taskRes1.body.data.id}/video-evidence/import`)
    .send({ evidence: [{ video_url: videoUrl, title: 'Cross Campaign', author_name: 'Creator' }] });
  assert.equal(import1.status, 200);
  assert.equal(import1.body.data.inserted, 1);

  const source1 = await models.VideoSource.findOne();
  assert.ok(source1);
  assert.equal(source1.crawl_status, 'success');
  const snapshotsForSource = await models.VideoSnapshot.findAll({ where: { video_source_id: Number(source1.id) } });
  assert.equal(snapshotsForSource.length, 1);

  // Import same canonical video into second task: should reuse video_source, not create new snapshot
  const import2 = await request
    .post(`/api/finder-tasks/${taskRes2.body.data.id}/video-evidence/import`)
    .send({ evidence: [{ video_url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Reused', author_name: 'Creator' }] });
  assert.equal(import2.status, 200);
  assert.equal(import2.body.data.inserted, 1);

  const sources = await models.VideoSource.findAll();
  assert.equal(sources.length, 1);
  const snapshotsForSource2 = await models.VideoSnapshot.findAll({ where: { video_source_id: source1.id } });
  assert.equal(snapshotsForSource2.length, 1);

  // Manually age the snapshot beyond 30 days and re-import: should trigger a fresh crawl
  await models.VideoSource.update(
    { last_crawled_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
    { where: { id: source1.id } }
  );

  const import3 = await request
    .post(`/api/finder-tasks/${taskRes2.body.data.id}/video-evidence/import`)
    .send({ evidence: [{ video_url: videoUrl, title: 'Stale Re-import', author_name: 'Creator' }] });
  assert.equal(import3.status, 200);
  const snapshotsForSource3 = await models.VideoSnapshot.findAll({ where: { video_source_id: source1.id } });
  assert.equal(snapshotsForSource3.length, 2);
});

// ---- 阶段 D2：Finder 任务断点续跑（spec 第十一节“任务失败恢复”）----

async function getTaskCheckpoint(taskId) {
  const row = await dbOperations.get('SELECT checkpoint_json FROM finder_tasks WHERE id = ?', [taskId]);
  return safeParseJson(row?.checkpoint_json);
}

function d2TikTokFixture() {
  return {
    search_item_list: [
      { aweme_info: { aweme_id: '7334621391758642478', desc: 'Demo A', author: { unique_id: 'creator.a' }, statistics: { play_count: 100 } } },
      { aweme_info: { aweme_id: '7334621391758642479', desc: 'Demo B', author: { unique_id: 'creator.b' }, statistics: { play_count: 200 } } }
    ]
  };
}

test('D2: 执行链逐节点写入检查点，retry 跳过已完成节点且不重复导入', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  await strategy.update({ primary_platform: 'tiktok', product: 'vocal processor' });
  const { server: scrapeServer, port: scrapePort, requests: scrapeRequests } = await startMockScrapeCreatorsServer(() => ({ body: d2TikTokFixture() }));
  const { server: aiServer, port: aiPort } = await startMockAiServer();
  await seedMockScrapeCreatorsSettings(scrapePort, 'd2-checkpoint-key', 'tiktok');
  await seedMockAiSettings(aiPort);

  try {
    const createRes = await request.post('/api/finder-tasks').send({
      strategy_id: strategy.id,
      target_platform: 'tiktok',
      limit: 10
    });
    const taskId = createRes.body.data.id;
    await finderTaskRoutes.runVideoEvidenceDiscovery(taskId);

    // 节点①②：搜索 + 导入检查点
    let checkpoint = await getTaskCheckpoint(taskId);
    assert.equal(checkpoint.search_completed, true);
    assert.equal(checkpoint.search_candidates.length, 2);
    assert.equal(checkpoint.videos_imported, 2);
    assert.equal(checkpoint.imported_video_urls.length, 2);
    assert.deepEqual(checkpoint.import_failures, []);
    const scrapeCallsAfterDiscovery = scrapeRequests.length;
    assert.ok(scrapeCallsAfterDiscovery > 0);

    // 节点③：分析检查点
    const analyze = await request.post(`/api/finder-tasks/${taskId}/evidence-analysis`).send({});
    assert.equal(analyze.body.data.success_count, 2);
    checkpoint = await getTaskCheckpoint(taskId);
    assert.equal(checkpoint.videos_analyzed, 2);
    assert.deepEqual(checkpoint.failed_video_ids, []);
    assert.equal(checkpoint.candidates_generated, false);

    // 节点④：候选检查点
    const generate = await request.post(`/api/finder-tasks/${taskId}/generate-candidates-from-evidence`).send({});
    assert.equal(generate.status, 200);
    checkpoint = await getTaskCheckpoint(taskId);
    assert.equal(checkpoint.candidates_generated, true);

    // retry：已完成节点不重跑——不重新调供应商、不重复导入、任务仍为成功
    await finderTaskRoutes.runVideoEvidenceDiscovery(taskId);
    assert.equal(scrapeRequests.length, scrapeCallsAfterDiscovery, 'retry 不应重新调用供应商');
    assert.equal(await models.VideoSource.count(), 2, 'retry 不应重复建 video_sources');
    assert.equal(await models.FinderVideoEvidence.count(), 2, 'retry 不应重复建 finder_video_evidence');
    const task = await models.FinderTask.findByPk(taskId);
    assert.equal(task.status, 'success');
    assert.equal(task.success_count, 2);
    const summary = safeParseJson(task.raw_response_summary);
    assert.equal(summary[0].resumed_from_checkpoint, true);
    assert.equal(summary[0].already_imported, 2);
  } finally {
    scrapeServer.close();
    aiServer.close();
  }
});

test('D2: 单条分析失败记入 failed_video_ids 不整批失败，重跑只分析失败项', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  await strategy.update({ primary_platform: 'tiktok', product: 'vocal processor' });
  const { server: scrapeServer, port: scrapePort } = await startMockScrapeCreatorsServer(() => ({ body: d2TikTokFixture() }));
  // 首轮分析放行 1 个请求后失败 1 次，之后全部放行
  let failedOnce = false;
  const { server: aiServer, port: aiPort, requests: aiRequests } = await startMockAiServer({
    shouldFail: () => {
      if (!failedOnce) {
        failedOnce = true;
        return true;
      }
      return false;
    }
  });
  await seedMockScrapeCreatorsSettings(scrapePort, 'd2-analysis-key', 'tiktok');
  await seedMockAiSettings(aiPort);

  try {
    const createRes = await request.post('/api/finder-tasks').send({
      strategy_id: strategy.id,
      target_platform: 'tiktok',
      limit: 10
    });
    const taskId = createRes.body.data.id;
    await finderTaskRoutes.runVideoEvidenceDiscovery(taskId);
    assert.equal(await models.FinderVideoEvidence.count(), 2);

    // 首轮：2 条证据，1 成 1 败（AI 500 不中止整批）
    const first = await request.post(`/api/finder-tasks/${taskId}/evidence-analysis`).send({});
    assert.equal(first.status, 200);
    assert.equal(first.body.data.success_count, 1);
    assert.equal(first.body.data.failed_count, 1);
    assert.equal(aiRequests.length, 2);

    let checkpoint = await getTaskCheckpoint(taskId);
    assert.equal(checkpoint.videos_analyzed, 1);
    assert.equal(checkpoint.failed_video_ids.length, 1);
    const failedEvidenceId = checkpoint.failed_video_ids[0];

    // 重跑（默认无 evidence_ids）：只补分析失败项，已成功的 1 条不重复消耗 AI 额度
    const second = await request.post(`/api/finder-tasks/${taskId}/evidence-analysis`).send({});
    assert.equal(second.status, 200);
    assert.equal(second.body.data.success_count, 1);
    assert.equal(second.body.data.failed_count, 0);
    assert.equal(aiRequests.length, 3, '重跑只应对失败项发起 1 次 AI 调用');
    assert.equal(second.body.data.results[0].evidence_id, failedEvidenceId);

    checkpoint = await getTaskCheckpoint(taskId);
    assert.equal(checkpoint.videos_analyzed, 2);
    assert.deepEqual(checkpoint.failed_video_ids, []);

    const task = await models.FinderTask.findByPk(taskId);
    assert.notEqual(task.status, 'failed', '单条分析失败不应整批置 failed');
  } finally {
    scrapeServer.close();
    aiServer.close();
  }
});

test('D2: 服务重启把遗留 running 任务标记为失败，retry 可从检查点续跑', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const request = supertest(app);
  const { strategy } = await seedBaseData();
  await strategy.update({ primary_platform: 'tiktok', product: 'vocal processor' });
  const { server: scrapeServer, port: scrapePort, requests: scrapeRequests } = await startMockScrapeCreatorsServer(() => ({ body: d2TikTokFixture() }));
  await seedMockScrapeCreatorsSettings(scrapePort, 'd2-recovery-key', 'tiktok');

  try {
    const createRes = await request.post('/api/finder-tasks').send({
      strategy_id: strategy.id,
      target_platform: 'tiktok',
      limit: 10
    });
    const taskId = createRes.body.data.id;
    await finderTaskRoutes.runVideoEvidenceDiscovery(taskId);
    const scrapeCallsAfterDiscovery = scrapeRequests.length;

    // 模拟服务重启时任务仍处于 running（进程中途退出）
    await dbOperations.run('UPDATE finder_tasks SET status = ? WHERE id = ?', ['running', taskId]);
    const marked = await finderTaskRoutes.markInterruptedFinderTasks();
    assert.equal(marked, 1);
    let task = await models.FinderTask.findByPk(taskId);
    assert.equal(task.status, 'failed');
    assert.equal(task.error_message, '服务重启中断');

    // 检查点在重启后仍然保留，retry 从断点续跑，不重调供应商
    const checkpoint = await getTaskCheckpoint(taskId);
    assert.equal(checkpoint.search_completed, true);
    assert.equal(checkpoint.videos_imported, 2);
    await finderTaskRoutes.runVideoEvidenceDiscovery(taskId);
    assert.equal(scrapeRequests.length, scrapeCallsAfterDiscovery, '重启恢复后的 retry 不应重新调用供应商');
    task = await models.FinderTask.findByPk(taskId);
    assert.equal(task.status, 'success');
    assert.equal(task.success_count, 2);
    assert.equal(await models.FinderVideoEvidence.count(), 2);

    // 再次标记应无可标记行（幂等）
    assert.equal(await finderTaskRoutes.markInterruptedFinderTasks(), 0);
  } finally {
    scrapeServer.close();
  }
});

// Cleanup after all tests
test('cleanup', async () => {
  await sequelize.close();
});
