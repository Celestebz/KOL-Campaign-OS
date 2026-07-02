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
    campaign_table_id: extra.campaign_table_id || ''
  };
}

function requireFeishuConfig(config) {
  const missing = [];
  if (!config.app_id) missing.push('App ID');
  if (!config.app_secret) missing.push('App Secret');
  if (!config.app_token) missing.push('Base/App Token');
  if (!config.kol_table_id) missing.push('KOL Master Table ID');
  if (!config.campaign_kol_table_id) missing.push('Campaign KOL Table ID');
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
    KOL: compact(row.name),
    '联系人': compact(row.contact_name),
    YouTube: compact(row.youtube_url),
    'YouTube粉丝量': compact(row.youtube_followers),
    Instagram: compact(row.instagram_url),
    'Instagram粉丝量': compact(row.instagram_followers),
    TikTok: compact(row.tiktok_url),
    'TikTok粉丝量': compact(row.tiktok_followers),
    Email: compact(row.email),
    Phone: compact(row.phone),
    '国家地区': compact(row.country_region),
    '默认视频价格': compact(row.video_price),
    '汇率': compact(row.exchange_rate),
    '价格RMB': compact(row.price_rmb),
    Rate: compact(row.rating),
    Remark: compact(row.notes),
    '来源': row.source_raw_candidate_id ? `Raw Candidate #${row.source_raw_candidate_id}` : 'Manual',
    '最后验证时间': compact(row.last_verified_at)
  };
}

function campaignKolFields(row) {
  return {
    '合作产品': compact(row.campaign_name),
    KOL: compact(row.kol_name || row.kol_name_snapshot),
    '联系人': compact(row.contact_name || row.contact_name_snapshot),
    YouTube: compact(row.youtube_url || row.youtube_url_snapshot),
    '粉丝量': compact(row.youtube_followers || row.youtube_followers_snapshot),
    Instagram: compact(row.instagram_url || row.instagram_url_snapshot),
    Email: compact(row.email || row.email_snapshot),
    '国家地区': compact(row.country_region || row.country_region_snapshot),
    '项目视频价格': compact(row.quoted_price),
    '汇率': compact(row.exchange_rate),
    '价格RMB': compact(row.price_rmb),
    '状态': compact(row.status),
    '跟进人': compact(row.owner),
    'YouTube视频链接': compact(row.youtube_video_link),
    'Instagram视频链接': compact(row.instagram_video_link),
    'TikTok视频链接': compact(row.tiktok_video_link),
    '备注': compact(row.notes)
  };
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
      k.youtube_url, k.youtube_followers, k.instagram_url
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
      const recordId = await pushBitableRecord(
        config,
        token,
        config.campaign_kol_table_id,
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
