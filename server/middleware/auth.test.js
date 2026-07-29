const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const { createAuthRouter, authGuard, COOKIE_NAME, isAgentFinderOperation } = require('./auth');

const TEST_PASSWORD = 'team-secret-pass';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRouter());
  app.use(authGuard);
  app.get('/api/health', (req, res) => res.json({ status: 'OK' }));
  app.get('/api/agent/ping', (req, res) => res.json({ ok: true }));
  app.get('/api/customers', (req, res) => res.json({ ok: true }));
  app.get('/uploads/images/x.png', (req, res) => res.json({ ok: true }));
  app.get('/', (req, res) => res.send('index'));
  return app;
}

function extractAuthCookie(res) {
  const cookies = res.headers['set-cookie'] || [];
  const raw = Array.isArray(cookies) ? cookies[0] : cookies;
  if (!raw) return null;
  return raw.split(';')[0];
}

test('passes through when APP_ACCESS_PASSWORD is not set', async () => {
  delete process.env.APP_ACCESS_PASSWORD;
  const res = await request(buildApp()).get('/api/customers');
  assert.strictEqual(res.status, 200);
});

test('reports authRequired=false when disabled', async () => {
  delete process.env.APP_ACCESS_PASSWORD;
  const res = await request(buildApp()).get('/api/auth/me');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.authenticated, true);
  assert.strictEqual(res.body.authRequired, false);
});

test('returns 401 for protected API without cookie', async () => {
  process.env.APP_ACCESS_PASSWORD = TEST_PASSWORD;
  const res = await request(buildApp()).get('/api/customers');
  assert.strictEqual(res.status, 401);
});

test('returns 401 for uploads without cookie', async () => {
  process.env.APP_ACCESS_PASSWORD = TEST_PASSWORD;
  const res = await request(buildApp()).get('/uploads/images/x.png');
  assert.strictEqual(res.status, 401);
});

test('health check and agent API stay public', async () => {
  process.env.APP_ACCESS_PASSWORD = TEST_PASSWORD;
  const app = buildApp();
  assert.strictEqual((await request(app).get('/api/health')).status, 200);
  assert.strictEqual((await request(app).get('/api/agent/ping')).status, 200);
});

test('only the documented Finder operations qualify for Agent token access', () => {
  const matches = (method, path) => isAgentFinderOperation({ method, path });
  assert.strictEqual(matches('GET', '/api/settings/health/config'), true);
  assert.strictEqual(matches('POST', '/api/finder-tasks'), true);
  assert.strictEqual(matches('POST', '/api/finder-tasks/12/video-evidence/import'), true);
  assert.strictEqual(matches('POST', '/api/finder-tasks/12/evidence-analysis'), true);
  assert.strictEqual(matches('POST', '/api/finder-tasks/12/generate-candidates-from-evidence'), true);
  assert.strictEqual(matches('GET', '/api/finder-tasks'), false);
  assert.strictEqual(matches('POST', '/api/finder-tasks/12/cancel'), false);
  assert.strictEqual(matches('GET', '/api/raw-candidates'), false);
  assert.strictEqual(matches('POST', '/api/raw-candidates/12/approve'), false);
});

test('static frontend stays public', async () => {
  process.env.APP_ACCESS_PASSWORD = TEST_PASSWORD;
  const res = await request(buildApp()).get('/');
  assert.strictEqual(res.status, 200);
});

test('rejects wrong password', async () => {
  process.env.APP_ACCESS_PASSWORD = TEST_PASSWORD;
  const res = await request(buildApp())
    .post('/api/auth/login')
    .send({ password: 'wrong' });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.success, false);
});

test('login issues a cookie that unlocks protected routes', async () => {
  process.env.APP_ACCESS_PASSWORD = TEST_PASSWORD;
  const app = buildApp();

  const login = await request(app)
    .post('/api/auth/login')
    .send({ password: TEST_PASSWORD });
  assert.strictEqual(login.status, 200);
  assert.strictEqual(login.body.success, true);

  const cookie = extractAuthCookie(login);
  assert.ok(cookie && cookie.startsWith(`${COOKIE_NAME}=`));

  const res = await request(app).get('/api/customers').set('Cookie', cookie);
  assert.strictEqual(res.status, 200);

  const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
  assert.strictEqual(me.body.authenticated, true);
  assert.strictEqual(me.body.authRequired, true);
});

test('tampered cookie is rejected', async () => {
  process.env.APP_ACCESS_PASSWORD = TEST_PASSWORD;
  const app = buildApp();
  const login = await request(app)
    .post('/api/auth/login')
    .send({ password: TEST_PASSWORD });
  const cookie = extractAuthCookie(login);
  const tampered = `${cookie.slice(0, -2)}xx`;
  const res = await request(app).get('/api/customers').set('Cookie', tampered);
  assert.strictEqual(res.status, 401);
});

test('logout clears the session', async () => {
  process.env.APP_ACCESS_PASSWORD = TEST_PASSWORD;
  const app = buildApp();
  const login = await request(app)
    .post('/api/auth/login')
    .send({ password: TEST_PASSWORD });
  const cookie = extractAuthCookie(login);

  const logout = await request(app).post('/api/auth/logout').set('Cookie', cookie);
  assert.strictEqual(logout.status, 200);

  const res = await request(app).get('/api/customers').set('Cookie', cookie);
  // The old token is still cryptographically valid; the client discards it.
  // Clearing is signalled via the Set-Cookie header on logout.
  assert.ok(String(logout.headers['set-cookie']).includes('Max-Age=0'));
  assert.strictEqual(res.status, 200);
});
