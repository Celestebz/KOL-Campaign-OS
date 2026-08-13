// Internal helper: read APP_ACCESS_PASSWORD from .env, login to workbench,
// list campaigns and strategies, print only non-secret results, then exit.
// Password never leaves this process memory; not persisted anywhere.

const path = require('path');
const fs = require('fs');
const http = require('http');

const ENV_PATH = path.resolve(__dirname, '..', '.env');
const BASE_URL = 'http://localhost:5001';
const PASSWORD_KEY = 'APP_ACCESS_PASSWORD';

function loadEnvValue(filePath, key) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === key) {
      let v = trimmed.slice(eq + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      return v;
    }
  }
  return '';
}

function request(method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE_URL + urlPath);
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    if (body) {
      const data = Buffer.from(JSON.stringify(body));
      opts.headers['Content-Length'] = data.length;
    }
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const setCookie = res.headers['set-cookie'] || [];
        const cookies = setCookie.map((c) => c.split(';')[0]).join('; ');
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (_) { /* keep raw */ }
        resolve({ status: res.statusCode, headers: res.headers, cookies, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const password = loadEnvValue(ENV_PATH, PASSWORD_KEY);
  if (!password) {
    console.error(JSON.stringify({ ok: false, step: 'env', error: 'APP_ACCESS_PASSWORD not set in .env' }));
    process.exit(2);
  }

  // 1. Login
  const login = await request('POST', '/api/auth/login', { body: { password } });
  if (login.status !== 200) {
    console.error(JSON.stringify({ ok: false, step: 'login', status: login.status, body: login.body }));
    process.exit(3);
  }
  const sessionCookie = login.cookies;
  const authedHeaders = { Cookie: sessionCookie };

  // 2. List campaigns
  const camps = await request('GET', '/api/campaigns', { headers: authedHeaders });
  if (camps.status !== 200) {
    console.error(JSON.stringify({ ok: false, step: 'campaigns', status: camps.status, body: camps.body }));
    process.exit(4);
  }
  const campaignRows = Array.isArray(camps.body?.data) ? camps.body.data : (camps.body?.data?.items || camps.body?.data || []);
  const compactCampaigns = campaignRows.map((c) => ({
    id: c.id,
    name: c.name,
    brand: c.brand || '',
    product: c.product || '',
    status: c.status || '',
    primary_platform: c.primary_platform || '',
    target_market: c.target_market || '',
    language: c.language || ''
  }));

  // 3. List strategies (each campaign)
  const strategies = [];
  for (const c of campaignRows) {
    const s = await request('GET', `/api/kol-strategies?campaign_id=${c.id}`, { headers: authedHeaders });
    if (s.status !== 200) {
      strategies.push({ campaign_id: c.id, error: `status ${s.status}`, body: s.body });
      continue;
    }
    const list = Array.isArray(s.body?.data) ? s.body.data : (s.body?.data?.items || s.body?.data || []);
    for (const row of list) {
      strategies.push({
        id: row.id,
        campaign_id: c.id,
        campaign_name: c.name,
        title: row.title || row.name || '',
        status: row.status || '',
        primary_platform: row.primary_platform || '',
        secondary_platforms: row.secondary_platforms || [],
        version: row.version || '',
        updated_at: row.updated_at || ''
      });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    campaignCount: campaignRows.length,
    campaigns: compactCampaigns,
    strategyCount: strategies.length,
    strategies
  }, null, 2));
})();
