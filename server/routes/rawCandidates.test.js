const assert = require('node:assert/strict');
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
  return { campaignId: campaign.id, strategyId: strategy.id };
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

test('approve raw candidate creates customer, platform account, and campaign kol', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const { campaignId, strategyId } = await setupCampaignAndStrategy();
  const candidateId = await createRawCandidate(strategyId, campaignId);

  const res = await supertest(app)
    .post(`/api/raw-candidates/${candidateId}/approve`)
    .send({ strategy_id: strategyId, campaign_id: campaignId })
    .expect(200);

  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.data.candidateStatus, 'approved');
  assert.ok(res.body.data.customer?.id, 'Customer should be created');
  assert.ok(res.body.data.platformAccount?.id, 'Platform account should be created');
  assert.ok(res.body.data.campaignKol?.id, 'Campaign KOL should be created');

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
  const { campaignId, strategyId } = await setupCampaignAndStrategy();
  const candidateId1 = await createRawCandidate(strategyId, campaignId);
  const candidateId2 = await createRawCandidate(strategyId, campaignId);

  await supertest(app)
    .post(`/api/raw-candidates/${candidateId1}/approve`)
    .send({ strategy_id: strategyId, campaign_id: campaignId });

  const res = await supertest(app)
    .post(`/api/raw-candidates/${candidateId2}/approve`)
    .send({ strategy_id: strategyId, campaign_id: campaignId })
    .expect(200);

  assert.strictEqual(res.body.data.candidateStatus, 'duplicate');
  assert.ok(res.body.data.campaignKol?.id, 'Campaign KOL should be linked');
});

test('GET /api/campaigns/:id/kols returns approved campaign kols', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();
  const { campaignId, strategyId } = await setupCampaignAndStrategy();
  const candidateId = await createRawCandidate(strategyId, campaignId);

  await supertest(app)
    .post(`/api/raw-candidates/${candidateId}/approve`)
    .send({ strategy_id: strategyId, campaign_id: campaignId });

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
