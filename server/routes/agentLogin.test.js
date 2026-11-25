const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { createRouter } = require('./agentLogin');
const { challengeFor } = require('../services/agentLogin');

function appFor(service = {}) {
  const app = express(); app.use(express.json());
  const requireSession = (req, res, next) => {
    if (req.headers['x-test-session'] !== 'yes') return res.sendStatus(401);
    req.user = { id: 7, status: 'active' }; return next();
  };
  app.use('/api/auth/agent', createRouter({ service, requireSession }));
  return request(app);
}
test('anonymous callers cannot view, approve or revoke browser connections', async () => {
  const client = appFor();
  for (const path of ['/device/ABCD-EFGH', '/connections']) await client.get('/api/auth/agent' + path).expect(401);
  await client.post('/api/auth/agent/device/ABCD-EFGH/decision').send({ approve: true }).expect(401);
  await client.delete('/api/auth/agent/connections/1').expect(401);
});
test('browser mutations require matching Origin and an explicit boolean decision', async () => {
  const calls = [];
  const client = appFor({ decide: async (...args) => calls.push(args), revoke: async (...args) => calls.push(args) });
  const path = '/api/auth/agent/device/ABCD-EFGH/decision';
  await client.post(path).set('x-test-session', 'yes').send({ approve: true }).expect(403);
  await client.post(path).set('x-test-session', 'yes').set('Host', 'os.test').set('Origin', 'http://evil.test').send({ approve: true }).expect(403);
  await client.post(path).set('x-test-session', 'yes').set('Host', 'os.test').set('Origin', 'http://os.test').send({ approve: 'true' }).expect(400);
  await client.post(path).set('x-test-session', 'yes').set('Host', 'os.test').set('Origin', 'http://os.test').send({ approve: true }).expect(200);
  await client.delete('/api/auth/agent/connections/1').set('x-test-session', 'yes').set('Host', 'os.test').set('Origin', 'http://os.test').expect(200);
  assert.equal(calls.length, 2);
});
test('device creation is rate limited and token responses are never cached', async () => {
  const client = appFor({ start: async () => ({ user_code: 'ABCD-EFGH' }), poll: async () => ({ error: 'authorization_pending' }) });
  for (let i = 0; i < 5; i += 1) {
    const res = await client.post('/api/auth/agent/device').send({ challenge: challengeFor('x'.repeat(43)) }).expect(200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.verification_path, '/agent/connect?code=ABCD-EFGH');
  }
  await client.post('/api/auth/agent/device').send({}).expect(429);
  await client.post('/api/auth/agent/token').send({}).expect(400);
});
test('server errors are sanitized and never echo credential-bearing exception messages', async () => {
  const client = appFor({ refresh: async () => { throw new Error('secret-value-must-not-be-echoed'); } });
  const res = await client.post('/api/auth/agent/refresh').send({}).expect(500);
  assert.deepEqual(res.body, { error: 'agent_login_failed' });
});
