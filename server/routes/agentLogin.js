const express = require('express');
const { createAgentLogin } = require('../services/agentLogin');

function createRouter({ requireSession, service = createAgentLogin(), now = () => Date.now() }) {
  const router = express.Router();
  const windows = new Map();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['/device', '/token', '/refresh'].includes(req.path)) return next();
    const key = `${req.ip}:${req.path}`;
    const cutoff = now() - 60000;
    for (const [id, entry] of windows) if (entry.start < cutoff) windows.delete(id);
    const entry = windows.get(key) || { start: now(), count: 0 };
    const limit = req.path === '/device' ? 5 : 60;
    if (entry.count >= limit || (!windows.has(key) && windows.size >= 10000)) {
      res.set('Retry-After', '60');
      return res.status(429).json({ error: 'too_many_requests' });
    }
    entry.count += 1;
    windows.set(key, entry);
    return next();
  });
  const handle = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (error) { res.status(error.statusCode || 500).json({ error: error.code || 'agent_login_failed' }); }
  };
  const sameOrigin = (req, res, next) => {
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    if (req.headers.origin !== `${protocol}://${req.get('host')}`) return res.status(403).json({ error: 'origin_not_allowed' });
    return next();
  };
  router.post('/device', handle(async (req, res) => {
    const device = await service.start(req.body || {});
    res.json({ ...device, verification_path: '/agent/connect?code=' + encodeURIComponent(device.user_code) });
  }));
  router.post('/token', handle(async (req, res) => {
    const result = await service.poll(req.body || {});
    res.status(result.error ? 400 : 200).json(result);
  }));
  router.post('/refresh', handle(async (req, res) => res.json(await service.refresh(req.body?.refresh_token))));
  router.get('/device/:code', requireSession, handle(async (req, res) => res.json(await service.details(req.params.code))));
  router.post('/device/:code/decision', requireSession, sameOrigin, handle(async (req, res) => {
    if (typeof req.body?.approve !== 'boolean') return res.status(400).json({ error: 'invalid_decision' });
    await service.decide(req.params.code, req.user, req.body.approve);
    return res.json({ success: true });
  }));
  router.get('/connections', requireSession, handle(async (req, res) => res.json({ data: await service.list(req.user) })));
  router.delete('/connections/:id', requireSession, sameOrigin, handle(async (req, res) => {
    await service.revoke(req.params.id, req.user);
    res.json({ success: true });
  }));
  // Agent can discard only its own browser-authorized connection.
  router.post('/logout', handle(async (req, res) => {
    const user = await service.authenticate(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!user) return res.status(401).json({ error: 'login_required' });
    await service.revoke(user.grant_id, user);
    return res.json({ success: true });
  }));
  return router;
}
module.exports = { createRouter };
