const express = require('express');
const { dbOperations } = require('../database');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await dbOperations.query('SELECT * FROM campaigns ORDER BY id DESC');
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

module.exports = router;
