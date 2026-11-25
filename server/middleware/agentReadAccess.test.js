const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { dbOperations } = require('../database');
const { createAuthGuard, isAgentReadOperation, issueToken, COOKIE_NAME } = require('./auth');
const { currentUserId } = require('../utils/requestContext');
const emailRoutes = require('../routes/emails');

test('Agent read allowlist excludes mutations, settings and job-starting GETs', () => {
  for (const path of ['/api/emails/settings/sync-status', '/api/emails/threads', '/api/emails/threads/12', '/api/customers', '/api/customers/12', '/api/customers/12/project-history']) {
    assert.equal(isAgentReadOperation({ method: 'GET', path }), true, path);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      assert.equal(isAgentReadOperation({ method, path }), false);
    }
  }
  for (const path of ['/api/emails/settings', '/api/emails/threads/1/draft-reply', '/api/emails/settings/sync-now', '/api/customers/1/youtube-snapshot', '/api/customers/1/social-snapshot/tiktok', '/api/customers/export', '/api/emails/threads/1/extra']) {
    assert.equal(isAgentReadOperation({ method: 'GET', path }), false, path);
  }
});

test('Agent reads authenticate active owners and preserve email ownership without writes', async (t) => {
  const originalQuery = dbOperations.query;
  const originalRun = dbOperations.run;
  t.after(() => { dbOperations.query = originalQuery; dbOperations.run = originalRun; });
  let owner = { id: 7, status: 'active', token_version: 1 };
  let tokenOwner = 7;
  const reads = [];
  dbOperations.run = async () => { assert.fail('Read request attempted a database write'); };
  dbOperations.query = async (sql, params = []) => {
    reads.push({ sql, params });
    if (sql.includes('FROM api_settings')) return [{ api_key: 'test-only-agent', owner_user_id: tokenOwner }];
    if (sql.includes('SELECT id FROM email_threads')) {
      assert.equal(params[1], 7);
      return Number(params[0]) === 10 ? [{ id: 10 }] : [];
    }
    if (sql.includes('SELECT * FROM email_threads')) return [{ id: 10, owner_user_id: 7 }];
    if (sql.includes('FROM email_threads t')) {
      assert.match(sql, /t.owner_user_id = \?/);
      assert.equal(params[0], 7);
      return sql.includes('COUNT(*)') ? [{ total: 0 }] : [];
    }
    if (sql.includes('FROM email_settings')) {
      assert.match(sql, /owner_user_id = \?/);
      assert.deepEqual(params, [7]);
      return [{ id: 5, username: 'mail@example.test', password: 'must-never-return', owner_user_id: 7 }];
    }
    if (/FROM email_(replies|records|drafts)/.test(sql)) return [];
    assert.fail('Unexpected SQL: ' + sql);
  };
  const store = { findUserById: async (id) => owner && Number(id) === owner.id ? owner : null };
  const app = express();
  app.use(createAuthGuard(store));
  app.use('/api/emails', emailRoutes);
  app.get('/api/customers', (req, res) => res.json({ id: req.user.id, context: currentUserId() }));
  const client = request(app);
  const auth = { Authorization: 'Bearer test-only-agent' };
  await client.get('/api/customers').expect(401);
  await client.get('/api/customers').set('Authorization', 'Bearer invalid').expect(401);
  const customer = await client.get('/api/customers').set(auth).expect(200);
  assert.deepEqual(customer.body, { id: 7, context: 7 });
  await client.get('/api/emails/threads?owner_user_id=99').set(auth).expect(200);
  await client.get('/api/emails/threads/10').set(auth).expect(200);
  await client.get('/api/emails/threads/11').set(auth).expect(404);
  const sync = await client.get('/api/emails/settings/sync-status?owner_user_id=99').set(auth).expect(200);
  assert.equal(sync.body.data[0].mailbox_id, 5);
  assert.equal(JSON.stringify(sync.body).includes('must-never-return'), false);
  for (const path of ['/api/emails/settings', '/api/customers/1/youtube-snapshot']) await client.get(path).set(auth).expect(401);
  for (const path of ['/api/emails/settings/sync-now', '/api/emails/threads/10/draft-reply', '/api/emails/drafts/1/send', '/api/emails/drafts/1/approve']) await client.post(path).set(auth).expect(401);
  owner.status = 'disabled';
  await client.get('/api/customers').set(auth).expect(403);
  owner = null;
  await client.get('/api/customers').set(auth).expect(403);
  tokenOwner = null;
  await client.get('/api/customers').set(auth).expect(403);
  owner = { id: 7, status: 'active', token_version: 1 };
  await client.get('/api/customers').set('Cookie', `${COOKIE_NAME}=${issueToken(owner)}`).expect(200);
  assert.ok(reads.length > 0);
});
