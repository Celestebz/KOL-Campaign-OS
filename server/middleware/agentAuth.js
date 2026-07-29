const crypto = require('crypto');
const { dbOperations } = require('../database');

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

async function requireAgentToken(req, res, next) {
  try {
    const row = await dbOperations.get(
      'SELECT api_key FROM api_settings WHERE provider = ?',
      [AGENT_API_PROVIDER_KEY]
    );
    const expected = clean(row?.api_key);
    if (!expected) {
      return res.status(403).json({ success: false, error: 'External Agent API Token is not configured' });
    }
    if (!secureEqual(bearerToken(req), expected)) {
      return res.status(401).json({ success: false, error: 'Invalid External Agent API Token' });
    }
    return next();
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

module.exports = { AGENT_API_PROVIDER_KEY, requireAgentToken };
