const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { createAuthRouter, createAuthGuard, COOKIE_NAME, hashPassword, isAgentFinderOperation } = require('./auth');

function makeStore() {
  const users = [];
  const invites = [];
  return {
    users,
    invites,
    countUsers: async () => users.length,
    findUserById: async (id) => users.find((user) => user.id === Number(id)) || null,
    findUserForLogin: async (username) => users.find((user) => user.username === username) || null,
    createBootstrap: async ({ username, displayName, passwordHash }) => {
      if (users.length) return null;
      const user = { id: 1, username, display_name: displayName, password_hash: passwordHash, role: 'admin', status: 'active', token_version: 1 };
      users.push(user);
      return user;
    },
    createFromInvite: async ({ username, displayName, passwordHash, code }) => {
      const invite = invites.find((item) => item.code === code && !item.revoked_at && item.used_count < item.max_uses && (!item.expires_at || item.expires_at > new Date()));
      if (!invite) return null;
      invite.used_count += 1;
      const user = { id: users.length + 1, username, display_name: displayName, password_hash: passwordHash, role: 'member', status: 'active', token_version: 1 };
      users.push(user);
      return user;
    },
    touchLogin: async () => {},
    listUsers: async () => users,
    listInvites: async () => invites,
    createInvite: async ({ code, note, maxUses, expiresAt, createdBy }) => {
      const row = { id: invites.length + 1, code, note, max_uses: maxUses, used_count: 0, expires_at: expiresAt, revoked_at: null, created_by: createdBy };
      invites.push(row);
      return row;
    },
    revokeInvite: async (id) => { const row = invites.find((item) => item.id === id); if (row) row.revoked_at = new Date(); },
    updateUserStatus: async (id, status) => { const user = users.find((item) => item.id === id); if (user) { user.status = status; user.token_version += 1; } }
  };
}

function buildApp(store) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRouter(store));
  app.use(createAuthGuard(store));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/agent/ping', (req, res) => res.json({ ok: true }));
  app.get('/api/customers', (req, res) => res.json({ user: req.user }));
  app.get('/uploads/a.png', (req, res) => res.json({ ok: true }));
  return app;
}

function cookie(res) {
  const value = (res.headers['set-cookie'] || [])[0];
  return value ? value.split(';')[0] : '';
}

test('reports bootstrap state and protects APIs before initialization', async () => {
  const store = makeStore();
  const app = buildApp(store);
  const me = await request(app).get('/api/auth/me').expect(200);
  assert.equal(me.body.needsBootstrap, true);
  assert.equal(me.body.authenticated, false);
  await request(app).get('/api/customers').expect(401);
  await request(app).get('/uploads/a.png').expect(401);
});

test('initializes exactly one admin and session unlocks protected routes', async () => {
  const store = makeStore();
  const app = buildApp(store);
  const created = await request(app).post('/api/auth/bootstrap').send({ username: 'Owner_1', displayName: 'Owner', password: 'password-123' }).expect(201);
  assert.equal(store.users[0].username, 'owner_1');
  assert.equal(store.users[0].role, 'admin');
  const session = cookie(created);
  assert.ok(session.startsWith(`${COOKIE_NAME}=`));
  const protectedRes = await request(app).get('/api/customers').set('Cookie', session).expect(200);
  assert.equal(protectedRes.body.user.username, 'owner_1');
  await request(app).post('/api/auth/bootstrap').send({ username: 'second', displayName: 'Second', password: 'password-123' }).expect(409);
});

test('logs in with personal credentials and rejects invalid passwords', async () => {
  const store = makeStore();
  store.users.push({ id: 1, username: 'alice', display_name: 'Alice', password_hash: await hashPassword('correct-pass'), role: 'admin', status: 'active', token_version: 1 });
  const app = buildApp(store);
  await request(app).post('/api/auth/login').send({ username: 'alice', password: 'wrong-pass' }).expect(401);
  const login = await request(app).post('/api/auth/login').send({ username: 'ALICE', password: 'correct-pass' }).expect(200);
  const me = await request(app).get('/api/auth/me').set('Cookie', cookie(login)).expect(200);
  assert.equal(me.body.user.username, 'alice');
});

test('session cookie is usable over HTTP and secure behind HTTPS proxy', async () => {
  const store = makeStore();
  store.users.push({ id: 1, username: 'alice', display_name: 'Alice', password_hash: await hashPassword('correct-pass'), role: 'admin', status: 'active', token_version: 1 });
  const app = buildApp(store);

  const httpLogin = await request(app).post('/api/auth/login').send({ username: 'alice', password: 'correct-pass' }).expect(200);
  assert.doesNotMatch(String(httpLogin.headers['set-cookie']), /; Secure/i);

  const httpsLogin = await request(app).post('/api/auth/login').set('X-Forwarded-Proto', 'https').send({ username: 'alice', password: 'correct-pass' }).expect(200);
  assert.match(String(httpsLogin.headers['set-cookie']), /; Secure/i);
});

test('admin creates invite and member registers once', async () => {
  const store = makeStore();
  store.users.push({ id: 1, username: 'admin', display_name: 'Admin', password_hash: await hashPassword('admin-pass'), role: 'admin', status: 'active', token_version: 1 });
  const app = buildApp(store);
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin-pass' });
  const adminCookie = cookie(login);
  const invite = await request(app).post('/api/auth/admin/invites').set('Cookie', adminCookie).send({ note: 'Bob', maxUses: 1 }).expect(201);
  const code = invite.body.data.code;
  const registration = await request(app).post('/api/auth/register').send({ username: 'bob', displayName: 'Bob', password: 'member-pass', inviteCode: code }).expect(201);
  assert.equal(registration.body.user.role, 'member');
  await request(app).post('/api/auth/register').send({ username: 'carol', displayName: 'Carol', password: 'member-pass', inviteCode: code }).expect(400);
});

test('disabled user session becomes invalid immediately', async () => {
  const store = makeStore();
  store.users.push({ id: 1, username: 'admin', display_name: 'Admin', password_hash: await hashPassword('admin-pass'), role: 'admin', status: 'active', token_version: 1 });
  store.users.push({ id: 2, username: 'member', display_name: 'Member', password_hash: await hashPassword('member-pass'), role: 'member', status: 'active', token_version: 1 });
  const app = buildApp(store);
  const memberLogin = await request(app).post('/api/auth/login').send({ username: 'member', password: 'member-pass' });
  const adminLogin = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin-pass' });
  await request(app).patch('/api/auth/admin/users/2/status').set('Cookie', cookie(adminLogin)).send({ status: 'disabled' }).expect(200);
  await request(app).get('/api/customers').set('Cookie', cookie(memberLogin)).expect(401);
});

test('health and Agent API remain public, Finder Agent allowlist is preserved', async () => {
  const app = buildApp(makeStore());
  await request(app).get('/api/health').expect(200);
  await request(app).get('/api/agent/ping').expect(200);
  const matches = (method, path) => isAgentFinderOperation({ method, path });
  assert.equal(matches('POST', '/api/finder-tasks/batch'), true);
  assert.equal(matches('GET', '/api/finder-tasks'), false);
  assert.equal(matches('POST', '/api/raw-candidates/1/approve'), false);
});

test('logout clears the personal session cookie', async () => {
  const store = makeStore();
  store.users.push({ id: 1, username: 'admin', display_name: 'Admin', password_hash: await hashPassword('admin-pass'), role: 'admin', status: 'active', token_version: 1 });
  const app = buildApp(store);
  const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'admin-pass' });
  const logout = await request(app).post('/api/auth/logout').set('Cookie', cookie(login)).expect(200);
  assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
});
