const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentLogin, challengeFor, hash } = require('./agentLogin');

function fixture() {
  const devices = [], grants = [];
  let time = Date.now();
  const users = [{ id: 7, status: 'active', token_version: 2 }, { id: 8, status: 'active', token_version: 1 }];
  let queue = Promise.resolve();
  const store = {
    async insertDevice(row) { devices.push({ ...row, id: devices.length + 1 }); },
    async findDevice(value) { return devices.find((d) => d.device_hash === value) || null; },
    async findDeviceByCode(value) { return devices.find((d) => d.user_code_hash === value) || null; },
    async findUser(id) { return users.find((u) => u.id === id); },
    async decideDevice(value, owner, status, date) {
      const row = devices.find((d) => d.user_code_hash === value && d.status === 'pending' && d.expires_at > date);
      if (!row) return 0;
      Object.assign(row, { owner_user_id: owner, status }); return 1;
    },
    async pollDevice(id, date) { devices.find((d) => d.id === id).last_poll_at = date; },
    async consumeDevice(id) { devices.find((d) => d.id === id).status = 'consumed'; },
    async insertGrant(row) { grants.push({ ...row, id: grants.length + 1 }); },
    async findGrant(kind, value) {
      const row = grants.find((g) => g[`${kind}_hash`] === value);
      const user = row && users.find((u) => u.id === row.owner_user_id);
      return row && user ? { ...row, user_status: user.status, user_token_version: user.token_version } : null;
    },
    async renewGrant(id, value, expiry) { Object.assign(grants.find((g) => g.id === id), { access_hash: value, access_expires_at: expiry }); },
    async listGrants(owner) { return grants.filter((g) => g.owner_user_id === owner && !g.revoked_at).map(({ id, label }) => ({ id, label })); },
    async revokeGrant(id, owner, date) {
      const row = grants.find((g) => g.id === id && g.owner_user_id === owner && !g.revoked_at);
      if (!row) return 0;
      row.revoked_at = date; return 1;
    },
    transaction(fn) {
      const value = queue.then(() => fn(store));
      queue = value.catch(() => {});
      return value;
    }
  };
  const service = createAgentLogin({ store, now: () => time });
  const verifier = 'v'.repeat(43);
  const start = () => service.start({ challenge: challengeFor(verifier), label: 'Test computer' });
  const login = async () => {
    const device = await start();
    await service.decide(device.user_code, users[0], true);
    return service.poll({ device_code: device.device_code, verifier });
  };
  return { service, store, devices, grants, users, verifier, start, login, advance: (ms) => { time += ms; } };
}

test('browser approval binds account and proof; stores only hashes; exchange is one-time', async () => {
  const f = fixture();
  const device = await f.start();
  const serialized = JSON.stringify(f.devices);
  assert.equal(serialized.includes(device.device_code), false);
  assert.equal(serialized.includes(device.user_code), false);
  assert.deepEqual(await f.service.details(device.user_code), { label: 'Test computer', status: 'pending', expires_at: f.devices[0].expires_at });
  await assert.rejects(f.service.poll({ device_code: device.device_code, verifier: 'x'.repeat(43) }), { code: 'invalid_device' });
  assert.deepEqual(await f.service.poll({ device_code: device.device_code, verifier: f.verifier }), { error: 'authorization_pending' });
  assert.deepEqual(await f.service.poll({ device_code: device.device_code, verifier: f.verifier }), { error: 'slow_down' });
  await f.service.decide(device.user_code, f.users[0], true);
  await assert.rejects(f.service.decide(device.user_code, f.users[1], true), { code: 'device_not_pending' });
  f.advance(5000);
  const results = await Promise.allSettled([1, 2].map(() => f.service.poll({ device_code: device.device_code, verifier: f.verifier })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const token = results.find((r) => r.status === 'fulfilled').value;
  const user = await f.service.authenticate(token.access_token);
  assert.equal(user.id, 7);
  assert.equal(user.auth_type, 'agent_login');
  assert.equal(f.grants[0].access_hash, hash(token.access_token));
  assert.equal(JSON.stringify(f.grants).includes(token.refresh_token), false);
  assert.equal(JSON.stringify(await f.service.list(f.users[0])).includes('hash'), false);
});

test('expiry, renewal, revocation, disabled users and version changes invalidate access', async () => {
  const f = fixture();
  const token = await f.login();
  f.advance(16 * 60000);
  assert.equal(await f.service.authenticate(token.access_token), null);
  const renewed = await f.service.refresh(token.refresh_token);
  assert.equal((await f.service.authenticate(renewed.access_token)).id, 7);
  assert.equal(await f.service.authenticate(token.access_token), null);
  await assert.rejects(f.service.revoke(f.grants[0].id, f.users[1]), { code: 'connection_not_found' });
  assert.deepEqual(await f.service.list(f.users[1]), []);
  f.users[0].status = 'disabled';
  assert.equal(await f.service.authenticate(renewed.access_token), null);
  await assert.rejects(f.service.refresh(token.refresh_token), { code: 'login_required' });
  f.users[0].status = 'active';
  f.users[0].token_version += 1;
  assert.equal(await f.service.authenticate(renewed.access_token), null);
  await assert.rejects(f.service.refresh(token.refresh_token), { code: 'login_required' });
  f.users[0].token_version -= 1;
  await f.service.revoke(f.grants[0].id, f.users[0]);
  assert.equal(await f.service.authenticate(renewed.access_token), null);
  await assert.rejects(f.service.refresh(token.refresh_token), { code: 'login_required' });
});

test('expired, denied, invalid and disabled-owner device requests cannot grant access', async () => {
  const f = fixture();
  await assert.rejects(f.service.start({ challenge: 'bad' }), { code: 'invalid_challenge' });
  const expired = await f.start();
  f.advance(11 * 60000);
  await assert.rejects(f.service.details(expired.user_code), { code: 'expired_device' });
  await assert.rejects(f.service.decide(expired.user_code, f.users[0], true), { code: 'device_not_pending' });
  await assert.rejects(f.service.poll({ device_code: expired.device_code, verifier: f.verifier }), { code: 'expired_device' });
  const denied = await f.start();
  await f.service.decide(denied.user_code, f.users[0], false);
  await assert.rejects(f.service.poll({ device_code: denied.device_code, verifier: f.verifier }), { code: 'access_denied' });
  const inactive = await f.start();
  await f.service.decide(inactive.user_code, f.users[0], true);
  f.users[0].status = 'disabled';
  await assert.rejects(f.service.poll({ device_code: inactive.device_code, verifier: f.verifier }), { code: 'inactive_user' });
  await assert.rejects(f.service.decide(inactive.user_code, f.users[0], true), { code: 'inactive_user' });
  assert.equal(f.grants.length, 0);
});

test('long-term authorization expires rather than silently extending indefinitely', async () => {
  const f = fixture(); const token = await f.login();
  f.advance(91 * 24 * 3600000);
  await assert.rejects(f.service.refresh(token.refresh_token), { code: 'login_required' });
});

test('installed client completes browser approval, reads API, renews, and loses access after revocation', async (t) => {
  const express = require('express');
  const { createRouter } = require('../routes/agentLogin');
  const { createAgentAuth } = require('../middleware/agentAuth');
  const { currentUserId } = require('../utils/requestContext');
  const { createClient } = require('../../skills/kol-campaign-os-agent/scripts/os-client.cjs');
  const f = fixture();
  const app = express(); app.use(express.json());
  const session = (req, res, next) => {
    if (req.headers.cookie !== 'test-browser-session') return res.sendStatus(401);
    req.user = f.users[0]; return next();
  };
  app.use('/api/auth/agent', createRouter({ service: f.service, requireSession: session }));
  app.get('/api/emails/threads', createAgentAuth({ login: f.service, database: { query: async () => assert.fail('Browser login must not require a manual Agent Token') } }), (req, res) => res.json({ user_id: currentUserId(), threads: [] }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  let saved, approval, opened;
  const output = [];
  const client = createClient({ baseUrl,
    store: { read: () => saved, write: (value) => { saved = value; }, clear: () => { saved = null; } },
    browser: (url) => {
      opened = url;
      const code = new URL(url).searchParams.get('code');
      approval = fetch(baseUrl + '/api/auth/agent/device/' + code + '/decision', {
        method: 'POST', headers: { Cookie: 'test-browser-session', Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ approve: true })
      }).then((res) => assert.equal(res.status, 200));
    },
    sleep: async (ms) => { await approval; f.advance(ms); },
    now: () => new Date(f.devices[0]?.created_at || Date.now()).getTime(),
    notify: (value) => output.push(value)
  });
  await client.login();
  assert.equal(new URL(opened).pathname, '/agent/connect');
  assert.equal(output.some((value) => value.includes(saved.access_token) || value.includes(saved.refresh_token)), false);
  assert.equal((await client.request('GET', '/api/emails/threads')).user_id, 7);
  const oldAccess = saved.access_token;
  f.advance(16 * 60000);
  assert.equal((await client.request('GET', '/api/emails/threads')).user_id, 7);
  assert.notEqual(saved.access_token, oldAccess);
  await assert.rejects(client.request('GET', 'http://evil.test/api/emails/threads'));
  await assert.rejects(client.request('GET', '/api/auth/agent/token'));
  await f.service.revoke(f.grants[0].id, f.users[0]);
  await assert.rejects(client.request('GET', '/api/emails/threads'));
  assert.equal(saved, null);
  assert.equal(opened.includes('access_token'), false);
  await client.login();
  const lastAccess = saved.access_token;
  await client.logout();
  assert.equal(saved, null);
  assert.equal(await f.service.authenticate(lastAccess), null);
});
