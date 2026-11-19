// Message headers take precedence. Otherwise use the latest preceding successful
// outbound in the same owner/thread; address-based email_record_id guesses alone
// must never move another product task to "replied".
const REPLY_SCOPE_JOIN = `r.thread_id=er.thread_id AND r.owner_user_id=er.owner_user_id
  AND er.id=COALESCE(
    (SELECT direct.id FROM email_records direct WHERE direct.thread_id=r.thread_id
      AND direct.owner_user_id=r.owner_user_id AND direct.status='success'
      AND direct.smtp_message_id=r.reply_to_message_id ORDER BY direct.id DESC LIMIT 1),
    (SELECT preceding.id FROM email_records preceding WHERE preceding.thread_id=r.thread_id
      AND preceding.owner_user_id=r.owner_user_id AND preceding.status='success'
      AND preceding.created_at<=r.received_at ORDER BY preceding.created_at DESC, preceding.id DESC LIMIT 1)
  )`;
module.exports = { REPLY_SCOPE_JOIN };
