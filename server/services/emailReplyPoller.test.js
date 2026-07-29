const test = require('node:test');
const assert = require('node:assert/strict');
const { dbOperations } = require('../database');
const imapflow = require('imapflow');
const aiClient = require('../services/aiClient');
const poller = require('../services/emailReplyPoller');

function withPatchedDb(patch, fn) {
  const originals = {};
  for (const key of Object.keys(patch)) {
    originals[key] = dbOperations[key];
    dbOperations[key] = patch[key];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of Object.keys(originals)) dbOperations[key] = originals[key];
  });
}

test('normalizeAddress extracts bare address and lowercases', () => {
  assert.equal(poller.normalizeAddress('Bob <Bob@X.com>'), 'bob@x.com');
  assert.equal(poller.normalizeAddress('Alice@X.com '), 'alice@x.com');
  assert.equal(poller.normalizeAddress(''), '');
});

test('summarizeReply stores AI summary and intent', async () => {
  const original = aiClient.callActiveAi;
  aiClient.callActiveAi = async () => ({ parsed: { summary: '想合作，问报价', intent: 'interested' } });
  const statements = [];
  try {
    await withPatchedDb({
      get: async () => ({ id: 3, subject: 'Re: 合作', body_text: '有兴趣，报价多少？' }),
      run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
    }, async () => {
      await poller.summarizeReply(3);
    });
  } finally {
    aiClient.callActiveAi = original;
  }
  const update = statements.find((s) => /UPDATE email_replies/.test(s.sql));
  assert.match(update.sql, /ai_status = 'success'/);
  assert.ok(update.params.includes('想合作，问报价'));
  assert.ok(update.params.includes('interested'));
});

test('summarizeReply marks ai_status failed when AI throws', async () => {
  const original = aiClient.callActiveAi;
  aiClient.callActiveAi = async () => { throw new Error('AI 超时'); };
  const statements = [];
  try {
    await withPatchedDb({
      get: async () => ({ id: 4, subject: 's', body_text: 'b' }),
      run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
    }, async () => {
      await poller.summarizeReply(4);
    });
  } finally {
    aiClient.callActiveAi = original;
  }
  const update = statements.find((s) => /UPDATE email_replies/.test(s.sql));
  assert.match(update.sql, /ai_status = 'failed'/);
});

test('pollOnce dedupes by message-id, inserts matched replies, skips unmatched without marking seen', async () => {
  const seenFlags = [];
  const fakeClient = {
    connect: async () => {},
    logout: async () => {},
    getMailboxLock: async () => ({ release: () => {} }),
    search: async () => [1, 2, 3],
    fetchOne: async (uid) => {
      const messages = {
        1: { envelope: { messageId: 'm-dup', from: [{ address: 'alice@x.com' }], subject: 'Re: hi', date: new Date('2026-07-20') }, bodyParts: new Map([['text', Buffer.from('dup')]]) },
        2: { envelope: { messageId: 'm-new', from: [{ address: 'Bob <bob@x.com>' }], subject: 'Re: 合作', date: new Date('2026-07-21') }, bodyParts: new Map([['text', Buffer.from('我愿意合作')]]) },
        3: { envelope: { messageId: 'm-unknown', from: [{ address: 'nobody@x.com' }], subject: 'hello', date: new Date('2026-07-22') }, bodyParts: new Map([['text', Buffer.from('spam')]]) }
      };
      return messages[uid];
    },
    messageFlagsAdd: async (uid) => { seenFlags.push(uid); }
  };
  const originalImapFlow = imapflow.ImapFlow;
  imapflow.ImapFlow = function FakeImapFlow() { return fakeClient; };

  const statements = [];
  try {
    await withPatchedDb({
      get: async (sql, params) => {
        if (/FROM email_settings/.test(sql)) {
          return { id: 1, imap_host: 'imap.x.com', imap_port: 993, imap_secure: 1, username: 'u@x.com', password: 'p' };
        }
        if (/FROM email_replies/.test(sql)) {
          return params[0] === 'm-dup' ? { id: 10 } : null;
        }
        if (/FROM email_records/.test(sql)) {
          return params[0] === 'bob@x.com' ? { id: 20, campaign_id: 2, customer_id: 7 } : null;
        }
        return null; // customers / campaign_kols 无匹配
      },
      run: async (sql, params) => {
        statements.push({ sql, params });
        return { id: 0, changes: 1 }; // id=0：不触发异步 summarizeReply
      }
    }, async () => {
      await poller.pollOnce();
    });
  } finally {
    imapflow.ImapFlow = originalImapFlow;
  }

  const inserts = statements.filter((s) => /INSERT INTO email_replies/.test(s.sql));
  assert.equal(inserts.length, 1, '只应插入 m-new 一条');
  assert.equal(inserts[0].params[3], 'bob@x.com');
  assert.equal(inserts[0].params[4], 'm-new');
  assert.equal(inserts[0].params[6], '我愿意合作');
  assert.deepEqual(seenFlags.sort(), [1, 2], 'm-dup 与 m-new 标已读，未匹配的不标');
  const outreachUpdate = statements.find((s) => /UPDATE campaign_kols SET needs_reply = 1/.test(s.sql));
  assert.ok(outreachUpdate, 'matched inbound mail should immediately create a reply todo');
  assert.deepEqual(outreachUpdate.params, [2, 7]);
  assert.doesNotMatch(outreachUpdate.sql, /outreach_status\s*=/);
  const pollUpdate = statements.find((s) => /UPDATE email_settings SET last_poll_at/.test(s.sql));
  assert.ok(pollUpdate, '应更新 last_poll_at');
});

test('markWaitingReply ignores missing ownership and protects outcome states', async () => {
  const statements = [];
  await withPatchedDb({
    run: async (sql, params) => { statements.push({ sql, params }); return { changes: 1 }; }
  }, async () => {
    await poller.markWaitingReply(null, 7);
    await poller.markWaitingReply(2, 7);
  });
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].params, [2, 7]);
  assert.match(statements[0].sql, /needs_reply = 1/);
  assert.doesNotMatch(statements[0].sql, /pipeline_stage = 'candidate'/);
});

test('pollOnce does nothing when IMAP not configured', async () => {
  await withPatchedDb({
    get: async () => ({ id: 1, imap_host: null, username: null, password: null })
  }, async () => {
    await poller.pollOnce(); // 不应抛错、不应连接
  });
});
