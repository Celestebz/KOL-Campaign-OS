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

    const usage = await dbOperations.get('SELECT COUNT(*) as count FROM video_sources WHERE campaign_id = ?', [id]);
    if (usage?.count > 0) {
      return res.status(400).json({ success: false, error: `该产品/活动已有 ${usage.count} 条视频，不能删除。请先把视频改到其他产品/活动。` });
    }

    await dbOperations.run('DELETE FROM campaigns WHERE id = ?', [id]);
    res.json({ success: true, message: '产品/活动已删除' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
