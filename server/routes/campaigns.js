const express = require('express');
const { dbOperations } = require('../database');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await dbOperations.query(`
      SELECT * FROM campaigns
      ORDER BY CASE WHEN id = 1 THEN 0 ELSE 1 END, created_at DESC, id DESC
    `);
    res.json({ success: true, data: rows });
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
