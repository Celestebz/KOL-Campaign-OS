// IMAP 回复轮询（imapflow）：UNSEEN 邮件按发件人匹配发送记录，幂等去重，写 email_replies 后异步 AI 摘要。
// 注：imapflow / aiClient 均通过模块对象引用（非解构），便于测试 monkey-patch。
const imapflow = require('imapflow');
const { dbOperations } = require('../database');
const aiClient = require('./aiClient');

const BODY_TEXT_LIMIT = 8000;
const VALID_INTENTS = new Set(['interested', 'question', 'rejected', 'other']);

const SUMMARY_SYSTEM = 'You are an assistant that summarizes creator business email replies for a marketing team. Return valid JSON only. No Markdown, no explanations.';
const SUMMARY_USER = `Summarize this email reply. Return JSON: {"summary": "2-3句中文摘要，含对方诉求、报价或问题", "intent": "interested|question|rejected|other"}
- interested: 明确表达合作意愿
- question: 有兴趣但在询问细节
- rejected: 明确拒绝
- other: 无法归类（如自动回复）

Subject: {{subject}}

Body:
{{body}}`;

async function summarizeReply(replyId) {
  try {
    const reply = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [replyId]);
    if (!reply) return;
    const userPrompt = SUMMARY_USER
      .replace('{{subject}}', reply.subject || '')
      .replace('{{body}}', reply.body_text || '');
    const { parsed } = await aiClient.callActiveAi(SUMMARY_SYSTEM, userPrompt);
    const summary = String(parsed?.summary || '').trim();
    const intent = VALID_INTENTS.has(parsed?.intent) ? parsed.intent : 'other';
    if (!summary) throw new Error('AI 未返回有效摘要');
    await dbOperations.run(
      `UPDATE email_replies SET ai_summary = ?, ai_intent = ?, ai_status = 'success', ai_error = NULL, updated_at = NOW() WHERE id = ?`,
      [summary, intent, replyId]
    );
    return { success: true };
  } catch (error) {
    console.error(`回复总结失败 (reply ${replyId}):`, error.message);
    await dbOperations.run(
      `UPDATE email_replies SET ai_status = 'failed', ai_error = ?, updated_at = NOW() WHERE id = ?`,
      [String(error.message || 'AI 摘要失败').slice(0, 2000), replyId]
    ).catch(() => {});
    return { success: false, error: error.message || 'AI 摘要失败' };
  }
}

function normalizeAddress(input) {
  const text = String(input || '').trim();
  const match = text.match(/<([^>]+)>/);
  return (match ? match[1] : text).trim().toLowerCase();
}

async function findOwnerByAddress(fromAddress) {
  const record = await dbOperations.get(
    'SELECT id, campaign_id, customer_id FROM email_records WHERE LOWER(to_address) = ? ORDER BY created_at DESC LIMIT 1',
    [fromAddress]
  );
  if (record) return record;
  const customer = await dbOperations.get('SELECT id FROM customers WHERE LOWER(email) = ? LIMIT 1', [fromAddress]);
  if (customer) {
    const kol = await dbOperations.get(
      'SELECT campaign_id, customer_id FROM campaign_kols WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 1',
      [customer.id]
    );
    if (kol) return { id: null, campaign_id: kol.campaign_id, customer_id: kol.customer_id };
  }
  return null;
}

// A matched inbound message creates an independent email todo. Outreach phase
// is deliberately untouched, so interested/confirmed/terminated remain intact.
async function markWaitingReply(campaignId, customerId) {
  if (!campaignId || !customerId) return;
  await dbOperations.run(
    `UPDATE campaign_kols SET needs_reply = 1, last_inbound_at = NOW(),
     sync_status = 'sync_pending', updated_at = NOW()
     WHERE campaign_id = ? AND customer_id = ?`,
    [campaignId, customerId]
  );
}

async function pollOnce() {
  const settings = await dbOperations.get('SELECT * FROM email_settings ORDER BY id LIMIT 1');
  if (!settings || !settings.imap_host || !settings.username || !settings.password) return;

  const client = new imapflow.ImapFlow({
    host: settings.imap_host,
    port: Number(settings.imap_port) || 993,
    secure: settings.imap_secure === undefined ? true : Boolean(settings.imap_secure),
    auth: { user: settings.username, pass: settings.password },
    logger: false,
    socketTimeout: 30000
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ seen: false });
      for (const uid of uids || []) {
        const message = await client.fetchOne(uid, { envelope: true, bodyParts: ['text'], uid: true }, { uid: true });
        if (!message?.envelope) continue;
        const messageId = message.envelope.messageId || `uid-${uid}`;
        // 幂等：message_id 已存在则跳过（标已读）
        const existing = await dbOperations.get('SELECT id FROM email_replies WHERE message_id = ? LIMIT 1', [messageId]);
        if (existing) {
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }).catch(() => {});
          continue;
        }
        const fromAddress = normalizeAddress(message.envelope.from?.[0]?.address || '');
        const owner = await findOwnerByAddress(fromAddress);
        if (!owner) continue; // 未匹配：不标已读，不处理

        const bodyPart = message.bodyParts?.get('text');
        const bodyText = String(bodyPart?.toString() || '').slice(0, BODY_TEXT_LIMIT);
        const result = await dbOperations.run(
          `INSERT INTO email_replies
           (email_record_id, campaign_id, customer_id, from_address, message_id, subject, body_text, received_at,
            ai_status, confirm_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', NOW(), NOW())`,
          [owner.id, owner.campaign_id, owner.customer_id, fromAddress, messageId,
           message.envelope.subject || '', bodyText, message.envelope.date || new Date()]
        );
        await markWaitingReply(owner.campaign_id, owner.customer_id);
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }).catch(() => {});
        if (result.id) summarizeReply(result.id).catch(() => {});
      }
      await dbOperations.run('UPDATE email_settings SET last_poll_at = NOW() WHERE id = ?', [settings.id]);
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (error) {
    console.error('IMAP 轮询失败:', error.message);
    try { await client.logout(); } catch { /* ignore */ }
  }
}

let timer = null;

async function startReplyPoller() {
  if (timer) return;
  const settings = await dbOperations.get('SELECT * FROM email_settings ORDER BY id LIMIT 1');
  const minutes = Number(settings?.poll_interval_minutes ?? 5);
  if (!settings || !settings.imap_host || !minutes) {
    console.log('[email] 未配置 IMAP 或轮询间隔为 0，回复追踪未启动。');
    return;
  }
  console.log(`[email] 回复追踪已启动，每 ${minutes} 分钟轮询一次。`);
  timer = setInterval(() => pollOnce().catch((e) => console.error('IMAP 轮询异常:', e.message)), minutes * 60 * 1000);
  timer.unref();
}

module.exports = { startReplyPoller, pollOnce, summarizeReply, normalizeAddress, findOwnerByAddress, markWaitingReply };
