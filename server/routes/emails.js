const express = require('express');
const { dbOperations } = require('../database');
const mailer = require('../services/mailer');
const emailDrafter = require('../services/emailDrafter');
const emailReviewActions = require('../services/emailReviewActions');
const emailDraftSender = require('../services/emailDraftSender');
const emailLiveSync = require('../services/emailLiveSync');
const emailMailboxes = require('../services/emailMailboxes');
const emailDashboardSummary = require('../services/emailDashboardSummary');
const emailFilterService = require('../services/emailFilterService');
const automationRuns = require('../services/automationRuns');
const { parseInboundBody } = require('../services/emailBodyParser');
const emailThreader = require('../services/emailThreader');
const emailThreadBackfill = require('../services/emailThreadBackfill');
const emailContextBuilder = require('../services/emailContextBuilder');

const router = express.Router();

function sendActionError(res, error) {
  return res.status(error.statusCode || 500).json({ success: false, error: error.message });
}

// ---- 邮箱配置（多邮箱） ----

const MASKED_SECRET = "••••••••";
const TEMPLATE_KINDS = new Set(['style_guide', 'fixed']);


// GET /api/emails/settings — 返回邮箱列表
router.get("/settings", async (req, res) => {
  try {
    const mailboxes = await emailMailboxes.listMailboxes();
    const data = mailboxes.map(m => ({
      ...m,
      password: m.password ? MASKED_SECRET : ""
    }));
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/emails/settings — 新增邮箱
router.post("/settings", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.username || !body.smtp_host) {
      return res.status(400).json({ success: false, error: "邮箱账号和 SMTP 服务器为必填" });
    }
    const all = await emailMailboxes.listMailboxes();
    const isFirst = all.length === 0;
    const result = await dbOperations.run(
      `INSERT INTO email_settings
       (smtp_host, smtp_port, smtp_secure, imap_host, imap_port, imap_secure,
        username, password, sender_name, default_cc, poll_interval_minutes, sync_mode,
        label, brand, is_default, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        body.smtp_host, Number(body.smtp_port) || 465, body.smtp_secure ? 1 : 0,
        body.imap_host || null, Number(body.imap_port) || 993, body.imap_secure ? 1 : 0,
        body.username, body.password || null,
        body.sender_name || null, body.default_cc || null,
        Number(body.poll_interval_minutes ?? 5),
        ["idle", "poll", "off"].includes(body.sync_mode) ? body.sync_mode : "idle",
        body.label || null,
        body.brand || null,
        isFirst ? 1 : 0,
        1
      ]
    );
    const mailbox = await emailMailboxes.getMailboxById(result.id);
    if (mailbox && mailbox.enabled && mailbox.imap_host && mailbox.sync_mode !== "off") {
      try { await emailLiveSync.restartEmailSync(); } catch (e) { /* ignore */ }
    }
    res.json({ success: true, data: { ...mailbox, password: MASKED_SECRET } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 共享的更新逻辑：保持密码未变时不覆盖，同时写入 label/enabled
async function updateMailboxRow(id, body) {
  const existing = await emailMailboxes.getMailboxById(id);
  if (!existing) throw Object.assign(new Error('邮箱不存在'), { statusCode: 404 });
  const password = body.password === MASKED_SECRET || body.password === undefined
    ? (existing.password || null)
    : body.password;
  const syncMode = ['idle', 'poll', 'off'].includes(body.sync_mode) ? body.sync_mode : (existing.sync_mode || 'idle');
  await dbOperations.run(
    `UPDATE email_settings SET smtp_host=?, smtp_port=?, smtp_secure=?, imap_host=?, imap_port=?, imap_secure=?,
     username=?, password=?, sender_name=?, default_cc=?, poll_interval_minutes=?, sync_mode=?,
     label=?, brand=?, enabled=?, updated_at=NOW() WHERE id=?`,
    [
      body.smtp_host || null, Number(body.smtp_port) || 465, body.smtp_secure ? 1 : 0,
      body.imap_host || null, Number(body.imap_port) || 993, body.imap_secure ? 1 : 0,
      body.username || null, password,
      body.sender_name || null, body.default_cc || null,
      Number(body.poll_interval_minutes ?? 5), syncMode,
      body.label !== undefined ? body.label : existing.label,
      body.brand !== undefined ? body.brand : existing.brand,
      body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
      id
    ]
  );
}

// PUT /api/emails/settings/:id — 更新指定邮箱
router.put('/settings/:id', async (req, res) => {
  try {
    await updateMailboxRow(Number(req.params.id), req.body || {});
    try { await emailLiveSync.restartEmailSync(Number(req.params.id)); } catch (e) { /* ignore */ }
    res.json({ success: true, message: '邮箱设置已保存，收信监听已重启' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// PUT /api/emails/settings（无 id，兼容旧接口）— 操作默认邮箱
router.put('/settings', async (req, res) => {
  try {
    const setting = await emailMailboxes.getDefaultMailbox();
    if (!setting) return res.status(400).json({ success: false, error: '请先配置邮箱设置' });
    await updateMailboxRow(setting.id, req.body || {});
    try { await emailLiveSync.restartEmailSync(setting.id); } catch (e) { /* ignore */ }
    res.json({ success: true, message: '邮箱设置已保存，收信监听已重启' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// DELETE /api/emails/settings/:id — 删除邮箱
router.delete("/settings/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await emailMailboxes.getMailboxById(id);
    if (!row) return res.status(404).json({ success: false, error: "邮箱不存在" });
    if (row.is_default) return res.status(409).json({ success: false, error: "不能删除默认邮箱，请先另设默认" });

    for (const table of ["email_drafts", "email_records", "email_replies", "email_threads"]) {
      const existing = await dbOperations.get(
        `SELECT id FROM ${table} WHERE mailbox_id = ? LIMIT 1`, [id]
      );
      if (existing) {
        return res.status(409).json({ success: false, error: "该邮箱有关联记录，请先停用而非删除" });
      }
    }

    await dbOperations.run("DELETE FROM email_settings WHERE id = ?", [id]);
    try { await emailLiveSync.restartEmailSync(); } catch (e) { /* ignore */ }
    res.json({ success: true, message: "邮箱已删除" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/emails/settings/:id/default — 设为默认邮箱
router.post("/settings/:id/default", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await emailMailboxes.getMailboxById(id);
    if (!row) return res.status(404).json({ success: false, error: "邮箱不存在" });
    await dbOperations.run("UPDATE email_settings SET is_default = 0");
    await dbOperations.run("UPDATE email_settings SET is_default = 1 WHERE id = ?", [id]);
    res.json({ success: true, message: "已设为默认邮箱" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/emails/settings/sync-status
router.get("/settings/sync-status", async (req, res) => {
  try {
    res.json({ success: true, data: await emailLiveSync.getEmailSyncStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/emails/settings/test-imap
router.post("/settings/test-imap", async (req, res) => {
  try {
    const id = req.body?.id;
    const settings = id ? await emailMailboxes.getMailboxById(id) : await emailMailboxes.getDefaultMailbox();
    if (!settings) return res.status(400).json({ success: false, error: "请先配置邮箱设置" });
    const info = await emailLiveSync.testImapConnection(settings.id);
    res.json({ success: true, message: "IMAP 连接成功（收件箱 " + info.exists + " 封邮件）", data: info });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/emails/settings/sync-now
router.post("/settings/sync-now", async (req, res) => {
  try {
    const id = req.body?.id;
    if (id) {
      const settings = await emailMailboxes.getMailboxById(id);
      if (!settings) return res.status(400).json({ success: false, error: "邮箱不存在" });
      const result = await emailLiveSync.syncNow(id);
      res.json({ success: true, message: "同步完成", data: result });
    } else {
      const result = await emailLiveSync.syncNow();
      res.json({ success: true, message: "同步完成", data: result });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/emails/settings/test
router.post("/settings/test", async (req, res) => {
  try {
    const id = req.body?.id;
    const settings = id ? await emailMailboxes.getMailboxById(id) : await emailMailboxes.getDefaultMailbox();
    if (!settings) return res.status(400).json({ success: false, error: "请先配置邮箱设置" });
    await mailer.verifySettings(settings);
    res.json({ success: true, message: "SMTP 连接成功" });
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
    const { status, campaign_id, mailbox_id } = req.query || {};
    const conditions = [];
    const params = [];
    if (status) { conditions.push('er.status = ?'); params.push(status); }
    if (campaign_id) { conditions.push('er.campaign_id = ?'); params.push(campaign_id); }
    if (mailbox_id) { conditions.push('er.mailbox_id = ?'); params.push(Number(mailbox_id)); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const totalRow = await dbOperations.get(`SELECT COUNT(*) AS total FROM email_records er ${where}`, params);
    const records = await dbOperations.query(
      `SELECT er.*, d.id AS draft_exists, ms.label AS mailbox_label, ms.username AS mailbox_username
       FROM email_records er
       LEFT JOIN email_drafts d ON d.id = er.draft_id
       LEFT JOIN email_settings ms ON ms.id = er.mailbox_id
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
    const { status, kind, risk_level, campaign_id, mailbox_id } = req.query || {};
    const conditions = [];
    const params = [];
    if (status) { conditions.push('d.status = ?'); params.push(status); }
    if (kind) { conditions.push('d.kind = ?'); params.push(kind); }
    if (risk_level) { conditions.push('d.risk_level = ?'); params.push(risk_level); }
    if (campaign_id) { conditions.push('d.campaign_id = ?'); params.push(campaign_id); }
    if (mailbox_id) { conditions.push('d.mailbox_id = ?'); params.push(Number(mailbox_id)); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const drafts = (await dbOperations.query(
      `SELECT d.*, k.name AS kol_name, k.email AS recipient_email, c.name AS campaign_name, ms.label AS mailbox_label, ms.username AS mailbox_username,
        (SELECT er.to_address FROM email_records er WHERE er.draft_id = d.id ORDER BY er.id DESC LIMIT 1) AS sent_to_address,
        (SELECT er.status FROM email_records er WHERE er.draft_id = d.id ORDER BY er.id DESC LIMIT 1) AS delivery_status,
        (SELECT er.error FROM email_records er WHERE er.draft_id = d.id ORDER BY er.id DESC LIMIT 1) AS delivery_error,
        (SELECT er.created_at FROM email_records er WHERE er.draft_id = d.id ORDER BY er.id DESC LIMIT 1) AS sent_at
       FROM email_drafts d
       LEFT JOIN customers k ON k.id = d.customer_id
       LEFT JOIN campaigns c ON c.id = d.campaign_id
       LEFT JOIN email_settings ms ON ms.id = d.mailbox_id
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

// ---- 审批台顶部指标卡：今日/本周联络 KOL、30天回复率 ----
// 只读统计接口，与审批列表解耦：失败时返回 200 + 占位 null，前端单独降级显示 —。
router.get('/approval-dashboard/summary', async (req, res) => {
  try {
    const summary = await emailDashboardSummary.buildSummary(dbOperations, new Date());
    res.json({ success: true, data: summary });
  } catch (error) {
    console.error('[email] approval dashboard summary failed:', error.message);
    console.error(error.stack);
    res.status(200).json({
      success: true,
      data: {
        todayContactedKols: null,
        weekContactedKols: null,
        previousWeekContactedKols: null,
        weekDifference: null,
        replyRate30d: null,
        repliedKols30d: null,
        deliveredKols30d: null,
        bounceRate30d: null,
        bouncedEmails30d: null,
        hardBounces30d: null,
        softBounces30d: null,
        sentEmails30d: null,
        denominatorType: 'sent_success',
        timezone: 'Asia/Shanghai',
        replyWindowDays: 30,
        generatedAt: new Date().toISOString(),
        error: error.message
      }
    });
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
    const { confirm_status, scope, campaign_id, mailbox_id } = req.query || {};
    const conditions = [];
    const params = [];
    if (scope === 'blocked') conditions.push("er.classification = 'spam'");
    else if (scope === 'system') conditions.push("er.classification = 'system'");
    else conditions.push("COALESCE(er.classification, 'needs_review') NOT IN ('spam', 'system')");
    if (scope === 'unmatched') conditions.push('er.customer_id IS NULL');
    if (campaign_id) {
      const campaignId = Number(campaign_id);
      if (!Number.isSafeInteger(campaignId) || campaignId <= 0) {
        return res.status(400).json({ success: false, error: 'campaign_id 必须是正整数' });
      }
      conditions.push('er.campaign_id = ?');
      params.push(campaignId);
    }
    if (scope === 'needs_reply') {
      conditions.push('ck.needs_reply = 1');
      conditions.push(`er.id = (
        SELECT er2.id FROM email_replies er2
        WHERE er2.campaign_id = er.campaign_id AND er2.customer_id = er.customer_id
          AND er2.confirm_status <> 'ignored'
        ORDER BY er2.received_at DESC, er2.id DESC LIMIT 1
      )`);
    }
    if (mailbox_id) { conditions.push('er.mailbox_id = ?'); params.push(Number(mailbox_id)); }
    if (confirm_status) { conditions.push('er.confirm_status = ?'); params.push(confirm_status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const replies = await dbOperations.query(
      `SELECT er.*, k.name AS kol_name, c.name AS campaign_name, ms.label AS mailbox_label, ms.username AS mailbox_username,
         eb.bounce_type, eb.recipient AS bounce_recipient, eb.status_code AS bounce_status_code,
         eb.reason AS bounce_reason, eb.email_record_id AS bounce_email_record_id
       FROM email_replies er
       LEFT JOIN customers k ON k.id = er.customer_id
       LEFT JOIN campaigns c ON c.id = er.campaign_id
       LEFT JOIN campaign_kols ck ON ck.campaign_id = er.campaign_id AND ck.customer_id = er.customer_id
       LEFT JOIN email_bounces eb ON eb.email_reply_id = er.id
       LEFT JOIN email_settings ms ON ms.id = er.mailbox_id
       ${where}
       ORDER BY er.received_at DESC
       LIMIT 200`,
      params
    );
    // 兼容修复上线前已存入数据库的原始 MIME 正文：仅 legacy/未标记的旧数据且尚未拆出
    // clean_body_text 时才重跑旧解析器补 body_text；新标准解析过的行直接返回。
    const normalizedReplies = replies.map((reply) => {
      const hasParsedBody = reply.clean_body_text !== null && reply.clean_body_text !== undefined;
      const isLegacy = !reply.parse_status || reply.parse_status === 'legacy';
      if (hasParsedBody || !isLegacy) return reply;
      return { ...reply, body_text: parseInboundBody(reply.body_text) };
    });
    res.json({ success: true, data: normalizedReplies });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/replies/:id/confirm', async (req, res) => {
  try {
    const result = await emailReviewActions.confirmReply(
      req.params.id, req.body?.summary, req.body?.intent, req.body?.actor || 'boss'
    );
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

router.post('/replies/:id/block', async (req, res) => {
  try {
    const blockScope = req.body?.block_scope;
    if (!['sender', 'domain'].includes(blockScope)) {
      return res.status(400).json({ success: false, error: '请选择屏蔽该邮箱或整个域名' });
    }
    const result = await emailFilterService.markSpam(req.params.id, {
      blockScope,
      handledBy: req.body?.handled_by || 'boss'
    });
    res.json({ success: true, message: '已标记为屏蔽', data: result });
  } catch (error) {
    sendActionError(res, error);
  }
});

router.post('/replies/:id/restore', async (req, res) => {
  try {
    await emailFilterService.restoreReply(req.params.id);
    res.json({ success: true, message: '邮件已恢复' });
  } catch (error) {
    sendActionError(res, error);
  }
});

router.get('/filter-rules', async (req, res) => {
  try {
    res.json({ success: true, data: await emailFilterService.listRules() });
  } catch (error) {
    sendActionError(res, error);
  }
});

router.post('/filter-rules', async (req, res) => {
  try {
    const data = await emailFilterService.addRule(req.body?.rule_type, req.body?.rule_value, req.body?.created_by || 'boss');
    res.json({ success: true, message: '屏蔽规则已添加', data });
  } catch (error) {
    sendActionError(res, error);
  }
});

router.put('/filter-rules/:id', async (req, res) => {
  try {
    const data = await emailFilterService.setRuleActive(req.params.id, Boolean(req.body?.active));
    res.json({ success: true, data });
  } catch (error) {
    sendActionError(res, error);
  }
});

router.delete('/filter-rules/:id', async (req, res) => {
  try {
    await emailFilterService.deleteRule(req.params.id);
    res.json({ success: true, message: '屏蔽规则已删除' });
  } catch (error) {
    sendActionError(res, error);
  }
});

router.post('/replies/:id/manually-replied', async (req, res) => {
  try {
    const result = await emailReviewActions.markReplyManuallyHandled(
      req.params.id,
      req.body?.handled_by || 'boss'
    );
    res.json({ success: true, message: '已标记为人工回复', data: result });
  } catch (error) {
    sendActionError(res, error);
  }
});

router.post('/replies/:id/retry-summary', async (req, res) => {
  try {
    const reply = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [req.params.id]);
    if (!reply) return res.status(404).json({ success: false, error: '回复不存在' });
    const { summarizeReply } = require('../services/emailReplyPoller');
    const result = await summarizeReply(reply.id);
    const updated = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [req.params.id]);
    if (!result?.success) {
      return res.status(502).json({ success: false, error: result?.error || 'AI 摘要失败', data: updated });
    }
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
      kind: 'reply', sourceReplyId: reply.id
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
    if (campaignId) {
      const campaignKol = await dbOperations.get(
        'SELECT id FROM campaign_kols WHERE campaign_id = ? AND customer_id = ?',
        [campaignId, customerId]
      );
      if (!campaignKol) {
        return res.status(409).json({ success: false, error: '该达人不在当前项目中，请先添加到项目' });
      }
    }
    if (!campaignId) {
      const kol = await dbOperations.get(
        'SELECT campaign_id FROM campaign_kols WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 1',
        [customerId]
      );
      campaignId = kol?.campaign_id || null;
      if (!campaignId) {
        return res.status(409).json({ success: false, error: '该达人不在任何项目中，请先添加到项目后再绑定' });
      }
    }

    await dbOperations.run(
      'UPDATE email_replies SET customer_id = ?, campaign_id = ?, updated_at = NOW() WHERE id = ?',
      [customerId, campaignId, reply.id]
    );
    await require('../services/emailReplyPoller').markWaitingReply(campaignId, customerId);
    // 绑定后补 AI 摘要（未识别回复此前不做摘要，避免广告消耗 AI）
    const { summarizeReply } = require('../services/emailReplyPoller');
    summarizeReply(reply.id).catch(() => {});

    const updated = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [reply.id]);
    res.json({ success: true, message: '已绑定 KOL', data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---- 邮件会话（thread） ----

// 管理员触发历史回填：同步执行，默认每类最多扫 500 条；dry_run=true 只预演不落库
router.post('/reparse', async (req, res) => {
  try {
    const limit = Number(req.body?.limit) || 500;
    const dryRun = Boolean(req.body?.dry_run);
    const stats = await emailThreadBackfill.runBackfill({ limit, dryRun });
    res.json({ success: true, message: dryRun ? '回填预演完成（未写入）' : '历史回填完成', data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 人工归属：把回复绑到指定项目/KOL/会话
router.post('/replies/:id/reassign', async (req, res) => {
  try {
    const result = await emailThreader.reassignReply(req.params.id, {
      campaignId: Number(req.body?.campaign_id) || null,
      customerId: Number(req.body?.customer_id) || null,
      threadId: Number(req.body?.thread_id) || null
    });
    res.json({ success: true, message: '已重新归属', data: { thread_id: result.threadId } });
  } catch (error) {
    sendActionError(res, error);
  }
});

// 会话列表：按项目/KOL 过滤；needs_reply=1 只列有待回复来信的会话（复用 campaign_kols.needs_reply 待办标记）
router.get('/threads', async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const conditions = [];
    const params = [];
    if (req.query.campaign_id) {
      conditions.push('t.campaign_id = ?');
      params.push(Number(req.query.campaign_id));
    }
    if (req.query.customer_id) {
      conditions.push('t.customer_id = ?');
      params.push(Number(req.query.customer_id));
    }
    if (req.query.needs_reply === '1' || req.query.needs_reply === 'true') {
      conditions.push(`EXISTS (
        SELECT 1 FROM campaign_kols ck
        WHERE ck.campaign_id = t.campaign_id AND ck.customer_id = t.customer_id AND ck.needs_reply = 1
      )`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const totalRow = await dbOperations.get(`SELECT COUNT(*) AS total FROM email_threads t ${where}`, params);
    const threads = await dbOperations.query(
      `SELECT t.*, c.name AS campaign_name, cu.name AS customer_name, cu.email AS customer_email
       FROM email_threads t
       LEFT JOIN campaigns c ON c.id = t.campaign_id
       LEFT JOIN customers cu ON cu.id = t.customer_id
       ${where}
       ORDER BY t.last_message_at DESC, t.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    // 每页会话补充最后一封消息（收发两侧取较新者），供列表展示双方标识与摘要
    const items = [];
    for (const thread of threads) {
      const lastReply = await dbOperations.get(
        `SELECT id, subject, from_address, received_at, ai_summary, clean_body_text, body_text, confirm_status
         FROM email_replies WHERE thread_id = ? ORDER BY received_at DESC, id DESC LIMIT 1`,
        [thread.id]
      );
      const lastRecord = await dbOperations.get(
        `SELECT id, subject, to_address, created_at, body_text
         FROM email_records WHERE thread_id = ? AND status = 'success' ORDER BY created_at DESC, id DESC LIMIT 1`,
        [thread.id]
      );
      let lastMessage = null;
      if (lastReply && (!lastRecord || new Date(lastReply.received_at) >= new Date(lastRecord.created_at))) {
        lastMessage = {
          direction: 'inbound',
          at: lastReply.received_at,
          subject: lastReply.subject,
          from: lastReply.from_address,
          confirm_status: lastReply.confirm_status,
          summary: lastReply.ai_summary || String(lastReply.clean_body_text || lastReply.body_text || '').slice(0, 120)
        };
      } else if (lastRecord) {
        lastMessage = {
          direction: 'outbound',
          at: lastRecord.created_at,
          subject: lastRecord.subject,
          to: lastRecord.to_address,
          summary: String(lastRecord.body_text || '').slice(0, 120)
        };
      }
      items.push({ ...thread, last_message: lastMessage });
    }
    res.json({ success: true, data: { total: totalRow?.total || 0, page, pageSize, items } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 会话详情：thread 信息 + 合并时间线 + 当前待审草稿 + 项目/KOL 基本信息
router.get('/threads/:id', async (req, res) => {
  try {
    const thread = await dbOperations.get('SELECT * FROM email_threads WHERE id = ?', [req.params.id]);
    if (!thread) return res.status(404).json({ success: false, error: '会话不存在' });
    const timeline = await emailContextBuilder.loadThreadTimeline(thread.id);
    const campaign = thread.campaign_id
      ? await dbOperations.get('SELECT id, name, brand, product, status, period FROM campaigns WHERE id = ?', [thread.campaign_id])
      : null;
    const customer = thread.customer_id
      ? await dbOperations.get('SELECT id, name, email, platform, country_region FROM customers WHERE id = ?', [thread.customer_id])
      : null;
    const pendingDraft = await dbOperations.get(
      `SELECT id, kind, subject, body_text, status, risk_level, source_reply_id,
              reply_to_message_id, context_message_ids, context_summary_snapshot, generated_at, updated_at
       FROM email_drafts WHERE thread_id = ? AND status = 'pending_review' ORDER BY id DESC LIMIT 1`,
      [thread.id]
    );
    res.json({ success: true, data: { thread, campaign, customer, timeline, pending_draft: pendingDraft || null } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 会话内起草回复：默认针对最新来信，可指定 reply_id；已有待审草稿时复用（dedupe 在 drafter 内）
router.post('/threads/:id/draft-reply', async (req, res) => {
  try {
    const thread = await dbOperations.get('SELECT * FROM email_threads WHERE id = ?', [req.params.id]);
    if (!thread) return res.status(404).json({ success: false, error: '会话不存在' });
    let reply;
    if (req.body?.reply_id) {
      reply = await dbOperations.get(
        'SELECT * FROM email_replies WHERE id = ? AND thread_id = ?',
        [Number(req.body.reply_id), thread.id]
      );
      if (!reply) return res.status(404).json({ success: false, error: '该来信不在此会话中' });
    } else {
      reply = await dbOperations.get(
        'SELECT * FROM email_replies WHERE thread_id = ? ORDER BY received_at DESC, id DESC LIMIT 1',
        [thread.id]
      );
      if (!reply) return res.status(400).json({ success: false, error: '该会话暂无来信，无法起草回复' });
    }
    const result = await emailDrafter.draftForCustomer({
      campaignId: thread.campaign_id,
      customerId: thread.customer_id,
      kind: 'reply',
      sourceReplyId: reply.id,
      feedback: req.body?.feedback || null
    });
    if (!result.ok) return res.status(500).json({ success: false, error: result.error });
    res.json({
      success: true,
      message: result.skipped ? '已有草稿，复用现有' : '回复草稿已生成，请到审批台审阅',
      data: { draftId: result.draftId }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 手动刷新会话滚动摘要；AI 失败时返回当前已存摘要，不报错
router.post('/threads/:id/context/refresh', async (req, res) => {
  try {
    const result = await emailContextBuilder.generateThreadSummary(Number(req.params.id));
    if (result) {
      return res.json({
        success: true,
        message: result.updated ? '会话摘要已更新' : '会话摘要已是最新',
        data: { context_summary: result.summary, summary_through_message_id: result.throughMessageId }
      });
    }
    const thread = await dbOperations.get(
      'SELECT context_summary, summary_through_message_id FROM email_threads WHERE id = ?',
      [req.params.id]
    );
    res.json({
      success: true,
      message: 'AI 摘要生成失败，返回现有摘要',
      data: { context_summary: thread?.context_summary || null, summary_through_message_id: thread?.summary_through_message_id || null }
    });
  } catch (error) {
    sendActionError(res, error);
  }
});

module.exports = router;
