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
});

test('cleanup agent database connection', async () => {
  await sequelize.close();
});