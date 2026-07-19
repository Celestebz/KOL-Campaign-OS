const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const supertest = require('supertest');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
require('dotenv').config();

process.env.NODE_ENV = 'test';
process.env.DB_NAME = 'kol_campaign_os_raw_test';
process.env.DB_NAME_TEST = 'kol_campaign_os_raw_test';

const express = require('express');
const { Sequelize } = require('sequelize');
const { initDatabase, sequelize, dbOperations } = require('../database');
const rawCandidates = require('./rawCandidates');
const campaignKolRoutes = require('./campaignKols');
const campaignRoutes = require('./campaigns');

async function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/raw-candidates', rawCandidates.router);
  app.use('/api/campaign-kols', campaignKolRoutes);
  app.use('/api/campaigns', campaignRoutes);
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

async function setupCampaignAndStrategy() {
  const campaign = await dbOperations.run(
    `INSERT INTO campaigns (name, brand, product) VALUES (?, ?, ?)`,
    ['Approve Test Campaign', 'TestBrand', 'TestProduct']
  );
  const strategy = await dbOperations.run(
    `INSERT INTO kol_strategies (campaign_id, name, status, campaign_goal, product_context, persona_config, scoring_weights, finder_handoff)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [campaign.id, 'Approve Test Strategy', 'ready', 'goal', 'context', '{}', '{}', '{}']
  );
  const product = await dbOperations.run(
    `INSERT INTO products (brand, name, status, catalog_key_hash)
     VALUES (?, ?, 'active', ?)`,
    ['TestBrand', 'Approve Test Product', crypto.createHash('sha256').update(`approve-product:${campaign.id}`).digest('hex')]
  );
  const campaignProduct = await dbOperations.run(
    `INSERT INTO campaign_products (campaign_id, product_id, role, priority, status)
     VALUES (?, ?, 'hero', 0, 'active')`,
    [campaign.id, product.id]
  );
  await dbOperations.run(
    'UPDATE kol_strategies SET campaign_product_id = ? WHERE id = ?',
    [campaignProduct.id, strategy.id]
  );
  return { campaignId: campaign.id, strategyId: strategy.id, campaignProductId: campaignProduct.id };
}

async function createRawCandidate(strategyId, campaignId) {
  const result = await dbOperations.run(
    `INSERT INTO raw_candidates
     (strategy_id, campaign_id, platform, kol_name, contact_name, profile_url, video_url, video_title,
      followers, avg_views, email, country_region, ai_score, ai_match_reason, status, source,
      target_platform, scoring_breakdown, raw_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      strategyId, campaignId, 'youtube', 'Test Creator', 'Test Contact',
      'https://www.youtube.com/channel/UCtest123',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'Test Video', '1.2M', '500K', 'test@example.com', 'US',
      85, 'High match for test brand', 'new', 'finder',
      'youtube', '{}', '{}'
    ]
  );
  return result.id;
}

async function createRawCandidateProductFit(candidateId, campaignProductId, strategyId) {
  const identityKey = 'profile:youtube:https://www.youtube.com/channel/UCtest123';
  const result = await dbOperations.run(
    `INSERT INTO raw_candidate_product_fits
     (latest_raw_candidate_id, campaign_product_id, platform, identity_key_hash, strategy_id,
      identity_status, fit_score, matched_persona, evidence_summary, decision_status, analysis_version)
     VALUES (?, ?, 'youtube', ?, ?, 'new_kol', 85, 'Reviewer', ?, 'pending', 1)`,
    [
      candidateId,
      campaignProductId,
      crypto.createHash('sha256').update(identityKey).digest('hex'),
      strategyId,
      JSON.stringify({ recommendation: 'High match for test brand' })
    ]
  );
  return result.id;
}

test('approve raw candidate creates customer, platform account, and campaign kol', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const { campaignId, strategyId, campaignProductId } = await setupCampaignAndStrategy();
  const candidateId = await createRawCandidate(strategyId, campaignId);
  await createRawCandidateProductFit(candidateId, campaignProductId, strategyId);

  const res = await supertest(app)
    .post(`/api/raw-candidates/${candidateId}/approve`)
    .send({ strategy_id: strategyId, campaign_id: campaignId, campaign_product_id: campaignProductId })
    .expect(200);

  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.candidateStatus, 'approved');
  assert.ok(res.body.data.customer?.id, 'Customer should be created');
  assert.ok(res.body.data.platformAccount?.id, 'Platform account should be created');
  assert.ok(res.body.data.campaignKol?.id, 'Campaign KOL should be created');
  assert.ok(res.body.data.campaignKolProduct?.id, 'Campaign KOL Product should be created');
  assert.strictEqual(res.body.data.campaignKolProduct.campaign_product_id, campaignProductId);

  const customer = await dbOperations.get('SELECT * FROM customers WHERE id = ?', [res.body.data.customer.id]);
  assert.strictEqual(customer.name, 'Test Creator');

  const platformAccount = await dbOperations.get('SELECT * FROM kol_platform_accounts WHERE id = ?', [res.body.data.platformAccount.id]);
  assert.strictEqual(platformAccount.platform, 'youtube');
  assert.ok(platformAccount.profile_url_hash, 'profile_url_hash should be set');

  const campaignKol = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [res.body.data.campaignKol.id]);
  assert.strictEqual(campaignKol.campaign_id, campaignId);
  assert.strictEqual(campaignKol.customer_id, customer.id);
  assert.strictEqual(campaignKol.platform_account_id, platformAccount.id);
  assert.ok(campaignKol.master_snapshot, 'master_snapshot should be set');
  assert.ok(campaignKol.evidence_summary, 'evidence_summary should be set');

  const candidate = await dbOperations.get('SELECT * FROM raw_candidates WHERE id = ?', [candidateId]);
  assert.strictEqual(candidate.status, 'approved');
  assert.strictEqual(candidate.approved_customer_id, customer.id);
  assert.strictEqual(candidate.approved_campaign_kol_id, campaignKol.id);
});

test('approve duplicate raw candidate links existing customer and campaign kol', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const { campaignId, strategyId, campaignProductId } = await setupCampaignAndStrategy();
  const candidateId1 = await createRawCandidate(strategyId, campaignId);
  const candidateId2 = await createRawCandidate(strategyId, campaignId);
  await createRawCandidateProductFit(candidateId2, campaignProductId, strategyId);

  await supertest(app)
    .post(`/api/raw-candidates/${candidateId1}/approve`)
    .send({ strategy_id: strategyId, campaign_id: campaignId, campaign_product_id: campaignProductId });

  const res = await supertest(app)
    .post(`/api/raw-candidates/${candidateId2}/approve`)
    .send({ strategy_id: strategyId, campaign_id: campaignId, campaign_product_id: campaignProductId })
    .expect(200);

  assert.strictEqual(res.body.data.candidateStatus, 'duplicate');
  assert.ok(res.body.data.campaignKol?.id, 'Campaign KOL should be linked');
  assert.ok(res.body.data.campaignKolProduct?.id, 'Campaign KOL Product should be linked');
});

test('approve same KOL into multiple Campaign Products reuses identities', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const { campaignId, strategyId, campaignProductId } = await setupCampaignAndStrategy();

  const secondProduct = await dbOperations.run(
    `INSERT INTO products (brand, name, status, catalog_key_hash)
     VALUES (?, ?, 'active', ?)`,
    ['TestBrand', 'Evercrest', crypto.createHash('sha256').update('evercrest').digest('hex')]
  );
  const secondCampaignProduct = await dbOperations.run(
    `INSERT INTO campaign_products (campaign_id, product_id, role, priority, status)
     VALUES (?, ?, 'secondary', 1, 'active')`,
    [campaignId, secondProduct.id]
  );
  const secondStrategy = await dbOperations.run(
    `INSERT INTO kol_strategies (campaign_id, name, status, campaign_goal, product_context, persona_config, scoring_weights, finder_handoff, campaign_product_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [campaignId, 'Second Strategy', 'ready', 'goal', 'context', '{}', '{}', '{}', secondCampaignProduct.id]
  );

  const candidateId1 = await createRawCandidate(strategyId, campaignId);
  const candidateId2 = await createRawCandidate(secondStrategy.id, campaignId);
  await createRawCandidateProductFit(candidateId1, campaignProductId, strategyId);
  await createRawCandidateProductFit(candidateId2, secondCampaignProduct.id, secondStrategy.id);

  const first = await supertest(app)
    .post(`/api/raw-candidates/${candidateId1}/approve`)
    .send({ strategy_id: strategyId, campaign_id: campaignId, campaign_product_id: campaignProductId })
    .expect(200);
  const second = await supertest(app)
    .post(`/api/raw-candidates/${candidateId2}/approve`)
    .send({ strategy_id: secondStrategy.id, campaign_id: campaignId, campaign_product_id: secondCampaignProduct.id })
    .expect(200);

  assert.strictEqual(first.body.data.customer.id, second.body.data.customer.id);
  assert.strictEqual(first.body.data.campaignKol.id, second.body.data.campaignKol.id);

  const assignments = await dbOperations.query(
    'SELECT * FROM campaign_kol_products WHERE campaign_kol_id = ?',
    [first.body.data.campaignKol.id]
  );
  assert.strictEqual(assignments.length, 2);

  const productsRes = await supertest(app)
    .get(`/api/campaign-kols/${first.body.data.campaignKol.id}/products`)
    .expect(200);
  assert.strictEqual(productsRes.body.data.length, 2);
  assert.ok(productsRes.body.data.find((row) => row.product_name === 'Approve Test Product'));
  assert.ok(productsRes.body.data.find((row) => row.product_name === 'Evercrest'));

  const evercrestAssignment = productsRes.body.data.find((row) => row.product_name === 'Evercrest');
  const updateRes = await supertest(app)
    .put(`/api/campaign-kols/${first.body.data.campaignKol.id}/products/${evercrestAssignment.campaign_product_id}`)
    .send({ assignment_status: 'paused', sample_status: 'sent', content_status: 'draft' })
    .expect(200);
  assert.strictEqual(updateRes.body.data.assignment_status, 'paused');
  assert.strictEqual(updateRes.body.data.sample_status, 'sent');
  assert.strictEqual(updateRes.body.data.content_status, 'draft');
});

test('approve rejects Campaign Product from another Campaign', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const { campaignId, strategyId, campaignProductId } = await setupCampaignAndStrategy();

  const otherCampaign = await dbOperations.run(
    'INSERT INTO campaigns (name, brand, product) VALUES (?, ?, ?)',
    ['Other Campaign', 'OtherBrand', 'OtherProduct']
  );
  const otherProduct = await dbOperations.run(
    `INSERT INTO products (brand, name, status, catalog_key_hash)
     VALUES (?, ?, 'active', ?)`,
    ['OtherBrand', 'OtherProduct', crypto.createHash('sha256').update('other').digest('hex')]
  );
  const otherCampaignProduct = await dbOperations.run(
    `INSERT INTO campaign_products (campaign_id, product_id, role, priority, status)
     VALUES (?, ?, 'hero', 0, 'active')`,
    [otherCampaign.id, otherProduct.id]
  );

  const candidateId = await createRawCandidate(strategyId, campaignId);
  await createRawCandidateProductFit(candidateId, campaignProductId, strategyId);

  const res = await supertest(app)
    .post(`/api/raw-candidates/${candidateId}/approve`)
    .send({ strategy_id: strategyId, campaign_id: campaignId, campaign_product_id: otherCampaignProduct.id })
    .expect(400);

  assert.match(res.body.error, /does not match Strategy|不属于当前项目/);
});

test('GET /api/campaigns/:id/kols returns approved campaign kols', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const { campaignId, strategyId, campaignProductId } = await setupCampaignAndStrategy();
  const candidateId = await createRawCandidate(strategyId, campaignId);
  await createRawCandidateProductFit(candidateId, campaignProductId, strategyId);

  await supertest(app)
    .post(`/api/raw-candidates/${candidateId}/approve`)
    .send({ strategy_id: strategyId, campaign_id: campaignId, campaign_product_id: campaignProductId });

  const res = await supertest(app)
    .get(`/api/campaigns/${campaignId}/kols`)
    .expect(200);

  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.length, 1);
  assert.strictEqual(res.body.data[0].campaign_id, campaignId);
  assert.ok(res.body.data[0].master_snapshot, 'master_snapshot should be returned');
});

test('cleanup rawCandidates database connection', async () => {
  await sequelize.close();
});
