// 历史邮件会话回填：先发送记录后来信，按时间升序，可重复执行（幂等）。
// 冲突/未识别的保持 thread_id NULL，计入 needs_manual 交人工处理。
const { dbOperations } = require('../database');
const emailThreader = require('./emailThreader');

const MAX_ERRORS = 10;

function pushError(stats, message) {
  if (stats.errors.length < MAX_ERRORS) stats.errors.push(String(message).slice(0, 500));
}

async function runBackfill({ limit = 500, dryRun = false } = {}, db = dbOperations) {
  const stats = { scanned: 0, assigned: 0, needs_manual: 0, failed: 0, errors: [] };
  const opts = { dryRun: Boolean(dryRun) };
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 5000));

  // 1) 发送记录：有回复头（in_reply_to/references）或可由来信反查关联的
  const records = await db.query(
    `SELECT id FROM email_records
     WHERE thread_id IS NULL AND (
       (in_reply_to IS NOT NULL AND in_reply_to != '')
       OR (references_json IS NOT NULL AND references_json NOT IN ('', '[]', 'null'))
       OR EXISTS (SELECT 1 FROM email_replies r WHERE r.email_record_id = email_records.id AND r.thread_id IS NOT NULL)
     )
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
    [safeLimit]
  );
  for (const record of records) {
    try {
      await emailThreader.assignRecordThread(record.id, db, opts);
    } catch (error) {
      stats.failed++;
      pushError(stats, `record ${record.id}: ${error.message}`);
    }
  }

  // 2) 来信：按 received_at 升序扫描未挂 thread 的，逐条走归属规则
  const replies = await db.query(
    `SELECT id, message_id, in_reply_to, references_json, subject, from_address, received_at,
            campaign_id, customer_id, email_record_id
     FROM email_replies
     WHERE thread_id IS NULL
     ORDER BY received_at ASC, id ASC
     LIMIT ?`,
    [safeLimit]
  );
  for (const reply of replies) {
    stats.scanned++;
    try {
      const result = await emailThreader.assignReplyThread({
        replyId: reply.id,
        messageId: reply.message_id,
        inReplyTo: reply.in_reply_to,
        references: reply.references_json,
        subject: reply.subject,
        fromAddress: reply.from_address,
        receivedAt: reply.received_at,
        campaignId: reply.campaign_id,
        customerId: reply.customer_id,
        emailRecordId: reply.email_record_id
      }, db, opts);
      // dryRun 下建会话不落库（threadId 为 null），按 matchedBy 判断是否可归属
      const ok = opts.dryRun
        ? (!result.ambiguous && Boolean(result.matchedBy))
        : Boolean(result.threadId);
      if (ok) stats.assigned++;
      else stats.needs_manual++;
    } catch (error) {
      stats.failed++;
      pushError(stats, `reply ${reply.id}: ${error.message}`);
    }
  }
  return stats;
}

module.exports = { runBackfill };
