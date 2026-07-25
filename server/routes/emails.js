const express = require('express');
const { dbOperations } = require('../database');
const mailer = require('../services/mailer');

const router = express.Router();

const MASKED_SECRET = '••••••••';
const TEMPLATE_KINDS = new Set(['style_guide', 'fixed']);

const VARIABLE_LABELS = {
  kol_name: 'KOL名称',
  contact_name: '联系人姓名',
  campaign_name: '项目名称',
  product_names: '合作产品',
  cooperation_type: '合作方式',
  sender_name: '发件人署名'
};

async function getEmailSettings() {
  return dbOperations.get('SELECT * FROM email_settings ORDER BY id LIMIT 1');
}

// ---- 邮箱配置 ----

router.get('/settings', async (req, res) => {
  try {
    const settings = await getEmailSettings();
    if (!settings) return res.json({ success: true, data: null });
    res.json({ success: true, data: { ...settings, password: settings.password ? MASKED_SECRET : '' } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const body = req.body || {};
    const existing = await getEmailSettings();
    const password = body.password === MASKED_SECRET || body.password === undefined
      ? (existing?.password || null)
      : body.password;
    const values = [
      body.smtp_host || null, Number(body.smtp_port) || 465, body.smtp_secure === undefined ? 1 : (body.smtp_secure ? 1 : 0),
      body.imap_host || null, Number(body.imap_port) || 993, body.imap_secure === undefined ? 1 : (body.imap_secure ? 1 : 0),
      body.username || null, password,
      body.sender_name || null, body.default_cc || null,
      Number(body.poll_interval_minutes ?? 5)
    ];
    if (existing) {
      await dbOperations.run(
        `UPDATE email_settings SET smtp_host=?, smtp_port=?, smtp_secure=?, imap_host=?, imap_port=?, imap_secure=?,
         username=?, password=?, sender_name=?, default_cc=?, poll_interval_minutes=?, updated_at=NOW() WHERE id=?`,
        [...values, existing.id]
      );
    } else {
      await dbOperations.run(
        `INSERT INTO email_settings (smtp_host, smtp_port, smtp_secure, imap_host, imap_port, imap_secure,
         username, password, sender_name, default_cc, poll_interval_minutes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        values
      );
    }
    res.json({ success: true, message: '邮箱设置已保存' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/settings/test', async (req, res) => {
  try {
    const settings = await getEmailSettings();
    if (!settings) return res.status(400).json({ success: false, error: '请先配置邮箱设置' });
    await mailer.verifySettings(settings);
    res.json({ success: true, message: 'SMTP 连接成功' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---- 模板（写作规范 / 固定模板） ----

router.get('/templates', async (req, res) => {
  try {
    const templates = await dbOperations.query('SELECT * FROM email_templates ORDER BY created_at DESC');
    res.json({ success: true, data: templates });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/templates/variables', async (req, res) => {
  res.json({ success: true, data: VARIABLE_LABELS });
});

function validateTemplateBody(body) {
  if (!body.name) return '模板名称为必填字段';
  if (body.kind && !TEMPLATE_KINDS.has(body.kind)) return '模板类型只能是 style_guide 或 fixed';
  if (!body.body_html) return '模板内容为必填字段';
  return null;
}

router.post('/templates', async (req, res) => {
  try {
    const invalid = validateTemplateBody(req.body || {});
    if (invalid) return res.status(400).json({ success: false, error: invalid });
    const { name, kind = 'fixed', subject = '', body_html } = req.body;
    const result = await dbOperations.run(
      'INSERT INTO email_templates (name, kind, subject, body_html, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
      [name, kind, subject, body_html]
    );
    res.json({ success: true, message: '模板创建成功', data: { id: result.id } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/templates/:id', async (req, res) => {
  try {
    const invalid = validateTemplateBody(req.body || {});
    if (invalid) return res.status(400).json({ success: false, error: invalid });
    const { name, kind = 'fixed', subject = '', body_html } = req.body;
    await dbOperations.run(
      'UPDATE email_templates SET name=?, kind=?, subject=?, body_html=?, updated_at=NOW() WHERE id=?',
      [name, kind, subject, body_html, req.params.id]
    );
    res.json({ success: true, message: '模板更新成功' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    await dbOperations.run('DELETE FROM email_templates WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: '模板删除成功' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---- 发送记录 ----

router.get('/records', async (req, res) => {
  try {
    const { status } = req.query || {};
    const conditions = [];
    const params = [];
    if (status) { conditions.push('er.status = ?'); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const totalRow = await dbOperations.get(`SELECT COUNT(*) AS total FROM email_records er ${where}`, params);
    const records = await dbOperations.query(
      `SELECT er.*, d.id AS draft_exists
       FROM email_records er
       LEFT JOIN email_drafts d ON d.id = er.draft_id
       ${where}
       ORDER BY er.created_at DESC
       LIMIT 200`,
      params
    );
    res.json({ success: true, data: { records, total: totalRow?.total || 0 } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
