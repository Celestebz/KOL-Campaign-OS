// 邮件审批/回复确认的共享业务逻辑。
// emails 路由（/drafts/:id/approve 等）与 approval_items 决定副作用（decisionDispatcher）
// 共用这里的实现，避免两处复制 SQL 导致行为分叉。
const { dbOperations } = require('../database');

const INTENT_TO_OUTREACH = {
  interested: 'interested',
  question: 'negotiating',
  rejected: 'terminated',
  other: 'negotiating'
};

function actionError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function getDraftOrThrow(draftId) {
  const draft = await dbOperations.get('SELECT * FROM email_drafts WHERE id = ?', [draftId]);
  if (!draft) throw actionError('草稿不存在', 404);
  return draft;
}

async function getReplyOrThrow(replyId) {
  const reply = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [replyId]);
  if (!reply) throw actionError('回复不存在', 404);
  return reply;
}

async function approveDraft(draftId) {
  const draft = await getDraftOrThrow(draftId);
  if (draft.status !== 'pending_review') throw actionError('仅待审阅状态可批准', 409);
  await dbOperations.run(
    `UPDATE email_drafts SET status = 'approved', reviewed_at = NOW(), updated_at = NOW() WHERE id = ?`,
    [draft.id]
  );
}

async function rejectDraft(draftId, reason) {
  const draft = await getDraftOrThrow(draftId);
  if (draft.status !== 'pending_review') throw actionError('仅待审阅状态可驳回', 409);
  await dbOperations.run(
    `UPDATE email_drafts SET status = 'rejected', reviewer_note = ?, reviewed_at = NOW(), updated_at = NOW() WHERE id = ?`,
    [reason || null, draft.id]
  );
}

async function confirmReply(replyId, summaryOverride) {
  const reply = await getReplyOrThrow(replyId);
  const summary = (summaryOverride || reply.ai_summary || '').trim();
  const outreachStatus = INTENT_TO_OUTREACH[reply.ai_intent] || 'negotiating';

  const kol = await dbOperations.get(
    'SELECT id, internal_notes FROM campaign_kols WHERE campaign_id = ? AND customer_id = ?',
    [reply.campaign_id, reply.customer_id]
  );
  if (kol) {
    const noteLine = `[邮件回复 ${new Date().toISOString().slice(0, 10)}] ${summary}`;
    const internalNotes = kol.internal_notes ? `${kol.internal_notes}\n${noteLine}` : noteLine;
    await dbOperations.run(
      `UPDATE campaign_kols SET outreach_status = ?, last_reply_summary = ?, internal_notes = ?,
       sync_status = 'sync_pending', updated_at = NOW() WHERE id = ?`,
      [outreachStatus, summary, internalNotes, kol.id]
    );
  }
  await dbOperations.run(
    `UPDATE email_replies SET confirm_status = 'confirmed', confirmed_summary = ?, updated_at = NOW() WHERE id = ?`,
    [summary, reply.id]
  );
  return { outreach_status: outreachStatus };
}

async function ignoreReply(replyId) {
  const reply = await getReplyOrThrow(replyId);
  await dbOperations.run(
    `UPDATE email_replies SET confirm_status = 'ignored', updated_at = NOW() WHERE id = ?`,
    [reply.id]
  );
  if (reply.campaign_id && reply.customer_id) {
    await dbOperations.run(
      `UPDATE campaign_kols SET needs_reply = 0, sync_status = 'sync_pending', updated_at = NOW()
       WHERE campaign_id = ? AND customer_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM email_replies newer
           WHERE newer.campaign_id = ? AND newer.customer_id = ?
             AND newer.confirm_status <> 'ignored'
             AND (newer.received_at > ? OR (newer.received_at = ? AND newer.id > ?))
         )`,
      [reply.campaign_id, reply.customer_id, reply.campaign_id, reply.customer_id,
       reply.received_at, reply.received_at, reply.id]
    );
  }
}

async function markReplyManuallyHandled(replyId, handledBy = 'boss') {
  const reply = await getReplyOrThrow(replyId);
  if (reply.confirm_status === 'ignored' || reply.confirm_status === 'manually_replied') {
    throw actionError('该邮件待办已经处理', 409);
  }
  await dbOperations.run(
    `UPDATE email_replies
     SET confirm_status = 'manually_replied', handled_at = NOW(), handled_by = ?, updated_at = NOW()
     WHERE id = ?`,
    [handledBy || 'boss', reply.id]
  );
  if (reply.campaign_id && reply.customer_id) {
    await dbOperations.run(
      `UPDATE campaign_kols
       SET needs_reply = 0, sync_status = 'sync_pending', updated_at = NOW()
       WHERE campaign_id = ? AND customer_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM email_replies newer
           WHERE newer.campaign_id = ? AND newer.customer_id = ?
             AND newer.confirm_status NOT IN ('ignored', 'manually_replied')
             AND (newer.received_at > ? OR (newer.received_at = ? AND newer.id > ?))
         )`,
      [reply.campaign_id, reply.customer_id, reply.campaign_id, reply.customer_id,
       reply.received_at, reply.received_at, reply.id]
    );
  }
  return { confirm_status: 'manually_replied', handled_by: handledBy || 'boss' };
}

module.exports = {
  INTENT_TO_OUTREACH,
  approveDraft,
  rejectDraft,
  confirmReply,
  ignoreReply,
  markReplyManuallyHandled
};
