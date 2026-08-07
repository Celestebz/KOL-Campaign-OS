const test = require('node:test');
const assert = require('node:assert/strict');
const imapflow = require('imapflow');
const { dbOperations } = require('../database');
const emailReplyPoller = require('../services/emailReplyPoller');
const emailThreader = require('../services/emailThreader');
const liveSync = require('../services/emailLiveSync');

function makeMail(uid, { messageId, from, subject } = {}) {
  return {
    uid,
    envelope: {
      messageId: messageId || `<m${uid}@test>`,
      from: [{ address: from || 'kol@example.com' }],
      subject: subject || 'Re: 合作咨询',
      date: new Date('2026-07-27T06:00:00Z')
    },
    bodyParts: new Map([['text', Buffer.from('你好，我对合作感兴趣')]])
  };
}

function fakeClient({ uidNext = 101, messages = [] } = {}) {
  const calls = { flagsAdd: 0 };
  return {
    calls,
    mailbox: { uidNext, exists: messages.length },
    usable: true,
    on() {},
    async *fetch() { for (const message of messages) yield message; },
    async messageFlagsAdd() { calls.flagsAdd += 1; },
    async connect() {},
    async mailboxOpen() {},
    async idle() {},
    async logout() {}
  };
}
function makeWorkerForTest(client, settings) {
  return {
    mailboxId: settings.id,
    settings,
    client,
    idleTask: null,
    pollTimer: null,
    stopping: false,
    fetching: false,
    state: {
      mode: 'idle', status: 'connected', lastMailAt: null, lastFullSyncAt: null,
      lastError: null, reconnectAttempts: 0, connectedSince: null
    }
  };
}

// 按 SQL 分发：设置表 / 回复去重 / 发件人匹配；捕获写入与 UID 游标推进
// 会话归属走真实 dbOperations.query，这里统一 stub 掉并记录调用参数
function mockDb({ settings, existingMessageIds = new Set(), matchedEmails = {}, throwOnInsert = null,
  threadResult = { threadId: null, ambiguous: false, matchedBy: null } } = {}) {
  const inserts = [];
  const uidWrites = [];
  const outreachWrites = [];
  const threadCalls = [];
  const originalGet = dbOperations.get;
  const originalRun = dbOperations.run;
  const originalAssign = emailThreader.assignReplyThread;

  emailThreader.assignReplyThread = async (params) => {
    threadCalls.push(params);
    if (threadResult instanceof Error) throw threadResult;
    return threadResult;
  };

  dbOperations.get = async (sql, params = []) => {
    const text = String(sql);
    if (text.includes('FROM email_replies WHERE message_id = ?')) {
      return existingMessageIds.has(params[0]) ? { id: 1 } : null;
    }
    if (text.includes('FROM email_records WHERE LOWER(to_address)')) return null;
    if (text.includes('FROM customers WHERE LOWER(email)')) {
      const customerId = matchedEmails[params[0]];
      return customerId ? { id: customerId } : null;
    }
    if (text.includes('FROM campaign_kols WHERE customer_id = ?')) {
      return { campaign_id: 2, customer_id: params[0] };
    }
    return null;
  };
  dbOperations.run = async (sql, params = []) => {
    const text = String(sql);
    if (text.startsWith('INSERT INTO email_replies')) {
      if (throwOnInsert) throw throwOnInsert;
      inserts.push(params);
      return { id: 900 + inserts.length, changes: 1 };
    }
    if (text.includes('UPDATE email_settings SET last_uid')) {
      uidWrites.push(params[0]);
      return { changes: 1 };
    }
    if (text.includes('UPDATE campaign_kols SET needs_reply = 1')) {
      outreachWrites.push({ sql: text, params });
      return { changes: 1 };
    }
    return { changes: 1 };
  };
  return {
    inserts,
    uidWrites,
    outreachWrites,
    threadCalls,
    restore() {
      dbOperations.get = originalGet;
      dbOperations.run = originalRun;
      emailThreader.assignReplyThread = originalAssign;
    }
  };
}

const baseSettings = {
  id: 1, imap_host: 'imap.test', imap_port: 993, imap_secure: 1,
  username: 'u@test.com', password: 'secret', sync_mode: 'idle', last_uid: 100
};

test('first connection initializes the UID cursor to the current mailbox high-water mark', async () => {
  const settings = { ...baseSettings, last_uid: 0 };
  const db = mockDb({ settings });
  try {
    const client = fakeClient({ uidNext: 250, messages: [makeMail(249)] });
    const result = await liveSync.fetchNew(makeWorkerForTest(client, settings));
    assert.deepEqual(result, { fetched: 0, matched: 0, unmatched: 0, initialized: true });
    assert.deepEqual(db.uidWrites, [249], 'cursor initialized to uidNext-1 so history is not re-imported');
    assert.equal(db.inserts.length, 0);
  } finally {
    db.restore();
  }
});

test('UID incremental fetch processes only new mail, matches KOLs and parks unknown senders', async () => {
  const settings = { ...baseSettings, last_uid: 100 };
  const db = mockDb({ settings, matchedEmails: { 'kol@example.com': 7 } });
  try {
    const client = fakeClient({
      messages: [makeMail(101, { from: 'kol@example.com' }), makeMail(102, { from: 'ad@spam.cn' })]
    });
    const result = await liveSync.fetchNew(makeWorkerForTest(client, settings));
    assert.deepEqual(result, { fetched: 2, matched: 1, unmatched: 1 });

    const [matchedInsert, unmatchedInsert] = db.inserts;
    assert.equal(matchedInsert[1], 2, 'matched reply keeps campaign attribution');
    assert.equal(matchedInsert[2], 7, 'matched reply keeps customer attribution');
    assert.equal(unmatchedInsert[1], null, 'unmatched reply has no campaign');
    assert.equal(unmatchedInsert[2], null, 'unmatched reply has no customer (未识别回复)');

    assert.deepEqual(db.uidWrites, [101, 102], 'cursor advances per message');
    assert.equal(db.outreachWrites.length, 1, 'only matched inbound mail changes outreach state');
    assert.deepEqual(db.outreachWrites[0].params, [2, 7]);
    assert.equal(client.calls.flagsAdd, 0, 'mailbox read state is never modified');
  } finally {
    db.restore();
  }
});

test('message_id dedupe skips already imported mail', async () => {
  const settings = { ...baseSettings };
  const db = mockDb({
    settings,
    existingMessageIds: new Set(['<m101@test>'])
  });
  try {
    const client = fakeClient({ messages: [makeMail(101)] });
    const result = await liveSync.fetchNew(makeWorkerForTest(client, settings));
    assert.equal(result.fetched, 1);
    assert.equal(result.matched, 0);
    assert.equal(db.inserts.length, 0);
  } finally {
    db.restore();
  }
});

test('a unique-constraint race is treated as a duplicate instead of an error', async () => {
  const settings = { ...baseSettings };
  const db = mockDb({
    settings,
    throwOnInsert: new Error("Duplicate entry '<m101@test>' for key 'uniq_email_replies_message_id'")
  });
  try {
    const client = fakeClient({ messages: [makeMail(101)] });
    const result = await liveSync.fetchNew(makeWorkerForTest(client, settings));
    assert.equal(result.fetched, 1);
    assert.deepEqual(db.uidWrites, [101], 'cursor still advances past the duplicate');
  } finally {
    db.restore();
  }
});

test('AI summary runs for matched replies only, not for unmatched', async () => {
  const summarized = [];
  const original = emailReplyPoller.summarizeReply;
  emailReplyPoller.summarizeReply = async (id) => { summarized.push(id); };
  const settings = { ...baseSettings };
  const db = mockDb({ settings, matchedEmails: { 'kol@example.com': 7 } });
  try {
    const client = fakeClient({
      messages: [makeMail(101, { from: 'kol@example.com' }), makeMail(102, { from: 'ad@spam.cn' })]
    });
    await liveSync.fetchNew(makeWorkerForTest(client, settings));
    assert.equal(summarized.length, 1, 'only the matched reply is summarized');
  } finally {
    emailReplyPoller.summarizeReply = original;
    db.restore();
  }
});

test('sync status returns one entry per mailbox', async () => {
  const emailMailboxes = require('../services/emailMailboxes');
  const original = emailMailboxes.listMailboxes;
  emailMailboxes.listMailboxes = async () => [
    { id: 1, username: 'a@x.com', label: '\u9ed8\u8ba4\u90ae\u7bb1', sync_mode: 'idle' },
    { id: 2, username: 'b@x.com', label: 'B \u4e1a\u52a1', sync_mode: 'poll' }
  ];
  try {
    const rows = await liveSync.getEmailSyncStatus();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].mailbox_id, 1);
    assert.equal(rows[0].username, 'a@x.com');
    assert.equal(rows[0].status, 'off', 'no worker yet means off');
    for (const key of ['mailbox_id', 'username', 'label', 'mode', 'status', 'last_mail_at', 'last_full_sync_at', 'last_error', 'reconnect_attempts', 'connected_since']) {
      assert.ok(key in rows[0], `status missing ${key}`);
    }
  } finally {
    emailMailboxes.listMailboxes = original;
  }
});

// ---- 标准 MIME 解析接入 ----

const RAW_REPLY = [
  'From: Kol Name <kol@example.com>',
  'To: u@test.com',
  'Subject: Re: 合作咨询',
  'Date: Mon, 27 Jul 2026 06:00:00 +0000',
  'Message-ID: <reply-1@test>',
  'In-Reply-To: <sent-1@test>',
  'References: <sent-1@test> <root-1@test>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '好的，我们愿意合作，请发报价单。',
  '',
  'On 2026-07-26, Someone wrote:',
  '> 旧的沟通内容'
].join('\r\n');

// INSERT params \u4e0b\u6807\uff1a0 email_record_id, 1 campaign_id, 2 customer_id, 3 from_address,
// 4 message_id, 5 subject, 6 body_text, 7 received_at, 8 mailbox_id, 9 confirm_status, 10 classification,
// 11 classification_source, 12 classification_reason, 13 in_reply_to, 14 references_json,
// 15 clean_body_text, 16 body_html, 17 quoted_body_text, 18 signature_text,
// 19 raw_source, 20 parse_status, 21 parse_error
test('parse-ok message stores MIME columns and is assigned to a thread', async () => {
  const settings = { ...baseSettings };
  const db = mockDb({ settings, matchedEmails: { 'kol@example.com': 7 } });
  try {
    const mail = makeMail(101, { from: 'kol@example.com' });
    mail.source = Buffer.from(RAW_REPLY, 'utf8');
    const client = fakeClient({ messages: [mail] });
    const result = await liveSync.fetchNew(makeWorkerForTest(client, settings));
    assert.equal(result.matched, 1);

    const params = db.inserts[0];
    assert.equal(params[3], 'kol@example.com');
    assert.equal(params[8], baseSettings.id, 'mailbox_id \u843d\u5e93');
    assert.match(params[6], /愿意合作/, 'body_text 用解析出的完整可读纯文本');
    assert.equal(params[13], '<sent-1@test>', 'in_reply_to 对齐库存尖括号格式');
    assert.equal(params[14], '["<sent-1@test>","<root-1@test>"]');
    assert.match(params[15], /愿意合作/, 'clean_body_text 为本次新写内容');
    assert.ok(!params[15].includes('旧的沟通内容'), 'clean_body_text 不含引用');
    assert.match(params[17], /旧的沟通内容/, 'quoted_body_text 保留引用');
    assert.match(params[19], /In-Reply-To/, 'raw_source 存原始 RFC822');
    assert.equal(params[20], 'ok');
    assert.equal(params[21], null);

    assert.equal(db.threadCalls.length, 1, '入库后调用会话归属');
    const call = db.threadCalls[0];
    assert.equal(call.replyId, 901);
    assert.equal(call.messageId, '<m101@test>');
    assert.equal(call.inReplyTo, '<sent-1@test>');
    assert.deepEqual(call.references, ['<sent-1@test>', '<root-1@test>']);
    assert.equal(call.campaignId, 2);
    assert.equal(call.customerId, 7);
  } finally {
    db.restore();
  }
});

test('raw_source larger than 2MB is parsed but not stored', async () => {
  const settings = { ...baseSettings };
  const db = mockDb({ settings, matchedEmails: { 'kol@example.com': 7 } });
  try {
    const bigBody = `长线正文${'x'.repeat(2 * 1024 * 1024)}`;
    const mail = makeMail(101, { from: 'kol@example.com' });
    mail.source = Buffer.from(RAW_REPLY.replace('好的，我们愿意合作，请发报价单。', bigBody), 'utf8');
    const client = fakeClient({ messages: [mail] });
    const result = await liveSync.fetchNew(makeWorkerForTest(client, settings));
    assert.equal(result.matched, 1);
    assert.equal(db.inserts[0][20], 'ok');
    assert.equal(db.inserts[0][19], null, 'raw_source 超过 2MB 置 NULL');
    assert.match(db.inserts[0][6], /^长线正文/, 'body_text 不截断');
  } finally {
    db.restore();
  }
});

test('missing source falls back to the legacy parser with parse_status failed', async () => {
  const settings = { ...baseSettings };
  const db = mockDb({ settings, matchedEmails: { 'kol@example.com': 7 } });
  try {
    const client = fakeClient({ messages: [makeMail(101, { from: 'kol@example.com' })] });
    const result = await liveSync.fetchNew(makeWorkerForTest(client, settings));
    assert.equal(result.matched, 1, '回退路径仍正常入库');
    const params = db.inserts[0];
    assert.equal(params[6], '你好，我对合作感兴趣', 'body_text 由旧解析器兜底');
    assert.equal(params[20], 'failed');
    assert.ok(params[21], 'parse_error 记录原因');
    for (const index of [13, 14, 15, 16, 17, 18, 19]) {
      assert.equal(params[index], null, `新列 params[${index}] 置 NULL`);
    }
    assert.equal(db.threadCalls.length, 1, '回退路径也尝试会话归属');
    assert.equal(db.threadCalls[0].inReplyTo, null);
    assert.deepEqual(db.threadCalls[0].references, []);
  } finally {
    db.restore();
  }
});

test('ambiguous thread assignment logs a warning without breaking ingestion', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  const settings = { ...baseSettings };
  const db = mockDb({
    settings,
    matchedEmails: { 'kol@example.com': 7 },
    threadResult: { threadId: null, ambiguous: true, matchedBy: null }
  });
  try {
    const client = fakeClient({ messages: [makeMail(101, { from: 'kol@example.com' })] });
    const result = await liveSync.fetchNew(makeWorkerForTest(client, settings));
    assert.equal(result.matched, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /歧义/);
  } finally {
    console.warn = originalWarn;
    db.restore();
  }
});

test('threading failure is logged and does not break ingestion', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const settings = { ...baseSettings };
  const db = mockDb({
    settings,
    matchedEmails: { 'kol@example.com': 7 },
    threadResult: new Error('thread db down')
  });
  try {
    const client = fakeClient({ messages: [makeMail(101, { from: 'kol@example.com' })] });
    const result = await liveSync.fetchNew(makeWorkerForTest(client, settings));
    assert.equal(result.matched, 1, '会话归属失败不影响入库');
    assert.equal(db.inserts.length, 1);
    assert.ok(errors.some((line) => line.includes('会话归属失败')), '失败记日志');
  } finally {
    console.error = originalError;
    db.restore();
  }
});
