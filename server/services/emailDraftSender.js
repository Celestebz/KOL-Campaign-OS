const { dbOperations } = require('../database');
const mailer = require('./mailer');

function actionError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function markFailed(draftId) {
  await dbOperations.run(
    `UPDATE email_drafts SET status = 'send_failed', updated_at = NOW() WHERE id = ?`,
    [draftId]
  );
}

async function sendApprovedDraft(draftId) {
  const claim = await dbOperations.run(
    `UPDATE email_drafts SET status = 'sending', updated_at = NOW()
     WHERE id = ? AND status = 'approved'`,
    [draftId]
  );

  if (claim.changes !== 1) {
    const current = await dbOperations.get('SELECT status FROM email_drafts WHERE id = ?', [draftId]);
    if (!current) throw actionError('草稿不存在', 404);
    if (current.status === 'sent') throw actionError('该邮件已经发送，请勿重复操作', 409);
    if (current.status === 'sending') throw actionError('该邮件正在发送，请勿重复操作', 409);
    throw actionError('仅已批准的草稿可发送', 409);
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
    await dbOperations.run(
      `INSERT INTO email_records
       (draft_id, campaign_id, customer_id, kol_name, to_address, subject, body_text, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, NOW())`,
      [draft.id, draft.campaign_id, draft.customer_id, customer.name, customer.email,
       draft.subject, draft.body_text, sendError.message]
    );
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

module.exports = { sendApprovedDraft };
