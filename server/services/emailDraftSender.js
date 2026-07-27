const { dbOperations } = require('../database');
const mailer = require('./mailer');

function actionError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// sending 恢复安全时限：大于 mailer 全部超时之和（connection/greeting/socket ≈ 75s），
// 超过它，在途 SMTP 请求必定已经尘埃落定，恢复待审阅不会再与原请求竞争。
const SENDING_RECOVERY_TIMEOUT_MS = 2 * 60 * 1000;

// 状态回写一律带 status='sending' 条件：人工已确认的结果不会被迟到的回写覆盖。
async function markFailed(draftId) {
  await dbOperations.run(
    `UPDATE email_drafts SET status = 'send_failed', updated_at = NOW() WHERE id = ? AND status = 'sending'`,
    [draftId]
  );
}

async function markUnknown(draftId) {
  await dbOperations.run(
    `UPDATE email_drafts SET status = 'send_unknown', updated_at = NOW() WHERE id = ? AND status = 'sending'`,
    [draftId]
  );
}

function isAmbiguousSendError(error) {
  const code = String(error?.code || '').toUpperCase();
  const command = String(error?.command || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return ['ETIMEDOUT', 'ESOCKET', 'ECONNRESET'].includes(code)
    || command === 'DATA'
    || message.includes('timeout')
    || message.includes('timed out');
}

async function sendApprovedDraft(draftId) {
  const claim = await dbOperations.run(
    `UPDATE email_drafts SET status = 'sending', updated_at = NOW()
     WHERE id = ? AND status IN ('approved', 'send_failed')`,
    [draftId]
  );

  if (claim.changes !== 1) {
    const current = await dbOperations.get('SELECT status FROM email_drafts WHERE id = ?', [draftId]);
    if (!current) throw actionError('草稿不存在', 404);
    if (current.status === 'sent') throw actionError('该邮件已经发送，请勿重复操作', 409);
    if (current.status === 'sending') throw actionError('该邮件正在发送，请勿重复操作', 409);
    if (current.status === 'send_unknown') throw actionError('发送结果尚未确认，为避免重复投递，请先到邮箱发件箱核实', 409);
    throw actionError('仅已批准或发送失败的草稿可发送', 409);
  }

  const draft = await dbOperations.get('SELECT * FROM email_drafts WHERE id = ?', [draftId]);
  const settings = await dbOperations.get('SELECT * FROM email_settings ORDER BY id LIMIT 1');
  if (!settings) {
    await markFailed(draft.id);
    throw actionError('请先配置邮箱设置', 400);
  }

  const customer = await dbOperations.get(
    'SELECT id, name, email FROM customers WHERE id = ?',
    [draft.customer_id]
  );
  if (!customer?.email) {
    await markFailed(draft.id);
    throw actionError('达人无邮箱地址', 400);
  }

  const cc = mailer.parseCc(settings.default_cc);
  let messageId;
  try {
    ({ messageId } = await mailer.sendMail({
      settings,
      to: customer.email,
      cc,
      subject: draft.subject,
      text: draft.body_text
    }));
  } catch (sendError) {
    const ambiguous = isAmbiguousSendError(sendError);
    await dbOperations.run(
      `INSERT INTO email_records
       (draft_id, campaign_id, customer_id, kol_name, to_address, subject, body_text, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, NOW())`,
      [draft.id, draft.campaign_id, draft.customer_id, customer.name, customer.email,
       draft.subject, draft.body_text, sendError.message]
    );
    if (ambiguous) {
      await markUnknown(draft.id);
      throw actionError(`发送结果待确认：${sendError.message}。请先检查邮箱发件箱，系统不会自动重发`, 504);
    }
    await markFailed(draft.id);
    throw actionError(`发送失败：${sendError.message}`, 500);
  }

  // SMTP 已接受邮件后不再把草稿标成可重试，避免数据库回写异常导致重复外发。
  await dbOperations.run(
      `INSERT INTO email_records
       (draft_id, campaign_id, customer_id, kol_name, to_address, cc, subject, body_text, status, smtp_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', ?, NOW())`,
    [draft.id, draft.campaign_id, draft.customer_id, customer.name, customer.email,
     cc.join(',') || null, draft.subject, draft.body_text, messageId]
  );
  await dbOperations.run(
    `UPDATE email_drafts SET status = 'sent', updated_at = NOW()
     WHERE id = ? AND status = 'sending'`,
    [draft.id]
  );
  await dbOperations.run(
    `UPDATE campaign_kols SET outreach_status = ?, last_outreach_at = NOW(),
     sync_status = 'sync_pending', updated_at = NOW()
     WHERE campaign_id = ? AND customer_id = ?`,
    ['contacted', draft.campaign_id, draft.customer_id]
  );
  return { draft_id: draft.id, message_id: messageId, to: customer.email };
}

async function confirmManuallySent(draftId) {
  const draft = await dbOperations.get('SELECT * FROM email_drafts WHERE id = ?', [draftId]);
  if (!draft) throw actionError('草稿不存在', 404);
  if (!['sending', 'send_unknown'].includes(draft.status)) {
    throw actionError('仅发送中或发送结果待确认的草稿可人工确认', 409);
  }

  const customer = await dbOperations.get(
    'SELECT id, name, email FROM customers WHERE id = ?',
    [draft.customer_id]
  );
  const note = '已由人工确认通过网页邮箱发送';
  const updated = await dbOperations.run(
    `UPDATE email_drafts SET status = 'sent', reviewer_note = CONCAT_WS('\n', NULLIF(reviewer_note, ''), ?), updated_at = NOW()
     WHERE id = ? AND status IN ('sending', 'send_unknown')`,
    [note, draft.id]
  );
  if (updated.changes !== 1) throw actionError('草稿状态已变化，请刷新后重试', 409);

  await dbOperations.run(
    `INSERT INTO email_records
     (draft_id, campaign_id, customer_id, kol_name, to_address, subject, body_text, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'success', ?, NOW())`,
    [draft.id, draft.campaign_id, draft.customer_id, customer?.name || null, customer?.email || null,
     draft.subject, draft.body_text, note]
  );
  await dbOperations.run(
    `UPDATE campaign_kols SET outreach_status = ?, last_outreach_at = NOW(),
     sync_status = 'sync_pending', updated_at = NOW()
     WHERE campaign_id = ? AND customer_id = ?`,
    ['contacted', draft.campaign_id, draft.customer_id]
  );
  return { draft_id: draft.id, manually_confirmed: true, to: customer?.email || null };
}

async function confirmNotSent(draftId) {
  const draft = await dbOperations.get('SELECT * FROM email_drafts WHERE id = ?', [draftId]);
  if (!draft) throw actionError('草稿不存在', 404);
  if (draft.status === 'sending') {
    // 原 SMTP 请求可能仍在途：未超过安全时限不允许恢复，否则重新发送会与其竞争出重复邮件
    const elapsed = Date.now() - new Date(draft.updated_at).getTime();
    if (Number.isFinite(elapsed) && elapsed < SENDING_RECOVERY_TIMEOUT_MS) {
      throw actionError('发送请求可能仍在进行，请 2 分钟后再确认，避免重复投递', 409);
    }
  } else if (draft.status !== 'send_unknown') {
    throw actionError('仅发送中（超过安全时限）或发送结果待确认的草稿可恢复', 409);
  }

  const note = '已由人工确认未发送，恢复待审阅';
  const updated = await dbOperations.run(
    `UPDATE email_drafts SET status = 'pending_review', reviewed_at = NULL,
     reviewer_note = CONCAT_WS('\n', NULLIF(reviewer_note, ''), ?), updated_at = NOW()
     WHERE id = ? AND status IN ('sending', 'send_unknown')`,
    [note, draftId]
  );
  if (updated.changes !== 1) {
    throw actionError('草稿状态已变化，请刷新后重试', 409);
  }
  return { draft_id: Number(draftId), status: 'pending_review' };
}

module.exports = { sendApprovedDraft, isAmbiguousSendError, confirmManuallySent, confirmNotSent, SENDING_RECOVERY_TIMEOUT_MS };
