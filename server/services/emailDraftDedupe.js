const { dbOperations } = require('../database');

function draftDedupeKey({ campaignId, customerId, kind, sourceReplyId, followUpCount = 0 }) {
  if (kind === 'reply') return sourceReplyId ? `reply:${sourceReplyId}` : null;
  if (kind === 'follow_up') return `follow_up:${campaignId}:${customerId}:${Number(followUpCount) || 0}`;
  return `first_touch:${campaignId}:${customerId}`;
}

async function findBlockingDraft({ campaignId, customerId, kind, sourceReplyId }) {
  const sourceClause = kind === 'reply' ? ' AND source_reply_id = ?' : '';
  const params = [campaignId, customerId, kind];
  if (kind === 'reply') params.push(sourceReplyId);
  return dbOperations.get(
    `SELECT id, status FROM email_drafts
     WHERE campaign_id = ? AND customer_id = ? AND kind = ?${sourceClause}
       AND status IN ('pending_review', 'approved', 'sent', 'rejected')
     ORDER BY id DESC LIMIT 1`,
    params
  );
}

function isDuplicateError(error) {
  const code = error?.original?.code || error?.parent?.code || error?.code;
  return code === 'ER_DUP_ENTRY' || String(error?.message || '').includes('Duplicate entry');
}

module.exports = { draftDedupeKey, findBlockingDraft, isDuplicateError };
