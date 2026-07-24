const crypto = require('crypto');

// Minimal shared-password access control for the LAN/team deployment.
// Password lives in APP_ACCESS_PASSWORD (.env). When it is not set, the
// middleware passes everything through so local development is unaffected.
//
// The session token is an HMAC-SHA256 signed expiry timestamp stored in an
// HttpOnly cookie. No external dependencies are required.

const COOKIE_NAME = 'kol_auth';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getPassword() {
  return String(process.env.APP_ACCESS_PASSWORD || '').trim();
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function issueToken(secret) {
  const expires = Date.now() + TOKEN_TTL_MS;
  const payload = `v1.${expires}`;
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  return timingSafeEqual(parts[2], sign(payload, secret));
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key) return;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch (error) {
      cookies[key] = value;
    }
  });
  return cookies;
}

function setAuthCookie(res, token) {
  const maxAge = Math.floor(TOKEN_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
  );
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function isAuthenticated(req) {
  const secret = getPassword();
  if (!secret) return true; // access control disabled
  return verifyToken(parseCookies(req)[COOKIE_NAME], secret);
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ success: false, error: 'Authentication required' });
}

// Guard mounted at the app root. Protects /api/* and /uploads/* while leaving
// public endpoints (login, health check) and the External Agent API (which has
// its own Bearer token check) untouched. Static frontend files stay public so
// the login page can load.
function authGuard(req, res, next) {
  const p = req.path;
  if (p === '/api/health' || p.startsWith('/api/agent') || p.startsWith('/api/auth')) {
    return next();
  }
  if (p.startsWith('/api/') || p.startsWith('/uploads')) {
    return requireAuth(req, res, next);
  }
  return next();
}

function createAuthRouter() {
  const express = require('express');
  const router = express.Router();

  router.post('/login', (req, res) => {
    const secret = getPassword();
    if (!secret) {
      return res.json({ success: true, authRequired: false });
    }
    const provided = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!provided || !timingSafeEqual(provided, secret)) {
      return res.status(401).json({ success: false, error: '访问口令错误' });
    }
    setAuthCookie(res, issueToken(secret));
    return res.json({ success: true });
  });

  router.get('/me', (req, res) => {
    res.json({
      authenticated: isAuthenticated(req),
      authRequired: Boolean(getPassword())
    });
  });

  router.post('/logout', (req, res) => {
    clearAuthCookie(res);
    res.json({ success: true });
  });

  return router;
}

module.exports = {
  COOKIE_NAME,
  createAuthRouter,
  authGuard,
  requireAuth,
  isAuthenticated
};
