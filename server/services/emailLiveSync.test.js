const test = require('node:test');
const assert = require('node:assert/strict');
const imapflow = require('imapflow');
const { dbOperations } = require('../database');
const emailReplyPoller = require('../services/emailReplyPoller');
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

// 按 SQL 分发：设置表 / 回复去重 / 发件人匹配；捕获写入与 UID 游标推进
function mockDb({ settings, existingMessageIds = new Set(), matchedEmails = {}, throwOnInsert = null } = {}) {
  const inserts = [];
  const uidWrites = [];
  const originalGet = dbOperations.get;
  const originalRun = dbOperations.run;

  dbOperations.get = async (sql, params = []) => {
    const text = String(sql);
    if (text.includes('FROM email_settings')) return settings;
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
    return { changes: 1 };
  };
  return {
    inserts,
    uidWrites,
    restore() {
      dbOperations.get = originalGet;
      dbOperations.run = originalRun;
    }
  };
}

const baseSettings = {
  id: 1, imap_host: 'imap.test', imap_port: 993, imap_secure: 1,
  username: 'u@test.com', password: 'secret', sync_mode: 'idle', last_uid: 100
};

test('first connection initializes the UID cursor to the current mailbox high-water mark', async () => {
  const db = mockDb({ settings: { ...baseSettings, last_uid: 0 } });
  try {
    const client = fakeClient({ uidNext: 250, messages: [makeMail(249)] });
    const result = await liveSync.fetchNew(client);
    assert.deepEqual(result, { fetched: 0, matched: 0, unmatched: 0, initialized: true });
    assert.deepEqual(db.uidWrites, [249], 'cursor initialized to uidNext-1 so history is not re-imported');
    assert.equal(db.inserts.length, 0);
  } finally {
    db.restore();
  }
});

test('UID incremental fetch processes only new mail, matches KOLs and parks unknown senders', async () => {
  const db = mockDb({ settings: { ...baseSettings, last_uid: 100 }, matchedEmails: { 'kol@example.com': 7 } });
  try {
    const client = fakeClient({
      messages: [makeMail(101, { from: 'kol@example.com' }), makeMail(102, { from: 'ad@spam.cn' })]
    });
    const result = await liveSync.fetchNew(client);
    assert.deepEqual(result, { fetched: 2, matched: 1, unmatched: 1 });

    const [matchedInsert, unmatchedInsert] = db.inserts;
    assert.equal(matchedInsert[1], 2, 'matched reply keeps campaign attribution');
    assert.equal(matchedInsert[2], 7, 'matched reply keeps customer attribution');
    assert.equal(unmatchedInsert[1], null, 'unmatched reply has no campaign');
    assert.equal(unmatchedInsert[2], null, 'unmatched reply has no customer (未识别回复)');

    assert.deepEqual(db.uidWrites, [101, 102], 'cursor advances per message');
    assert.equal(client.calls.flagsAdd, 0, 'mailbox read state is never modified');
  } finally {
    db.restore();
  }
});

test('message_id dedupe skips already imported mail', async () => {
  const db = mockDb({
    settings: baseSettings,
    existingMessageIds: new Set(['<m101@test>'])
  });
  try {
    const client = fakeClient({ messages: [makeMail(101)] });
    const result = await liveSync.fetchNew(client);
    assert.equal(result.fetched, 1);
    assert.equal(result.matched, 0);
    assert.equal(db.inserts.length, 0);
  } finally {
    db.restore();
  }
});

test('a unique-constraint race is treated as a duplicate instead of an error', async () => {
  const db = mockDb({
    settings: baseSettings,
    throwOnInsert: new Error("Duplicate entry '<m101@test>' for key 'uniq_email_replies_message_id'")
  });
  try {
    const client = fakeClient({ messages: [makeMail(101)] });
    const result = await liveSync.fetchNew(client);
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
  const db = mockDb({ settings: baseSettings, matchedEmails: { 'kol@example.com': 7 } });
  try {
    const client = fakeClient({
      messages: [makeMail(101, { from: 'kol@example.com' }), makeMail(102, { from: 'ad@spam.cn' })]
    });
    await liveSync.fetchNew(client);
    assert.equal(summarized.length, 1, 'only the matched reply is summarized');
  } finally {
    emailReplyPoller.summarizeReply = original;
    db.restore();
  }
});

test('sync status exposes mode, connection state and timestamps', () => {
  const status = liveSync.getEmailSyncStatus();
  for (const key of ['mode', 'status', 'last_mail_at', 'last_full_sync_at', 'last_error', 'reconnect_attempts', 'connected_since']) {
    assert.ok(key in status, `status missing ${key}`);
  }
});
