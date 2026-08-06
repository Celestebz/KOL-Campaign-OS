const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('path');
const express = require('express');
const supertest = require('supertest');
const { Sequelize } = require('sequelize');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.DB_NAME = 'kol_campaign_os_agent_test';
process.env.DB_NAME_TEST = 'kol_campaign_os_agent_test';

const { initDatabase, models, sequelize } = require('../database');
const agentRoutes = require('./agent');
const emailRoutes = require('./emails');
const { authGuard } = require('../middleware/auth');

async function resetTestDatabase() {
  const admin = new Sequelize('mysql', 'root', process.env.DB_ROOT_PASSWORD || 'root_password', {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    dialect: 'mysql',
    logging: false
  });
  await admin.query('DROP DATABASE IF EXISTS ' + process.env.DB_NAME);
  await admin.query('CREATE DATABASE ' + process.env.DB_NAME + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  await admin.query("GRANT ALL PRIVILEGES ON " + process.env.DB_NAME + ".* TO '" + (process.env.DB_USER || 'kol_user') + "'@'%'");
  await admin.query('FLUSH PRIVILEGES');
  await admin.close();
}

test('agent exposes only video evidence workflow and retires direct candidate import', async () => {
  await resetTestDatabase();
  await initDatabase();
  const campaign = await models.Campaign.create({ name: 'Agent Campaign', product: 'Product' });
  const strategy = await models.KolStrategy.create({
    campaign_id: campaign.id,
    name: 'Agent Strategy',
    status: 'ready',
    primary_platform: 'youtube',
    finder_handoff: JSON.stringify({ required_platforms: ['youtube'] })
  });
  await models.ApiSetting.create({ provider: 'agent.external_api', api_key: 'agent-token' });

  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRoutes);
  app.use('/api/emails', emailRoutes);
  const request = supertest(app);
  const auth = { Authorization: 'Bearer agent-token' };

  const brief = await request.get('/api/agent/brief/' + strategy.id).set(auth).expect(200);
  assert.equal(brief.body.data.finder.workflow, 'target_platform_video_evidence');
  assert.equal(brief.body.data.write_api.create_task.body.target_platform, 'youtube');
  assert.equal(brief.body.data.rules.direct_raw_candidate_import, false);
  assert.equal(JSON.stringify(brief.body).includes('cycle'), false);

  const retired = await request
    .post('/api/agent/raw-candidates/import')
    .set(auth)
    .send({ candidates: [{ kol_name: 'Legacy' }] })
    .expect(410);
  assert.match(retired.body.error, /retired/i);

  const previousPassword = process.env.APP_ACCESS_PASSWORD;
  process.env.APP_ACCESS_PASSWORD = 'team-password';
  const protectedApp = express();
  protectedApp.use(express.json());
  protectedApp.use(authGuard);
  protectedApp.post('/api/finder-tasks', (req, res) => res.json({ ok: true }));
  protectedApp.post('/api/finder-tasks/:id/video-evidence/import', (req, res) => res.json({ ok: true }));
  protectedApp.post('/api/raw-candidates/:id/approve', (req, res) => res.json({ ok: true }));
  const protectedRequest = supertest(protectedApp);

  await protectedRequest.post('/api/finder-tasks').set(auth).expect(200);
  await protectedRequest.post('/api/finder-tasks/1/video-evidence/import').set(auth).expect(200);
  await protectedRequest.post('/api/finder-tasks').set({ Authorization: 'Bearer wrong-token' }).expect(401);
  await protectedRequest.post('/api/raw-candidates/1/approve').set(auth).expect(401);

  if (previousPassword === undefined) delete process.env.APP_ACCESS_PASSWORD;
  else process.env.APP_ACCESS_PASSWORD = previousPassword;
});

test('restricted agent campaign API searches, previews, writes candidates and pending drafts idempotently', async () => {
  const campaign = await models.Campaign.create({
    name: 'TMB-1401',
    product: 'TMB-1401',
    campaign_type: 'active_project',
    status: 'active'
  });
  const eligible = await models.Customer.create({
    name: 'Eligible Creator',
    email: 'eligible@example.com',
    youtube_url: 'https://youtube.com/@eligible',
    youtube_avg_views_30d: 25000,
    youtube_median_views_30d: 18000
  });
  await models.Customer.create({
    name: 'Below Threshold',
    email: 'below@example.com',
    youtube_url: 'https://youtube.com/@below',
    youtube_avg_views_30d: 1000,
    youtube_median_views_30d: 2000
  });
  const instagramEligible = await models.Customer.create({
    name: 'Instagram Creator',
    instagram_url: 'https://instagram.com/eligible',
    instagram_followers: '25K'
  });
  await models.Customer.create({
    name: 'Instagram Below Threshold',
    instagram_url: 'https://instagram.com/below',
    instagram_followers: '4,999'
  });
  const tiktokEligible = await models.Customer.create({
    name: 'TikTok Creator',
    tiktok_url: 'https://tiktok.com/@eligible',
    tiktok_followers: '1.2M'
  });

  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRoutes);
  app.use('/api/emails', emailRoutes);
  const request = supertest(app);
  const auth = { Authorization: 'Bearer agent-token' };

  await request
    .get(`/api/agent/campaigns/${campaign.id}/kol-master/search`)
    .set({ 'x-agent-token': 'agent-token' })
    .query({ min_avg_views_30d: 19191, min_median_views_30d: 19191 })
    .expect(401);

  const search = await request
    .get(`/api/agent/campaigns/${campaign.id}/kol-master/search`)
    .set(auth)
    .query({
      platform: 'youtube',
      min_avg_views_30d: 19191,
      min_median_views_30d: 19191,
      metric_mode: 'any',
      exclude_in_campaign: true
    })
    .expect(200);
  assert.equal(search.body.data.total, 1);
  assert.equal(search.body.data.items[0].customer_id, eligible.id);
  assert.equal(search.body.data.platform, 'youtube');
  assert.equal(search.body.data.items[0].platform_url, eligible.youtube_url);

  const instagramSearch = await request
    .get(`/api/agent/campaigns/${campaign.id}/kol-master/search`)
    .set(auth)
    .query({ platform: 'instagram', min_followers: 10000 })
    .expect(200);
  assert.equal(instagramSearch.body.data.platform, 'instagram');
  assert.equal(instagramSearch.body.data.total, 1);
  assert.equal(instagramSearch.body.data.items[0].customer_id, instagramEligible.id);
  assert.equal(instagramSearch.body.data.items[0].platform_url, instagramEligible.instagram_url);
  assert.equal(instagramSearch.body.data.items[0].followers, '25K');

  const tiktokSearch = await request
    .get(`/api/agent/campaigns/${campaign.id}/kol-master/search`)
    .set(auth)
    .query({ platform: 'tiktok', min_followers: 500000 })
    .expect(200);
  assert.equal(tiktokSearch.body.data.platform, 'tiktok');
  assert.equal(tiktokSearch.body.data.total, 1);
  assert.equal(tiktokSearch.body.data.items[0].customer_id, tiktokEligible.id);

  const unsupportedInstagramMetrics = await request
    .get(`/api/agent/campaigns/${campaign.id}/kol-master/search`)
    .set(auth)
    .query({ platform: 'instagram', min_avg_views_30d: 5000 })
    .expect(400);
  assert.match(unsupportedInstagramMetrics.body.error, /view metrics are not available/i);

  await request
    .get(`/api/agent/campaigns/${campaign.id}/kol-master/search`)
    .set(auth)
    .query({ platform: 'facebook', min_followers: 10000 })
    .expect(400);

  const candidateBody = {
    idempotency_key: 'candidate-test-1',
    items: [{
      customer_id: eligible.id,
      cooperation_platforms: ['youtube'],
      priority: 'T2',
      recommendation_note: 'TMB-1401 fit'
    }]
  };
  const preview = await request
    .post(`/api/agent/campaigns/${campaign.id}/candidate-pool/batch`)
    .set(auth)
    .send({ ...candidateBody, dry_run: true })
    .expect(200);
  assert.equal(preview.body.data.items[0].action, 'add');

  const added = await request
    .post(`/api/agent/campaigns/${campaign.id}/candidate-pool/batch`)
    .set(auth)
    .send(candidateBody)
    .expect(200);
  assert.equal(added.body.data.items[0].action, 'added');

  const replay = await request
    .post(`/api/agent/campaigns/${campaign.id}/candidate-pool/batch`)
    .set(auth)
    .send(candidateBody)
    .expect(200);
  assert.equal(replay.body.data.idempotent_replay, true);

  const afterAdd = await request
    .get(`/api/agent/campaigns/${campaign.id}/kol-master/search`)
    .set(auth)
    .query({ min_avg_views_30d: 19191, min_median_views_30d: 19191, metric_mode: 'any' })
    .expect(200);
  assert.equal(afterAdd.body.data.total, 0);

  const draftBody = {
    idempotency_key: 'draft-test-1',
    kind: 'first_touch',
    drafts: [{
      customer_id: eligible.id,
      subject: 'TMB-1401 collaboration',
      body_text: 'Can you publish by August 31, 2026? We offer product exchange, 5% commission and an exclusive discount.'
    }]
  };
  const validation = await request
    .post(`/api/agent/campaigns/${campaign.id}/email-drafts/batch-upsert`)
    .set(auth)
    .send({ ...draftBody, validate_only: true })
    .expect(200);
  assert.equal(validation.body.data.items[0].action, 'create');

  const drafted = await request
    .post(`/api/agent/campaigns/${campaign.id}/email-drafts/batch-upsert`)
    .set(auth)
    .send(draftBody)
    .expect(200);
  assert.equal(drafted.body.data.items[0].action, 'create');

  const drafts = await request
    .get(`/api/agent/campaigns/${campaign.id}/email-drafts`)
    .set(auth)
    .query({ customer_id: eligible.id, kind: 'first_touch' })
    .expect(200);
  assert.equal(drafts.body.data.length, 1);
  assert.equal(drafts.body.data[0].status, 'pending_review');
  assert.ok(drafts.body.data[0].content_hash);

  const reviewDesk = await request
    .get('/api/emails/drafts')
    .query({ campaign_id: campaign.id, status: 'pending_review', kind: 'first_touch' })
    .expect(200);
  assert.equal(reviewDesk.body.data.drafts.length, 1);
  assert.equal(reviewDesk.body.data.drafts[0].id, drafts.body.data[0].draft_id);
  assert.equal(reviewDesk.body.data.drafts[0].subject, draftBody.drafts[0].subject);

  await request
    .post(`/api/agent/campaigns/${campaign.id}/email-drafts/${drafts.body.data[0].draft_id}/send`)
    .set(auth)
    .send({})
    .expect(404);
});

test('agent idempotency key rejects a changed request', async () => {
  const campaign = await models.Campaign.findOne({ where: { name: 'TMB-1401' } });
  const customer = await models.Customer.findOne({ where: { name: 'Eligible Creator' } });
  const request = supertest(express().use(express.json()).use('/api/agent', agentRoutes));
  const response = await request
    .post(`/api/agent/campaigns/${campaign.id}/candidate-pool/batch`)
    .set({ Authorization: 'Bearer agent-token' })
    .send({
      idempotency_key: 'candidate-test-1',
      items: [{ customer_id: customer.id, priority: 't1' }]
    })
    .expect(409);
  assert.match(response.body.error, /different request/i);
});

test.after(async () => {
  await sequelize.close();
});
