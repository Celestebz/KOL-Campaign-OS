const express = require('express');
const { dbOperations } = require('../database');
const mailer = require('../services/mailer');
const emailDrafter = require('../services/emailDrafter');
const emailReviewActions = require('../services/emailReviewActions');
const emailDraftSender = require('../services/emailDraftSender');
const emailLiveSync = require('../services/emailLiveSync');
const automationRuns = require('../services/automationRuns');

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
    const syncMode = ['idle', 'poll', 'off'].includes(body.sync_mode) ? body.sync_mode : (existing?.sync_mode || 'idle');
    const values = [
      body.smtp_host || null, Number(body.smtp_port) || 465, body.smtp_secure === undefined ? 1 : (body.smtp_secure ? 1 : 0),
      body.imap_host || null, Number(body.imap_port) || 993, body.imap_secure === undefined ? 1 : (body.imap_secure ? 1 : 0),
      body.username || null, password,
      body.sender_name || null, body.default_cc || null,
      Number(body.poll_interval_minutes ?? 5),
      syncMode
    ];
    if (existing) {
      await dbOperations.run(
        `UPDATE email_settings SET smtp_host=?, smtp_port=?, smtp_secure=?, imap_host=?, imap_port=?, imap_secure=?,
         username=?, password=?, sender_name=?, default_cc=?, poll_interval_minutes=?, sync_mode=?, updated_at=NOW() WHERE id=?`,
        [...values, existing.id]
      );
    } else {
      await dbOperations.run(
        `INSERT INTO email_settings (smtp_host, smtp_port, smtp_secure, imap_host, imap_port, imap_secure,
         username, password, sender_name, default_cc, poll_interval_minutes, sync_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        values
      );
    }
    // 修改邮箱配置后自动重启监听，无须重启整个系统
    try {
      await emailLiveSync.restartEmailSync();
    } catch (error) {
      console.error('[email] 重启收信监听失败:', error.message);
    }
    res.json({ success: true, message: '邮箱设置已保存，收信监听已重启' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/settings/sync-status', async (req, res) => {
  try {
    res.json({ success: true, data: emailLiveSync.getEmailSyncStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/settings/test-imap', async (req, res) => {
  try {
    const info = await emailLiveSync.testImapConnection();
    res.json({ success: true, message: `IMAP 连接成功（收件箱 ${info.exists} 封邮件）`, data: info });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/settings/sync-now', async (req, res) => {
  try {
    const result = await emailLiveSync.syncNow();
    res.json({
      success: true,
      message: `同步完成：新收 ${result.fetched}，匹配 ${result.matched}，未识别 ${result.unmatched}`,
      data: result
    });
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
    const { status, campaign_id } = req.query || {};
    const conditions = [];
    const params = [];
    if (status) { conditions.push('er.status = ?'); params.push(status); }
    if (campaign_id) { conditions.push('er.campaign_id = ?'); params.push(campaign_id); }
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

// 批量起草（阶段 D）：去重守卫 + 后台异步执行。
// 同 campaign 同达人同 kind 已存在 pending_review 草稿的达人直接跳过（防重复点击生成重复草稿）；
// 其余立即建行 automation_runs 并返回 run_id，起草由 setImmediate 后台执行，
// 进度与结果经 GET /api/automation-runs/:id 轮询；全部跳过时不建 run，run_id 为 null。
router.post('/drafts/generate', async (req, res) => {
  try {
    const { campaign_id, customer_ids, kind = 'first_touch' } = req.body || {};
    if (!campaign_id || !Array.isArray(customer_ids) || !customer_ids.length) {
      return res.status(400).json({ success: false, error: '请提供 campaign_id 和 customer_ids' });
    }
    if (!DRAFT_KINDS.has(kind)) return res.status(400).json({ success: false, error: '无效的草稿类型' });

    const placeholders = customer_ids.map(() => '?').join(', ');
    const existingRows = await dbOperations.query(
      `SELECT DISTINCT customer_id FROM email_drafts
       WHERE campaign_id = ? AND kind = ? AND status = 'pending_review' AND customer_id IN (${placeholders})`,
      [campaign_id, kind, ...customer_ids]
    );
    const existingSet = new Set(existingRows.map((row) => Number(row.customer_id)));
    const skipped = [];
    const queuedIds = [];
    for (const customerId of customer_ids) {
      if (existingSet.has(Number(customerId))) {
        skipped.push({ customer_id: customerId, reason: '已存在待审阅的同类型草稿' });
      } else {
        queuedIds.push(customerId);
      }
    }

    if (!queuedIds.length) {
      return res.json({
        success: true,
        data: { run_id: null, total_requested: customer_ids.length, queued: 0, skipped }
      });
    }

    const run = await automationRuns.createRun({
      run_type: 'email_draft_batch',
      campaign_id,
      subject_type: 'campaign',
      subject_id: campaign_id,
      current_node: 'draft',
      idempotency_key: `email_draft_batch:${campaign_id}:${kind}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
      total: queuedIds.length
    });
    res.json({
      success: true,
      data: { run_id: run.id, total_requested: customer_ids.length, queued: queuedIds.length, skipped }
    });
    const items = queuedIds.map((customerId) => ({ campaignId: campaign_id, customerId, kind }));
    setImmediate(() => {
      automationRuns.executeEmailDraftBatch(run.id, items).catch((error) => {
        console.error(`批量邮件起草后台执行失败 (run ${run.id}):`, error.message);
      });
    });
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
      `SELECT d.*, k.name AS kol_name, k.email AS recipient_email, c.name AS campaign_name
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
      `SELECT d.*, k.name AS kol_name, k.email AS recipient_email, c.name AS campaign_name
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
    const result = await emailDraftSender.sendApprovedDraft(req.params.id);
    res.json({ success: true, message: '发送成功', data: result });
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
    const result = await emailDraftSender.sendApprovedDraft(req.params.id);
    res.json({ success: true, message: '发送成功', data: result });
  } catch (error) {
    sendActionError(res, error);
  }
});

router.post('/drafts/:id/confirm-manual-sent', async (req, res) => {
  try {
    const result = await emailDraftSender.confirmManuallySent(req.params.id);
    res.json({ success: true, message: '已标记为手动发送', data: result });
  } catch (error) {
    sendActionError(res, error);
  }
});

router.post('/drafts/:id/confirm-not-sent', async (req, res) => {
  try {
    const result = await emailDraftSender.confirmNotSent(req.params.id);
    res.json({ success: true, message: '已恢复为待审阅', data: result });
  } catch (error) {
    sendActionError(res, error);
  }
});

// ---- 回复 ----

router.get('/replies', async (req, res) => {
  try {
    const { confirm_status, scope } = req.query || {};
    const conditions = [];
    const params = [];
    if (scope === 'unmatched') conditions.push('er.customer_id IS NULL');
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

router.post('/replies/:id/bind', async (req, res) => {
  try {
    const reply = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [req.params.id]);
    if (!reply) return res.status(404).json({ success: false, error: '回复不存在' });

    const customerId = Number(req.body?.customer_id);
    if (!Number.isSafeInteger(customerId) || customerId <= 0) {
      return res.status(400).json({ success: false, error: 'customer_id 为必填字段' });
    }
    const customer = await dbOperations.get('SELECT id FROM customers WHERE id = ?', [customerId]);
    if (!customer) return res.status(404).json({ success: false, error: 'KOL 不存在' });

    // 未显式指定项目时，归属到该 KOL 最近的项目关系
    let campaignId = Number(req.body?.campaign_id) || null;
    if (!campaignId) {
      const kol = await dbOperations.get(
        'SELECT campaign_id FROM campaign_kols WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 1',
        [customerId]
      );
      campaignId = kol?.campaign_id || null;
    }

    await dbOperations.run(
      'UPDATE email_replies SET customer_id = ?, campaign_id = ?, updated_at = NOW() WHERE id = ?',
      [customerId, campaignId, reply.id]
    );
    // 绑定后补 AI 摘要（未识别回复此前不做摘要，避免广告消耗 AI）
    const { summarizeReply } = require('../services/emailReplyPoller');
    summarizeReply(reply.id).catch(() => {});

    const updated = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [reply.id]);
    res.json({ success: true, message: '已绑定 KOL', data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
