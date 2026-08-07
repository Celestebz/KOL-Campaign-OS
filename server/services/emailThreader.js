// 邮件会话（thread）归属：按 In-Reply-To / References / 发送记录 / 主题+窗口 逐级匹配。
// 注：db 通过参数注入（默认 dbOperations），便于测试传入内存 stub，不连真实数据库。
const { dbOperations } = require('../database');

// 同主题会话的时间窗口：超过 60 天视为新会话
const THREAD_WINDOW_DAYS = 60;

// 常见本地化回复/转发前缀（含 Re[2]:、Aw: 等变体），循环剥离去重
const SUBJECT_PREFIX = /^\s*(?:(?:re|fw|fwd|aw|sv)\s*(?:\[\d+\])?|回复|答复|转发|自動返信|自动回复|自动返信)\s*[:：]\s*/i;

function normalizeSubject(subject) {
  let text = String(subject || '').trim();
  let prev;
  do {
    prev = text;
    text = text.replace(SUBJECT_PREFIX, '');
  } while (text !== prev);
  return text.replace(/\s+/g, ' ').trim();
}

// 安全解析 references_json：兼容数组、JSON 字符串、脏数据
function extractMessageIds(jsonOrArray) {
  if (Array.isArray(jsonOrArray)) {
    return jsonOrArray.map((v) => String(v || '').trim()).filter(Boolean);
  }
  if (typeof jsonOrArray === 'string' && jsonOrArray.trim()) {
    try {
      return extractMessageIds(JSON.parse(jsonOrArray));
    } catch {
      return [];
    }
  }
  return [];
}

// 时间窗口判断（纯函数，便于单测）：两个时间点相差不超过 days 天
function isWithinWindow(a, b, days = THREAD_WINDOW_DAYS) {
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) <= days * 24 * 60 * 60 * 1000;
}

// 按 Message-ID 反查：先查来信 message_id，再查发送记录 smtp_message_id
async function findThreadByMessageId(db, messageId) {
  if (!messageId) return null;
  const reply = await db.get(
    'SELECT id, thread_id, campaign_id, customer_id, subject, received_at FROM email_replies WHERE message_id = ? LIMIT 1',
    [messageId]
  );
  if (reply) return { kind: 'reply', row: reply };
  const record = await db.get(
    'SELECT id, thread_id, campaign_id, customer_id, subject, created_at FROM email_records WHERE smtp_message_id = ? LIMIT 1',
    [messageId]
  );
  if (record) return { kind: 'record', row: record };
  return null;
}

async function createThread(db, { campaignId, customerId, normalizedSubject, messageAt, messageCount = 0 }, dryRun) {
  if (dryRun) return null; // 预演模式不落库
  const result = await db.run(
    `INSERT INTO email_threads (campaign_id, customer_id, normalized_subject, last_message_at, message_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
    [campaignId || null, customerId || null, normalizedSubject || '', messageAt || new Date(), messageCount]
  );
  return result.id || null;
}

// 归属成功后累加会话计数；last_message_at 只前进不回退
async function bumpThread(db, threadId, messageAt) {
  await db.run(
    `UPDATE email_threads
     SET last_message_at = GREATEST(COALESCE(last_message_at, ?), ?),
         message_count = message_count + 1, updated_at = NOW()
     WHERE id = ?`,
    [messageAt || new Date(), messageAt || new Date(), threadId]
  );
}

// 命中消息尚无 thread 时为其补建（记 1 条消息），再复用
async function ensureThreadForMatch(db, match, fallbackNormalizedSubject, dryRun) {
  if (match.row.thread_id) return match.row.thread_id;
  if (!match.row.customer_id) return null; // 对方也未识别，无法建会话
  const threadId = await createThread(db, {
    campaignId: match.row.campaign_id,
    customerId: match.row.customer_id,
    normalizedSubject: normalizeSubject(match.row.subject) || fallbackNormalizedSubject,
    messageAt: match.row.received_at || match.row.created_at || new Date(),
    messageCount: 1
  }, dryRun);
  if (threadId && !dryRun) {
    const table = match.kind === 'reply' ? 'email_replies' : 'email_records';
    // email_records 表无 updated_at 列，仅 email_replies 维护该时间戳
    const setClause = table === 'email_replies' ? 'thread_id = ?, updated_at = NOW()' : 'thread_id = ?';
    await db.run(`UPDATE ${table} SET ${setClause} WHERE id = ?`, [threadId, match.row.id]);
  }
  return threadId;
}

// 规则 4：同 KOL + 同项目 + 同主题 + 60 天窗口；跨项目候选视为冲突，不自动合并
async function matchThreadBySubject(db, { campaignId, customerId, normalizedSubject, messageAt }) {
  if (!campaignId || !customerId) return { threadId: null, ambiguous: false };
  const rows = await db.query(
    'SELECT id, campaign_id, last_message_at FROM email_threads WHERE customer_id = ? AND normalized_subject = ? ORDER BY last_message_at DESC',
    [customerId, normalizedSubject]
  );
  const inWindow = rows.filter((r) => isWithinWindow(r.last_message_at, messageAt));
  const sameCampaign = inWindow.filter((r) => Number(r.campaign_id) === Number(campaignId));
  if (sameCampaign.length) return { threadId: sameCampaign[0].id, ambiguous: false };
  if (inWindow.length) return { threadId: null, ambiguous: true }; // 同邮箱多项目
  return { threadId: null, ambiguous: false };
}

// 找或建 thread（带 60 天窗口，避免陈年同主题邮件串会话）
async function findOrCreateThread({ campaignId, customerId, normalizedSubject, messageAt }, db = dbOperations, opts = {}) {
  if (!campaignId || !customerId) return null;
  const { threadId } = await matchThreadBySubject(db, { campaignId, customerId, normalizedSubject, messageAt: messageAt || new Date() });
  if (threadId) return threadId;
  return createThread(db, { campaignId, customerId, normalizedSubject, messageAt: messageAt || new Date() }, Boolean(opts.dryRun));
}

// 来信归属。优先级：in_reply_to → references → 发送记录 → 主题+窗口 → 新建 → 未识别。
// 幂等：reply 已有 thread_id 直接返回，不重复累加 message_count。
async function assignReplyThread(params, db = dbOperations, opts = {}) {
  const {
    replyId, inReplyTo, references, subject,
    receivedAt, campaignId, customerId, emailRecordId
  } = params;
  const dryRun = Boolean(opts.dryRun);
  const messageAt = receivedAt || new Date();

  const existing = await db.get('SELECT thread_id FROM email_replies WHERE id = ?', [replyId]);
  if (existing?.thread_id) return { threadId: existing.thread_id, ambiguous: false, matchedBy: null };

  const normalizedSubject = normalizeSubject(subject);
  let threadId = null;
  let matchedBy = null;
  let replyToMessageId = null;
  let ambiguous = false;

  // 规则 1/2：In-Reply-To 精确匹配，其次 References 中任意 Message-ID
  const candidates = [];
  if (inReplyTo) candidates.push({ id: String(inReplyTo).trim(), by: 'in_reply_to' });
  for (const ref of extractMessageIds(references)) candidates.push({ id: ref, by: 'references' });
  for (const cand of candidates) {
    if (!cand.id) continue;
    const match = await findThreadByMessageId(db, cand.id);
    if (!match) continue;
    threadId = await ensureThreadForMatch(db, match, normalizedSubject, dryRun);
    matchedBy = cand.by;
    replyToMessageId = cand.id;
    break;
  }

  // 规则 3：对应发送记录已挂 thread
  if (!threadId && emailRecordId) {
    const record = await db.get('SELECT thread_id FROM email_records WHERE id = ?', [emailRecordId]);
    if (record?.thread_id) {
      threadId = record.thread_id;
      matchedBy = 'record';
    }
  }

  // 规则 4：同 customer + 同 campaign + 同主题 + 60 天窗口
  if (!threadId && campaignId && customerId) {
    const bySubject = await matchThreadBySubject(db, { campaignId, customerId, normalizedSubject, messageAt });
    if (bySubject.threadId) {
      threadId = bySubject.threadId;
      matchedBy = 'subject';
    } else if (bySubject.ambiguous) {
      ambiguous = true; // 同邮箱多项目，保持 NULL 交人工
    }
  }

  // 规则 5：有唯一归属但无历史 thread → 新建
  if (!threadId && !ambiguous && campaignId && customerId) {
    threadId = await createThread(db, { campaignId, customerId, normalizedSubject, messageAt }, dryRun);
    matchedBy = 'new';
  }

  // 规则 6：未识别回复（customerId 为空）不建 thread
  if (!threadId) return { threadId: null, ambiguous, matchedBy: ambiguous ? null : matchedBy };

  if (!dryRun) {
    await db.run(
      'UPDATE email_replies SET thread_id = ?, reply_to_message_id = ?, updated_at = NOW() WHERE id = ?',
      [threadId, replyToMessageId, replyId]
    );
    await bumpThread(db, threadId, messageAt);
    // 多邮箱：会话归属到首封邮件所在邮箱（只补空，不覆盖）
    const replyMailbox = await db.get('SELECT mailbox_id FROM email_replies WHERE id = ?', [replyId]);
    if (replyMailbox?.mailbox_id && threadId) {
      await db.run('UPDATE email_threads SET mailbox_id = ? WHERE id = ? AND mailbox_id IS NULL',
        [replyMailbox.mailbox_id, threadId]);
    }
  }
  return { threadId, ambiguous: false, matchedBy };
}

// 发送记录侧归属：按回复头命中来信复用，否则按 campaign/customer + 主题补建。幂等。
async function assignRecordThread(recordId, db = dbOperations, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const record = await db.get(
    'SELECT id, thread_id, draft_id, campaign_id, customer_id, subject, in_reply_to, references_json, created_at FROM email_records WHERE id = ?',
    [recordId]
  );
  if (!record) {
    const error = new Error('发送记录不存在');
    error.statusCode = 404;
    throw error;
  }
  if (record.thread_id) return { threadId: record.thread_id, matchedBy: null };

  const messageAt = record.created_at || new Date();
  const normalizedSubject = normalizeSubject(record.subject);
  let threadId = null;
  let matchedBy = null;

  // 1) 发送记录的 In-Reply-To / References 命中来信或已发送邮件
  const candidates = [];
  if (record.in_reply_to) candidates.push({ id: String(record.in_reply_to).trim(), by: 'in_reply_to' });
  for (const ref of extractMessageIds(record.references_json)) candidates.push({ id: ref, by: 'references' });
  for (const cand of candidates) {
    if (!cand.id) continue;
    const match = await findThreadByMessageId(db, cand.id);
    if (!match) continue;
    threadId = await ensureThreadForMatch(db, match, normalizedSubject, dryRun);
    matchedBy = cand.by;
    break;
  }

  // 2) 反查：已有来信挂在该发送记录上且已有 thread
  if (!threadId) {
    const reply = await db.get(
      'SELECT thread_id FROM email_replies WHERE email_record_id = ? AND thread_id IS NOT NULL ORDER BY received_at DESC LIMIT 1',
      [recordId]
    );
    if (reply?.thread_id) {
      threadId = reply.thread_id;
      matchedBy = 'record';
    }
  }

  // 3) 按 campaign/customer + 主题窗口复用或补建（发送侧归属明确，跨项目不判冲突，直接各建各的）
  if (!threadId && record.campaign_id && record.customer_id) {
    const bySubject = await matchThreadBySubject(db, {
      campaignId: record.campaign_id, customerId: record.customer_id, normalizedSubject, messageAt
    });
    if (bySubject.threadId) {
      threadId = bySubject.threadId;
      matchedBy = 'subject';
    } else {
      threadId = await createThread(db, {
        campaignId: record.campaign_id, customerId: record.customer_id, normalizedSubject, messageAt
      }, dryRun);
      matchedBy = 'new';
    }
  }

  if (!threadId) return { threadId: null, matchedBy: null };
  if (!dryRun) {
    await db.run('UPDATE email_records SET thread_id = ? WHERE id = ?', [threadId, recordId]);
    await bumpThread(db, threadId, messageAt);
    // 多邮箱：会话归属到发送记录所在邮箱（只补空，不覆盖）
    const recordMailbox = await db.get('SELECT mailbox_id FROM email_records WHERE id = ?', [recordId]);
    if (recordMailbox?.mailbox_id && threadId) {
      await db.run('UPDATE email_threads SET mailbox_id = ? WHERE id = ? AND mailbox_id IS NULL',
        [recordMailbox.mailbox_id, threadId]);
    }
  }
  return { threadId, matchedBy };
}

// 人工归属：绑定到指定项目/KOL，threadId 给了就用，没给按规则 4 查找或新建
async function reassignReply(replyId, { campaignId, customerId, threadId }, db = dbOperations) {
  const reply = await db.get(
    'SELECT id, thread_id, subject, received_at FROM email_replies WHERE id = ?',
    [replyId]
  );
  if (!reply) {
    const error = new Error('回复不存在');
    error.statusCode = 404;
    throw error;
  }
  if (!customerId) {
    const error = new Error('customer_id 为必填字段');
    error.statusCode = 400;
    throw error;
  }

  const messageAt = reply.received_at || new Date();
  const normalizedSubject = normalizeSubject(reply.subject);
  let targetThreadId = Number(threadId) || null;

  if (targetThreadId) {
    const thread = await db.get('SELECT id FROM email_threads WHERE id = ?', [targetThreadId]);
    if (!thread) {
      const error = new Error('会话不存在');
      error.statusCode = 404;
      throw error;
    }
  }
  if (!targetThreadId && campaignId) {
    const bySubject = await matchThreadBySubject(db, { campaignId, customerId, normalizedSubject, messageAt });
    targetThreadId = bySubject.threadId;
  }
  if (!targetThreadId) {
    targetThreadId = await createThread(db, { campaignId, customerId, normalizedSubject, messageAt });
  }

  await db.run(
    'UPDATE email_replies SET campaign_id = ?, customer_id = ?, thread_id = ?, updated_at = NOW() WHERE id = ?',
    [campaignId || null, customerId, targetThreadId, replyId]
  );
  // 换会话时校正两边计数；原会话不变则不动
  if (Number(reply.thread_id) !== Number(targetThreadId)) {
    if (reply.thread_id) {
      await db.run(
        'UPDATE email_threads SET message_count = GREATEST(message_count - 1, 0), updated_at = NOW() WHERE id = ?',
        [reply.thread_id]
      );
    }
    await bumpThread(db, targetThreadId, messageAt);
  }
  return { threadId: targetThreadId };
}

module.exports = {
  THREAD_WINDOW_DAYS,
  normalizeSubject,
  extractMessageIds,
  isWithinWindow,
  findOrCreateThread,
  assignReplyThread,
  assignRecordThread,
  reassignReply
};
