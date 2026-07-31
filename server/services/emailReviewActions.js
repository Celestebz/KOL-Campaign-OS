// 邮件审批/回复确认的共享业务逻辑。
// emails 路由（/drafts/:id/approve 等）与 approval_items 决定副作用（decisionDispatcher）
// 共用这里的实现，避免两处复制 SQL 导致行为分叉。
const { dbOperations } = require('../database');
const timeline = require('./campaignKolTimeline');

const INTENT_TO_OUTREACH = timeline.INTENT_TO_OUTREACH;

async function closePendingApproval(type, subjectType, subjectId) {
  await dbOperations.run(
    `UPDATE approval_items
     SET status = 'cancelled', decision = 'source_gone', decided_at = NOW(), updated_at = NOW()
     WHERE type = ? AND subject_type = ? AND subject_id = ? AND status = 'pending'`,
    [type, subjectType, subjectId]
  );
}

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

async function approveDraft(draftId, { closeApproval = true } = {}) {
  const draft = await getDraftOrThrow(draftId);
  if (draft.status !== 'pending_review') throw actionError('仅待审阅状态可批准', 409);
  await dbOperations.run(
    `UPDATE email_drafts SET status = 'approved', reviewed_at = NOW(), updated_at = NOW() WHERE id = ?`,
    [draft.id]
  );
  if (closeApproval) await closePendingApproval('outreach', 'email_draft', draft.id);
}

async function rejectDraft(draftId, reason, { closeApproval = true } = {}) {
  const draft = await getDraftOrThrow(draftId);
  if (draft.status !== 'pending_review') throw actionError('仅待审阅状态可驳回', 409);
  await dbOperations.run(
    `UPDATE email_drafts SET status = 'rejected', reviewer_note = ?, reviewed_at = NOW(), updated_at = NOW() WHERE id = ?`,
    [reason || null, draft.id]
  );
  if (closeApproval) await closePendingApproval('outreach', 'email_draft', draft.id);
}

async function confirmReply(
  replyId,
  summaryOverride,
  intentOverride,
  actor = 'boss'
) {
  const reply = await getReplyOrThrow(replyId);
  const summary = (summaryOverride || reply.ai_summary || '').trim();
  const confirmedIntent = timeline.normalizeConfirmedIntent(intentOverride || reply.ai_intent);
  const outreachStatus = timeline.outreachForIntent(confirmedIntent);

  const kol = await dbOperations.get(
    `SELECT id, campaign_id, customer_id, outreach_status
     FROM campaign_kols WHERE campaign_id = ? AND customer_id = ?`,
    [reply.campaign_id, reply.customer_id]
  );
  let appliedOutreachStatus = outreachStatus;
  if (kol) {
    await timeline.appendEvent({
      campaignKol: kol, eventType: 'email_reply_confirmed',
      occurredAt: reply.received_at || new Date(), summary,
      sourceType: 'email_reply', sourceId: reply.id,
      aiIntent: reply.ai_intent, confirmedIntent, outreachStatus, actor
    });
    appliedOutreachStatus = (await timeline.applyLatestStatus(kol.id)) || outreachStatus;
  }
  await dbOperations.run(
    `UPDATE email_replies SET confirm_status = 'confirmed', confirmed_summary = ?,
       confirmed_intent = ?, updated_at = NOW() WHERE id = ?`,
    [summary, confirmedIntent, reply.id]
  );
  return { outreach_status: appliedOutreachStatus, confirmed_intent: confirmedIntent };
}

async function ignoreReply(replyId, { closeApproval = true } = {}) {
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
  if (closeApproval) await closePendingApproval('reply', 'email_reply', reply.id);
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
  await closePendingApproval('reply', 'email_reply', reply.id);
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
