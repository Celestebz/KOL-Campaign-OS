// 准实时收信：IMAP IDLE 长连接 + 断线递增重连 + 15 分钟补偿扫描 + UID 增量。
// - UID 游标替代 UNSEEN 过滤：业务人员在网页端读过也不漏信，且不修改邮箱已读状态
// - Message-ID 唯一索引兜底幂等；未匹配邮件进入"未识别回复"（customer_id 为空）
// - 未识别回复不做 AI 摘要（避免广告消耗 AI），人工绑定 KOL 后再触发
// 注：imapflow / aiClient 通过模块对象引用（非解构），便于测试 monkey-patch。
const imapflow = require('imapflow');
const { dbOperations } = require('../database');
const emailReplyPoller = require('./emailReplyPoller');
const emailFilterService = require('./emailFilterService');
const emailBounceService = require('./emailBounceService');
const { parseInboundBody } = require('./emailBodyParser');

const { normalizeAddress, findOwnerByAddress } = emailReplyPoller;

const RECONNECT_DELAYS_MS = [5000, 15000, 30000, 60000];
const FULL_SCAN_INTERVAL_MS = 15 * 60 * 1000;
const SYNC_MODES = new Set(['idle', 'poll', 'off']);

const state = {
  mode: 'off',
  status: 'off', // connecting | connected | reconnecting | failed | off
  lastMailAt: null,
  lastFullSyncAt: null,
  lastError: null,
  reconnectAttempts: 0,
  connectedSince: null
};

let client = null;
let idleTask = null;
let pollTimer = null;
let fullScanTimer = null;
let stopping = false;
let fetching = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getSettings() {
  return dbOperations.get('SELECT * FROM email_settings ORDER BY id LIMIT 1');
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

// 处理一封已抓取的邮件：幂等去重 → 匹配 → 入库 → AI 摘要（仅已匹配）
async function processFetchedMessage(message) {
  const uid = message.uid;
  const messageId = message.envelope?.messageId || `uid-${uid}`;
  const existing = await dbOperations.get('SELECT id FROM email_replies WHERE message_id = ? LIMIT 1', [messageId]);
  if (existing) return { duplicate: true };

  const fromAddress = normalizeAddress(message.envelope?.from?.[0]?.address || '');
  const owner = fromAddress ? await findOwnerByAddress(fromAddress) : null;
  const filterRule = fromAddress ? await emailFilterService.matchingRule(fromAddress) : null;
  const bodyText = parseInboundBody(message.bodyParts?.get('text') || '');
  const systemMail = emailBounceService.detectSystemMail({
    fromAddress, subject: message.envelope?.subject || '', bodyText
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
        ai_status, confirm_status, classification, classification_source, classification_reason, classified_at,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NOW(), NOW(), NOW())`,
      [owner?.id || null, owner?.campaign_id || null, owner?.customer_id || null, fromAddress, messageId,
       message.envelope?.subject || '', bodyText, message.envelope?.date || new Date(), confirmStatus,
       classification, classificationSource, classificationReason]
    );
    if (owner?.customer_id && !filterRule && !systemMail.isSystem) {
      await emailReplyPoller.markWaitingReply(owner.campaign_id, owner.customer_id);
    }
    if (result.id && systemMail.isSystem) emailBounceService.processSystemMail(result.id).catch(() => {});
    if (result.id && owner?.customer_id && !filterRule && !systemMail.isSystem) emailReplyPoller.summarizeReply(result.id).catch(() => {});
    if (result.id && !owner?.customer_id && !filterRule && !systemMail.isSystem) emailFilterService.classifyStoredReply(result.id).catch(() => {});
    return { matched: Boolean(owner?.customer_id), replyId: result.id || null };
  } catch (error) {
    // Message-ID 唯一索引兜底：并发重复按已处理对待
    if (String(error.message).includes('Duplicate entry')) return { duplicate: true };
    throw error;
  }
}

// UID 增量抓取：只处理 uid > last_uid 的邮件并推进游标（逐封持久化，崩溃不重复）
async function fetchNew(activeClient) {
  if (fetching) return { fetched: 0, matched: 0, unmatched: 0, busy: true };
  fetching = true;
  try {
    const settings = await getSettings();
    if (!settings) return { fetched: 0, matched: 0, unmatched: 0 };
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
    for await (const message of activeClient.fetch(range, { envelope: true, bodyParts: ['text'] }, { uid: true })) {
      if (!message?.uid || message.uid <= lastUid) continue;
      const outcome = await processFetchedMessage(message);
      fetched += 1;
      if (outcome.duplicate) { /* 不计入 */ } else if (outcome.matched) matched += 1;
      else unmatched += 1;
      lastUid = message.uid;
      state.lastMailAt = new Date();
      await dbOperations.run('UPDATE email_settings SET last_uid = ? WHERE id = ?', [lastUid, settings.id]);
    }
    return { fetched, matched, unmatched };
  } finally {
    fetching = false;
  }
}

async function fetchNewSafe(activeClient) {
  try {
    return await fetchNew(activeClient);
  } catch (error) {
    state.lastError = error.message;
    return { fetched: 0, matched: 0, unmatched: 0, error: error.message };
  }
}

async function runIdleLoop() {
  let attempt = 0;
  while (!stopping) {
    const settings = await getSettings();
    if (!settings?.imap_host || !settings?.username || !settings?.password) {
      state.status = 'failed';
      state.lastError = 'IMAP 未配置完整';
      return;
    }
    try {
      state.status = attempt ? 'reconnecting' : 'connecting';
      state.reconnectAttempts = attempt;
      client = makeClient(settings);
      await client.connect();
      await client.mailboxOpen('INBOX');
      attempt = 0;
      state.status = 'connected';
      state.connectedSince = new Date();
      state.lastError = null;
      state.reconnectAttempts = 0;
      // 连接/重连后立即补扫，覆盖断线窗口
      const catchUp = await fetchNewSafe(client);
      if (!catchUp.busy && !catchUp.error) state.lastFullSyncAt = new Date();
      client.on('exists', () => { fetchNewSafe(client); });
      client.on('error', () => {});
      while (!stopping && client.usable) {
        await client.idle();
        await fetchNewSafe(client);
      }
      if (stopping) break;
      throw new Error('IDLE 连接已断开');
    } catch (error) {
      state.lastError = error.message;
      state.status = 'reconnecting';
      state.reconnectAttempts = attempt + 1;
      console.error(`[email] IDLE 连接异常（第 ${attempt + 1} 次重连）:`, error.message);
      try { await client?.logout(); } catch { /* ignore */ }
      client = null;
      if (stopping) break;
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      attempt += 1;
      await sleep(delay);
    }
  }
}

async function pollOnceLive() {
  const settings = await getSettings();
  if (!settings?.imap_host || !settings?.username || !settings?.password) return;
  const pollClient = makeClient(settings);
  try {
    await pollClient.connect();
    await pollClient.mailboxOpen('INBOX');
    const result = await fetchNewSafe(pollClient);
    if (!result.error) state.lastFullSyncAt = new Date();
    await pollClient.logout();
  } catch (error) {
    state.lastError = error.message;
    try { await pollClient.logout(); } catch { /* ignore */ }
  }
}

async function stopMachinery() {
  stopping = true;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (fullScanTimer) { clearInterval(fullScanTimer); fullScanTimer = null; }
  try { await client?.logout(); } catch { /* ignore */ }
  client = null;
  if (idleTask) { await idleTask.catch(() => {}); idleTask = null; }
}

async function startEmailSync() {
  // 测试环境不建立真实连接（node --test 默认 NODE_ENV=test）
  if (process.env.NODE_ENV === 'test') {
    state.mode = 'off';
    state.status = 'off';
    return;
  }
  await stopMachinery();
  stopping = false;
  const backfilled = await emailBounceService.backfillSystemMails().catch((error) => {
    console.error('[email] 历史系统邮件整理失败:', error.message);
    return 0;
  });
  if (backfilled > 0) console.log(`[email] 已整理 ${backfilled} 封历史系统邮件/退信。`);
  const settings = await getSettings();
  const mode = SYNC_MODES.has(settings?.sync_mode) ? settings.sync_mode : 'idle';
  state.mode = mode;

  if (mode === 'off' || !settings?.imap_host) {
    state.status = 'off';
    console.log('[email] 回复同步已关闭（收信模式 off 或未配置 IMAP）。');
    return;
  }
  if (mode === 'poll') {
    const minutes = Number(settings.poll_interval_minutes) || 5;
    state.status = 'connected';
    console.log(`[email] 回复追踪：定时轮询模式，每 ${minutes} 分钟一次。`);
    pollTimer = setInterval(() => pollOnceLive(), minutes * 60 * 1000);
    pollTimer.unref();
    return;
  }
  console.log('[email] 回复追踪：实时监听模式（IMAP IDLE），15 分钟补偿扫描。');
  idleTask = runIdleLoop();
  fullScanTimer = setInterval(async () => {
    if (client && state.status === 'connected') {
      const result = await fetchNewSafe(client);
      if (!result.error && !result.busy) state.lastFullSyncAt = new Date();
    }
  }, FULL_SCAN_INTERVAL_MS);
  fullScanTimer.unref();
}

async function restartEmailSync() {
  await stopMachinery();
  await startEmailSync();
}

// 「立即同步一次」：IDLE 模式复用长连接，其他模式一次性连接补扫
async function syncNow() {
  if (state.mode === 'idle' && client && state.status === 'connected') {
    const result = await fetchNew(client);
    if (!result.error) state.lastFullSyncAt = new Date();
    return result;
  }
  const settings = await getSettings();
  if (!settings?.imap_host || !settings?.username || !settings?.password) {
    throw new Error('IMAP 未配置完整');
  }
  const oneShot = makeClient(settings);
  try {
    await oneShot.connect();
    await oneShot.mailboxOpen('INBOX');
    const result = await fetchNew(oneShot);
    state.lastFullSyncAt = new Date();
    await oneShot.logout();
    return result;
  } catch (error) {
    try { await oneShot.logout(); } catch { /* ignore */ }
    throw error;
  }
}

async function testImapConnection() {
  const settings = await getSettings();
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

function getEmailSyncStatus() {
  return {
    mode: state.mode,
    status: state.status,
    last_mail_at: state.lastMailAt,
    last_full_sync_at: state.lastFullSyncAt,
    last_error: state.lastError,
    reconnect_attempts: state.reconnectAttempts,
    connected_since: state.connectedSince
  };
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
