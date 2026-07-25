const express = require('express');
const { dbOperations } = require('../database');
const mailer = require('../services/mailer');
const emailDrafter = require('../services/emailDrafter');
const emailReviewActions = require('../services/emailReviewActions');

const router = express.Router();

function sendActionError(res, error) {
  return res.status(error.statusCode || 500).json({ success: false, error: error.message });
}

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

// ---- 草稿（审批台） ----

const DRAFT_KINDS = new Set(['first_touch', 'follow_up', 'reply']);

function parseDraftJson(draft) {
  if (!draft) return draft;
  const parse = (v, fallback) => {
    if (!v) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
  };
  return { ...draft, risk_reasons: parse(draft.risk_reasons, []), evidence: parse(draft.evidence, null) };
}

async function resolveCustomerEmail(customerId) {
  const customer = await dbOperations.get('SELECT id, name, email FROM customers WHERE id = ?', [customerId]);
  return customer;
}

router.post('/drafts/generate', async (req, res) => {
  try {
    const { campaign_id, customer_ids, kind = 'first_touch' } = req.body || {};
    if (!campaign_id || !Array.isArray(customer_ids) || !customer_ids.length) {
      return res.status(400).json({ success: false, error: '请提供 campaign_id 和 customer_ids' });
    }
    if (!DRAFT_KINDS.has(kind)) return res.status(400).json({ success: false, error: '无效的草稿类型' });
    const results = await emailDrafter.draftBatch(
      customer_ids.map((customerId) => ({ campaignId: campaign_id, customerId, kind }))
    );
    res.json({ success: true, data: { results } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/drafts', async (req, res) => {
  try {
    const { status, kind, risk_level, campaign_id } = req.query || {};
    const conditions = [];
    const params = [];
    if (status) { conditions.push('d.status = ?'); params.push(status); }
    if (kind) { conditions.push('d.kind = ?'); params.push(kind); }
    if (risk_level) { conditions.push('d.risk_level = ?'); params.push(risk_level); }
    if (campaign_id) { conditions.push('d.campaign_id = ?'); params.push(campaign_id); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const drafts = (await dbOperations.query(
      `SELECT d.*, k.name AS kol_name, c.name AS campaign_name
       FROM email_drafts d
       LEFT JOIN customers k ON k.id = d.customer_id
       LEFT JOIN campaigns c ON c.id = d.campaign_id
       ${where}
       ORDER BY d.generated_at DESC
       LIMIT 200`,
      params
    )).map(parseDraftJson);
    const all = drafts; // 计数基于当前过滤结果（计数口径与列表一致）
    res.json({
      success: true,
      data: {
        drafts: all,
        counts: {
          pending_review: all.filter((d) => d.status === 'pending_review').length,
          high_risk: all.filter((d) => d.status === 'pending_review' && d.risk_level === 'high').length,
          approved: all.filter((d) => d.status === 'approved').length
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/drafts/:id', async (req, res) => {
  try {
    const draft = await dbOperations.get(
      `SELECT d.*, k.name AS kol_name, c.name AS campaign_name
       FROM email_drafts d
       LEFT JOIN customers k ON k.id = d.customer_id
       LEFT JOIN campaigns c ON c.id = d.campaign_id
       WHERE d.id = ?`,
      [req.params.id]
    );
    if (!draft) return res.status(404).json({ success: false, error: '草稿不存在' });
    res.json({ success: true, data: parseDraftJson(draft) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/drafts/:id', async (req, res) => {
  try {
    const draft = await dbOperations.get('SELECT * FROM email_drafts WHERE id = ?', [req.params.id]);
    if (!draft) return res.status(404).json({ success: false, error: '草稿不存在' });
    if (draft.status !== 'pending_review') {
      return res.status(409).json({ success: false, error: '仅待审阅状态可编辑' });
    }
    const { subject, body_text } = req.body || {};
    if (!subject || !body_text) return res.status(400).json({ success: false, error: '主题和正文为必填' });
    await dbOperations.run(
      `INSERT INTO email_draft_versions (draft_id, subject, body_text, source, created_at) VALUES (?, ?, ?, 'human', NOW())`,
      [draft.id, subject, body_text]
    );
    await dbOperations.run(
      'UPDATE email_drafts SET subject = ?, body_text = ?, updated_at = NOW() WHERE id = ?',
      [subject, body_text, draft.id]
    );
    res.json({ success: true, message: '已保存' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/drafts/:id/regenerate', async (req, res) => {
  try {
    const draft = await dbOperations.get('SELECT * FROM email_drafts WHERE id = ?', [req.params.id]);
    if (!draft) return res.status(404).json({ success: false, error: '草稿不存在' });
    if (draft.status !== 'pending_review') {
      return res.status(409).json({ success: false, error: '仅待审阅状态可重新生成' });
    }
    const feedback = (req.body?.feedback || '').trim() || null;
    await dbOperations.run(
      `INSERT INTO email_draft_versions (draft_id, subject, body_text, source, feedback, created_at)
       VALUES (?, ?, ?, 'regenerate', ?, NOW())`,
      [draft.id, draft.subject, draft.body_text, feedback]
    );
    const result = await emailDrafter.draftForCustomer({
      campaignId: draft.campaign_id, customerId: draft.customer_id,
      kind: draft.kind, sourceReplyId: draft.source_reply_id, feedback, draftId: draft.id
    });
    if (!result.ok) return res.status(500).json({ success: false, error: result.error });
    const updated = await dbOperations.get('SELECT * FROM email_drafts WHERE id = ?', [draft.id]);
    res.json({ success: true, data: parseDraftJson(updated) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/drafts/:id/approve', async (req, res) => {
  try {
    await emailReviewActions.approveDraft(req.params.id);
    res.json({ success: true, message: '已批准' });
  } catch (error) {
    sendActionError(res, error);
  }
});

router.post('/drafts/:id/reject', async (req, res) => {
  try {
    await emailReviewActions.rejectDraft(req.params.id, req.body?.reason);
    res.json({ success: true, message: '已驳回' });
  } catch (error) {
    sendActionError(res, error);
  }
});

router.post('/drafts/:id/send', async (req, res) => {
  try {
    const draft = await dbOperations.get('SELECT * FROM email_drafts WHERE id = ?', [req.params.id]);
    if (!draft) return res.status(404).json({ success: false, error: '草稿不存在' });
    if (draft.status !== 'approved') {
      return res.status(409).json({ success: false, error: '草稿未批准，不能发送' });
    }

    const settings = await getEmailSettings();
    if (!settings) return res.status(400).json({ success: false, error: '请先配置邮箱设置' });

    const customer = await resolveCustomerEmail(draft.customer_id);
    if (!customer?.email) {
      await dbOperations.run(`UPDATE email_drafts SET status = 'send_failed', updated_at = NOW() WHERE id = ?`, [draft.id]);
      return res.status(400).json({ success: false, error: '达人无邮箱地址' });
    }

    try {
      const { messageId } = await mailer.sendMail({
        settings,
        to: customer.email,
        cc: mailer.parseCc(settings.default_cc),
        subject: draft.subject,
        text: draft.body_text
      });
      await dbOperations.run(
        `INSERT INTO email_records
         (draft_id, campaign_id, customer_id, kol_name, to_address, cc, subject, body_text, status, smtp_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', ?, NOW())`,
        [draft.id, draft.campaign_id, draft.customer_id, customer.name, customer.email,
         mailer.parseCc(settings.default_cc).join(',') || null, draft.subject, draft.body_text, messageId]
      );
      await dbOperations.run(`UPDATE email_drafts SET status = 'sent', updated_at = NOW() WHERE id = ?`, [draft.id]);
      // 回写 campaign_kols：按 campaign_id + customer_id 定位
      await dbOperations.run(
        `UPDATE campaign_kols SET outreach_status = ?, last_outreach_at = NOW(),
         sync_status = 'sync_pending', updated_at = NOW()
         WHERE campaign_id = ? AND customer_id = ?`,
        ['contacted', draft.campaign_id, draft.customer_id]
      );
      res.json({ success: true, message: '发送成功' });
    } catch (sendError) {
      await dbOperations.run(
        `INSERT INTO email_records
         (draft_id, campaign_id, customer_id, kol_name, to_address, subject, body_text, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, NOW())`,
        [draft.id, draft.campaign_id, draft.customer_id, customer.name, customer.email,
         draft.subject, draft.body_text, sendError.message]
      );
      await dbOperations.run(`UPDATE email_drafts SET status = 'send_failed', updated_at = NOW() WHERE id = ?`, [draft.id]);
      res.status(500).json({ success: false, error: `发送失败：${sendError.message}` });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---- 回复 ----

router.get('/replies', async (req, res) => {
  try {
    const { confirm_status } = req.query || {};
    const conditions = [];
    const params = [];
    if (confirm_status) { conditions.push('er.confirm_status = ?'); params.push(confirm_status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const replies = await dbOperations.query(
      `SELECT er.*, k.name AS kol_name, c.name AS campaign_name
       FROM email_replies er
       LEFT JOIN customers k ON k.id = er.customer_id
       LEFT JOIN campaigns c ON c.id = er.campaign_id
       ${where}
       ORDER BY er.received_at DESC
       LIMIT 200`,
      params
    );
    res.json({ success: true, data: replies });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/replies/:id/confirm', async (req, res) => {
  try {
    const result = await emailReviewActions.confirmReply(req.params.id, req.body?.summary);
    res.json({ success: true, message: '已确认', data: result });
  } catch (error) {
    sendActionError(res, error);
  }
});

router.post('/replies/:id/ignore', async (req, res) => {
  try {
    await emailReviewActions.ignoreReply(req.params.id);
    res.json({ success: true, message: '已忽略' });
  } catch (error) {
    sendActionError(res, error);
  }
});

router.post('/replies/:id/retry-summary', async (req, res) => {
  try {
    const reply = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [req.params.id]);
    if (!reply) return res.status(404).json({ success: false, error: '回复不存在' });
    const { summarizeReply } = require('../services/emailReplyPoller');
    await summarizeReply(reply.id);
    const updated = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/replies/:id/draft-reply', async (req, res) => {
  try {
    const reply = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [req.params.id]);
    if (!reply) return res.status(404).json({ success: false, error: '回复不存在' });
    const result = await emailDrafter.draftForCustomer({
      campaignId: reply.campaign_id, customerId: reply.customer_id,
      kind: 'reply', sourceReplyId: reply.id,
      feedback: `对方回复内容：${(reply.body_text || '').slice(0, 2000)}`
    });
    if (!result.ok) return res.status(500).json({ success: false, error: result.error });
    res.json({ success: true, message: '回复草稿已生成，请到审批台审阅', data: { draftId: result.draftId } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
