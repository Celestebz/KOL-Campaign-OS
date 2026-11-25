const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCredentialStore, createClient, windowsProtect } = require('../../skills/kol-campaign-os-agent/scripts/os-client.cjs');

test('Windows authorization cache uses user-bound DPAPI and can be refreshed without exposing plaintext', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows DPAPI only');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kol-login-dpapi-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = createCredentialStore({ baseUrl: 'http://os.test', home });
  const data = { access_token: 'test-access-value', refresh_token: 'test-refresh-value', expires_at: new Date().toISOString() };
  store.write(data);
  const directory = path.join(home, '.kol-campaign-os', 'auth');
  const content = fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8');
  assert.equal(content.includes(data.access_token), false);
  assert.equal(content.includes(data.refresh_token), false);
  assert.deepEqual(store.read(), { ...data, base_url: 'http://os.test' });
  store.write({ ...data, access_token: 'renewed-test-access' });
  assert.equal(store.read().access_token, 'renewed-test-access');
  store.clear(); assert.equal(store.read(), null);
  assert.equal(windowsProtect(windowsProtect('DPAPI round-trip'), true), 'DPAPI round-trip');
});

test('cache is separated per OS origin and Unix files have private permissions', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kol-login-origin-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = createCredentialStore({ baseUrl: 'https://one.test', home, platform: 'linux' });
  store.write({ access_token: 'test-value' });
  assert.equal(createCredentialStore({ baseUrl: 'https://two.test', home, platform: 'linux' }).read(), null);
  if (process.platform !== 'win32') {
    const directory = path.join(home, '.kol-campaign-os', 'auth');
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, fs.readdirSync(directory)[0])).mode & 0o777, 0o600);
  }
});

test('refresh network failure preserves authorization and logout is retryable', async () => {
  const expired = { access_token: 'test-value', refresh_token: 'test-refresh', expires_at: new Date(0).toISOString() };
  let saved = expired;
  const client = createClient({ baseUrl: 'https://os.test', store: { read: () => saved, write: (v) => { saved = v; }, clear: () => { saved = null; } },
    fetchImpl: async () => { throw new Error('network-unavailable'); }, notify: () => {} });
  await assert.rejects(client.request('GET', '/api/customers'));
  assert.equal(saved, expired);
  await assert.rejects(client.logout());
  assert.equal(saved, expired);
});

test('expired authorization is removed only after authoritative rejection', async () => {
  let saved = { refresh_token: 'test-refresh', expires_at: new Date(0).toISOString() };
  const client = createClient({ baseUrl: 'https://os.test', store: { read: () => saved, clear: () => { saved = null; } },
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'login_required' }) }), notify: () => {} });
  await assert.rejects(client.status());
  assert.equal(saved, null);
});
