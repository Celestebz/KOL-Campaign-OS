const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const supertest = require('supertest');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
require('dotenv').config();

process.env.NODE_ENV = 'test';
process.env.DB_NAME = 'kol_campaign_os_strategy_test';
process.env.DB_NAME_TEST = 'kol_campaign_os_strategy_test';

const express = require('express');
const { Sequelize } = require('sequelize');
const { initDatabase, dbOperations } = require('../database');
const kolStrategies = require('./kolStrategies');

async function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/kol-strategies', kolStrategies);
  return app;
}

async function resetTestDatabase() {
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

async function createCampaign(name = 'Strategy Test Campaign') {
  const result = await dbOperations.run(
    'INSERT INTO campaigns (name, brand, product) VALUES (?, ?, ?)',
    [name, 'TestBrand', 'TestProduct']
  );
  return result.id;
}

async function createCampaignProduct(campaignId, { name = 'Strategy Test Product', status = 'active' } = {}) {
  const productResult = await dbOperations.run(
    'INSERT INTO products (brand, name, status, catalog_key_hash) VALUES (?, ?, ?, ?)',
    ['TestBrand', name, 'active', crypto.createHash('sha256').update(`${campaignId}:${name}`).digest('hex')]
  );
  const campaignProductResult = await dbOperations.run(
    `INSERT INTO campaign_products
     (campaign_id, product_id, role, priority, status)
     VALUES (?, ?, 'hero', 0, ?)`,
    [campaignId, productResult.id, status]
  );
  return { id: campaignProductResult.id, productId: productResult.id, name, status };
}

function readyStrategyPayload(campaignId) {
  return {
    campaign_id: campaignId,
    name: 'Ready Strategy',
    brand: 'TestBrand',
    product: 'TestProduct',
    category: 'Audio',
    target_market: 'Musicians',
    language: 'English',
    primary_platform: 'youtube',
    secondary_platforms: ['instagram'],
    campaign_goal: 'Drive awareness',
    status: 'draft',
    product_context: { key_selling_points: ['great sound'] },
    persona_config: { primary_persona: 'musician' },
    scoring_weights: { approval_threshold: 60 },
    finder_handoff: { required_platforms: ['youtube'] }
  };
}

test('POST /api/kol-strategies creates strategy without search_strategy and mark-ready succeeds', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const campaignId = await createCampaign();
  const campaignProduct = await createCampaignProduct(campaignId);

  const createRes = await supertest(app)
    .post('/api/kol-strategies')
    .send({ ...readyStrategyPayload(campaignId), campaign_product_id: campaignProduct.id })
    .expect(200);

  assert.strictEqual(createRes.body.success, true);
  assert.ok(createRes.body.data.id, 'strategy id should be returned');
  assert.strictEqual(createRes.body.data.search_strategy, undefined, 'response should not expose search_strategy');
  assert.strictEqual(createRes.body.data.campaign_product_id, campaignProduct.id);
  assert.strictEqual(createRes.body.data.campaign_product_status, 'active');
  assert.strictEqual(createRes.body.data.product_id, campaignProduct.productId);
  assert.strictEqual(createRes.body.data.product_name, campaignProduct.name);

  const strategyId = createRes.body.data.id;

  const readyRes = await supertest(app)
    .post(`/api/kol-strategies/${strategyId}/mark-ready`)
    .send({})
    .expect(200);

  assert.strictEqual(readyRes.body.success, true);
  assert.strictEqual(readyRes.body.data.status, 'ready');
  assert.strictEqual(readyRes.body.data.search_strategy, undefined, 'ready response should not expose search_strategy');
});

test('POST /api/kol-strategies requires an active Campaign Product owned by the Campaign', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const campaignId = await createCampaign();
  const otherCampaignId = await createCampaign('Other Strategy Campaign');
  const activeProduct = await createCampaignProduct(campaignId, { name: 'Active Product' });
  const archivedProduct = await createCampaignProduct(campaignId, { name: 'Archived Product', status: 'archived' });
  const otherCampaignProduct = await createCampaignProduct(otherCampaignId, { name: 'Other Product' });

  await supertest(app)
    .post('/api/kol-strategies')
    .send({ ...readyStrategyPayload(campaignId), campaign_product_id: activeProduct.id })
    .expect(200);

  const missing = await supertest(app)
    .post('/api/kol-strategies')
    .send(readyStrategyPayload(campaignId))
    .expect(400);
  assert.match(missing.body.error, /campaign_product_id/);

  const wrongCampaign = await supertest(app)
    .post('/api/kol-strategies')
    .send({ ...readyStrategyPayload(campaignId), campaign_product_id: otherCampaignProduct.id })
    .expect(400);
  assert.match(wrongCampaign.body.error, /不属于当前项目/);

  const archived = await supertest(app)
    .post('/api/kol-strategies')
    .send({ ...readyStrategyPayload(campaignId), campaign_product_id: archivedProduct.id })
    .expect(400);
  assert.match(archived.body.error, /active/);
});

test('PUT /api/kol-strategies/:id validates and preserves the effective Campaign Product binding', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const campaignId = await createCampaign();
  const otherCampaignId = await createCampaign('Other Strategy Campaign');
  const campaignProduct = await createCampaignProduct(campaignId);
  const otherCampaignProduct = await createCampaignProduct(otherCampaignId, { name: 'Other Product' });

  const createRes = await supertest(app)
    .post('/api/kol-strategies')
    .send({ ...readyStrategyPayload(campaignId), campaign_product_id: campaignProduct.id })
    .expect(200);

  const updateRes = await supertest(app)
    .put(`/api/kol-strategies/${createRes.body.data.id}`)
    .send({ ...readyStrategyPayload(campaignId), name: 'Updated Strategy' })
    .expect(200);
  assert.strictEqual(updateRes.body.data.campaign_product_id, campaignProduct.id);

  const wrongCampaign = await supertest(app)
    .put(`/api/kol-strategies/${createRes.body.data.id}`)
    .send({
      ...readyStrategyPayload(campaignId),
      campaign_product_id: otherCampaignProduct.id
    })
    .expect(400);
  assert.match(wrongCampaign.body.error, /不属于当前项目/);
});

test('legacy unassigned strategies remain listable but cannot be marked ready until assigned', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const campaignId = await createCampaign();
  const campaignProduct = await createCampaignProduct(campaignId);
  const legacyResult = await dbOperations.run(
    `INSERT INTO kol_strategies
     (campaign_id, campaign_product_id, name, target_market, primary_platform, campaign_goal,
      status, product_context, persona_config, finder_handoff)
     VALUES (?, NULL, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    [
      campaignId,
      'Legacy Strategy',
      'Musicians',
      'youtube',
      'Drive awareness',
      JSON.stringify({ key_selling_points: ['great sound'] }),
      JSON.stringify({ primary_persona: 'musician' }),
      JSON.stringify({ required_platforms: ['youtube'] })
    ]
  );

  const listRes = await supertest(app).get('/api/kol-strategies').expect(200);
  const legacy = listRes.body.data.find((strategy) => strategy.id === legacyResult.id);
  assert.ok(legacy, 'legacy strategy should remain listable');
  assert.strictEqual(legacy.product_binding_status, 'legacy_unassigned');
  assert.strictEqual(legacy.campaign_product_id, null);
  assert.strictEqual(legacy.campaign_product_status, null);
  assert.strictEqual(legacy.product_id, null);
  assert.strictEqual(legacy.product_name, null);

  const blocked = await supertest(app)
    .post(`/api/kol-strategies/${legacyResult.id}/mark-ready`)
    .send({})
    .expect(400);
  assert.match(blocked.body.error, /campaign_product_id/);

  const assigned = await supertest(app)
    .put(`/api/kol-strategies/${legacyResult.id}`)
    .send({ ...readyStrategyPayload(campaignId), campaign_product_id: campaignProduct.id })
    .expect(200);
  assert.strictEqual(assigned.body.data.campaign_product_id, campaignProduct.id);

  await supertest(app)
    .post(`/api/kol-strategies/${legacyResult.id}/mark-ready`)
    .send({})
    .expect(200);
});

test('POST /api/kol-strategies rejects legacy cycle fields', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const campaignId = await createCampaign();

  for (const field of ['search_strategy', 'cycles', 'search_cycles', 'search_intensity']) {
    const payload = readyStrategyPayload(campaignId);
    payload[field] = field === 'search_intensity' ? 5 : [{ cycle: 'C1' }];

    const res = await supertest(app)
      .post('/api/kol-strategies')
      .send(payload)
      .expect(400);

    assert.strictEqual(res.body.success, false);
    assert.match(res.body.error, /Legacy Cycle fields are no longer supported/);
    assert.match(res.body.error, new RegExp(field));
  }
});

test('PUT /api/kol-strategies/:id rejects legacy cycle fields', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const campaignId = await createCampaign();
  const campaignProduct = await createCampaignProduct(campaignId);

  const createRes = await supertest(app)
    .post('/api/kol-strategies')
    .send({ ...readyStrategyPayload(campaignId), campaign_product_id: campaignProduct.id })
    .expect(200);

  const strategyId = createRes.body.data.id;

  for (const field of ['search_strategy', 'cycles', 'search_cycles', 'search_intensity']) {
    const payload = { name: 'Updated' };
    payload[field] = field === 'search_intensity' ? 5 : [{ cycle: 'C1' }];

    const res = await supertest(app)
      .put(`/api/kol-strategies/${strategyId}`)
      .send(payload)
      .expect(400);

    assert.strictEqual(res.body.success, false);
    assert.match(res.body.error, /Legacy Cycle fields are no longer supported/);
    assert.match(res.body.error, new RegExp(field));
  }
});

test('POST /api/kol-strategies/:id/mark-ready rejects legacy cycle fields', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const campaignId = await createCampaign();
  const campaignProduct = await createCampaignProduct(campaignId);

  const createRes = await supertest(app)
    .post('/api/kol-strategies')
    .send({ ...readyStrategyPayload(campaignId), campaign_product_id: campaignProduct.id })
    .expect(200);

  const strategyId = createRes.body.data.id;

  for (const field of ['search_strategy', 'cycles', 'search_cycles', 'search_intensity']) {
    const payload = {};
    payload[field] = field === 'search_intensity' ? 5 : [{ cycle: 'C1' }];

    const res = await supertest(app)
      .post(`/api/kol-strategies/${strategyId}/mark-ready`)
      .send(payload)
      .expect(400);

    assert.strictEqual(res.body.success, false);
    assert.match(res.body.error, /Legacy Cycle fields are no longer supported/);
    assert.match(res.body.error, new RegExp(field));
  }
});

test('GET /api/kol-strategies does not expose search_strategy', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const campaignId = await createCampaign();
  const campaignProduct = await createCampaignProduct(campaignId);

  const createRes = await supertest(app)
    .post('/api/kol-strategies')
    .send({ ...readyStrategyPayload(campaignId), campaign_product_id: campaignProduct.id })
    .expect(200);

  const strategyId = createRes.body.data.id;

  const listRes = await supertest(app)
    .get('/api/kol-strategies')
    .expect(200);

  const found = listRes.body.data.find((s) => s.id === strategyId);
  assert.ok(found, 'strategy should be in list');
  assert.strictEqual(found.search_strategy, undefined, 'list response should not expose search_strategy');
});

test('cleanup kolStrategies database connection', async () => {
  const { sequelize } = require('../database');
  await sequelize.close();
});
