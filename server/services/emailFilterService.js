const { dbOperations } = require('../database');
const aiClient = require('./aiClient');

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}
function addressDomain(value) {
  const address = normalizeAddress(value);
  return address.includes('@') ? address.split('@').pop() : '';
}

async function matchingRule(fromAddress) {
  const sender = normalizeAddress(fromAddress);
  const domain = addressDomain(sender);
  if (!sender) return null;
  return dbOperations.get(
    `SELECT * FROM email_filter_rules
     WHERE active = 1 AND ((rule_type = 'sender' AND rule_value = ?)
       OR (rule_type = 'domain' AND rule_value = ?))
     ORDER BY CASE rule_type WHEN 'sender' THEN 1 ELSE 2 END LIMIT 1`,
    [sender, domain]
  );
}

async function classifyIncoming({ fromAddress, subject, bodyText, matched }) {
  const rule = await matchingRule(fromAddress);
  if (rule) return { classification: 'spam', source: 'rule', reason: `命中${rule.rule_type === 'sender' ? '发件人' : '域名'}屏蔽规则` };
  if (matched) return { classification: 'kol_reply', source: 'system', reason: '发件地址已匹配 KOL' };
  const text = `${subject || ''}\n${bodyText || ''}`.slice(0, 4000);
  if (/mailer-daemon|delivery status notification|undeliverable|out of office|automatic reply/i.test(`${fromAddress} ${text}`)) {
    return { classification: 'system', source: 'system', reason: '识别为退信或自动回复' };
  }
  try {
    const { parsed } = await aiClient.callActiveAi(
      'Classify inbound business email. Return JSON only.',
      `判断这封邮件是否是 KOL 合作回复。返回 {"classification":"suspected_kol|spam|system|needs_review","confidence":0-100,"reason":"简短中文理由"}。\n发件人：${fromAddress}\n${text}`
    );
    const allowed = new Set(['suspected_kol', 'spam', 'system', 'needs_review']);
    return {
      classification: allowed.has(parsed?.classification) ? parsed.classification : 'needs_review',
      source: 'ai', reason: String(parsed?.reason || 'AI 无法确定').slice(0, 500),
      confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0))
    };
  } catch {
    return { classification: 'needs_review', source: 'system', reason: 'AI 暂不可用，需要人工确认' };
  }
}

async function addRule(ruleType, value, createdBy = 'boss') {
  if (!['sender', 'domain'].includes(ruleType)) throw Object.assign(new Error('不支持的屏蔽规则'), { statusCode: 400 });
  const normalized = ruleType === 'sender' ? normalizeAddress(value) : addressDomain(value) || normalizeAddress(value).replace(/^@/, '');
  if (!normalized) throw Object.assign(new Error('屏蔽规则不能为空'), { statusCode: 400 });
  await dbOperations.run(
    `INSERT INTO email_filter_rules (rule_type, rule_value, active, created_by, created_at, updated_at)
     VALUES (?, ?, 1, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE active = 1, created_by = VALUES(created_by), updated_at = NOW()`,
    [ruleType, normalized, createdBy]
  );
  return { rule_type: ruleType, rule_value: normalized };
}

async function markSpam(replyId, { blockScope = 'none', handledBy = 'boss' } = {}) {
  const reply = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [replyId]);
  if (!reply) throw Object.assign(new Error('邮件不存在'), { statusCode: 404 });
  if (blockScope !== 'none') await addRule(blockScope, reply.from_address, handledBy);
  await dbOperations.run(
    `UPDATE email_replies SET classification = 'spam', classification_source = 'human',
     classification_reason = ?, classified_at = NOW(), spam_marked_by = ?, confirm_status = 'spam', updated_at = NOW()
     WHERE id = ?`,
    [blockScope === 'none' ? '人工标记为垃圾邮件' : `人工标记并屏蔽${blockScope === 'sender' ? '发件人' : '域名'}`, handledBy, reply.id]
  );
  return { id: reply.id, classification: 'spam' };
}

async function restoreReply(replyId) {
  const reply = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [replyId]);
  if (!reply) throw Object.assign(new Error('邮件不存在'), { statusCode: 404 });
  await dbOperations.run(
    `UPDATE email_replies SET classification = 'needs_review', classification_source = 'human',
     classification_reason = '从垃圾邮件恢复', classified_at = NOW(), spam_marked_by = NULL,
     confirm_status = 'pending', updated_at = NOW() WHERE id = ?`, [reply.id]
  );
}

async function classifyStoredReply(replyId) {
  const reply = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [replyId]);
  if (!reply || reply.classification === 'spam' || reply.customer_id) return null;
  const result = await classifyIncoming({
    fromAddress: reply.from_address, subject: reply.subject,
    bodyText: reply.body_text, matched: Boolean(reply.customer_id)
  });
  await dbOperations.run(
    `UPDATE email_replies SET classification = ?, classification_source = ?, classification_reason = ?,
     classified_at = NOW(), confirm_status = CASE WHEN ? IN ('spam', 'system') THEN ? ELSE confirm_status END,
     updated_at = NOW() WHERE id = ?`,
    [result.classification, result.source, result.reason, result.classification,
     result.classification === 'spam' ? 'spam' : 'system', reply.id]
  );
  return result;
}

module.exports = { normalizeAddress, addressDomain, matchingRule, classifyIncoming, classifyStoredReply, addRule, markSpam, restoreReply };
