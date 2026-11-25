const crypto = require('crypto');
const { dbOperations } = require('../database');
const requestContext = require('../utils/requestContext');
const agentLogin = require('../services/agentLogin').createAgentLogin();

const AGENT_API_PROVIDER_KEY = 'agent.external_api';

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function bearerToken(req) {
  const auth = clean(req.headers.authorization);
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

function secureEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function createAgentAuth({ login = agentLogin, database = dbOperations } = {}) {
return async function requireAgentToken(req, res, next) {
  try {
    const supplied = bearerToken(req);
    if (supplied.startsWith('kol_access_')) {
      const user = await login.authenticate(supplied);
      if (!user) return res.status(401).json({ success: false, error: 'Skill 登录已过期或已撤销，请重新登录' });
      req.user = user;
      return requestContext.runWithUser(user, next);
    }
    const rows = await database.query(
      'SELECT api_key, owner_user_id FROM api_settings WHERE provider = ?',
      [AGENT_API_PROVIDER_KEY]
    );
    const row = rows.find((candidate) => clean(candidate.api_key) && secureEqual(supplied, clean(candidate.api_key)));
    if (!rows.some((candidate) => clean(candidate.api_key))) {
      return res.status(403).json({ success: false, error: 'External Agent API Token is not configured' });
    }
    if (!row) {
      return res.status(401).json({ success: false, error: 'Invalid External Agent API Token' });
    }
    req.user = { id: row.owner_user_id, role: 'member', auth_type: 'agent_token' };
    return requestContext.runWithUser(req.user, next);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
}

module.exports = { AGENT_API_PROVIDER_KEY, requireAgentToken: createAgentAuth(), createAgentAuth };
