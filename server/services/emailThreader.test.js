const assert = require('node:assert/strict');
const test = require('node:test');
const emailThreader = require('./emailThreader');

// 内存 db stub：按 SQL 片段签名命中 handler，不连真实数据库
function makeDb(handlers = []) {
  const calls = { get: [], query: [], run: [] };
  let nextInsertId = 100;
  const pick = (sql, params, key) => {
    for (const h of handlers) {
      if (!sql.includes(h.match)) continue;
      const v = typeof h[key] === 'function' ? h[key](params) : h[key];
      if (v !== undefined) return v;
    }
    return key === 'query' ? [] : null;
  };
  return {
    calls,
    get: async (sql, params) => { calls.get.push({ sql, params }); return pick(sql, params, 'get'); },
    query: async (sql, params) => { calls.query.push({ sql, params }); return pick(sql, params, 'query'); },
    run: async (sql, params) => {
      calls.run.push({ sql, params });
      if (/^\s*INSERT/i.test(sql)) return { id: nextInsertId++, changes: 1 };
      return { id: 0, changes: 1 };
    }
  };
}

const REPLY_BY_ID = 'SELECT thread_id FROM email_replies WHERE id = ?';
const REPLY_BY_MSGID = 'FROM email_replies WHERE message_id = ?';
const RECORD_BY_SMTP = 'FROM email_records WHERE smtp_message_id = ?';
const RECORD_THREAD = 'SELECT thread_id FROM email_records WHERE id = ?';
const THREAD_BY_CUSTOMER = 'FROM email_threads WHERE customer_id = ?';

// ---- normalizeSubject ----

test('normalizeSubject 剥离各语言回复/转发前缀', () => {
  assert.equal(emailThreader.normalizeSubject('Re: Hello'), 'Hello');
  assert.equal(emailThreader.normalizeSubject('RE: Fwd: Hello'), 'Hello');
  assert.equal(emailThreader.normalizeSubject('回复：答复：合作事宜'), '合作事宜');
  assert.equal(emailThreader.normalizeSubject('转发： 报价单'), '报价单');
  assert.equal(emailThreader.normalizeSubject('自動返信: お問い合わせ'), 'お問い合わせ');
  assert.equal(emailThreader.normalizeSubject('自动回复：收到'), '收到');
});

test('normalizeSubject 处理编号变体与多余空白', () => {
  assert.equal(emailThreader.normalizeSubject('Re[2]: Pricing'), 'Pricing');
  assert.equal(emailThreader.normalizeSubject('Aw: Angebot'), 'Angebot');
  assert.equal(emailThreader.normalizeSubject('Re:  Re:   Multi   Space '), 'Multi Space');
  assert.equal(emailThreader.normalizeSubject(''), '');
  assert.equal(emailThreader.normalizeSubject(null), '');
  assert.equal(emailThreader.normalizeSubject('  纯主题  '), '纯主题');
});

// ---- extractMessageIds ----

test('extractMessageIds 兼容数组、JSON 字符串与脏数据', () => {
  assert.deepEqual(emailThreader.extractMessageIds(['<a@x>', ' <b@x> ', '']), ['<a@x>', '<b@x>']);
  assert.deepEqual(emailThreader.extractMessageIds('["<a@x>","<b@x>"]'), ['<a@x>', '<b@x>']);
  assert.deepEqual(emailThreader.extractMessageIds('not-json'), []);
  assert.deepEqual(emailThreader.extractMessageIds(null), []);
  assert.deepEqual(emailThreader.extractMessageIds(42), []);
});

// ---- isWithinWindow ----

test('isWithinWindow 60 天窗口判断', () => {
  const now = new Date('2026-07-31T00:00:00Z');
  assert.equal(emailThreader.isWithinWindow('2026-07-01T00:00:00Z', now), true);
  assert.equal(emailThreader.isWithinWindow('2026-05-01T00:00:00Z', now), false);
  assert.equal(emailThreader.isWithinWindow(null, now), false);
  assert.equal(emailThreader.isWithinWindow('bad-date', now), false);
});

// ---- assignReplyThread ----

test('assignReplyThread 幂等：已有 thread_id 直接返回且不落库', async () => {
  const db = makeDb([{ match: REPLY_BY_ID, get: { thread_id: 7 } }]);
  const result = await emailThreader.assignReplyThread({ replyId: 1, customerId: 3, campaignId: 2 }, db);
  assert.deepEqual(result, { threadId: 7, ambiguous: false, matchedBy: null });
  assert.equal(db.calls.run.length, 0);
});

test('assignReplyThread 规则1：in_reply_to 命中来信复用其 thread', async () => {
  const db = makeDb([
    { match: REPLY_BY_ID, get: { thread_id: null } },
    {
      match: REPLY_BY_MSGID,
      get: { id: 9, thread_id: 5, campaign_id: 2, customer_id: 3, subject: 'Re: Hi', received_at: '2026-07-20' }
    }
  ]);
  const result = await emailThreader.assignReplyThread({
    replyId: 1, inReplyTo: '<m1@x>', subject: 'Re: Hi', customerId: 3, campaignId: 2, receivedAt: '2026-07-30'
  }, db);
  assert.equal(result.threadId, 5);
  assert.equal(result.matchedBy, 'in_reply_to');
  const updateReply = db.calls.run.find((c) => c.sql.includes('UPDATE email_replies SET thread_id'));
  assert.deepEqual(updateReply.params, [5, '<m1@x>', 1]);
  const bump = db.calls.run.find((c) => c.sql.includes('message_count = message_count + 1'));
  assert.deepEqual(bump.params[2], 5);
});

test('assignReplyThread 规则2：references 命中无 thread 的发送记录时为其补建再复用', async () => {
  const db = makeDb([
    { match: REPLY_BY_ID, get: { thread_id: null } },
    { match: REPLY_BY_MSGID, get: null },
    {
      match: RECORD_BY_SMTP,
      get: (params) => (params[0] === '<b@x>'
        ? { id: 9, thread_id: null, campaign_id: 2, customer_id: 3, subject: 'Hi', created_at: '2026-07-01' }
        : null)
    }
  ]);
  const result = await emailThreader.assignReplyThread({
    replyId: 1, references: '["<a@x>","<b@x>"]', subject: 'Re: Hi', customerId: 3, campaignId: 2, receivedAt: '2026-07-30'
  }, db);
  assert.equal(result.threadId, 100); // stub 首个 insertId
  assert.equal(result.matchedBy, 'references');
  // 补建 thread、回写发送记录、回写 reply、累加计数
  assert.ok(db.calls.run.some((c) => c.sql.includes('INSERT INTO email_threads')));
  const backfillRecord = db.calls.run.find((c) => c.sql.includes('UPDATE email_records SET thread_id'));
  assert.deepEqual(backfillRecord.params, [100, 9]);
});

test('assignReplyThread 规则4：同邮箱多项目同主题判冲突，不自动合并', async () => {
  const db = makeDb([
    { match: REPLY_BY_ID, get: { thread_id: null } },
    {
      match: THREAD_BY_CUSTOMER,
      query: [
        { id: 11, campaign_id: 2, last_message_at: '2026-07-25T00:00:00Z' },
        { id: 12, campaign_id: 8, last_message_at: '2026-07-26T00:00:00Z' }
      ]
    }
  ]);
  const result = await emailThreader.assignReplyThread({
    replyId: 1, subject: 'Re: 合作', customerId: 3, campaignId: 9, receivedAt: '2026-07-30T00:00:00Z'
  }, db);
  assert.deepEqual(result, { threadId: null, ambiguous: true, matchedBy: null });
  assert.equal(db.calls.run.length, 0);
});

test('assignReplyThread 规则4：同项目同主题窗口内复用，超出 60 天则新建', async () => {
  const recent = makeDb([
    { match: REPLY_BY_ID, get: { thread_id: null } },
    { match: THREAD_BY_CUSTOMER, query: [{ id: 11, campaign_id: 2, last_message_at: '2026-07-25T00:00:00Z' }] }
  ]);
  const reuse = await emailThreader.assignReplyThread({
    replyId: 1, subject: 'Re: 合作', customerId: 3, campaignId: 2, receivedAt: '2026-07-30T00:00:00Z'
  }, recent);
  assert.equal(reuse.threadId, 11);
  assert.equal(reuse.matchedBy, 'subject');

  const stale = makeDb([
    { match: REPLY_BY_ID, get: { thread_id: null } },
    { match: THREAD_BY_CUSTOMER, query: [{ id: 11, campaign_id: 2, last_message_at: '2026-04-01T00:00:00Z' }] }
  ]);
  const created = await emailThreader.assignReplyThread({
    replyId: 1, subject: 'Re: 合作', customerId: 3, campaignId: 2, receivedAt: '2026-07-30T00:00:00Z'
  }, stale);
  assert.equal(created.threadId, 100);
  assert.equal(created.matchedBy, 'new');
});

test('assignReplyThread 规则6：未识别回复不建 thread', async () => {
  const db = makeDb([{ match: REPLY_BY_ID, get: { thread_id: null } }]);
  const result = await emailThreader.assignReplyThread({ replyId: 1, subject: 'Hi', customerId: null, campaignId: null }, db);
  assert.deepEqual(result, { threadId: null, ambiguous: false, matchedBy: null });
  assert.equal(db.calls.run.length, 0);
});

// ---- reassignReply ----

const REASSIGN_REPLY = 'SELECT id, thread_id, subject, received_at FROM email_replies WHERE id = ?';

test('reassignReply 指定 thread：改绑并校正两边计数', async () => {
  const db = makeDb([
    { match: REASSIGN_REPLY, get: { id: 1, thread_id: 5, subject: 'Re: Hi', received_at: '2026-07-30' } },
    { match: 'SELECT id FROM email_threads WHERE id = ?', get: { id: 9 } }
  ]);
  const result = await emailThreader.reassignReply(1, { campaignId: 2, customerId: 3, threadId: 9 }, db);
  assert.equal(result.threadId, 9);
  const updateReply = db.calls.run.find((c) => c.sql.includes('UPDATE email_replies SET campaign_id'));
  assert.deepEqual(updateReply.params, [2, 3, 9, 1]);
  assert.ok(db.calls.run.some((c) => c.sql.includes('message_count - 1'))); // 旧会话减一
  assert.ok(db.calls.run.some((c) => c.sql.includes('message_count = message_count + 1'))); // 新会话加一
});

test('reassignReply 回复不存在抛 404', async () => {
  const db = makeDb([{ match: REASSIGN_REPLY, get: null }]);
  await assert.rejects(
    () => emailThreader.reassignReply(99, { campaignId: 2, customerId: 3 }, db),
    (error) => error.statusCode === 404
  );
});
