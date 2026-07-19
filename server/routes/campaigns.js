const express = require('express');
const { dbOperations } = require('../database');

const router = express.Router();

const CAMPAIGN_PRODUCT_ROLES = new Set(['hero', 'secondary', 'test']);
const CAMPAIGN_PRODUCT_STATUSES = new Set(['planned', 'active', 'paused', 'completed', 'archived']);

function toCampaignProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    product_id: row.product_id,
    product: {
      id: row.product_id,
      brand: row.product_brand,
      name: row.product_name,
      sku: row.product_sku,
      category: row.product_category,
      product_url: row.product_url,
      description: row.product_description,
      selling_points: row.product_selling_points,
      status: row.product_status
    },
    role: row.role,
    priority: row.priority,
    campaign_brief: row.campaign_brief,
    status: row.status
  };
}

async function getCampaignProduct(campaignId, campaignProductId) {
  return dbOperations.get(
    `SELECT cp.id, cp.campaign_id, cp.product_id, cp.role, cp.priority, cp.campaign_brief, cp.status,
       p.brand AS product_brand, p.name AS product_name, p.sku AS product_sku,
       p.category AS product_category, p.product_url, p.description AS product_description,
       p.selling_points AS product_selling_points, p.status AS product_status
     FROM campaign_products cp
     JOIN products p ON p.id = cp.product_id
     WHERE cp.campaign_id = ? AND cp.id = ?`,
    [campaignId, campaignProductId]
  );
}

function validateCampaignProductValues(role, status) {
  if (!CAMPAIGN_PRODUCT_ROLES.has(role)) return 'Invalid Campaign Product role';
  if (!CAMPAIGN_PRODUCT_STATUSES.has(status)) return 'Invalid Campaign Product status';
  return null;
}

router.get('/', async (req, res) => {
  try {
    const rows = await dbOperations.query(`
      SELECT c.*,
        COUNT(cp.id) AS associated_product_count,
        COALESCE(SUM(CASE WHEN cp.status = 'active' THEN 1 ELSE 0 END), 0) AS active_product_count
      FROM campaigns c
      LEFT JOIN campaign_products cp ON cp.campaign_id = c.id
      GROUP BY c.id
      ORDER BY CASE WHEN c.id = 1 THEN 0 ELSE 1 END, c.created_at DESC, c.id DESC
    `);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:id/products', async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const campaign = await dbOperations.get('SELECT id FROM campaigns WHERE id = ?', [campaignId]);
    if (!campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    const rows = await dbOperations.query(
      `SELECT cp.id, cp.campaign_id, cp.product_id, cp.role, cp.priority, cp.campaign_brief, cp.status,
         p.brand AS product_brand, p.name AS product_name, p.sku AS product_sku,
         p.category AS product_category, p.product_url, p.description AS product_description,
         p.selling_points AS product_selling_points, p.status AS product_status
       FROM campaign_products cp
       JOIN products p ON p.id = cp.product_id
       WHERE cp.campaign_id = ?
       ORDER BY cp.priority DESC, cp.created_at ASC, cp.id ASC`,
      [campaignId]
    );
    res.json({ success: true, data: rows.map(toCampaignProduct) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/products', async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const productId = Number(req.body.product_id);
    const role = req.body.role === undefined ? 'hero' : req.body.role;
    const status = req.body.status === undefined ? 'active' : req.body.status;
    const priority = req.body.priority === undefined ? 0 : Number(req.body.priority);
    const validationError = validateCampaignProductValues(role, status);
    if (validationError) {
      return res.status(400).json({ success: false, error: validationError });
    }
    if (!Number.isInteger(priority)) {
      return res.status(400).json({ success: false, error: 'Campaign Product priority must be an integer' });
    }

    const campaign = await dbOperations.get('SELECT id FROM campaigns WHERE id = ?', [campaignId]);
    if (!campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }
    const product = await dbOperations.get('SELECT id FROM products WHERE id = ?', [productId]);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    const duplicate = await dbOperations.get(
      'SELECT id FROM campaign_products WHERE campaign_id = ? AND product_id = ?',
      [campaignId, productId]
    );
    if (duplicate) {
      return res.status(409).json({ success: false, error: 'Product is already attached to this Campaign' });
    }

    const result = await dbOperations.run(
      `INSERT INTO campaign_products
        (campaign_id, product_id, role, priority, campaign_brief, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [campaignId, productId, role, priority, req.body.campaign_brief ?? null, status]
    );
    const created = await getCampaignProduct(campaignId, result.id);
    res.json({ success: true, data: toCampaignProduct(created), message: 'Product attached to Campaign' });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, error: 'Product is already attached to this Campaign' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/:campaignId/products/:campaignProductId', async (req, res) => {
  try {
    const campaignId = Number(req.params.campaignId);
    const campaignProductId = Number(req.params.campaignProductId);
    const current = await getCampaignProduct(campaignId, campaignProductId);
    if (!current) {
      return res.status(404).json({ success: false, error: 'Campaign Product not found' });
    }

    const role = req.body.role === undefined ? current.role : req.body.role;
    const status = req.body.status === undefined ? current.status : req.body.status;
    const priority = req.body.priority === undefined ? current.priority : Number(req.body.priority);
    const validationError = validateCampaignProductValues(role, status);
    if (validationError) {
      return res.status(400).json({ success: false, error: validationError });
    }
    if (!Number.isInteger(priority)) {
      return res.status(400).json({ success: false, error: 'Campaign Product priority must be an integer' });
    }

    await dbOperations.run(
      `UPDATE campaign_products SET
         role = ?, priority = ?, campaign_brief = ?, status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE campaign_id = ? AND id = ?`,
      [
        role,
        priority,
        req.body.campaign_brief === undefined ? current.campaign_brief : req.body.campaign_brief,
        status,
        campaignId,
        campaignProductId
      ]
    );
    const updated = await getCampaignProduct(campaignId, campaignProductId);
    res.json({ success: true, data: toCampaignProduct(updated), message: 'Campaign Product updated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:campaignId/products/:campaignProductId/archive', async (req, res) => {
  try {
    const campaignId = Number(req.params.campaignId);
    const campaignProductId = Number(req.params.campaignProductId);
    const current = await getCampaignProduct(campaignId, campaignProductId);
    if (!current) {
      return res.status(404).json({ success: false, error: 'Campaign Product not found' });
    }

    await dbOperations.run(
      `UPDATE campaign_products
       SET status = 'archived', updated_at = CURRENT_TIMESTAMP
       WHERE campaign_id = ? AND id = ?`,
      [campaignId, campaignProductId]
    );
    const archived = await getCampaignProduct(campaignId, campaignProductId);
    res.json({ success: true, data: toCampaignProduct(archived), message: 'Campaign Product archived' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, brand, product, brand_keywords, purchase_keywords, negative_keywords } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: '产品/活动名称为必填字段' });
    }

    const existing = await dbOperations.get('SELECT * FROM campaigns WHERE name = ?', [name]);
    if (existing) {
      return res.json({ success: true, data: existing, message: '产品/活动已存在' });
    }

    const result = await dbOperations.run(
      `INSERT INTO campaigns (name, brand, product, brand_keywords, purchase_keywords, negative_keywords)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, brand || '', product || '', brand_keywords || '', purchase_keywords || '', negative_keywords || '']
    );
    const created = await dbOperations.get('SELECT * FROM campaigns WHERE id = ?', [result.id]);
    res.json({ success: true, data: created, message: '产品/活动已创建' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, brand, product, brand_keywords, purchase_keywords, negative_keywords } = req.body;
    const cleanName = String(name || '').trim();

    if (!cleanName) {
      return res.status(400).json({ success: false, error: '产品/活动名称为必填字段' });
    }

    const campaign = await dbOperations.get('SELECT * FROM campaigns WHERE id = ?', [id]);
    if (!campaign) {
      return res.status(404).json({ success: false, error: '产品/活动不存在' });
    }

    const duplicate = await dbOperations.get('SELECT id FROM campaigns WHERE name = ? AND id != ?', [cleanName, id]);
    if (duplicate) {
      return res.status(400).json({ success: false, error: '已存在同名产品/活动' });
    }

    await dbOperations.run(
      `UPDATE campaigns SET
       name = ?,
       brand = COALESCE(?, brand),
       product = ?,
       brand_keywords = COALESCE(?, brand_keywords),
       purchase_keywords = COALESCE(?, purchase_keywords),
       negative_keywords = COALESCE(?, negative_keywords),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        cleanName,
        brand ?? null,
        product !== undefined ? product : cleanName,
        brand_keywords ?? null,
        purchase_keywords ?? null,
        negative_keywords ?? null,
        id
      ]
    );

    const updated = await dbOperations.get('SELECT * FROM campaigns WHERE id = ?', [id]);
    res.json({ success: true, data: updated, message: '产品/活动已重命名' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === 1) {
      return res.status(400).json({ success: false, error: 'Default Campaign 不能删除' });
    }

    const campaign = await dbOperations.get('SELECT * FROM campaigns WHERE id = ?', [id]);
    if (!campaign) {
      return res.status(404).json({ success: false, error: '产品/活动不存在' });
    }

    const usage = await dbOperations.get('SELECT COUNT(*) as count FROM campaign_videos WHERE campaign_id = ?', [id]);
    if (usage?.count > 0) {
      return res.status(400).json({ success: false, error: `该产品/活动已有 ${usage.count} 条视频，不能删除。请先把视频改到其他产品/活动。` });
    }

    const campaignKolUsage = await dbOperations.get('SELECT COUNT(*) as count FROM campaign_kols WHERE campaign_id = ?', [id]);
    if (campaignKolUsage?.count > 0) {
      return res.status(400).json({ success: false, error: `该产品/活动已有 ${campaignKolUsage.count} 条 Campaign KOL，不能删除。请先移除项目 KOL。` });
    }

    const rawUsage = await dbOperations.get('SELECT COUNT(*) as count FROM raw_candidates WHERE campaign_id = ?', [id]);
    if (rawUsage?.count > 0) {
      return res.status(400).json({ success: false, error: `该产品/活动已有 ${rawUsage.count} 条 Raw Candidate，不能删除。请先清理候选。` });
    }

    const strategyUsage = await dbOperations.get('SELECT COUNT(*) as count FROM kol_strategies WHERE campaign_id = ?', [id]);
    if (strategyUsage?.count > 0) {
      return res.status(400).json({ success: false, error: `该产品/活动已有 ${strategyUsage.count} 条 KOL Strategy，不能删除。请先归档或删除 Strategy。` });
    }

    await dbOperations.run('DELETE FROM campaigns WHERE id = ?', [id]);
    res.json({ success: true, message: '产品/活动已删除' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

function safeParseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

router.get('/:campaignId/kols', async (req, res) => {
  try {
    const campaignId = Number(req.params.campaignId);
    const { status, search } = req.query;
    let sql = `
      SELECT ck.*, k.name as kol_name, k.contact_name, k.email, k.phone, k.country_region,
        k.cooperation_status as global_cooperation_status,
        k.cooperation_risk_category as global_cooperation_risk_category,
        k.cooperation_risk_reason as global_cooperation_risk_reason,
        k.youtube_url, k.youtube_followers, k.instagram_url, k.instagram_followers,
        k.tiktok_url, k.tiktok_followers, k.video_price as default_video_price,
        k.price_rmb as default_price_rmb, k.rating,
        kpa.platform as platform_account_platform, kpa.profile_url as platform_account_url,
        kpa.username as platform_account_username, kpa.followers_text as platform_account_followers
      FROM campaign_kols ck
      JOIN customers k ON k.id = ck.customer_id
      LEFT JOIN kol_platform_accounts kpa ON kpa.id = ck.platform_account_id
      WHERE ck.campaign_id = ?
    `;
    const params = [campaignId];

    if (status) {
      sql += ' AND ck.project_status = ?';
      params.push(status);
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
    res.json({
      success: true,
      data: rows.map((row) => ({
        ...row,
        master_snapshot: safeParseJson(row.master_snapshot),
        project_override: safeParseJson(row.project_override),
        evidence_summary: safeParseJson(row.evidence_summary)
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
