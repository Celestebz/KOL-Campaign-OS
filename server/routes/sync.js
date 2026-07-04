const express = require('express');
const { dbOperations } = require('../database');

const router = express.Router();

const FEISHU_PROVIDER_KEY = 'cloud.feishu_bitable';

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function compact(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function parseCampaignSubtableMap(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  const text = String(value).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return text.split(/\r?\n|,/).reduce((acc, line) => {
      const [name, tableId] = line.split('=').map((part) => part && part.trim());
      if (name && tableId) acc[name] = tableId;
      return acc;
    }, {});
  }
}

async function fetchJson(url, options = {}) {
  if (typeof fetch !== 'function') throw new Error('Node.js 18+ is required for Feishu sync');
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || (data.code !== undefined && data.code !== 0)) {
    throw new Error(data.msg || data.message || `HTTP ${response.status}`);
  }
  return data;
}

async function getFeishuConfig() {
  const row = await dbOperations.get('SELECT * FROM api_settings WHERE provider = ?', [FEISHU_PROVIDER_KEY]);
  const extra = parseJson(row?.extra_config, {});
  return {
    base_url: (row?.base_url || extra.base_url || 'https://open.feishu.cn').replace(/\/$/, ''),
    app_id: extra.app_id || '',
    app_secret: row?.api_key || extra.app_secret || '',
    app_token: extra.app_token || '',
    kol_table_id: extra.kol_table_id || '',
    campaign_kol_table_id: extra.campaign_kol_table_id || '',
    campaign_table_id: extra.campaign_table_id || '',
    campaign_subtable_map: parseCampaignSubtableMap(extra.campaign_subtable_map)
  };
}

function requireFeishuConfig(config) {
  const missing = [];
  if (!config.app_id) missing.push('App ID');
  if (!config.app_secret) missing.push('App Secret');
  if (!config.app_token) missing.push('Base/App Token');
  if (!config.kol_table_id) missing.push('KOL Master Table ID');
  if (missing.length) throw new Error(`Feishu Bitable is not configured: ${missing.join(', ')}`);
}

async function getTenantAccessToken(config) {
  const data = await fetchJson(`${config.base_url}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: config.app_id, app_secret: config.app_secret })
  });
  return data.tenant_access_token;
}

async function pushBitableRecord(config, token, tableId, recordId, fields) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  };
  const base = `${config.base_url}/open-apis/bitable/v1/apps/${encodeURIComponent(config.app_token)}/tables/${encodeURIComponent(tableId)}/records`;
  if (recordId) {
    const data = await fetchJson(`${base}/${encodeURIComponent(recordId)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ fields })
    });
    return data.data?.record?.record_id || recordId;
  }
  const data = await fetchJson(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({ fields })
  });
  return data.data?.record?.record_id;
}

function kolFields(row) {
  return {
    'KOL名称': compact(row.name),
    '平台': compact(row.platform),
    creator_id: compact(row.creator_id),
    '联系人': compact(row.contact_name),
    'YouTube主页': compact(row.youtube_url),
    'YouTube粉丝量': compact(row.youtube_followers),
    'Instagram主页': compact(row.instagram_url),
    'Instagram粉丝量': compact(row.instagram_followers),
    Email: compact(row.email),
    '国家地区': compact(row.country_region),
    '内容类型': compact(row.creator_type || 'KOL'),
    '标签': 'KOL Campaign OS',
    '备注': compact(row.notes),
    '最后更新时间': compact(row.updated_at || row.last_verified_at)
  };
}

function campaignKolFields(row) {
  return {
    'KOL名称': compact(row.kol_name || row.kol_name_snapshot),
    '项目状态': compact(row.status),
    '平台': compact(row.platform),
    'Instagram主页': compact(row.instagram_url || row.instagram_url_snapshot),
    'Instagram粉丝量': compact(row.instagram_followers || row.instagram_followers_snapshot),
    'YouTube主页': compact(row.youtube_url || row.youtube_url_snapshot),
    'YouTube粉丝量': compact(row.youtube_followers || row.youtube_followers_snapshot),
    'TikTok主页': compact(row.tiktok_url || row.tiktok_url_snapshot),
    'TikTok粉丝量': compact(row.tiktok_followers || row.tiktok_followers_snapshot),
    Email: compact(row.email || row.email_snapshot),
    '国家地区': compact(row.country_region || row.country_region_snapshot),
    Tier: '',
    '项目报价': compact(row.quoted_price),
    '汇率': compact(row.exchange_rate),
    '价格RMB': compact(row.price_rmb),
    '跟进人': compact(row.owner),
    '联系状态': '',
    '回复状态': '',
    '推荐原因': compact(row.notes),
    '推荐内容角度': '',
    '项目备注': `campaign_kol_id: ${row.id}\ncustomer_id: ${row.customer_id}\nraw_candidate_id: ${row.raw_candidate_id || ''}`,
    '来源RawCandidate': row.raw_candidate_id ? `raw_candidate_${row.raw_candidate_id}` : ''
  };
}

function getCampaignKolTableId(config, row) {
  const map = config.campaign_subtable_map || {};
  return map[row.campaign_id] || map[String(row.campaign_id)] || map[row.campaign_name] || config.campaign_kol_table_id || '';
}

function campaignFields(row) {
  return {
    '项目/产品名': compact(row.name),
    '品牌': compact(row.brand),
    '产品品类': compact(row.product),
    '品牌关键词': compact(row.brand_keywords),
    '购买意向关键词': compact(row.purchase_keywords),
    '负面关键词': compact(row.negative_keywords),
    '备注': compact(row.notes)
  };
}

async function syncKols(config, token, ids = []) {
  const params = [];
  let sql = 'SELECT * FROM customers WHERE 1=1';
  if (ids.length) {
    sql += ` AND id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  } else {
    sql += " AND (sync_status IS NULL OR sync_status IN ('sync_pending', 'sync_failed'))";
  }
  const rows = await dbOperations.query(sql, params);
  const results = [];

  for (const row of rows) {
    try {
      const recordId = await pushBitableRecord(config, token, config.kol_table_id, row.feishu_record_id, kolFields(row));
      await dbOperations.run(
        `UPDATE customers SET feishu_record_id = ?, sync_status = ?, last_synced_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [recordId, 'synced', row.id]
      );
      results.push({ type: 'kol', id: row.id, success: true, record_id: recordId });
    } catch (error) {
      await dbOperations.run('UPDATE customers SET sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['sync_failed', row.id]);
      results.push({ type: 'kol', id: row.id, success: false, error: error.message });
    }
  }
  return results;
}

async function syncCampaigns(config, token, ids = []) {
  if (!config.campaign_table_id) {
    if (ids.length) throw new Error('Feishu Campaigns Table ID is not configured');
    return [];
  }

  const params = [];
  let sql = 'SELECT * FROM campaigns WHERE 1=1';
  if (ids.length) {
    sql += ` AND id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }
  sql += ' ORDER BY id';
  const rows = await dbOperations.query(sql, params);
  const results = [];

  for (const row of rows) {
    try {
      const recordId = await pushBitableRecord(config, token, config.campaign_table_id, null, campaignFields(row));
      results.push({ type: 'campaign', id: row.id, success: true, record_id: recordId });
    } catch (error) {
      results.push({ type: 'campaign', id: row.id, success: false, error: error.message });
    }
  }
  return results;
}

async function syncCampaignKols(config, token, ids = []) {
  const params = [];
  let sql = `
    SELECT ck.*, c.name as campaign_name,
      k.name as kol_name, k.contact_name, k.email, k.country_region,
      k.platform, k.youtube_url, k.youtube_followers, k.instagram_url, k.instagram_followers,
      k.tiktok_url, k.tiktok_followers
    FROM campaign_kols ck
    JOIN campaigns c ON c.id = ck.campaign_id
    JOIN customers k ON k.id = ck.customer_id
    WHERE 1=1
  `;
  if (ids.length) {
    sql += ` AND ck.id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  } else {
    sql += " AND (ck.sync_status IS NULL OR ck.sync_status IN ('sync_pending', 'sync_failed'))";
  }
  const rows = await dbOperations.query(sql, params);
  const results = [];

  for (const row of rows) {
    try {
      const tableId = getCampaignKolTableId(config, row);
      if (!tableId) throw new Error(`No Feishu campaign subtable configured for ${row.campaign_name}`);
      const recordId = await pushBitableRecord(
        config,
        token,
        tableId,
        row.feishu_record_id,
        campaignKolFields(row)
      );
      await dbOperations.run(
        `UPDATE campaign_kols SET feishu_record_id = ?, sync_status = ?, last_synced_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [recordId, 'synced', row.id]
      );
      results.push({ type: 'campaign_kol', id: row.id, success: true, record_id: recordId });
    } catch (error) {
      await dbOperations.run('UPDATE campaign_kols SET sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['sync_failed', row.id]);
      results.push({ type: 'campaign_kol', id: row.id, success: false, error: error.message });
    }
  }
  return results;
}

router.post('/feishu/push', async (req, res) => {
  try {
    const config = await getFeishuConfig();
    requireFeishuConfig(config);
    const token = await getTenantAccessToken(config);
    const scope = req.body.scope || 'all';
    const ids = (req.body.ids || []).map((id) => Number(id)).filter(Boolean);

    let results = [];
    if (scope === 'all' || scope === 'kols') results = results.concat(await syncKols(config, token, scope === 'kols' ? ids : []));
    if (scope === 'all' || scope === 'campaigns') results = results.concat(await syncCampaigns(config, token, scope === 'campaigns' ? ids : []));
    if (scope === 'all' || scope === 'campaign_kols') {
      results = results.concat(await syncCampaignKols(config, token, scope === 'campaign_kols' ? ids : []));
    }

    res.json({
      success: true,
      data: {
        success_count: results.filter((item) => item.success).length,
        failed_count: results.filter((item) => !item.success).length,
        results
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
