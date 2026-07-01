const express = require('express');
const router = express.Router();
const { dbOperations } = require('../database');

// 获取所有分组
router.get('/', async (req, res) => {
  try {
    const groups = await dbOperations.query('SELECT * FROM customer_groups');
    res.json({ success: true, data: groups });
  } catch (err) {
    res.status(500).json({ success: false, error: '获取分组列表失败', message: err.message });
  }
});

// 新增分组
router.post('/', async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, error: '分组名称不能为空' });
  }
  try {
    await dbOperations.run('INSERT INTO customer_groups (name) VALUES (?)', [name]);
    res.json({ success: true, message: '分组添加成功' });
  } catch (err) {
    res.status(500).json({ success: false, error: '添加分组失败', message: err.message });
  }
});

// 删除分组（并将该分组下联系人的 group_id 置为 NULL）
router.delete('/:id', async (req, res) => {
  const groupId = req.params.id;
  try {
    // 先将该分组下的联系人 group_id 置为 NULL
    await dbOperations.run('UPDATE customers SET group_id = NULL WHERE group_id = ?', [groupId]);
    // 再删除分组
    await dbOperations.run('DELETE FROM customer_groups WHERE id = ?', [groupId]);
    res.json({ success: true, message: '分组删除成功' });
  } catch (err) {
    res.status(500).json({ success: false, error: '删除分组失败', message: err.message });
  }
});

module.exports = router; 