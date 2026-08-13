const express = require('express');
const { dbOperations } = require('../database');
const { normalizeVideoUrl } = require('../utils/videoUrlNormalizer');
const timeline = require('../services/campaignKolTimeline');
const emailFollowUp = require('../services/emailFollowUp');
const { syncConfirmedToFeishu } = require('../services/confirmCooperationSync');
const {
  PROJECT_STATUSES,
  PRIORITY_LEVELS,
  PIPELINE_STAGES,
  OUTREACH_STATUSES,
  normalizeOutreachStatus,
  normalizeProjectStatus,
  normalizePriorityLevel
} = require('../utils/campaignKolEnums');

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
  'owner',
  'best_evidence_url',
  'evidence_summary',
  'project_override',
  'shipping_address',
  'expected_publish_at',
  'content_format',
  'estimated_total_cost_usd',
  'median_views_30d_snapshot',
  'posts_30d_snapshot',
  'avg_views_30d_snapshot',
  'engagement_rate_30d_snapshot',
  'youtube_snapshot_updated_at',
  'expected_views',
  'estimated_cpm',
  'budget_approval_status',
  'shipping_date',
  'tracking_number',
  'cooperation_platforms'
];

const CAMPAIGN_KOL_PRODUCT_STATUSES = {
  fit_status: new Set(['pending', 'approved', 'rejected']),
  assignment_status: new Set(['active', 'paused', 'completed', 'archived']),
  sample_status: new Set(['pending', 'sent', 'received', 'returned']),
  content_status: new Set(['pending', 'draft', 'review', 'published'])
};

const JSON_FIELDS = new Set(['evidence_summary', 'project_override', 'cooperation_platforms']);
const COLLABORATION_ONLY_FIELDS = [
  'shipping_address',
  'content_format',
  'expected_publish_at',
  'shipping_date',
  'tracking_number'
];

function hideCandidateCollaborationFields(row) {
  if (!row || row.pipeline_stage !== 'candidate') return row;
  const sanitized = { ...row, published_video_count: 0 };
  for (const field of COLLABORATION_ONLY_FIELDS) delete sanitized[field];
  return sanitized;
}

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

async function switchCommunicationProduct(campaignKolId, productId) {
  const campaignKol = await dbOperations.get(
    'SELECT id, campaign_id, customer_id FROM campaign_kols WHERE id = ?',
    [campaignKolId]
  );
  if (!campaignKol) {
    const error = new Error('Campaign KOL not found');
    error.statusCode = 404;
    throw error;
  }

  const product = await dbOperations.get(
    'SELECT id, sku, name, status FROM products WHERE id = ?',
    [productId]
  );
  if (!product) {
    const error = new Error('Product not found');
    error.statusCode = 404;
    throw error;
  }
  if (product.status === 'archived') {
    const error = new Error('Archived Product cannot be used as the communication product');
    error.statusCode = 409;
    throw error;
  }

  let campaignProduct = await dbOperations.get(
    'SELECT id, status FROM campaign_products WHERE campaign_id = ? AND product_id = ?',
    [campaignKol.campaign_id, productId]
  );
  if (!campaignProduct) {
    const created = await dbOperations.run(
      `INSERT INTO campaign_products
       (campaign_id, product_id, role, priority, status, created_at, updated_at)
       VALUES (?, ?, 'secondary', 1, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [campaignKol.campaign_id, productId]
    );
    campaignProduct = { id: created.id, status: 'active' };
  } else if (campaignProduct.status === 'archived') {
    await dbOperations.run(
      `UPDATE campaign_products SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [campaignProduct.id]
    );
    campaignProduct.status = 'active';
  }

  const existingAssignment = await dbOperations.get(
    'SELECT id FROM campaign_kol_products WHERE campaign_kol_id = ? AND campaign_product_id = ?',
    [campaignKolId, campaignProduct.id]
  );
  if (existingAssignment) {
    await dbOperations.run(
      `UPDATE campaign_kol_products SET assignment_status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [existingAssignment.id]
    );
  } else {
    await dbOperations.run(
      `INSERT INTO campaign_kol_products
       (campaign_kol_id, campaign_product_id, fit_status, assignment_status, created_at, updated_at)
       VALUES (?, ?, 'approved', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [campaignKolId, campaignProduct.id]
    );
  }

  await dbOperations.run(
    `UPDATE campaign_kol_products SET assignment_status = 'paused', updated_at = CURRENT_TIMESTAMP
     WHERE campaign_kol_id = ? AND campaign_product_id <> ? AND assignment_status = 'active'`,
    [campaignKolId, campaignProduct.id]
  );
  await dbOperations.run(
    `UPDATE campaign_kols SET sync_status = 'sync_pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [campaignKolId]
  );
  await markCustomerSyncPending(campaignKol.customer_id);

  return dbOperations.get(
    `SELECT ckp.*, cp.campaign_id, cp.role, cp.priority, cp.campaign_brief, cp.status AS campaign_product_status,
       p.id AS product_id, p.brand AS product_brand, p.name AS product_name, p.sku AS product_sku,
       p.category AS product_category, p.product_url, p.description AS product_description,
       p.selling_points AS product_selling_points, p.status AS product_status
     FROM campaign_kol_products ckp
     JOIN campaign_products cp ON cp.id = ckp.campaign_product_id
     JOIN products p ON p.id = cp.product_id
     WHERE ckp.campaign_kol_id = ? AND ckp.campaign_product_id = ?`,
    [campaignKolId, campaignProduct.id]
  );
}

// 以下两个函数供 approval_items 决定副作用（decisionDispatcher）复用，
// 与 PATCH /:id 走相同的 sync_status/markCustomerSyncPending 约定。
async function setCampaignKolStatus(id, status) {
  const row = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [id]);
  if (!row) {
    const error = new Error('Campaign KOL not found');
    error.statusCode = 404;
    throw error;
  }
  await dbOperations.run(
    `UPDATE campaign_kols SET status = ?, sync_status = 'sync_pending',
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [status, id]
  );
  await markCustomerSyncPending(row.customer_id);
  return dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [id]);
}

async function setBudgetApprovalStatus(id, status) {
  const row = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [id]);
  if (!row) {
    const error = new Error('Campaign KOL not found');
    error.statusCode = 404;
    throw error;
  }
  await dbOperations.run(
    `UPDATE campaign_kols SET budget_approval_status = ?, sync_status = 'sync_pending',
     updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [status, id]
  );
  await markCustomerSyncPending(row.customer_id);
  return dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [id]);
}

router.get('/', async (req, res) => {
  try {
    const { campaign_id, status, sync_status, search, pipeline_stage, outreach_status } = req.query;
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
         WHERE ckp.campaign_kol_id = ck.id
         ORDER BY (ckp.assignment_status = 'active') DESC, cp.priority DESC, ckp.id LIMIT 1) product_sku,
        (SELECT p.name FROM campaign_kol_products ckp
         JOIN campaign_products cp ON cp.id = ckp.campaign_product_id
         JOIN products p ON p.id = cp.product_id
         WHERE ckp.campaign_kol_id = ck.id
         ORDER BY (ckp.assignment_status = 'active') DESC, cp.priority DESC, ckp.id LIMIT 1) product_name
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
    if (outreach_status) {
      // 旧值兼容：筛选“待回复/已终止”时同时命中 replied/rejected
      const normalized = normalizeOutreachStatus(outreach_status);
      if (OUTREACH_STATUSES.has(normalized)) {
        const legacyAlias = { waiting_reply: 'replied', terminated: 'rejected' }[normalized];
        sql += legacyAlias ? ' AND ck.outreach_status IN (?, ?)' : ' AND ck.outreach_status = ?';
        params.push(...(legacyAlias ? [normalized, legacyAlias] : [normalized]));
      }
    }
    if (sync_status) {
      sql += ' AND ck.sync_status = ?';
      params.push(sync_status);
    }
    if (PIPELINE_STAGES.has(pipeline_stage)) {
      sql += ' AND ck.pipeline_stage = ?';
      params.push(pipeline_stage);
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
      ...hideCandidateCollaborationFields(row),
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
       ORDER BY (ckp.assignment_status = 'active') DESC, cp.priority DESC, cp.created_at ASC, cp.id ASC`,
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

router.post('/:id/products/switch', async (req, res) => {
  try {
    const campaignKolId = parsePathId(req.params.id);
    const productId = Number(req.body.product_id);
    if (campaignKolId === null) {
      return res.status(400).json({ success: false, error: 'Campaign KOL id must be a positive integer' });
    }
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      return res.status(400).json({ success: false, error: 'Product id must be a positive integer' });
    }

    const updated = await switchCommunicationProduct(campaignKolId, productId);
    res.json({ success: true, data: normalizeCampaignKolProduct(updated), message: 'Communication product switched' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

router.get('/:id/published-videos', async (req, res) => {
  try {
    const campaignKol = await dbOperations.get('SELECT pipeline_stage FROM campaign_kols WHERE id = ?', [req.params.id]);
    if (!campaignKol) return res.status(404).json({ success: false, error: 'KOL 合作记录不存在' });
    if (campaignKol.pipeline_stage === 'candidate') {
      return res.status(409).json({ success: false, error: '合作发布视频仅可在 KOL 合作阶段查看' });
    }
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
    if (campaignKol.pipeline_stage === 'candidate') {
      return res.status(409).json({ success: false, error: '合作发布视频仅可在 KOL 合作阶段维护' });
    }
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
        quoted_price, exchange_rate, price_rmb, pipeline_stage, project_status, outreach_status, owner, notes,
        posts_30d_snapshot, avg_views_30d_snapshot, median_views_30d_snapshot,
        engagement_rate_30d_snapshot, youtube_snapshot_updated_at, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        'candidate', 'pending_confirmation', 'not_contacted',
        clean(req.body.owner),
        clean(req.body.notes),
        customer.youtube_posts_30d,
        customer.youtube_avg_views_30d,
        customer.youtube_median_views_30d,
        customer.youtube_engagement_rate_30d,
        customer.youtube_snapshot_updated_at,
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

    const requestedProductId = req.body.product_id === undefined ? undefined : Number(req.body.product_id);
    if (requestedProductId !== undefined) {
      if (!Number.isSafeInteger(requestedProductId) || requestedProductId <= 0) {
        return res.status(400).json({ success: false, error: 'Product id must be a positive integer' });
      }
      await switchCommunicationProduct(id, requestedProductId);
    }

    const updates = {};
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        const value = field === 'project_status'
          ? normalizeProjectStatus(req.body[field])
          : field === 'priority_level'
            ? normalizePriorityLevel(req.body[field])
            : field === 'outreach_status'
              ? normalizeOutreachStatus(req.body[field])
              : req.body[field];
        if (field === 'project_status' && !PROJECT_STATUSES.has(value)) {
          return res.status(400).json({ success: false, error: 'Invalid project_status' });
        }
        if (field === 'priority_level' && !PRIORITY_LEVELS.has(value)) {
          return res.status(400).json({ success: false, error: 'Invalid priority_level' });
        }
        if (field === 'outreach_status' && !OUTREACH_STATUSES.has(value)) {
          return res.status(400).json({ success: false, error: 'Invalid outreach_status' });
        }
        updates[field] = JSON_FIELDS.has(field) ? normalizeJsonField(value) : value;
      }
    }

    // 阶段字段白名单：候选阶段只改外联状态，合作阶段只改项目状态，互不覆盖。
    const stage = row.pipeline_stage || 'candidate';
    if (stage === 'candidate') {
      delete updates.project_status;
      const forbiddenFields = COLLABORATION_ONLY_FIELDS.filter((field) => req.body[field] !== undefined);
      if (forbiddenFields.length) {
        return res.status(409).json({
          success: false,
          error: `以下字段仅可在 KOL 合作阶段维护：${forbiddenFields.join(', ')}`
        });
      }
    }
    if (stage === 'confirmed') delete updates.outreach_status;

    if (Object.keys(updates).length === 0 && requestedProductId === undefined) {
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

    if (fields.length > 0) {
      await dbOperations.run(
        `UPDATE campaign_kols SET ${assignments}, sync_status = 'sync_pending',
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [...values, id]
      );
    }
    await markCustomerSyncPending(row.customer_id);
    const updated = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [id]);
    res.json({ success: true, data: updated, message: 'Campaign KOL updated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/confirm-cooperation', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Campaign KOL id must be a positive integer' });
    }
    const row = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ success: false, error: 'Campaign KOL not found' });
    if (row.pipeline_stage === 'confirmed') {
      const syncs = await syncConfirmedToFeishu(id).then((result) => result?.targets || []).catch((error) => (
        [{ type: 'unknown', label: '飞书', success: false, error: error.message || '同步失败' }]
      ));
      return res.json({ success: true, data: row, message: 'KOL cooperation already confirmed', syncs });
    }
    if (row.pipeline_stage !== 'candidate') {
      return res.status(409).json({ success: false, error: '只有项目候选可以确认合作；历史合作记录不能确认合作' });
    }
    if (['terminated', 'rejected'].includes(row.outreach_status)) {
      return res.status(409).json({ success: false, error: '已终止的候选不能直接确认合作，请先恢复为其他外联状态' });
    }

    await dbOperations.run(
      `UPDATE campaign_kols
       SET pipeline_stage = 'confirmed', project_status = 'pending_shipping',
           outreach_status = 'confirmed',
           confirmed_at = CURRENT_TIMESTAMP, sync_status = 'sync_pending',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [id]
    );
    await markCustomerSyncPending(row.customer_id);
    const updated = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [id]);
    const syncs = await syncConfirmedToFeishu(id).then((result) => result?.targets || []).catch((error) => (
      [{ type: 'unknown', label: '飞书', success: false, error: error.message || '同步失败' }]
    ));
    res.json({ success: true, data: updated, message: 'KOL cooperation confirmed', syncs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 运营在外部渠道（网页邮箱/IM/电话后补邮件）已对达人发起一次跟进，
// 在系统里登记以阻断 48h 自动跟进扫描重起草。
// body 可选字段：subject / body_text / note / actor
router.post('/:id/record-manual-outreach', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Campaign KOL id must be a positive integer' });
    }
    const body = req.body || {};
    const result = await emailFollowUp.recordManualOutreach({
      campaignKolId: id,
      subject: typeof body.subject === 'string' ? body.subject.slice(0, 500) : null,
      bodyText: typeof body.body_text === 'string' ? body.body_text : null,
      note: typeof body.note === 'string' ? body.note.slice(0, 1000) : null,
      actor: typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim().slice(0, 100) : 'ops'
    });
    res.json({ success: true, message: '已登记人工跟进，自动跟进将延后', data: result });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
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
        k.cooperation_risk_reason, k.youtube_posts_30d, k.youtube_avg_views_30d,
        k.youtube_median_views_30d, k.youtube_engagement_rate_30d, k.youtube_snapshot_updated_at
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
        posts_30d_snapshot = ?,
        avg_views_30d_snapshot = ?,
        median_views_30d_snapshot = ?,
        engagement_rate_30d_snapshot = ?,
        youtube_snapshot_updated_at = ?,
        sync_status = 'sync_pending',
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        masterSnapshot,
        row.name, row.contact_name, row.email, row.country_region,
        row.youtube_url, row.instagram_url, row.tiktok_url,
        row.youtube_followers, row.instagram_followers, row.tiktok_followers,
        row.youtube_posts_30d, row.youtube_avg_views_30d, row.youtube_median_views_30d,
        row.youtube_engagement_rate_30d, row.youtube_snapshot_updated_at,
        id
      ]
    );
    const updated = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [id]);
    res.json({ success: true, data: updated, message: 'Synced from KOL Master' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:id/events', async (req, res) => {
  try {
    const id = parsePathId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid campaign KOL id' });
    const rows = await dbOperations.query(
      `SELECT id, campaign_kol_id, event_type, occurred_at, summary, source_type, source_id,
              ai_intent, confirmed_intent, outreach_status, previous_outreach_status, actor, created_at
       FROM campaign_kol_events WHERE campaign_kol_id = ?
       ORDER BY occurred_at DESC, id DESC LIMIT 200`,
      [id]
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/events/intent-correction', async (req, res) => {
  try {
    const id = parsePathId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid campaign KOL id' });
    const requestedIntent = String(req.body?.intent || '').trim().toLowerCase();
    if (!timeline.CONFIRMED_INTENTS.has(requestedIntent)) {
      return res.status(400).json({ success: false, error: 'Invalid intent' });
    }
    const row = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ success: false, error: 'Campaign KOL not found' });
    const outreachStatus = timeline.outreachForIntent(requestedIntent);
    await timeline.appendEvent({
      campaignKol: row,
      eventType: 'intent_corrected',
      occurredAt: new Date(),
      summary: clean(req.body?.summary) || row.last_reply_summary || null,
      sourceType: 'manual',
      confirmedIntent: requestedIntent,
      outreachStatus,
      actor: clean(req.body?.actor) || 'boss'
    });
    await timeline.applyLatestStatus(id);
    res.json({ success: true, data: { outreach_status: outreachStatus, confirmed_intent: requestedIntent } });
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
// 供 approval_items 决定副作用复用（decisionDispatcher）
module.exports.setCampaignKolStatus = setCampaignKolStatus;
module.exports.setBudgetApprovalStatus = setBudgetApprovalStatus;
