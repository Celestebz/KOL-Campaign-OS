const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const migration = require('../migrations/20260717000001-remove-agent-automation-settings');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
require('dotenv').config();
process.env.NODE_ENV = 'test';
process.env.DB_NAME = 'kol_campaign_os_agent_test';
process.env.DB_NAME_TEST = 'kol_campaign_os_agent_test';

const { Sequelize } = require('sequelize');
const { initDatabase, models, sequelize } = require('../database');

test.after(async () => {
  await sequelize.close();
});

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

test('deletes legacy Maton without creating canonical configuration', async () => {
  await resetTestDatabase();
  await initDatabase();
  await models.ApiSetting.create({ provider: 'agent.maton_gateway', api_key: 'legacy-key', base_url: 'https://legacy.example' });

  await migration.up(sequelize.getQueryInterface());

  const canonical = await models.ApiSetting.findOne({ where: { provider: 'youtube.maton_gateway' } });
  assert.equal(canonical, null);
  assert.equal(await models.ApiSetting.count({ where: { provider: 'agent.maton_gateway' } }), 0);
});

test('preserves canonical Maton config and deletes legacy automation rows', async () => {
  await resetTestDatabase();
  await initDatabase();
  await models.ApiSetting.bulkCreate([
    { provider: 'youtube.maton_gateway', api_key: 'canonical-key' },
    { provider: 'agent.maton_gateway', api_key: 'legacy-key' },
    { provider: 'agent.browseract', api_key: 'browser-key' },
    { provider: 'agent.external_api', api_key: 'access-token' }
  ]);

  await migration.up(sequelize.getQueryInterface());

  const canonical = await models.ApiSetting.findOne({ where: { provider: 'youtube.maton_gateway' } });
  assert.equal(canonical.api_key, 'canonical-key');
  assert.equal(await models.ApiSetting.count({ where: { provider: 'agent.maton_gateway' } }), 0);
  assert.equal(await models.ApiSetting.count({ where: { provider: 'agent.browseract' } }), 0);
  assert.equal(await models.ApiSetting.count({ where: { provider: 'agent.external_api' } }), 1);
});
