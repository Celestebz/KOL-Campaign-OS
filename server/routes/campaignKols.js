const express = require('express');
const { dbOperations } = require('../database');

const router = express.Router();

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

router.get('/', async (req, res) => {
  try {
    const { campaign_id, status, sync_status, search } = req.query;
    let sql = `
      SELECT ck.*, c.name as campaign_name, c.brand, c.product,
        k.name as kol_name, k.contact_name, k.email, k.phone, k.country_region,
        k.youtube_url, k.youtube_followers, k.instagram_url, k.instagram_followers,
        k.tiktok_url, k.tiktok_followers, k.video_price as default_video_price,
        k.price_rmb as default_price_rmb, k.rating
      FROM campaign_kols ck
      JOIN campaigns c ON c.id = ck.campaign_id
      JOIN customers k ON k.id = ck.customer_id
      WHERE 1=1
    `;
    const params = [];

    if (campaign_id) {
      sql += ' AND ck.campaign_id = ?';
      params.push(campaign_id);
    }
    if (status) {
      sql += ' AND ck.status = ?';
      params.push(status);
    }
    if (sync_status) {
      sql += ' AND ck.sync_status = ?';
      params.push(sync_status);
    }
    if (search) {
      sql += ` AND (
        k.name LIKE ? OR k.contact_name LIKE ? OR k.email LIKE ? OR k.country_region LIKE ?
        OR ck.kol_name_snapshot LIKE ? OR ck.notes LIKE ? OR ck.youtube_video_link LIKE ?
        OR ck.instagram_video_link LIKE ? OR ck.tiktok_video_link LIKE ?
      )`;
      const term = `%${search}%`;
      params.push(term, term, term, term, term, term, term, term, term);
    }

    sql += ' ORDER BY ck.created_at DESC, ck.id DESC';
    const rows = await dbOperations.query(sql, params);
    res.json({ success: true, data: rows });
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
      'SELECT * FROM campaign_kols WHERE campaign_id = ? AND customer_id = ?',
      [campaignId, customerId]
    );
    if (existing) return res.json({ success: true, data: existing, message: 'KOL already exists in this campaign' });

    const result = await dbOperations.run(
      `INSERT INTO campaign_kols
       (campaign_id, customer_id, kol_name_snapshot, contact_name_snapshot,
        youtube_url_snapshot, youtube_followers_snapshot, instagram_url_snapshot, instagram_followers_snapshot,
        tiktok_url_snapshot, tiktok_followers_snapshot, email_snapshot, country_region_snapshot,
        quoted_price, exchange_rate, price_rmb, status, owner, notes, sync_status)
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
        clean(req.body.status) || 'candidate',
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

router.put('/:id', async (req, res) => {
  try {
    const fields = [
      'quoted_price',
      'exchange_rate',
      'price_rmb',
      'status',
      'owner',
      'youtube_video_link',
      'instagram_video_link',
      'tiktok_video_link',
      'notes'
    ];
    const assignments = fields.map((field) => `${field} = ?`).join(', ');
    const values = fields.map((field) => clean(req.body[field]));

    await dbOperations.run(
      `UPDATE campaign_kols SET ${assignments}, sync_status = 'sync_pending',
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...values, req.params.id]
    );
    const row = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: row, message: 'Campaign KOL updated' });
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
