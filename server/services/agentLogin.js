const crypto = require('crypto');
const { createStore } = require('./agentLoginStore');
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const challengeFor = (value) => crypto.createHash('sha256').update(value).digest('base64url');
const ACCESS_MS = 15 * 60 * 1000;
const DEVICE_MS = 10 * 60 * 1000;
const REFRESH_MS = 90 * 24 * 60 * 60 * 1000;
const INTERVAL_MS = 5000;
function fail(code, status = 400) { throw Object.assign(new Error(code), { code, statusCode: status }); }
function normalizeCode(code) { return String(code || '').toUpperCase().replace(/-/g, ''); }
function createAgentLogin({ store = createStore(), now = () => Date.now() } = {}) {
  function validGrant(row, kind) {
    return row && !row.revoked_at && row.user_status === 'active'
      && Number(row.token_version) === Number(row.user_token_version)
      && new Date(row[`${kind}_expires_at`]).getTime() > now()
      && new Date(row.refresh_expires_at).getTime() > now();
  }
  return {
    async start({ challenge, label }) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(String(challenge || ''))) fail('invalid_challenge');
      const deviceCode = crypto.randomBytes(32).toString('base64url');
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const rawCode = Array.from(crypto.randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
      const userCode = rawCode.slice(0, 4) + '-' + rawCode.slice(4);
      if (store.pruneDevices) await store.pruneDevices(new Date(now() - 24 * 60 * 60 * 1000));
      await store.insertDevice({ device_hash: hash(deviceCode), user_code_hash: hash(rawCode), challenge,
        label: String(label || 'KOL Campaign OS Skill').trim().slice(0, 100) || 'KOL Campaign OS Skill',
        status: 'pending', expires_at: new Date(now() + DEVICE_MS), created_at: new Date(now()) });
      return { device_code: deviceCode, user_code: userCode, expires_in: DEVICE_MS / 1000, interval: INTERVAL_MS / 1000 };
    },
    async details(code) {
      const row = await store.findDeviceByCode(hash(normalizeCode(code)));
      if (!row || new Date(row.expires_at).getTime() <= now()) fail('expired_device', 404);
      return { label: row.label, status: row.status, expires_at: row.expires_at };
    },
    async decide(code, user, approve) {
      if (user.status !== 'active') fail('inactive_user', 403);
      const changed = await store.decideDevice(hash(normalizeCode(code)), user.id, approve ? 'approved' : 'denied', new Date(now()));
      if (!changed) fail('device_not_pending', 409);
    },
    async poll({ device_code: deviceCode, verifier }) {
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(String(verifier || '')) || !/^[A-Za-z0-9_-]{43}$/.test(String(deviceCode || ''))) fail('invalid_device', 401);
      return store.transaction(async (tx) => {
        const row = await tx.findDevice(hash(deviceCode));
        if (!row || row.challenge !== challengeFor(verifier)) fail('invalid_device', 401);
        if (new Date(row.expires_at).getTime() <= now()) fail('expired_device');
        if (row.status === 'denied') fail('access_denied', 403);
        if (row.status === 'consumed') fail('device_already_used', 409);
        if (row.last_poll_at && now() - new Date(row.last_poll_at).getTime() < INTERVAL_MS) return { error: 'slow_down' };
        await tx.pollDevice(row.id, new Date(now()));
        if (row.status === 'pending') return { error: 'authorization_pending' };
        const user = await tx.findUser(row.owner_user_id);
        if (!user || user.status !== 'active') fail('inactive_user', 403);
        const access = 'kol_access_' + crypto.randomBytes(32).toString('base64url');
        const refresh = 'kol_refresh_' + crypto.randomBytes(32).toString('base64url');
        const expiry = new Date(now() + ACCESS_MS);
        await tx.insertGrant({ owner_user_id: user.id, token_version: user.token_version, label: row.label,
          access_hash: hash(access), refresh_hash: hash(refresh), access_expires_at: expiry,
          refresh_expires_at: new Date(now() + REFRESH_MS), created_at: new Date(now()) });
        await tx.consumeDevice(row.id);
        return { access_token: access, refresh_token: refresh, expires_at: expiry.toISOString() };
      });
    },
    async refresh(refresh) {
      if (!/^kol_refresh_[A-Za-z0-9_-]{43}$/.test(String(refresh || ''))) fail('login_required', 401);
      return store.transaction(async (tx) => {
        const row = await tx.findGrant('refresh', hash(refresh));
        if (!validGrant(row, 'refresh')) fail('login_required', 401);
        const access = 'kol_access_' + crypto.randomBytes(32).toString('base64url');
        const expiry = new Date(now() + ACCESS_MS);
        await tx.renewGrant(row.id, hash(access), expiry);
        return { access_token: access, expires_at: expiry.toISOString() };
      });
    },
    async authenticate(access) {
      if (!/^kol_access_[A-Za-z0-9_-]{43}$/.test(String(access || ''))) return null;
      const row = await store.findGrant('access', hash(access));
      return validGrant(row, 'access') ? { id: row.owner_user_id, role: 'member', auth_type: 'agent_login', grant_id: row.id } : null;
    },
    list: (user) => store.listGrants(user.id),
    async revoke(id, user) {
      if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) fail('invalid_connection');
      if (!await store.revokeGrant(Number(id), user.id, new Date(now()))) fail('connection_not_found', 404);
    }
  };
}
module.exports = { createAgentLogin, hash, challengeFor };
