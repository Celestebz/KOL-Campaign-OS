// 准实时收信：IMAP IDLE 长连接 + 断线递增重连 + 15 分钟补偿扫描 + UID 增量。
// - UID 游标替代 UNSEEN 过滤：业务人员在网页端读过也不漏信，且不修改邮箱已读状态
// - Message-ID 唯一索引兜底幂等；未匹配邮件进入"未识别回复"（customer_id 为空）
// - 未识别回复不做 AI 摘要（避免广告消耗 AI），人工绑定 KOL 后再触发
// 注：imapflow / aiClient 通过模块对象引用（非解构），便于测试 monkey-patch。
const imapflow = require('imapflow');
const { dbOperations } = require('../database');
const emailMailboxes = require('./emailMailboxes');
const emailReplyPoller = require('./emailReplyPoller');
const emailFilterService = require('./emailFilterService');
const emailBounceService = require('./emailBounceService');
const { parseInboundBody } = require('./emailBodyParser');
const emailMimeParser = require('./emailMimeParser');
const emailThreader = require('./emailThreader');
const requestContext = require('../utils/requestContext');

const { normalizeAddress, findOwnerByAddress } = emailReplyPoller;
const { toStoredMessageId } = emailMimeParser;

// raw_source 超过 2MB 不落库（置 NULL），避免超大附件邮件撑爆行存储
const RAW_SOURCE_MAX_BYTES = 2 * 1024 * 1024;

const RECONNECT_DELAYS_MS = [5000, 15000, 30000, 60000];
const FULL_SCAN_INTERVAL_MS = 15 * 60 * 1000;
const SYNC_MODES = new Set(['idle', 'poll', 'off']);

// 多邮箱：每个启用邮箱一个 worker（IDLE 长连接或定时轮询），各自维护 last_uid 游标
const workers = new Map(); // mailboxId -> worker
let fullScanTimer = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeWorker(settings) {
  return {
    mailboxId: settings.id,
    settings,
    client: null,
    idleTask: null,
    pollTimer: null,
    stopping: false,
    fetching: false,
    state: {
      mode: 'off',
      status: 'off', // connecting | connected | reconnecting | failed | off
      lastMailAt: null,
      lastFullSyncAt: null,
      lastError: null,
      reconnectAttempts: 0,
      connectedSince: null
    }
  };
}

function makeClient(settings) {
  return new imapflow.ImapFlow({
    host: settings.imap_host,
    port: Number(settings.imap_port) || 993,
    secure: settings.imap_secure === undefined ? true : Boolean(settings.imap_secure),
    auth: { user: settings.username, pass: settings.password },
    logger: false,
    socketTimeout: 30000
  });
}

// 会话归属：失败只记日志，不影响入库与 UID 推进
async function assignThreadSafely(params) {
  try {
    const result = await emailThreader.assignReplyThread(params);
    if (result?.ambiguous) {
      console.warn(`[email] 回复 ${params.replyId} 会话归属歧义（同邮箱多项目），待人工处理。`);
    }
  } catch (error) {
    console.error(`[email] 回复 ${params.replyId} 会话归属失败:`, error.message);
  }
}

// 处理一封已抓取的邮件：幂等去重 → MIME 解析（失败回退旧解析器）→ 匹配 → 入库 → 会话归属 → AI 摘要（仅已匹配）
async function processFetchedMessage(message, mailboxId, ownerUserId = null) {
  const uid = message.uid;
  const messageId = message.envelope?.messageId || `uid-${uid}`;
  const existing = await dbOperations.get('SELECT id FROM email_replies WHERE message_id = ? LIMIT 1', [messageId]);
  if (existing) return { duplicate: true };

  // 标准 MIME 解析（优先用 RFC822 原始源）；失败回退旧自写解析器，入库与 UID 推进不中断
  const parsed = message.source ? await emailMimeParser.parseRawEmail(message.source) : null;
  const parseOk = parsed?.parseStatus === 'ok';
  const fromAddress = normalizeAddress((parseOk && parsed.fromAddress) || message.envelope?.from?.[0]?.address || '');
  const subject = (parseOk && parsed.subject) || message.envelope?.subject || '';
  const receivedAt = (parseOk && parsed.date) || message.envelope?.date || new Date();
  const bodyText = parseOk ? (parsed.bodyText || '') : parseInboundBody(message.bodyParts?.get('text') || '');
  const rawSource = parseOk && message.source && message.source.length <= RAW_SOURCE_MAX_BYTES
    ? message.source.toString('utf8') : null;
  const owner = fromAddress ? await findOwnerByAddress(fromAddress, ownerUserId) : null;
  const filterRule = fromAddress ? await emailFilterService.matchingRule(fromAddress, ownerUserId) : null;
  const systemMail = emailBounceService.detectSystemMail({
    fromAddress, subject, bodyText
  });
  const classification = systemMail.isSystem ? 'system' : (filterRule ? 'spam' : (owner?.customer_id ? 'kol_reply' : 'needs_review'));
  const confirmStatus = systemMail.isSystem ? 'system' : (filterRule ? 'spam' : 'pending');
  const classificationSource = systemMail.isSystem ? 'system' : (filterRule ? 'rule' : 'system');
  const classificationReason = systemMail.isSystem
    ? (systemMail.systemMailType === 'bounce' ? '识别为退信通知' : '识别为自动回复')
    : (filterRule ? '命中内部屏蔽规则' : (owner?.customer_id ? '发件地址已匹配 KOL' : '等待 AI 或人工确认'));

  try {
    const result = await dbOperations.run(
      `INSERT INTO email_replies
       (email_record_id, campaign_id, customer_id, from_address, message_id, subject, body_text, received_at,
        mailbox_id, owner_user_id,
        ai_status, confirm_status, classification, classification_source, classification_reason, classified_at,
        created_at, updated_at,
        in_reply_to, references_json, clean_body_text, body_html, quoted_body_text, signature_text,
        raw_source, parse_status, parse_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NOW(), NOW(), NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [owner?.id || null, owner?.campaign_id || null, owner?.customer_id || null, fromAddress, messageId,
       subject, bodyText, receivedAt, mailboxId || null, ownerUserId, confirmStatus,
       classification, classificationSource, classificationReason,
       parseOk ? toStoredMessageId(parsed.inReplyTo) : null,
       parseOk ? JSON.stringify((parsed.references || []).map(toStoredMessageId)) : null,
       parseOk ? parsed.cleanBodyText : null,
       parseOk ? parsed.bodyHtml : null,
       parseOk ? parsed.quotedBodyText : null,
       parseOk ? parsed.signatureText : null,
       rawSource,
       parseOk ? 'ok' : 'failed',
       parseOk ? null : String(parsed?.parseError || 'IMAP 未返回邮件原始源').slice(0, 2000)]
    );
    if (result.id) {
      await assignThreadSafely({
        replyId: result.id,
        messageId,
        inReplyTo: parseOk ? toStoredMessageId(parsed.inReplyTo) : null,
        references: parseOk ? (parsed.references || []).map(toStoredMessageId) : [],
        subject,
        fromAddress,
        receivedAt,
        campaignId: owner?.campaign_id || null,
        customerId: owner?.customer_id || null,
        emailRecordId: owner?.id || null
        , ownerUserId
      });
    }
    if (owner?.customer_id && !filterRule && !systemMail.isSystem) {
      await emailReplyPoller.markWaitingReply(owner.campaign_id, owner.customer_id);
    }
    const asOwner = (fn) => requestContext.runWithUser({ id: ownerUserId }, fn);
    if (result.id && systemMail.isSystem) asOwner(() => emailBounceService.processSystemMail(result.id)).catch(() => {});
    if (result.id && owner?.customer_id && !filterRule && !systemMail.isSystem) asOwner(() => emailReplyPoller.summarizeReply(result.id)).catch(() => {});
    if (result.id && !owner?.customer_id && !filterRule && !systemMail.isSystem) asOwner(() => emailFilterService.classifyStoredReply(result.id)).catch(() => {});
    return { matched: Boolean(owner?.customer_id), replyId: result.id || null };
  } catch (error) {
    // Message-ID 唯一索引兜底：并发重复按已处理对待
    if (String(error.message).includes('Duplicate entry')) return { duplicate: true };
    throw error;
  }
}

// UID 增量抓取：只处理 uid > last_uid 的邮件并推进游标（逐封持久化，崩溃不重复）
async function fetchNew(worker, activeClient = worker.client) {
  if (worker.fetching) return { fetched: 0, matched: 0, unmatched: 0, busy: true };
  worker.fetching = true;
  const settings = worker.settings;
  try {
    let lastUid = Number(settings.last_uid) || 0;
    if (!lastUid) {
      // 首次初始化：只收启用之后的新邮件，历史邮件由一次性导入补齐
      lastUid = Math.max(0, Number(activeClient.mailbox?.uidNext || 1) - 1);
      await dbOperations.run('UPDATE email_settings SET last_uid = ? WHERE id = ?', [lastUid, settings.id]);
      return { fetched: 0, matched: 0, unmatched: 0, initialized: true };
    }

    let fetched = 0;
    let matched = 0;
    let unmatched = 0;
    const range = `${lastUid + 1}:*`;
    for await (const message of activeClient.fetch(range, { envelope: true, bodyParts: ['text'], source: true }, { uid: true })) {
      if (!message?.uid || message.uid <= lastUid) continue;
      const outcome = await processFetchedMessage(message, settings.id, settings.owner_user_id);
      fetched += 1;
      if (outcome.duplicate) { /* 不计入 */ } else if (outcome.matched) matched += 1;
      else unmatched += 1;
      lastUid = message.uid;
      settings.last_uid = lastUid;
      worker.state.lastMailAt = new Date();
      await dbOperations.run('UPDATE email_settings SET last_uid = ? WHERE id = ?', [lastUid, settings.id]);
    }
    return { fetched, matched, unmatched };
  } finally {
    worker.fetching = false;
  }
}

async function fetchNewSafe(worker, activeClient) {
  try {
    return await fetchNew(worker, activeClient);
  } catch (error) {
    worker.state.lastError = error.message;
    return { fetched: 0, matched: 0, unmatched: 0, error: error.message };
  }
}

async function runIdleLoop(worker) {
  const settings = worker.settings;
  let attempt = 0;
  while (!worker.stopping) {
    try {
      worker.state.status = attempt ? 'reconnecting' : 'connecting';
      worker.state.reconnectAttempts = attempt;
      worker.client = makeClient(settings);
      await worker.client.connect();
      await worker.client.mailboxOpen('INBOX');
      attempt = 0;
      worker.state.status = 'connected';
      worker.state.connectedSince = new Date();
      worker.state.lastError = null;
      worker.state.reconnectAttempts = 0;
      // 连接/重连后立即补扫，覆盖断线窗口
      const catchUp = await fetchNewSafe(worker);
      if (!catchUp.busy && !catchUp.error) worker.state.lastFullSyncAt = new Date();
      worker.client.on('exists', () => { fetchNewSafe(worker); });
      worker.client.on('error', () => {});
      while (!worker.stopping && worker.client.usable) {
        await worker.client.idle();
        await fetchNewSafe(worker);
      }
      if (worker.stopping) break;
      throw new Error('IDLE 连接已断开');
    } catch (error) {
      worker.state.lastError = error.message;
      worker.state.status = 'reconnecting';
      worker.state.reconnectAttempts = attempt + 1;
      console.error(`[email] IDLE 连接异常（邮箱 ${settings.username}，第 ${attempt + 1} 次重连）:`, error.message);
      try { await worker.client?.logout(); } catch { /* ignore */ }
      worker.client = null;
      if (worker.stopping) break;
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      attempt += 1;
      await sleep(delay);
    }
  }
}

// poll 模式：一次性连接补扫后断开
async function pollOnceLive(worker) {
  const oneShot = makeClient(worker.settings);
  try {
    await oneShot.connect();
    await oneShot.mailboxOpen('INBOX');
    const result = await fetchNewSafe(worker, oneShot);
    if (!result.error && !result.busy) worker.state.lastFullSyncAt = new Date();
    await oneShot.logout();
  } catch (error) {
    worker.state.lastError = error.message;
    worker.state.status = 'failed';
    try { await oneShot.logout(); } catch { /* ignore */ }
  }
}

function startWorker(settings) {
  const mode = SYNC_MODES.has(settings?.sync_mode) ? settings.sync_mode : 'idle';
  const worker = makeWorker(settings);
  worker.state.mode = mode;
  workers.set(settings.id, worker);

  if (mode === 'off' || !settings?.imap_host || !settings?.username || !settings?.password) {
    worker.state.status = 'off';
    return worker;
  }
  if (mode === 'poll') {
    const minutes = Number(settings.poll_interval_minutes) || 5;
    worker.state.status = 'connected';
    console.log(`[email] 回复追踪（${settings.username}）：定时轮询模式，每 ${minutes} 分钟一次。`);
    worker.pollTimer = setInterval(() => pollOnceLive(worker), minutes * 60 * 1000);
    worker.pollTimer.unref();
    return worker;
  }
  console.log(`[email] 回复追踪（${settings.username}）：实时监听模式（IMAP IDLE）。`);
  worker.idleTask = runIdleLoop(worker);
  return worker;
}

async function stopWorker(worker) {
  worker.stopping = true;
  if (worker.pollTimer) { clearInterval(worker.pollTimer); worker.pollTimer = null; }
  try { await worker.client?.logout(); } catch { /* ignore */ }
  worker.client = null;
  if (worker.idleTask) { await worker.idleTask.catch(() => {}); worker.idleTask = null; }
}

async function stopMachinery() {
  if (fullScanTimer) { clearInterval(fullScanTimer); fullScanTimer = null; }
  for (const worker of workers.values()) await stopWorker(worker);
  workers.clear();
}

async function startEmailSync() {
  // 测试环境不建立真实连接（node --test 默认 NODE_ENV=test）
  if (process.env.NODE_ENV === 'test') return;
  await stopMachinery();
  const backfilled = await emailBounceService.backfillSystemMails().catch((error) => {
    console.error('[email] 历史系统邮件整理失败:', error.message);
    return 0;
  });
  if (backfilled > 0) console.log(`[email] 已整理 ${backfilled} 封历史系统邮件（退信）。`);

  const rows = await emailMailboxes.listMailboxes({ enabledOnly: true });
  for (const settings of rows) startWorker(settings);
  if (!rows.length) {
    console.log('[email] 回复同步已关闭（无启用的邮箱）。');
    return;
  }
  // 15 分钟补偿扫描：遍历所有已连接的 worker
  fullScanTimer = setInterval(async () => {
    for (const worker of workers.values()) {
      if (worker.client && worker.state.status === 'connected') {
        const result = await fetchNewSafe(worker);
        if (!result.error && !result.busy) worker.state.lastFullSyncAt = new Date();
      }
    }
  }, FULL_SCAN_INTERVAL_MS);
  fullScanTimer.unref();
}

async function restartEmailSync(mailboxId = null) {
  if (process.env.NODE_ENV === 'test') return;
  if (!mailboxId) {
    await startEmailSync();
    return;
  }
  const id = Number(mailboxId);
  const worker = workers.get(id);
  if (worker) {
    await stopWorker(worker);
    workers.delete(id);
  }
  const settings = await emailMailboxes.getMailboxById(id);
  if (settings && settings.enabled) startWorker(settings);
}

// “立即同步一次”：带 id 只同步该邮箱；不带 id 聚合所有启用邮箱
async function syncNow(mailboxId = null) {
  const targets = mailboxId
    ? [await emailMailboxes.getMailboxById(Number(mailboxId))].filter(Boolean)
    : await emailMailboxes.listMailboxes({ enabledOnly: true });
  const total = { fetched: 0, matched: 0, unmatched: 0 };
  for (const settings of targets) {
    const result = await syncMailboxNow(settings);
    total.fetched += result.fetched;
    total.matched += result.matched;
    total.unmatched += result.unmatched;
  }
  return total;
}

async function syncMailboxNow(settings) {
  const worker = workers.get(settings.id);
  // IDLE 模式复用长连接，其他模式一次性连接补扫
  if (worker?.state.mode === 'idle' && worker.client && worker.state.status === 'connected') {
    const result = await fetchNew(worker);
    if (!result.error) worker.state.lastFullSyncAt = new Date();
    return result;
  }
  if (!settings?.imap_host || !settings?.username || !settings?.password) {
    throw new Error(`邮箱 ${settings?.username || settings?.id} 的 IMAP 未配置完整`);
  }
  const oneShot = makeClient(settings);
  try {
    await oneShot.connect();
    await oneShot.mailboxOpen('INBOX');
    const tempWorker = makeWorker(settings);
    const result = await fetchNew(tempWorker, oneShot);
    if (worker) worker.state.lastFullSyncAt = new Date();
    await oneShot.logout();
    return result;
  } catch (error) {
    try { await oneShot.logout(); } catch { /* ignore */ }
    throw error;
  }
}

async function testImapConnection(mailboxId = null) {
  const settings = mailboxId
    ? await emailMailboxes.getMailboxById(Number(mailboxId))
    : await emailMailboxes.getDefaultMailbox();
  if (!settings?.imap_host || !settings?.username || !settings?.password) {
    throw new Error('IMAP 未配置完整');
  }
  const testClient = makeClient(settings);
  try {
    await testClient.connect();
    await testClient.mailboxOpen('INBOX', { readOnly: true });
    const info = { exists: testClient.mailbox?.exists ?? null, uidNext: testClient.mailbox?.uidNext ?? null };
    await testClient.logout();
    return info;
  } catch (error) {
    try { await testClient.logout(); } catch { /* ignore */ }
    throw error;
  }
}

async function getEmailSyncStatus(ownerUserId = null) {
  const rows = await emailMailboxes.listMailboxes({ ownerUserId });
  return rows.map((row) => {
    const worker = workers.get(row.id);
    return {
      mailbox_id: row.id,
      username: row.username,
      label: row.label,
      mode: worker?.state.mode || row.sync_mode || 'off',
      status: worker?.state.status || 'off',
      last_mail_at: worker?.state.lastMailAt || null,
      last_full_sync_at: worker?.state.lastFullSyncAt || null,
      last_error: worker?.state.lastError || null,
      reconnect_attempts: worker?.state.reconnectAttempts || 0,
      connected_since: worker?.state.connectedSince || null
    };
  });
}

module.exports = {
  startEmailSync,
  restartEmailSync,
  stopEmailSync: stopMachinery,
  syncNow,
  testImapConnection,
  getEmailSyncStatus,
  fetchNew,
  processFetchedMessage
};
