// Opt in only against a dedicated local/test MySQL instance.
// KOL_AGENT_LOGIN_MYSQL_TEST=1 and DB_ROOT_PASSWORD must be explicitly supplied.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const { createAgentLogin, challengeFor } = require('./agentLogin');
const { createStore } = require('./agentLoginStore');
const migration = require('../migrations/20261125000001-agent-browser-login');

test('MySQL migration and transactional browser login, renewal, owner isolation and revocation', {
  skip: process.env.KOL_AGENT_LOGIN_MYSQL_TEST !== '1' ? 'Requires dedicated MySQL test instance' : false
}, async (t) => {
  assert.ok(process.env.DB_ROOT_PASSWORD, 'Explicit test database credentials are required');
  const name = `kol_agent_login_test_${process.pid}_${Date.now()}`;
  assert.match(name, /^kol_agent_login_test_\d+_\d+$/);
  const options = { host: process.env.KOL_AGENT_LOGIN_MYSQL_HOST || '127.0.0.1', port: Number(process.env.KOL_AGENT_LOGIN_MYSQL_PORT || 3306), dialect: 'mysql', logging: false };
  const admin = new Sequelize('mysql', 'root', process.env.DB_ROOT_PASSWORD, options);
  await admin.query('CREATE DATABASE `' + name + '`');
  const database = new Sequelize(name, 'root', process.env.DB_ROOT_PASSWORD, options);
  t.after(async () => { await database.close(); await admin.query('DROP DATABASE `' + name + '`'); await admin.close(); });
  const q = database.getQueryInterface();
  await q.createTable('users', { id: { type: Sequelize.INTEGER, primaryKey: true }, status: Sequelize.STRING(16), token_version: Sequelize.INTEGER });
  await q.bulkInsert('users', [{ id: 7, status: 'active', token_version: 1 }, { id: 8, status: 'active', token_version: 1 }]);
  await migration.up(q, Sequelize);
  const service = createAgentLogin({ store: createStore(null, database) });
  const verifier = 'v'.repeat(43);
  const device = await service.start({ challenge: challengeFor(verifier), label: 'MySQL test' });
  const user = { id: 7, status: 'active' };
  await service.decide(device.user_code, user, true);
  const results = await Promise.allSettled([1, 2].map(() => service.poll({ device_code: device.device_code, verifier })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const token = results.find((r) => r.status === 'fulfilled').value;
  assert.equal((await service.authenticate(token.access_token)).id, 7);
  const refreshed = await service.refresh(token.refresh_token);
  assert.equal((await service.authenticate(refreshed.access_token)).id, 7);
  const list = await service.list(user);
  assert.equal(list.length, 1);
  assert.equal(JSON.stringify(list).includes('hash'), false);
  assert.deepEqual(await service.list({ id: 8 }), []);
  await assert.rejects(service.revoke(list[0].id, { id: 8 }), { code: 'connection_not_found' });
  await service.revoke(list[0].id, user);
  assert.equal(await service.authenticate(refreshed.access_token), null);
  await assert.rejects(service.refresh(token.refresh_token), { code: 'login_required' });
});
