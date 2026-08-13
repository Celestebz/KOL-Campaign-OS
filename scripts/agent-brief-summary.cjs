// Summarize strategy 3 brief: campaign, strategy key fields, KOL master pool,
// and raw_candidates grouped by status. Avoid dumping the full raw list.

const path = require('path');
const fs = require('fs');
const http = require('http');

const ENV_PATH = path.resolve(__dirname, '..', '.env');
const BASE_URL = 'http://localhost:5001';
const PASSWORD_KEY = 'APP_ACCESS_PASSWORD';
const STRATEGY_ID = 3;

function loadEnvValue(filePath, key) {
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    if (t.slice(0, eq) === key) {
      let v = t.slice(eq + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      return v;
    }
  }
  return '';
}

function request(method, urlPath, { headers = {}, body = null, cookies = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE_URL + urlPath);
    const hdrs = { 'Content-Type': 'application/json', ...headers };
    if (cookies) hdrs['Cookie'] = cookies;
    const opts = {
      method, hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, headers: hdrs
    };
    if (body) {
      const data = Buffer.from(JSON.stringify(body));
      hdrs['Content-Length'] = data.length;
    }
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const setCookie = res.headers['set-cookie'] || [];
        const newCookies = setCookie.map((c) => c.split(';')[0]).join('; ');
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, body: parsed, newCookies });
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
    console.error(JSON.stringify({ ok: false, error: 'no password' }));
    process.exit(2);
  }
  const login = await request('POST', '/api/auth/login', { body: { password } });
  if (login.status !== 200) {
    console.error(JSON.stringify({ ok: false, step: 'login', body: login.body }));
    process.exit(3);
  }
  const cookies = login.newCookies;

  // Brief with Agent bearer
  const brief = await request('GET', `/api/agent/brief/${STRATEGY_ID}`, {
    headers: { Authorization: 'Bearer Agent API Token' }
  });
  if (brief.status !== 200) {
    console.error(JSON.stringify({ ok: false, step: 'brief', status: brief.status, body: brief.body }));
    process.exit(4);
  }
  const d = brief.body.data;
  const s = d.strategy;

  // existing raw_candidates by status / platform
  const raw = d.existing.raw_candidates;
  const byStatus = {};
  const byStatusPlatform = {};
  const byStatusPlatformList = {};
  for (const r of raw) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const key = `${r.status}|${r.platform}`;
    byStatusPlatform[key] = (byStatusPlatform[key] || 0) + 1;
    if (!byStatusPlatformList[key]) byStatusPlatformList[key] = [];
    if (byStatusPlatformList[key].length < 5) {
      byStatusPlatformList[key].push({ id: r.id, name: r.kol_name, url: r.profile_url });
    }
  }

  // existing KOL master with instagram
  const masterAll = d.existing.kol_master;
  const masterIg = masterAll.filter((k) => k.instagram_url && k.instagram_url.trim());
  const masterByStatus = {};
  for (const k of masterIg) {
    const st = k.cooperation_status || 'unknown';
    masterByStatus[st] = (masterByStatus[st] || 0) + 1;
  }

  // campaign products (for product context)
  let products = [];
  try {
    const cp = await request('GET', `/api/campaigns/${d.campaign.id}/products`, { cookies });
    if (cp.status === 200) {
      const list = Array.isArray(cp.body?.data) ? cp.body.data : (cp.body?.data?.items || []);
      products = list.map((p) => ({
        id: p.id, product_id: p.product_id, role: p.role, priority: p.priority,
        status: p.status,
        brand: p.product?.brand, name: p.product?.name, sku: p.product?.sku,
        category: p.product?.category, price: p.product?.price, currency: p.product?.currency,
        selling_points: p.product?.selling_points
      }));
    }
  } catch (e) { /* non-fatal */ }

  console.log(JSON.stringify({
    ok: true,
    campaign: d.campaign,
    strategy: {
      id: s.id, title: s.title, status: s.status,
      primary_platform: s.primary_platform,
      secondary_platforms: s.secondary_platforms,
      category: s.category, target_market: s.target_market, language: s.language,
      campaign_goal: s.campaign_goal,
      product_context: s.product_context,
      persona_config: s.persona_config,
      scoring_weights: s.scoring_weights,
      finder_handoff: s.finder_handoff
    },
    finder: d.finder,
    raw_candidate_summary: {
      total: raw.length,
      by_status: byStatus,
      by_status_platform: byStatusPlatform,
      samples: byStatusPlatformList
    },
    kol_master_summary: {
      total: masterAll.length,
      with_instagram: masterIg.length,
      by_cooperation_status: masterByStatus
    },
    campaign_products: products
  }, null, 2));
})();
