const { dbOperations } = require('../database');

const SYSTEM_SENDER_PATTERN = /(?:^|@)(?:mailer-daemon|postmaster)|no-reply@mailsupport\.aliyun\.com/i;
const BOUNCE_TEXT_PATTERN = /delivery status notification|undeliverable|returned mail|mail delivery failed|failure notice|退信|投递失败|无法投递|邮件发送失败/i;
const AUTO_REPLY_PATTERN = /out of office|automatic reply|auto(?:matic)?[ -]?reply|自动回复|外出回复/i;

function normalizeAddress(value) {
  return String(value || '').trim().replace(/^<|>$/g, '').toLowerCase();
}

function detectSystemMail({ fromAddress, from_address, subject, bodyText, body_text }) {
  const sender = normalizeAddress(fromAddress || from_address);
  const text = `${subject || ''}\n${bodyText || body_text || ''}`;
  if (SYSTEM_SENDER_PATTERN.test(sender) || BOUNCE_TEXT_PATTERN.test(text)) {
    return { isSystem: true, systemMailType: 'bounce' };
  }
  if (AUTO_REPLY_PATTERN.test(text)) {
    return { isSystem: true, systemMailType: 'auto_reply' };
  }
  return { isSystem: false, systemMailType: null };
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return String(match[1]).trim();
  }
  return '';
}

function parseBounce({ fromAddress, from_address, subject, bodyText, body_text }) {
  const text = `${subject || ''}\n${bodyText || body_text || ''}`;
  const detected = detectSystemMail({ fromAddress: fromAddress || from_address, subject, bodyText: bodyText || body_text });
  if (!detected.isSystem || detected.systemMailType !== 'bounce') return null;

  let recipient = firstMatch(text, [
    /Final-Recipient:\s*(?:rfc822;\s*)?([^\s;<>]+@[^\s;<>]+)/i,
    /Original-Recipient:\s*(?:rfc822;\s*)?([^\s;<>]+@[^\s;<>]+)/i,
    /(?:收件人|原收件人|recipient|to)\s*[：:]\s*<?([^\s<>;,]+@[^\s<>;,]+)/i
  ]);
  recipient = normalizeAddress(recipient);
  if (!recipient) {
    const sender = normalizeAddress(fromAddress || from_address);
    recipient = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [])
      .map(normalizeAddress)
      .find((address) => address !== sender && !SYSTEM_SENDER_PATTERN.test(address)) || '';
  }

  const originalMessageId = firstMatch(text, [
    /X-Original-Message-ID:\s*(<[^>]+>|\S+)/i,
    /Original-Message-ID:\s*(<[^>]+>|\S+)/i
  ]);
  const statusCode = firstMatch(text, [
    /(?:^|\n)Status:\s*([245]\.\d+\.\d+)/i,
    /\b([45]\.\d+\.\d+)\b/,
    /\b([45]\d\d)\b/
  ]);
  const diagnostic = firstMatch(text, [
    /Diagnostic-Code:\s*(?:smtp;\s*)?([^\r\n]+)/i,
    /(?:退信原因|失败原因|reason)\s*[：:]\s*([^\r\n]+)/i
  ]);

  const hard = /^5/.test(statusCode)
    || /user unknown|no such user|mailbox.*(?:not found|unavailable)|recipient.*(?:not found|invalid)|address.*(?:does not exist|rejected)|邮箱.*(?:不存在|无效)/i.test(text);
  const soft = /^4/.test(statusCode)
    || /mailbox full|quota exceeded|temporar(?:y|ily)|try again|邮箱已满|容量不足|临时/i.test(text);
  const bounceType = hard ? 'hard' : (soft ? 'soft' : 'unknown');

  return {
    recipient,
    originalMessageId: originalMessageId || '',
    statusCode: statusCode || '',
    bounceType,
    reason: (diagnostic || String(subject || '系统退信')).slice(0, 1000)
  };
}

async function findEmailRecord(parsed, receivedAt, db = dbOperations) {
  if (parsed.originalMessageId) {
    const byMessageId = await db.get(
      'SELECT * FROM email_records WHERE LOWER(smtp_message_id) = ? ORDER BY created_at DESC LIMIT 1',
      [parsed.originalMessageId.toLowerCase()]
    );
    if (byMessageId) return byMessageId;
  }
  if (!parsed.recipient) return null;
  return db.get(
    `SELECT * FROM email_records
     WHERE LOWER(to_address) = ? AND status = 'success' AND created_at <= ?
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [parsed.recipient, receivedAt || new Date()]
  );
}

async function processSystemMail(replyId, db = dbOperations) {
  const reply = await db.get('SELECT * FROM email_replies WHERE id = ?', [replyId]);
  if (!reply) return null;
  const detection = detectSystemMail(reply);
  if (!detection.isSystem) return null;

  if (detection.systemMailType !== 'bounce') {
    await db.run(
      `UPDATE email_replies SET classification = 'system', classification_source = 'system',
       classification_reason = '识别为自动回复', system_mail_type = ?, confirm_status = 'system',
       classified_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [detection.systemMailType, reply.id]
    );
    return { systemMailType: detection.systemMailType };
  }

  const parsed = parseBounce(reply);
  const record = await findEmailRecord(parsed, reply.received_at, db);
  const campaignId = record?.campaign_id || reply.campaign_id || null;
  const customerId = record?.customer_id || reply.customer_id || null;
  await db.run(
    `UPDATE email_replies SET email_record_id = ?, campaign_id = ?, customer_id = ?,
     classification = 'system', classification_source = 'system', classification_reason = ?,
     system_mail_type = 'bounce', confirm_status = 'system', classified_at = NOW(), updated_at = NOW()
     WHERE id = ?`,
    [record?.id || null, campaignId, customerId,
      parsed.reason || '识别为退信通知', reply.id]
  );
  await db.run(
    `INSERT INTO email_bounces
     (email_reply_id, email_record_id, campaign_id, customer_id, recipient, bounce_type,
      status_code, reason, received_at, owner_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE email_record_id = VALUES(email_record_id), campaign_id = VALUES(campaign_id),
       customer_id = VALUES(customer_id), recipient = VALUES(recipient), bounce_type = VALUES(bounce_type),
       status_code = VALUES(status_code), reason = VALUES(reason), received_at = VALUES(received_at), updated_at = NOW()`,
    [reply.id, record?.id || null, campaignId, customerId, parsed.recipient || null,
      parsed.bounceType, parsed.statusCode || null, parsed.reason || null, reply.received_at, reply.owner_user_id]
  );
  return { systemMailType: 'bounce', ...parsed, emailRecordId: record?.id || null };
}

async function backfillSystemMails(db = dbOperations) {
  const rows = await db.query(
    `SELECT er.id FROM email_replies er
     LEFT JOIN email_bounces eb ON eb.email_reply_id = er.id
     WHERE eb.id IS NULL AND (
       er.classification = 'system'
       OR LOWER(er.from_address) = 'no-reply@mailsupport.aliyun.com'
       OR LOWER(er.from_address) LIKE 'mailer-daemon%'
       OR LOWER(er.from_address) LIKE 'postmaster%'
     )
     ORDER BY er.received_at DESC LIMIT 500`
  );
  let processed = 0;
  for (const row of rows) {
    if (await processSystemMail(row.id, db)) processed += 1;
  }
  return processed;
}

module.exports = { detectSystemMail, parseBounce, findEmailRecord, processSystemMail, backfillSystemMails };
