const { dbOperations } = require('../database');
const mailer = require('./mailer');
const emailThreader = require('./emailThreader');
const { normalizeReplySubject, buildTextQuote, buildHtmlQuote } = require('./emailReplyQuote');

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

function outreachStatusAfterSend(kind) {
  return kind === 'reply' ? 'negotiating' : 'contacted';
}

async function markOutreachAfterSend(draft) {
  const nextStatus = outreachStatusAfterSend(draft.kind);
  await dbOperations.run(
    `UPDATE campaign_kols SET
     outreach_status = CASE
       WHEN outreach_status IN ('interested', 'confirmed', 'terminated', 'rejected') THEN outreach_status
       ELSE ?
     END,
     needs_reply = CASE
       WHEN ? = 'reply' AND ? = (
         SELECT er.id FROM email_replies er
         WHERE er.campaign_id = campaign_kols.campaign_id
           AND er.customer_id = campaign_kols.customer_id
           AND er.confirm_status <> 'ignored'
         ORDER BY er.received_at DESC, er.id DESC LIMIT 1
       ) THEN 0
       ELSE COALESCE(needs_reply, 0)
     END,
     last_outreach_at = NOW(),
     sync_status = 'sync_pending', updated_at = NOW()
     WHERE campaign_id = ? AND customer_id = ?`,
    [nextStatus, draft.kind || '', draft.source_reply_id || null, draft.campaign_id, draft.customer_id]
  );
  if (draft.kind === 'reply' && draft.source_reply_id) {
    await dbOperations.run(
      `UPDATE approval_items
       SET status = 'cancelled', decision = 'source_gone', decided_at = NOW(), updated_at = NOW()
       WHERE type = 'reply' AND subject_type = 'email_reply'
         AND subject_id = ? AND status = 'pending'`,
      [draft.source_reply_id]
    );
  }
}

// 组装线程回复的发送内容：主题规范为恰好一个 "Re: "，正文附"最近一封来信"的引用块
//（不嵌套整条历史）。来信缺失 message_id 时降级：不加 In-Reply-To/References 头，
// 仍保留可读引用块，并标记 threadingMissing 交由前端提示。
function buildReplySendContext(draft, reply) {
  if (!reply) return null;
  const quoteBody = (reply.clean_body_text && String(reply.clean_body_text).trim())
    ? reply.clean_body_text
    : reply.body_text;
  const quote = { fromAddress: reply.from_address, receivedAt: reply.received_at, bodyText: quoteBody };
  const threadingMissing = !reply.message_id;
  const references = threadingMissing
    ? []
    : [...new Set([...emailThreader.extractMessageIds(reply.references_json), reply.message_id])];
  return {
    subject: normalizeReplySubject(draft.subject || reply.subject),
    text: `${draft.body_text || ''}${buildTextQuote(quote)}`,
    html: `${mailer.textToHtml(draft.body_text || '')}${buildHtmlQuote(quote)}`,
    inReplyTo: threadingMissing ? null : reply.message_id,
    references,
    threadingMissing
  };
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
  // kind='reply' 且来信可查时，按线程回复构造主题/引用正文/回复头；否则完全走原有逻辑
  let replyCtx = null;
  if (draft.kind === 'reply' && draft.source_reply_id) {
    const reply = await dbOperations.get(
      `SELECT id, message_id, references_json, subject, from_address, received_at, body_text, clean_body_text
       FROM email_replies WHERE id = ?`,
      [draft.source_reply_id]
    );
    replyCtx = buildReplySendContext(draft, reply);
  }
  const subject = replyCtx ? replyCtx.subject : draft.subject;
  const text = replyCtx ? replyCtx.text : draft.body_text;
  let messageId;
  try {
    const mailOptions = { settings, to: customer.email, cc, subject, text };
    if (replyCtx && replyCtx.inReplyTo) mailOptions.inReplyTo = replyCtx.inReplyTo;
    if (replyCtx && replyCtx.references.length) mailOptions.references = replyCtx.references;
    if (replyCtx) mailOptions.html = replyCtx.html;
    ({ messageId } = await mailer.sendMail(mailOptions));
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
  const recordInsert = await dbOperations.run(
      `INSERT INTO email_records
       (draft_id, campaign_id, customer_id, kol_name, to_address, cc, subject, body_text, status, smtp_message_id, in_reply_to, references_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', ?, ?, ?, NOW())`,
    [draft.id, draft.campaign_id, draft.customer_id, customer.name, customer.email,
     cc.join(',') || null, subject, text, messageId,
     replyCtx ? replyCtx.inReplyTo : null,
     replyCtx && replyCtx.references.length ? JSON.stringify(replyCtx.references) : null]
  );
  // 发送记录挂会话：按 In-Reply-To/References 命中来信复用 thread，失败仅记日志不影响发送结果
  if (recordInsert.id) {
    try {
      await emailThreader.assignRecordThread(recordInsert.id);
    } catch (threadError) {
      console.error(`[emailDraftSender] 发送记录 ${recordInsert.id} 会话归属失败:`, threadError.message);
    }
  }
  await dbOperations.run(
    `UPDATE email_drafts SET status = 'sent', updated_at = NOW()
     WHERE id = ? AND status = 'sending'`,
    [draft.id]
  );
  await markOutreachAfterSend(draft);
  const result = { draft_id: draft.id, message_id: messageId, to: customer.email };
  if (replyCtx && replyCtx.threadingMissing) result.threading_missing = true;
  return result;
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

  const manualInsert = await dbOperations.run(
    `INSERT INTO email_records
     (draft_id, campaign_id, customer_id, kol_name, to_address, subject, body_text, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'success', ?, NOW())`,
    [draft.id, draft.campaign_id, draft.customer_id, customer?.name || null, customer?.email || null,
     draft.subject, draft.body_text, note]
  );
  // 人工确认的记录也尽量补会话归属（无回复头，按主题+窗口匹配），失败仅记日志
  if (manualInsert.id) {
    try {
      await emailThreader.assignRecordThread(manualInsert.id);
    } catch (threadError) {
      console.error(`[emailDraftSender] 发送记录 ${manualInsert.id} 会话归属失败:`, threadError.message);
    }
  }
  await markOutreachAfterSend(draft);
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

module.exports = {
  sendApprovedDraft,
  buildReplySendContext,
  isAmbiguousSendError,
  confirmManuallySent,
  confirmNotSent,
  outreachStatusAfterSend,
  SENDING_RECOVERY_TIMEOUT_MS
};
