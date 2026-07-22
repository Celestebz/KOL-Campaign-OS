const express = require('express');
const { dbOperations } = require('../database');
const { normalizeVideoUrl } = require('../utils/videoUrlNormalizer');

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
  'cooperation_type',
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
  'project_override',
  'shipping_address',
  'expected_publish_at',
  'content_format',
  'estimated_total_cost_usd',
  'median_views_30d_snapshot',
  'expected_views',
  'estimated_cpm',
  'budget_approval_status',
  'shipping_date',
  'tracking_number',
  'cooperation_platforms'
];

const PROJECT_STATUSES = new Set([
  'pending_confirmation', 'pending_shipping', 'shipped', 'delivered',
  'content_preparation', 'pending_publish', 'published', 'cancelled'
]);
const PRIORITY_LEVELS = new Set(['t1', 't2', 't3', 't4']);

const CAMPAIGN_KOL_PRODUCT_STATUSES = {
  fit_status: new Set(['pending', 'approved', 'rejected']),
  assignment_status: new Set(['active', 'paused', 'completed', 'archived']),
  sample_status: new Set(['pending', 'sent', 'received', 'returned']),
  content_status: new Set(['pending', 'draft', 'review', 'published'])
};

const JSON_FIELDS = new Set(['evidence_summary', 'project_override', 'cooperation_platforms']);

function normalizeJsonField(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

async function markCustomerSyncPending(customerId) {
  if (!customerId) return;
  await dbOperations.run(
    "UPDATE customers SET sync_status = 'sync_pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [customerId]
  );
}

router.get('/', async (req, res) => {
  try {
    const { campaign_id, status, sync_status, search } = req.query;
    let sql = `
      SELECT ck.*, c.name as campaign_name, c.brand, c.product,
        (SELECT COUNT(*) FROM campaign_videos cv WHERE cv.campaign_kol_id = ck.id) published_video_count,
        k.name as kol_name, k.contact_name, k.email, k.phone, k.country_region,
        k.cooperation_status as global_cooperation_status,
        k.cooperation_risk_category as global_cooperation_risk_category,
        k.cooperation_risk_reason as global_cooperation_risk_reason,
        k.youtube_url, k.youtube_followers, k.instagram_url, k.instagram_followers,
        k.tiktok_url, k.tiktok_followers, k.video_price as default_video_price,
        k.price_rmb as default_price_rmb, k.rating,
        kpa.platform as platform_account_platform, kpa.profile_url as platform_account_url,
        kpa.username as platform_account_username, kpa.followers_text as platform_account_followers,
        (SELECT p.sku FROM campaign_kol_products ckp
         JOIN campaign_products cp ON cp.id = ckp.campaign_product_id
         JOIN products p ON p.id = cp.product_id
         WHERE ckp.campaign_kol_id = ck.id ORDER BY cp.priority DESC, ckp.id LIMIT 1) product_sku,
        (SELECT p.name FROM campaign_kol_products ckp
         JOIN campaign_products cp ON cp.id = ckp.campaign_product_id
         JOIN products p ON p.id = cp.product_id
         WHERE ckp.campaign_kol_id = ck.id ORDER BY cp.priority DESC, ckp.id LIMIT 1) product_name
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

function parsePathId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeCampaignKolProduct(row) {
  if (!row) return row;
  return {
    ...row,
    evidence_summary: safeParseJson(row.evidence_summary),
    deliverables: safeParseJson(row.deliverables)
  };
}

router.get('/:id/products', async (req, res) => {
  try {
    const campaignKolId = parsePathId(req.params.id);
    if (campaignKolId === null) {
      return res.status(400).json({ success: false, error: 'Campaign KOL id must be a positive integer' });
    }
    const campaignKol = await dbOperations.get('SELECT id, campaign_id, customer_id FROM campaign_kols WHERE id = ?', [campaignKolId]);
    if (!campaignKol) {
      return res.status(404).json({ success: false, error: 'Campaign KOL not found' });
    }

    const rows = await dbOperations.query(
      `SELECT ckp.*, cp.campaign_id, cp.role, cp.priority, cp.campaign_brief, cp.status AS campaign_product_status,
         p.id AS product_id, p.brand AS product_brand, p.name AS product_name, p.sku AS product_sku,
         p.category AS product_category, p.product_url, p.description AS product_description,
         p.selling_points AS product_selling_points, p.status AS product_status
       FROM campaign_kol_products ckp
       JOIN campaign_products cp ON cp.id = ckp.campaign_product_id
       JOIN products p ON p.id = cp.product_id
       WHERE ckp.campaign_kol_id = ?
       ORDER BY cp.priority DESC, cp.created_at ASC, cp.id ASC`,
      [campaignKolId]
    );
    res.json({ success: true, data: rows.map(normalizeCampaignKolProduct) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/:id/products/:campaignProductId', async (req, res) => {
  try {
    const campaignKolId = parsePathId(req.params.id);
    const campaignProductId = parsePathId(req.params.campaignProductId);
    if (campaignKolId === null || campaignProductId === null) {
      return res.status(400).json({ success: false, error: 'Campaign KOL and Campaign Product ids must be positive integers' });
    }

    const campaignKol = await dbOperations.get('SELECT id, campaign_id, customer_id FROM campaign_kols WHERE id = ?', [campaignKolId]);
    if (!campaignKol) {
      return res.status(404).json({ success: false, error: 'Campaign KOL not found' });
    }

    const current = await dbOperations.get(
      `SELECT ckp.*, cp.campaign_id
       FROM campaign_kol_products ckp
       JOIN campaign_products cp ON cp.id = ckp.campaign_product_id
       WHERE ckp.campaign_kol_id = ? AND ckp.campaign_product_id = ?`,
      [campaignKolId, campaignProductId]
    );
    if (!current) {
      return res.status(404).json({ success: false, error: 'Campaign KOL Product assignment not found' });
    }
    if (current.campaign_id !== campaignKol.campaign_id) {
      return res.status(400).json({ success: false, error: 'Campaign Product does not belong to the same Campaign as Campaign KOL' });
    }

    const assignments = [];
    const values = [];
    const allowedFields = ['fit_status', 'assignment_status', 'sample_status', 'content_status', 'quoted_fee', 'deliverables', 'result_summary'];
    for (const field of allowedFields) {
      if (req.body[field] === undefined) continue;
      if (CAMPAIGN_KOL_PRODUCT_STATUSES[field]) {
        if (!CAMPAIGN_KOL_PRODUCT_STATUSES[field].has(req.body[field])) {
          return res.status(400).json({ success: false, error: `Invalid ${field}` });
        }
      }
      const value = field === 'deliverables' ? normalizeJsonField(req.body[field]) : req.body[field];
      assignments.push(`${field} = ?`);
      values.push(value);
    }

    if (assignments.length === 0) {
      return res.status(400).json({ success: false, error: 'No editable fields provided' });
    }

    await dbOperations.run(
      `UPDATE campaign_kol_products SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...values, current.id]
    );
    await markCustomerSyncPending(campaignKol.customer_id);
    const updated = await dbOperations.get('SELECT * FROM campaign_kol_products WHERE id = ?', [current.id]);
    res.json({ success: true, data: normalizeCampaignKolProduct(updated), message: 'Campaign KOL Product updated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:id/published-videos', async (req, res) => {
  try {
    const rows = await dbOperations.query(
      `SELECT vs.id, vs.platform, vs.source_url, vs.canonical_url, vs.crawl_status
       FROM campaign_videos cv JOIN video_sources vs ON vs.id = cv.video_source_id
       WHERE cv.campaign_kol_id = ? ORDER BY cv.created_at, cv.id`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/:id/published-videos', async (req, res) => {
  try {
    const campaignKol = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [req.params.id]);
    if (!campaignKol) return res.status(404).json({ success: false, error: 'KOL 合作记录不存在' });
    const rawUrls = Array.isArray(req.body.urls) ? req.body.urls : String(req.body.urls || '').split(/\r?\n/);
    const normalized = Array.from(new Map(rawUrls.filter(Boolean).map((url) => {
      const item = normalizeVideoUrl(String(url).trim());
      return [item.canonicalUrlHash, { ...item, sourceUrl: String(url).trim() }];
    })).values());
    const videoIds = [];
    for (const item of normalized) {
      let video = await dbOperations.get('SELECT * FROM video_sources WHERE canonical_url_hash = ?', [item.canonicalUrlHash]);
      if (!video) {
        const inserted = await dbOperations.run(
          `INSERT INTO video_sources
           (platform, platform_video_id, source_url, canonical_url, canonical_url_hash,
            kol_name, status, crawl_status, analysis_status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', 'not_analyzed')`,
          [item.platform, item.platformVideoId, item.sourceUrl, item.canonicalUrl, item.canonicalUrlHash, campaignKol.kol_name_snapshot || '']
        );
        video = await dbOperations.get('SELECT * FROM video_sources WHERE id = ?', [inserted.id]);
      }
      videoIds.push(video.id);
      await dbOperations.run(
        `INSERT INTO campaign_videos (campaign_id, video_source_id, campaign_kol_id, added_reason)
         VALUES (?, ?, ?, 'kol_published')
         ON DUPLICATE KEY UPDATE campaign_kol_id = VALUES(campaign_kol_id), updated_at = CURRENT_TIMESTAMP`,
        [campaignKol.campaign_id, video.id, campaignKol.id]
      );
    }
    if (videoIds.length) {
      const placeholders = videoIds.map(() => '?').join(',');
      await dbOperations.run(
        `DELETE FROM campaign_videos
         WHERE campaign_kol_id = ? AND video_source_id NOT IN (${placeholders})`,
        [campaignKol.id, ...videoIds]
      );
    } else {
      await dbOperations.run('DELETE FROM campaign_videos WHERE campaign_kol_id = ?', [campaignKol.id]);
    }
    const rows = await dbOperations.query(
      `SELECT vs.id, vs.platform, vs.source_url, vs.canonical_url, vs.crawl_status
       FROM campaign_videos cv JOIN video_sources vs ON vs.id = cv.video_source_id
       WHERE cv.campaign_kol_id = ? ORDER BY cv.created_at, cv.id`,
      [campaignKol.id]
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
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
        clean(req.body.project_status) || 'pending_confirmation',
        clean(req.body.owner),
        clean(req.body.notes),
        'sync_pending'
      ]
    );
    const row = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [result.id]);
    await markCustomerSyncPending(customerId);
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
        if (field === 'project_status' && !PROJECT_STATUSES.has(req.body[field])) {
          return res.status(400).json({ success: false, error: 'Invalid project_status' });
        }
        if (field === 'priority_level' && !PRIORITY_LEVELS.has(req.body[field])) {
          return res.status(400).json({ success: false, error: 'Invalid priority_level' });
        }
        updates[field] = JSON_FIELDS.has(field) ? normalizeJsonField(req.body[field]) : req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No editable fields provided' });
    }

    if (updates.estimated_total_cost_usd !== undefined || updates.expected_views !== undefined) {
      const total = Number(updates.estimated_total_cost_usd ?? row.estimated_total_cost_usd);
      const views = Number(updates.expected_views ?? row.expected_views);
      updates.estimated_cpm = Number.isFinite(total) && Number.isFinite(views) && views > 0
        ? Number(((total / views) * 1000).toFixed(2))
        : null;
    }

    const fields = Object.keys(updates);
    const assignments = fields.map((field) => `${field} = ?`).join(', ');
    const values = fields.map((field) => updates[field]);

    await dbOperations.run(
      `UPDATE campaign_kols SET ${assignments}, sync_status = 'sync_pending',
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...values, id]
    );
    await markCustomerSyncPending(row.customer_id);
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
