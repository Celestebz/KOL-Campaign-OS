const express = require('express');
const { dbOperations } = require('../database');

const router = express.Router();

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function safeParseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

const EDITABLE_FIELDS = [
  'quoted_fee',
  'final_fee',
  'currency',
  'deliverables',
  'outreach_status',
  'negotiation_status',
  'contract_status',
  'payment_status',
  'content_status',
  'project_notes',
  'internal_notes',
  'priority_level',
  'project_status',
  'contact_email_override',
  'contact_name_override',
  'owner',
  'best_evidence_url',
  'evidence_summary',
  'project_override'
];

const JSON_FIELDS = new Set(['evidence_summary', 'project_override']);

function normalizeJsonField(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

router.get('/', async (req, res) => {
  try {
    const { campaign_id, status, sync_status, search } = req.query;
    let sql = `
      SELECT ck.*, c.name as campaign_name, c.brand, c.product,
        k.name as kol_name, k.contact_name, k.email, k.phone, k.country_region,
        k.cooperation_status as global_cooperation_status,
        k.cooperation_risk_category as global_cooperation_risk_category,
        k.cooperation_risk_reason as global_cooperation_risk_reason,
        k.youtube_url, k.youtube_followers, k.instagram_url, k.instagram_followers,
        k.tiktok_url, k.tiktok_followers, k.video_price as default_video_price,
        k.price_rmb as default_price_rmb, k.rating,
        kpa.platform as platform_account_platform, kpa.profile_url as platform_account_url,
        kpa.username as platform_account_username, kpa.followers_text as platform_account_followers
      FROM campaign_kols ck
      JOIN campaigns c ON c.id = ck.campaign_id
      JOIN customers k ON k.id = ck.customer_id
      LEFT JOIN kol_platform_accounts kpa ON kpa.id = ck.platform_account_id
      WHERE 1=1
    `;
    const params = [];

    if (campaign_id) {
      sql += ' AND ck.campaign_id = ?';
      params.push(campaign_id);
    }
    if (status) {
      sql += ' AND ck.project_status = ?';
      params.push(status);
    }
    if (sync_status) {
      sql += ' AND ck.sync_status = ?';
      params.push(sync_status);
    }
    if (search) {
      sql += ` AND (
        k.name LIKE ? OR k.contact_name LIKE ? OR k.email LIKE ? OR k.country_region LIKE ?
        OR ck.kol_name_snapshot LIKE ? OR ck.project_notes LIKE ? OR ck.internal_notes LIKE ?
        OR kpa.username LIKE ? OR kpa.profile_url LIKE ?
      )`;
      const term = `%${search}%`;
      params.push(term, term, term, term, term, term, term, term, term);
    }

    sql += ' ORDER BY ck.candidate_priority_score DESC, ck.created_at DESC, ck.id DESC';
    const rows = await dbOperations.query(sql, params);
    res.json({ success: true, data: rows.map((row) => ({
      ...row,
      master_snapshot: safeParseJson(row.master_snapshot),
      project_override: safeParseJson(row.project_override),
      evidence_summary: safeParseJson(row.evidence_summary)
    })) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const campaignId = Number(req.body.campaign_id);
    const customerId = Number(req.body.customer_id);
    if (!campaignId || !customerId) {
      return res.status(400).json({ success: false, error: 'campaign_id and customer_id are required' });
    }

    const customer = await dbOperations.get('SELECT * FROM customers WHERE id = ?', [customerId]);
    if (!customer) return res.status(404).json({ success: false, error: 'KOL not found' });

    const existing = await dbOperations.get(
      'SELECT * FROM campaign_kols WHERE campaign_id = ? AND customer_id = ? AND platform_account_id IS NULL',
      [campaignId, customerId]
    );
    if (existing) return res.json({ success: true, data: existing, message: 'KOL already exists in this campaign' });

    const result = await dbOperations.run(
      `INSERT INTO campaign_kols
       (campaign_id, customer_id, kol_name_snapshot, contact_name_snapshot,
        youtube_url_snapshot, youtube_followers_snapshot, instagram_url_snapshot, instagram_followers_snapshot,
        tiktok_url_snapshot, tiktok_followers_snapshot, email_snapshot, country_region_snapshot,
        quoted_price, exchange_rate, price_rmb, project_status, owner, notes, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        campaignId,
        customerId,
        customer.name || '',
        customer.contact_name || '',
        customer.youtube_url || '',
        customer.youtube_followers || '',
        customer.instagram_url || '',
        customer.instagram_followers || '',
        customer.tiktok_url || '',
        customer.tiktok_followers || '',
        customer.email || '',
        customer.country_region || '',
        clean(req.body.quoted_price || customer.video_price),
        clean(req.body.exchange_rate || customer.exchange_rate),
        clean(req.body.price_rmb || customer.price_rmb),
        clean(req.body.project_status) || 'candidate',
        clean(req.body.owner),
        clean(req.body.notes),
        'sync_pending'
      ]
    );
    const row = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [result.id]);
    res.json({ success: true, data: row, message: 'Campaign KOL added' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ success: false, error: 'Campaign KOL not found' });

    const updates = {};
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        updates[field] = JSON_FIELDS.has(field) ? normalizeJsonField(req.body[field]) : req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No editable fields provided' });
    }

    const fields = Object.keys(updates);
    const assignments = fields.map((field) => `${field} = ?`).join(', ');
    const values = fields.map((field) => updates[field]);

    await dbOperations.run(
      `UPDATE campaign_kols SET ${assignments}, sync_status = 'sync_pending',
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...values, id]
    );
    const updated = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [id]);
    res.json({ success: true, data: updated, message: 'Campaign KOL updated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/sync-from-master', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await dbOperations.get(`
      SELECT ck.*, k.name, k.contact_name, k.email, k.phone, k.country_region,
        k.youtube_url, k.youtube_followers, k.instagram_url, k.instagram_followers,
        k.tiktok_url, k.tiktok_followers, k.cooperation_status, k.cooperation_risk_category,
        k.cooperation_risk_reason
      FROM campaign_kols ck
      JOIN customers k ON k.id = ck.customer_id
      WHERE ck.id = ?
    `, [id]);
    if (!row) return res.status(404).json({ success: false, error: 'Campaign KOL not found' });

    const masterSnapshot = JSON.stringify({
      customer_id: row.customer_id,
      name: row.name,
      contact_name: row.contact_name,
      email: row.email,
      phone: row.phone,
      country_region: row.country_region,
      youtube_url: row.youtube_url,
      youtube_followers: row.youtube_followers,
      instagram_url: row.instagram_url,
      instagram_followers: row.instagram_followers,
      tiktok_url: row.tiktok_url,
      tiktok_followers: row.tiktok_followers,
      cooperation_status: row.cooperation_status,
      cooperation_risk_category: row.cooperation_risk_category,
      cooperation_risk_reason: row.cooperation_risk_reason
    });

    await dbOperations.run(
      `UPDATE campaign_kols SET
        master_snapshot = ?,
        kol_name_snapshot = COALESCE(NULLIF(?, ''), kol_name_snapshot),
        contact_name_snapshot = COALESCE(NULLIF(?, ''), contact_name_snapshot),
        email_snapshot = COALESCE(NULLIF(?, ''), email_snapshot),
        country_region_snapshot = COALESCE(NULLIF(?, ''), country_region_snapshot),
        youtube_url_snapshot = COALESCE(NULLIF(?, ''), youtube_url_snapshot),
        instagram_url_snapshot = COALESCE(NULLIF(?, ''), instagram_url_snapshot),
        tiktok_url_snapshot = COALESCE(NULLIF(?, ''), tiktok_url_snapshot),
        youtube_followers_snapshot = COALESCE(NULLIF(?, ''), youtube_followers_snapshot),
        instagram_followers_snapshot = COALESCE(NULLIF(?, ''), instagram_followers_snapshot),
        tiktok_followers_snapshot = COALESCE(NULLIF(?, ''), tiktok_followers_snapshot),
        sync_status = 'sync_pending',
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        masterSnapshot,
        row.name, row.contact_name, row.email, row.country_region,
        row.youtube_url, row.instagram_url, row.tiktok_url,
        row.youtube_followers, row.instagram_followers, row.tiktok_followers,
        id
      ]
    );
    const updated = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [id]);
    res.json({ success: true, data: updated, message: 'Synced from KOL Master' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/batch', async (req, res) => {
  try {
    const ids = req.body.ids || [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'Please select records' });
    const placeholders = ids.map(() => '?').join(',');
    await dbOperations.run(`DELETE FROM campaign_kols WHERE id IN (${placeholders})`, ids);
    res.json({ success: true, message: `Deleted ${ids.length} campaign KOL records` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await dbOperations.run('DELETE FROM campaign_kols WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Campaign KOL deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
