const express = require('express');
const { dbOperations } = require('../database');

const router = express.Router();
const FEISHU_PROVIDER_KEY = 'cloud.feishu_bitable';
const FEISHU_SHEET_PROVIDER_KEY = 'cloud.feishu_sheet';

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (error) { return fallback; }
}

function compact(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function parseCellText(value) {
  if (Array.isArray(value)) {
    return value.map((part) => part?.text || part?.link || '').join('').trim();
  }
  return compact(value);
}

function normalizePlatform(value) {
  const text = compact(value).toLowerCase();
  return ({ ig: 'instagram', tt: 'tiktok', yt: 'youtube' })[text] || text;
}

function normalizeHandle(value) {
  const text = parseCellText(value).toLowerCase().replace(/^@/, '').replace(/\/$/, '');
  const match = text.match(/(?:instagram\.com\/|tiktok\.com\/@|youtube\.com\/(?:@|channel\/))([^/?#]+)/);
  return (match?.[1] || text).replace(/^@/, '');
}

function profileKey(platform, value) {
  const normalizedPlatform = normalizePlatform(platform);
  const handle = normalizeHandle(value);
  return normalizedPlatform && handle ? `${normalizedPlatform}|${handle}` : '';
}

async function fetchJson(url, options = {}) {
  if (typeof fetch !== 'function') throw new Error('Node.js 18+ is required for Feishu Sheets sync');
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code) {
    const error = new Error(data.msg || data.message || `HTTP ${response.status}`);
    error.code = data.code;
    throw error;
  }
  return data;
}

async function getConfig(purpose = 'cooperation_tracking', campaignId = 61) {
  let row = await dbOperations.get('SELECT * FROM api_settings WHERE provider = ?', [FEISHU_SHEET_PROVIDER_KEY]);
  if (!row) row = await dbOperations.get('SELECT * FROM api_settings WHERE provider = ?', [FEISHU_PROVIDER_KEY]);
  const extra = parseJson(row?.extra_config, {});
  const savedTargets = parseJson(extra.sheet_purpose_map, []);
  const target = Array.isArray(savedTargets)
    ? savedTargets.find((item) => Number(item?.campaign_id) === Number(campaignId) && compact(item?.purpose) === purpose)
    : null;
  const legacyMap = !Array.isArray(savedTargets) ? savedTargets : {};
  const defaultMap = { candidate_pool: '6nUDXq', cooperation_tracking: compact(extra.sheet_id) || 'uSIrMc' };
  const config = {
    baseUrl: compact(row?.base_url || extra.base_url || 'https://open.feishu.cn').replace(/\/$/, ''),
    appId: compact(extra.app_id),
    appSecret: compact(row?.api_key),
    wikiNodeToken: compact(extra.sheet_wiki_node_token),
    sheetId: compact(target?.sheet_id || legacyMap[purpose] || (Number(campaignId) === 61 ? defaultMap[purpose] : '')),
    sheetPurpose: purpose
  };
  const missing = Object.entries(config)
    .filter(([key, value]) => !['baseUrl', 'sheetPurpose'].includes(key) && !value)
    .map(([key]) => key);
  if (missing.length) throw new Error(`飞书普通表格配置不完整：${missing.join(', ')}`);
  return config;
}

async function getSheetContext(config) {
  const auth = await fetchJson(`${config.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret })
  });
  const headers = { Authorization: `Bearer ${auth.tenant_access_token}` };
  const wiki = await fetchJson(`${config.baseUrl}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(config.wikiNodeToken)}`, { headers });
  const spreadsheetToken = wiki?.data?.node?.obj_token;
  if (!spreadsheetToken) throw new Error('无法从 Wiki 节点解析电子表格 token');
  return { headers, spreadsheetToken };
}

function tierLabel(value) {
  return ({ t1: 'S', t2: 'A', t3: 'B', t4: 'C' })[compact(value).toLowerCase()] || compact(value);
}

function cooperationTypeLabel(value) {
  return ({ paid_product: '付费合作', product_exchange: '样品置换', other: '其他' })[compact(value)] || compact(value);
}

function projectStatusLabel(value) {
  return ({
    candidate: '候选', pending_confirmation: '待确认', pending_shipping: '待发货',
    shipped: '已发货', delivered: '已签收', content_preparation: '内容准备中',
    pending_publish: '待上线', published: '已上线', cancelled: '已取消'
  })[compact(value)] || compact(value);
}

function outreachStatusLabel(value) {
  const status = compact(value).toLowerCase();
  if (['contacted', 'waiting_reply', 'follow_up'].includes(status)) return '已触达未回复';
  if (['negotiating', 'interested', 'confirmed'].includes(status)) return '已回复';
  return '未触达';
}

function richLink(text, link) {
  const cleanLink = compact(link);
  if (!cleanLink) return compact(text);
  return [{ type: 'url', text: compact(text) || cleanLink, link: cleanLink }];
}

function mapSystemRow(row) {
  const platform = compact(row.platform_account_platform || row.target_platform || row.platform);
  const normalized = normalizePlatform(platform);
  const profileUrl = compact(row.platform_account_url
    || (normalized === 'instagram' ? row.instagram_url || row.instagram_url_snapshot : '')
    || (normalized === 'tiktok' ? row.tiktok_url || row.tiktok_url_snapshot : '')
    || row.youtube_url || row.youtube_url_snapshot);
  const name = compact(row.kol_name || row.kol_name_snapshot || row.platform_account_username);
  const followers = row.platform_account_followers
    || (normalized === 'instagram' ? row.instagram_followers || row.instagram_followers_snapshot : '')
    || (normalized === 'tiktok' ? row.tiktok_followers || row.tiktok_followers_snapshot : '')
    || row.youtube_followers || row.youtube_followers_snapshot || '';
  const email = compact(row.email || row.email_snapshot);
  const key = profileKey(platform, row.platform_account_username || profileUrl || name);
  const all = [
    richLink(name, profileUrl), platform, followers, compact(row.owner),
    email ? richLink(email, `mailto:${email}`) : '', tierLabel(row.priority_level),
    compact(row.product_sku || row.product_name), cooperationTypeLabel(row.cooperation_type),
    row.final_fee || row.quoted_fee || '', row.shipping_address || '',
    row.deliverables || row.content_format || '', row.expected_publish_at || '', '',
    row.estimated_total_cost_usd || '', row.median_views_30d_snapshot || '',
    row.expected_views || '', row.estimated_cpm || '', compact(row.budget_approval_status), '',
    row.project_notes || row.notes || '', projectStatusLabel(row.project_status),
    row.shipping_date || '', `KOL-${row.customer_id}`, row.tracking_number || '', ''
  ];
  return {
    id: row.id,
    customerId: row.customer_id,
    key,
    systemId: `KOL-${row.customer_id}`,
    values: {
      identity: all.slice(0, 8),
      finance: all.slice(13, 15),
      budget: all.slice(16, 18),
      progress: all.slice(20, 23),
      all,
      append: all
    }
  };
}

function mapCandidateRow(row) {
  const platform = compact(row.platform_account_platform || row.target_platform || row.platform);
  const normalized = normalizePlatform(platform);
  const profileUrl = compact(row.platform_account_url
    || (normalized === 'instagram' ? row.instagram_url || row.instagram_url_snapshot : '')
    || (normalized === 'tiktok' ? row.tiktok_url || row.tiktok_url_snapshot : '')
    || row.youtube_url || row.youtube_url_snapshot);
  const name = compact(row.kol_name || row.kol_name_snapshot || row.platform_account_username);
  const email = compact(row.email || row.email_snapshot);
  const followers = row.platform_account_followers
    || (normalized === 'instagram' ? row.instagram_followers || row.instagram_followers_snapshot : '')
    || (normalized === 'tiktok' ? row.tiktok_followers || row.tiktok_followers_snapshot : '')
    || row.youtube_followers || row.youtube_followers_snapshot || '';
  const all = [
    platform, name, richLink(profileUrl || name, profileUrl),
    email ? richLink(email, `mailto:${email}`) : '', compact(row.creator_type),
    followers, row.median_views_30d_snapshot || '',
    '', compact(row.owner),
    outreachStatusLabel(row.outreach_status)
  ];
  return {
    id: row.id,
    customerId: row.customer_id,
    key: profileKey(platform, row.platform_account_username || profileUrl || name),
    systemId: '',
    values: { all, append: all }
  };
}

function applyFieldPolicies(systemValues, sheetValues, policies = {}, columnCount = 25) {
  const output = Array.from({ length: columnCount }, (_, index) => sheetValues[index] ?? '');
  for (const [column, requestedMode] of Object.entries(policies || {})) {
    const letter = compact(column).toUpperCase();
    const index = letter.charCodeAt(0) - 65;
    if (!/^[A-Y]$/.test(letter) || index < 0 || index >= columnCount) continue;
    const mode = compact(requestedMode).toLowerCase();
    const source = systemValues[index] ?? '';
    const sourceHasValue = parseCellText(source) !== '';
    const targetHasValue = parseCellText(output[index]) !== '';
    if (mode === 'overwrite') output[index] = source;
    if (mode === 'overwrite_nonempty' && sourceHasValue) output[index] = source;
    if (mode === 'fill_empty' && sourceHasValue && !targetHasValue) output[index] = source;
  }
  return output;
}

async function loadRows(ids = [], campaignId = null, purpose = 'cooperation_tracking') {
  const params = [];
  const pipelineStage = purpose === 'candidate_pool' ? 'candidate' : 'confirmed';
  let where = 'WHERE ck.pipeline_stage = ?';
  params.push(pipelineStage);
  if (ids.length) {
    where += ` AND ck.id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  } else if (campaignId) {
    where += ' AND ck.campaign_id = ?';
    params.push(campaignId);
  } else {
    throw new Error('请选择要同步的 KOL，或先选择项目');
  }
  const rows = await dbOperations.query(`
    SELECT ck.*, c.name kol_name, c.email, c.platform, c.creator_type, c.youtube_url, c.youtube_followers,
      c.instagram_url, c.instagram_followers, c.tiktok_url, c.tiktok_followers,
      kpa.platform platform_account_platform, kpa.username platform_account_username,
      kpa.profile_url platform_account_url,
      COALESCE(kpa.followers_count, kpa.followers_text) platform_account_followers,
      (SELECT p.sku FROM campaign_kol_products ckp
       JOIN campaign_products cp ON cp.id = ckp.campaign_product_id
       JOIN products p ON p.id = cp.product_id
       WHERE ckp.campaign_kol_id = ck.id
       ORDER BY (ckp.assignment_status = 'active') DESC, cp.priority DESC, ckp.id LIMIT 1) product_sku,
      (SELECT p.name FROM campaign_kol_products ckp
       JOIN campaign_products cp ON cp.id = ckp.campaign_product_id
       JOIN products p ON p.id = cp.product_id
       WHERE ckp.campaign_kol_id = ck.id
       ORDER BY (ckp.assignment_status = 'active') DESC, cp.priority DESC, ckp.id LIMIT 1) product_name
    FROM campaign_kols ck
    JOIN customers c ON c.id = ck.customer_id
    LEFT JOIN kol_platform_accounts kpa ON kpa.id = ck.platform_account_id
    ${where}
    ORDER BY ck.id
  `, params);
  return rows.map(purpose === 'candidate_pool' ? mapCandidateRow : mapSystemRow);
}

async function readSheet(config, context) {
  const range = encodeURIComponent(`${config.sheetId}!A1:Y5000`);
  const data = await fetchJson(`${config.baseUrl}/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(context.spreadsheetToken)}/values/${range}`, { headers: context.headers });
  return data?.data?.valueRange?.values || [];
}

function indexSheet(rows, purpose = 'cooperation_tracking') {
  const bySystemId = new Map();
  const byKey = new Map();
  rows.slice(1).forEach((raw, index) => {
    const rowNumber = index + 2;
    const row = [...raw];
    const systemId = purpose === 'candidate_pool' ? '' : parseCellText(row[22]);
    const key = purpose === 'candidate_pool'
      ? profileKey(parseCellText(row[0]), row[2])
      : profileKey(parseCellText(row[1]), row[0]);
    if (systemId && !bySystemId.has(systemId)) bySystemId.set(systemId, rowNumber);
    if (key && !byKey.has(key)) byKey.set(key, rowNumber);
  });
  return { bySystemId, byKey };
}

function buildPreview(systemRows, sheetRows, purpose = 'cooperation_tracking') {
  const index = indexSheet(sheetRows, purpose);
  const plan = systemRows.map((row) => {
    const sheetRow = index.bySystemId.get(row.systemId) || (row.key ? index.byKey.get(row.key) : null) || null;
    return { row, sheetRow, sheetValues: sheetRow ? (sheetRows[sheetRow - 1] || []) : [] };
  });
  return {
    plan,
    created: plan.filter((item) => !item.sheetRow).length,
    updated: plan.filter((item) => item.sheetRow).length,
    skipped: plan.filter((item) => !item.row.key).length
  };
}

async function batchUpdate(config, context, valueRanges) {
  for (let i = 0; i < valueRanges.length; i += 100) {
    await fetchJson(`${config.baseUrl}/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(context.spreadsheetToken)}/values_batch_update`, {
      method: 'POST',
      headers: { ...context.headers, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ valueRanges: valueRanges.slice(i, i + 100) })
    });
  }
}

async function appendRows(config, context, values) {
  if (!values.length) return;
  await fetchJson(`${config.baseUrl}/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(context.spreadsheetToken)}/values_append?insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: { ...context.headers, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ valueRange: { range: `${config.sheetId}!A:${config.endColumn || 'Y'}`, values } })
  });
}

async function prepare(req) {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  const campaignId = Number(req.body?.campaign_id) || null;
  const purpose = compact(req.body?.sheet_purpose) || 'cooperation_tracking';
  if (!campaignId) throw new Error('请先选择项目，再同步飞书普通表格');
  const config = await getConfig(purpose, campaignId);
  config.endColumn = purpose === 'candidate_pool' ? 'J' : 'Y';
  const context = await getSheetContext(config);
  const [systemRows, sheetRows] = await Promise.all([loadRows(ids, campaignId, purpose), readSheet(config, context)]);
  return { config, context, purpose, preview: buildPreview(systemRows, sheetRows, purpose) };
}

async function pushToSheet(ids, campaignId, purpose = 'cooperation_tracking', fieldPolicies = null) {
  const config = await getConfig(purpose, campaignId);
  config.endColumn = purpose === 'candidate_pool' ? 'J' : 'Y';
  const context = await getSheetContext(config);
  const [systemRows, sheetRows] = await Promise.all([loadRows(ids, campaignId, purpose), readSheet(config, context)]);
  const preview = buildPreview(systemRows, sheetRows, purpose);
  const updates = [];
  const creates = [];
  const hasFieldPolicies = fieldPolicies && typeof fieldPolicies === 'object';
  for (const item of preview.plan) {
    if (!item.sheetRow) {
      creates.push(item.row.values.append);
      continue;
    }
    const n = item.sheetRow;
    if (hasFieldPolicies) {
      const endColumn = purpose === 'candidate_pool' ? 'J' : 'Y';
      updates.push({
        range: `${config.sheetId}!A${n}:${endColumn}${n}`,
        values: [applyFieldPolicies(item.row.values.all, item.sheetValues, fieldPolicies, purpose === 'candidate_pool' ? 10 : 25)]
      });
      continue;
    }
    if (purpose === 'candidate_pool') {
      updates.push({ range: `${config.sheetId}!A${n}:J${n}`, values: [item.row.values.all] });
      continue;
    }
    updates.push(
      { range: `${config.sheetId}!A${n}:H${n}`, values: [item.row.values.identity] },
      { range: `${config.sheetId}!N${n}:O${n}`, values: [item.row.values.finance] },
      { range: `${config.sheetId}!Q${n}:R${n}`, values: [item.row.values.budget] },
      { range: `${config.sheetId}!U${n}:W${n}`, values: [item.row.values.progress] }
    );
  }
  await batchUpdate(config, context, updates);
  await appendRows(config, context, creates);
  return { created: creates.length, updated: preview.updated, skipped: preview.skipped };
}

router.post('/test', async (req, res) => {
  try {
    const config = await getConfig(compact(req.body?.sheet_purpose) || 'cooperation_tracking', Number(req.body?.campaign_id) || 61);
    const context = await getSheetContext(config);
    const rows = await readSheet(config, context);
    res.json({ success: true, data: { sheet_id: config.sheetId, rows: Math.max(0, rows.length - 1) } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/preview', async (req, res) => {
  try {
    const { preview } = await prepare(req);
    res.json({ success: true, data: { created: preview.created, updated: preview.updated, skipped: preview.skipped } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/push', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    const campaignId = Number(req.body?.campaign_id) || null;
    const purpose = compact(req.body?.sheet_purpose) || 'cooperation_tracking';
    if (!campaignId) throw new Error('请先选择项目，再同步飞书普通表格');
    const data = await pushToSheet(ids, campaignId, purpose, req.body?.field_policies);
    res.json({ success: true, data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
module.exports.profileKey = profileKey;
module.exports.mapSystemRow = mapSystemRow;
module.exports.mapCandidateRow = mapCandidateRow;
module.exports.buildPreview = buildPreview;
module.exports.applyFieldPolicies = applyFieldPolicies;
module.exports.getConfig = getConfig;
module.exports.getSheetContext = getSheetContext;
module.exports.readSheet = readSheet;
module.exports.loadRows = loadRows;
module.exports.pushToSheet = pushToSheet;
