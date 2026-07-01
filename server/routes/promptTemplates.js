const express = require('express');
const router = express.Router();
const { dbOperations } = require('../database');

router.get('/', async (req, res) => {
  try {
    const rows = await dbOperations.query('SELECT * FROM prompt_templates ORDER BY is_default DESC, created_at DESC');
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      name,
      platform = 'all',
      system_prompt,
      user_prompt,
      brand_keywords,
      purchase_keywords,
      negative_keywords,
      is_default = 0
    } = req.body;

    if (!name || !user_prompt) {
      return res.status(400).json({ success: false, error: '模板名称和用户 Prompt 为必填字段' });
    }

    if (is_default) {
      await dbOperations.run('UPDATE prompt_templates SET is_default = 0 WHERE platform = ?', [platform]);
    }

    const result = await dbOperations.run(
      `INSERT INTO prompt_templates
       (name, platform, system_prompt, user_prompt, brand_keywords, purchase_keywords, negative_keywords, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, platform, system_prompt || '', user_prompt, brand_keywords || '', purchase_keywords || '', negative_keywords || '', is_default ? 1 : 0]
    );
    res.json({ success: true, data: { id: result.id } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const {
      name,
      platform = 'all',
      system_prompt,
      user_prompt,
      brand_keywords,
      purchase_keywords,
      negative_keywords,
      is_default = 0
    } = req.body;

    if (!name || !user_prompt) {
      return res.status(400).json({ success: false, error: '模板名称和用户 Prompt 为必填字段' });
    }

    if (is_default) {
      await dbOperations.run('UPDATE prompt_templates SET is_default = 0 WHERE platform = ? AND id != ?', [platform, req.params.id]);
    }

    await dbOperations.run(
      `UPDATE prompt_templates SET
       name = ?, platform = ?, system_prompt = ?, user_prompt = ?, brand_keywords = ?,
       purchase_keywords = ?, negative_keywords = ?, is_default = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [name, platform, system_prompt || '', user_prompt, brand_keywords || '', purchase_keywords || '', negative_keywords || '', is_default ? 1 : 0, req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await dbOperations.run('DELETE FROM prompt_templates WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
