const assert = require('node:assert/strict');
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

async function seedBaseData() {
  const campaign = await models.Campaign.create({
    name: 'Test Campaign',
    brand: 'Test Brand',
    product: 'Test Product'
  });
  const strategy = await models.KolStrategy.create({
    campaign_id: campaign.id,
    name: 'Test Strategy',
    brand: 'Test Brand',
    product: 'Test Product',
    primary_platform: 'youtube',
    status: 'ready'
  });
  return { campaign, strategy };
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

async function startMockAiServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/chat/completions' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
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
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
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
  const strategy1 = await models.KolStrategy.create({
    campaign_id: campaign1.id, name: 'Strategy 1', brand: 'Brand', product: 'Product',
    primary_platform: 'youtube', status: 'ready'
  });
  const strategy2 = await models.KolStrategy.create({
    campaign_id: campaign2.id, name: 'Strategy 2', brand: 'Brand', product: 'Product',
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

// Cleanup after all tests
test('cleanup', async () => {
  await sequelize.close();
});
