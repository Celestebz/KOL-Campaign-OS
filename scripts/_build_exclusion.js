// 汇总排除集：KOL Master 全量客户、Raw Candidates 全量、TMB-1401 活动候选池、历史输出文件
// 输出 outputs/exclusion_set.json，包含 normalized name / @handle / channelId / 规范化 URL
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function api(method, apiPath) {
  const out = execFileSync('node', [path.join(__dirname, '_agent_http.js'), method, apiPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  return JSON.parse(out);
}

function normUrl(u) {
  if (!u) return '';
  let s = String(u).trim().toLowerCase();
  s = s.split('\n')[0].trim();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/^m\./, '');
  s = s.split('?')[0].split('#')[0].replace(/\/+$/, '');
  // 去掉 /videos /about 等子页
  s = s.replace(/\/(videos|shorts|streams|about|featured|playlists|community|channels)$/, '');
  return s;
}
function handleOf(u) {
  const m = String(u || '').match(/youtube\.com\/@([^/?#\s]+)/i);
  return m ? m[1].toLowerCase() : '';
}
function channelIdOf(u) {
  const m = String(u || '').match(/youtube\.com\/channel\/([^/?#\s]+)/i);
  return m ? m[1] : '';
}
function normName(n) {
  return String(n || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
}

const names = new Set(), handles = new Set(), channelIds = new Set(), urls = new Set();
const detail = [];
function add(source, obj) {
  const n = normName(obj.name);
  const h = handleOf(obj.url) || handleOf(obj.profile_url);
  const c = channelIdOf(obj.url) || channelIdOf(obj.profile_url);
  const u = normUrl(obj.url || obj.profile_url);
  if (n) names.add(n);
  if (h) handles.add(h);
  if (c) channelIds.add(c);
  if (u) urls.add(u);
  detail.push({ source, ...obj, _norm: { n, h, c, u } });
}

// 1) KOL Master 全量
let page = 1, total = Infinity, count = 0;
while (count < total) {
  const r = api('GET', `/api/customers?page=${page}&page_size=200`);
  total = r.pagination?.total ?? r.total ?? r.data.length;
  for (const c of r.data) {
    add('kol_master', { id: c.id, name: c.name, url: c.youtube_url || c.profile_url });
    count++;
  }
  if (!r.data.length) break;
  page++;
}
console.error(`kol_master: ${count}`);

// 2) Raw Candidates 全量
page = 1; total = Infinity; count = 0;
while (count < total) {
  const r = api('GET', `/api/raw-candidates?page=${page}&page_size=200`);
  total = r.pagination?.total ?? r.total ?? r.data.length;
  for (const c of r.data) {
    add('raw_candidate', { id: c.id, name: c.kol_name, url: c.profile_url, status: c.status });
    count++;
  }
  if (!r.data.length) break;
  page++;
}
console.error(`raw_candidates: ${count}`);

// 3) TMB-1401 候选池（campaign-kols 通过 customer_id 已覆盖 master，但也记录快照 URL）
const pool = api('GET', '/api/campaign-kols?campaign_id=2&page_size=500');
for (const k of (pool.data || [])) {
  add('campaign_pool', { id: k.customer_id, name: k.kol_name_snapshot || undefined, url: k.youtube_url_snapshot || undefined });
}
console.error(`campaign_pool: ${(pool.data || []).length}`);

// 4) 历史输出文件
for (const f of ['kol_master_pool_19191.json', 'remaining_317.json']) {
  const p = path.join(ROOT, 'outputs', f);
  if (fs.existsSync(p)) {
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const c of arr) add('historical_output', { id: c.id, name: c.name, url: c.youtube_url });
    console.error(`${f}: ${arr.length}`);
  }
}

const out = {
  generated_at: new Date().toISOString(),
  counts: { names: names.size, handles: handles.size, channelIds: channelIds.size, urls: urls.size },
  names: [...names], handles: [...handles], channelIds: [...channelIds], urls: [...urls]
};
fs.writeFileSync(path.join(ROOT, 'outputs', 'exclusion_set.json'), JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(ROOT, 'outputs', 'exclusion_detail.json'), JSON.stringify(detail, null, 1));
console.error('exclusion set written:', JSON.stringify(out.counts));
