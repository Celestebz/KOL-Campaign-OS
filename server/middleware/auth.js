const crypto = require('crypto');
const { promisify } = require('util');
const { requireAgentToken } = require('./agentAuth');
const { dbOperations, sequelize } = require('../database');

const scrypt = promisify(crypto.scrypt);
const COOKIE_NAME = 'kol_user_session';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const loginFailures = new Map();

function sessionSecret() {
  // APP_ACCESS_PASSWORD is accepted only as a signing-secret fallback so
  // existing deployments can upgrade without prompting for the old team password.
  const value = String(process.env.SESSION_SECRET || process.env.APP_ACCESS_PASSWORD || '').trim();
  if (value) return value;
  if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET must be set in production');
  return 'kol-campaign-os-development-session-secret';
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt}$${derived.toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  const [algorithm, n, r, p, salt, expected] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const derived = await scrypt(String(password), salt, expected.length / 2, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(derived.toString('hex'), expected);
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validateAccount(username, displayName, password) {
  if (!/^[a-z0-9_]{3,50}$/.test(username)) return '用户名须为3-50位字母、数字或下划线';
  if (!String(displayName || '').trim() || String(displayName).trim().length > 100) return '请输入不超过100个字符的昵称';
  if (String(password || '').length < 8 || String(password || '').length > 128) return '密码须为8-128个字符';
  return null;
}

function parseCookies(req) {
  const cookies = {};
  String(req.headers.cookie || '').split(';').forEach((pair) => {
    const index = pair.indexOf('=');
    if (index < 0) return;
    try { cookies[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim()); } catch (_) {}
  });
  return cookies;
}

function issueToken(user) {
  const expires = Date.now() + TOKEN_TTL_MS;
  const payload = `v2.${user.id}.${user.token_version}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

function parseToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 5 || parts[0] !== 'v2') return null;
  const payload = parts.slice(0, 4).join('.');
  const parsed = { userId: Number(parts[1]), tokenVersion: Number(parts[2]), expires: Number(parts[3]) };
  if (!Number.isInteger(parsed.userId) || !Number.isInteger(parsed.tokenVersion) || parsed.expires <= Date.now()) return null;
  return timingSafeEqual(parts[4], sign(payload)) ? parsed : null;
}

function isSecureRequest(req) {
  const override = String(process.env.COOKIE_SECURE || '').trim().toLowerCase();
  if (override === 'true') return true;
  if (override === 'false') return false;
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return Boolean(req?.secure) || forwardedProto === 'https';
}

function cookieHeader(token, clear = false, req = null) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${COOKIE_NAME}=${clear ? '' : encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : Math.floor(TOKEN_TTL_MS / 1000)}${secure}`;
}

const defaultStore = {
  countUsers: async () => Number((await dbOperations.get('SELECT COUNT(*) AS count FROM users'))?.count || 0),
  findUserById: (id) => dbOperations.get('SELECT id, username, display_name, role, status, token_version, last_login_at, created_at FROM users WHERE id = ?', [id]),
  findUserForLogin: (username) => dbOperations.get('SELECT * FROM users WHERE username = ?', [username]),
  createBootstrap: async ({ username, displayName, passwordHash }) => sequelize.transaction(async (transaction) => {
    const [state] = await sequelize.query('SELECT initialized FROM app_bootstrap_state WHERE id = 1 FOR UPDATE', { transaction });
    if (!state[0] || state[0].initialized) return null;
    const [result] = await sequelize.query(
      `INSERT INTO users (username, display_name, password_hash, role, status, token_version, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', 'active', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      { replacements: [username, displayName, passwordHash], transaction }
    );
    await sequelize.query('UPDATE app_bootstrap_state SET initialized = 1, updated_at = CURRENT_TIMESTAMP WHERE id = 1', { transaction });
    return { id: Number(result), username, display_name: displayName, role: 'admin', status: 'active', token_version: 1 };
  }),
  createFromInvite: async ({ username, displayName, passwordHash, code }) => sequelize.transaction(async (transaction) => {
    const [invites] = await sequelize.query(
      `SELECT * FROM invite_codes WHERE code = ? AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) AND used_count < max_uses FOR UPDATE`,
      { replacements: [code], transaction }
    );
    if (!invites[0]) return null;
    const [result] = await sequelize.query(
      `INSERT INTO users (username, display_name, password_hash, role, status, token_version, created_at, updated_at)
       VALUES (?, ?, ?, 'member', 'active', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      { replacements: [username, displayName, passwordHash], transaction }
    );
    await sequelize.query('UPDATE invite_codes SET used_count = used_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', { replacements: [invites[0].id], transaction });
    return { id: Number(result), username, display_name: displayName, role: 'member', status: 'active', token_version: 1 };
  }),
  touchLogin: (id) => dbOperations.run('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [id]),
  listUsers: () => dbOperations.query('SELECT id, username, display_name, role, status, token_version, last_login_at, created_at FROM users ORDER BY id'),
  listInvites: () => dbOperations.query('SELECT id, code, note, max_uses, used_count, expires_at, revoked_at, created_by, created_at FROM invite_codes ORDER BY id DESC'),
  createInvite: async ({ code, note, maxUses, expiresAt, createdBy }) => {
    const result = await dbOperations.run('INSERT INTO invite_codes (code, note, max_uses, expires_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)', [code, note || null, maxUses, expiresAt || null, createdBy]);
    return { id: result.id, code };
  },
  revokeInvite: (id) => dbOperations.run('UPDATE invite_codes SET revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]),
  updateUserStatus: (id, status) => dbOperations.run('UPDATE users SET status = ?, token_version = token_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, id])
};

async function loadSession(req, store = defaultStore) {
  const parsed = parseToken(parseCookies(req)[COOKIE_NAME]);
  if (!parsed) return null;
  const user = await store.findUserById(parsed.userId);
  if (!user || user.status !== 'active' || Number(user.token_version) !== parsed.tokenVersion) return null;
  return user;
}

function requireAuthWithStore(store = defaultStore) {
  return async (req, res, next) => {
    try {
      const user = await loadSession(req, store);
      if (!user) return res.status(401).json({ success: false, error: '请登录后继续' });
      req.user = user;
      return next();
    } catch (error) { return next(error); }
  };
}

const requireAuth = requireAuthWithStore();

function isAgentFinderOperation(req) {
  const method = req.method.toUpperCase();
  const p = req.path;
  if (method === 'GET' && p === '/api/settings/health/config') return true;
  if (method === 'POST' && p === '/api/finder-tasks') return true;
  if (method === 'POST' && p === '/api/finder-tasks/batch') return true;
  return method === 'POST' && /^\/api\/finder-tasks\/[^/]+\/(video-evidence\/import|evidence-analysis|generate-candidates-from-evidence)$/.test(p);
}

function createAuthGuard(store = defaultStore) {
  return function authGuardForStore(req, res, next) {
  const p = req.path;
  if (p === '/api/health' || p.startsWith('/api/agent') || p.startsWith('/api/auth')) return next();
  if (isAgentFinderOperation(req)) {
    return loadSession(req, store).then((user) => {
      if (user) { req.user = user; return next(); }
      return requireAgentToken(req, res, next);
    }).catch(next);
  }
  if (p.startsWith('/api/') || p.startsWith('/uploads')) return requireAuthWithStore(store)(req, res, next);
  return next();
  };
}

const authGuard = createAuthGuard();

function createAuthRouter(store = defaultStore) {
  const express = require('express');
  const router = express.Router();
  const sessionRequired = requireAuthWithStore(store);
  const requireAdmin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ success: false, error: '仅管理员可访问' });

  router.get('/me', async (req, res, next) => {
    try {
      const user = await loadSession(req, store);
      res.json({ authenticated: Boolean(user), authRequired: true, needsBootstrap: (await store.countUsers()) === 0, user: user || null });
    } catch (error) { next(error); }
  });

  router.post('/bootstrap', async (req, res, next) => {
    try {
      const username = normalizeUsername(req.body?.username);
      const displayName = String(req.body?.displayName || '').trim();
      const error = validateAccount(username, displayName, req.body?.password);
      if (error) return res.status(400).json({ success: false, error });
      const user = await store.createBootstrap({ username, displayName, passwordHash: await hashPassword(req.body.password) });
      if (!user) return res.status(409).json({ success: false, error: '管理员已初始化，请直接登录' });
      res.setHeader('Set-Cookie', cookieHeader(issueToken(user), false, req));
      return res.status(201).json({ success: true, user });
    } catch (error) { return handleAccountError(error, res, next); }
  });

  router.post('/register', async (req, res, next) => {
    try {
      const username = normalizeUsername(req.body?.username);
      const displayName = String(req.body?.displayName || '').trim();
      const code = String(req.body?.inviteCode || '').trim().toLowerCase();
      const error = validateAccount(username, displayName, req.body?.password);
      if (error) return res.status(400).json({ success: false, error });
      if (!code) return res.status(400).json({ success: false, error: '请输入邀请码' });
      const user = await store.createFromInvite({ username, displayName, passwordHash: await hashPassword(req.body.password), code });
      if (!user) return res.status(400).json({ success: false, error: '邀请码无效、已过期或使用次数已满' });
      res.setHeader('Set-Cookie', cookieHeader(issueToken(user), false, req));
      return res.status(201).json({ success: true, user });
    } catch (error) { return handleAccountError(error, res, next); }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const username = normalizeUsername(req.body?.username);
      const key = `${req.ip || 'unknown'}:${username}`;
      const record = loginFailures.get(key);
      if (record && record.lockedUntil > Date.now()) return res.status(429).json({ success: false, error: '登录失败次数过多，请15分钟后再试' });
      const user = username ? await store.findUserForLogin(username) : null;
      const valid = user && user.status === 'active' && await verifyPassword(req.body?.password, user.password_hash);
      if (!valid) {
        const fresh = !record || Date.now() - record.startedAt >= LOGIN_WINDOW_MS;
        const failures = fresh ? 1 : record.failures + 1;
        loginFailures.set(key, { failures, startedAt: fresh ? Date.now() : record.startedAt, lockedUntil: failures >= LOGIN_MAX_FAILURES ? Date.now() + LOGIN_WINDOW_MS : 0 });
        return res.status(401).json({ success: false, error: '用户名或密码错误' });
      }
      loginFailures.delete(key);
      await store.touchLogin(user.id);
      res.setHeader('Set-Cookie', cookieHeader(issueToken(user), false, req));
      return res.json({ success: true, user: publicUser(user) });
    } catch (error) { next(error); }
  });

  router.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', cookieHeader('', true, req));
    res.json({ success: true });
  });

  router.get('/admin/users', sessionRequired, requireAdmin, async (req, res, next) => {
    try { res.json({ success: true, data: await store.listUsers() }); } catch (error) { next(error); }
  });
  router.patch('/admin/users/:id/status', sessionRequired, requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const status = req.body?.status;
      if (!['active', 'disabled'].includes(status)) return res.status(400).json({ success: false, error: '无效状态' });
      if (id === Number(req.user.id) && status === 'disabled') return res.status(400).json({ success: false, error: '不能停用当前账号' });
      await store.updateUserStatus(id, status);
      return res.json({ success: true });
    } catch (error) { return next(error); }
  });
  router.get('/admin/invites', sessionRequired, requireAdmin, async (req, res, next) => {
    try { res.json({ success: true, data: await store.listInvites() }); } catch (error) { next(error); }
  });
  router.post('/admin/invites', sessionRequired, requireAdmin, async (req, res, next) => {
    try {
      const maxUses = Math.max(1, Math.min(100, Number(req.body?.maxUses) || 1));
      const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
      if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) return res.status(400).json({ success: false, error: '有效期必须晚于当前时间' });
      const invite = await store.createInvite({ code: crypto.randomBytes(16).toString('hex'), note: String(req.body?.note || '').trim(), maxUses, expiresAt, createdBy: req.user.id });
      return res.status(201).json({ success: true, data: invite });
    } catch (error) { return next(error); }
  });
  router.post('/admin/invites/:id/revoke', sessionRequired, requireAdmin, async (req, res, next) => {
    try { await store.revokeInvite(Number(req.params.id)); return res.json({ success: true }); } catch (error) { return next(error); }
  });
  return router;
}

function publicUser(user) {
  return { id: user.id, username: user.username, display_name: user.display_name, role: user.role, status: user.status };
}

function handleAccountError(error, res, next) {
  if (error?.name === 'SequelizeUniqueConstraintError' || error?.original?.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, error: '用户名已存在' });
  return next(error);
}

module.exports = { COOKIE_NAME, createAuthRouter, createAuthGuard, authGuard, requireAuth, isAgentFinderOperation, hashPassword, verifyPassword, issueToken, parseToken, loadSession };
