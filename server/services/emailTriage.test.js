const test = require('node:test');
const assert = require('node:assert/strict');
const { dbOperations: db } = require('../database');
const ai = require('./aiClient');
const triage = require('./emailTriage');
const { currentUserId } = require('../utils/requestContext');

function fixture(t, overrides = {}) {
  const originals = { get: db.get, run: db.run, query: db.query, call: ai.callActiveAi };
  const row = { id: 1, owner_user_id: 7, mailbox_id: 2, todo_status: 'pending',
    triage_status: 'pending', triage_attempts: 0, subject: 'Payment reminder', body_text: 'Please pay the overdue invoice',
    from_address: 'creator@example.com', received_at: '2026-11-02 08:00:00', ...overrides };
  const calls = [];
  db.get = async sql => sql.includes('FROM email_replies') ? { ...row } : null;
  db.query = async () => [];
  db.run = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("triage_status = 'running'")) {
      if (row.todo_status !== 'pending' || row.triage_status === 'success' || row.triage_status === 'running') return { changes: 0 };
      row.triage_status = 'running'; row.triage_lease = params[0]; row.triage_attempts++;
      return { changes: 1 };
    }
    if (sql.includes("triage_status = 'success'")) {
      if (row.todo_status !== 'pending' || row.triage_lease !== params[params.length - 1]) return { changes: 0 };
      row.triage_status = 'success'; row.triage_lease = null;
    }
    if (sql.includes("triage_status = 'failed'")) row.triage_status = 'failed';
    return { changes: 1 };
  };
  ai.callActiveAi = async () => ({ parsed: { summary: '红人催付逾期款项', intent: 'question',
    category: 'payment', priority: 'urgent', reason: '对方明确表示逾期未付', action: '核对发票及付款记录' } });
  t.after(() => { Object.assign(db, { get: originals.get, run: originals.run, query: originals.query }); ai.callActiveAi = originals.call; });
  return { row, calls };
}

test('delivery identity is stable and isolated by user, mailbox and UID validity', () => {
  const mail = { uid: 1, envelope: { messageId: '<same@example>' } };
  assert.equal(triage.deliveryKey(mail, 2, 7), triage.deliveryKey(mail, 2, 7));
  assert.notEqual(triage.deliveryKey(mail, 2, 7), triage.deliveryKey(mail, 3, 7));
  assert.notEqual(triage.deliveryKey(mail, 2, 7), triage.deliveryKey(mail, 2, 8));
  assert.notEqual(triage.deliveryKey({ uid: 1 }, 2, 7, 'a'), triage.deliveryKey({ uid: 1 }, 2, 7, 'b'));
});

test('concurrent workers and repeated refreshes call AI only once after success', async t => {
  const { row } = fixture(t);
  let release;
  let calls = 0;
  ai.callActiveAi = async () => {
    calls++; assert.equal(currentUserId(), 7);
    await new Promise(resolve => { release = resolve; });
    return { parsed: { summary: '催款', category: 'payment', priority: 'urgent', reason: '逾期', action: '核对付款' } };
  };
  const first = triage.analyze(1);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await triage.analyze(1), { skipped: true });
  release(); await first;
  assert.equal(row.triage_status, 'success');
  assert.deepEqual(await triage.analyze(1), { skipped: true });
  assert.equal(calls, 1);
});

test('failure stays visible and persists a delayed retry without completing the todo', async t => {
  const { row, calls } = fixture(t);
  ai.callActiveAi = async () => { throw new Error('upstream unavailable'); };
  assert.deepEqual(await triage.analyze(1), { success: false });
  assert.equal(row.todo_status, 'pending');
  assert.equal(row.triage_status, 'failed');
  assert.ok(calls.some(c => c.sql.includes('triage_retry_at = DATE_ADD') && c.params[0] === 'upstream unavailable'));
});

test('malformed AI response does not get stored as a successful classification', async t => {
  const { row } = fixture(t);
  ai.callActiveAi = async () => ({ parsed: { summary: 'bad', category: 'invented', priority: 'urgent' } });
  await triage.analyze(1);
  assert.equal(row.triage_status, 'failed');
});

test('manual completion during analysis prevents late results from changing a completed todo', async t => {
  const { row } = fixture(t);
  ai.callActiveAi = async () => {
    row.todo_status = 'done';
    return { parsed: { summary: '催款', category: 'payment', priority: 'urgent' } };
  };
  await triage.analyze(1);
  assert.equal(row.todo_status, 'done');
  assert.notEqual(row.triage_status, 'success');
});

test('AI sees scoped history and prior outreach as evidence, not as instructions', async t => {
  fixture(t, { thread_id: 9 });
  let historyQuery;
  db.query = async (sql, params) => { historyQuery = { sql, params }; return [{ direction: 'outbound', body: 'Invitation' }]; };
  ai.callActiveAi = async (system, prompt) => {
    assert.match(system, /untrusted evidence/);
    assert.match(prompt, /Invitation/);
    assert.match(prompt, /不要虚构付款状态/);
    return { parsed: { summary: '待核对', category: 'needs_review', priority: 'normal' } };
  };
  await triage.analyze(1);
  assert.equal(historyQuery.params[1], 7);
  assert.equal(historyQuery.params[5], 7);
  assert.match(historyQuery.sql, /owner_user_id = \?/);
});

test('unlinked senders get bounded same-mailbox history and payment output is checked before saving', async t => {
  const { calls } = fixture(t, { subject: 'Re:', body_text: 'Has the product shipped yet? Could you share tracking information?',
    quoted_body_text: 'We agreed on a gifted collaboration. Please share your shipping address.' });
  let query;
  db.query = async (sql, params) => { query = { sql, params }; return [{ direction: 'inbound', body: 'I agree to the gifted collaboration.' }]; };
  ai.callActiveAi = async (system, prompt) => {
    assert.match(prompt, /same_sender_and_mailbox_reference_only/);
    assert.match(prompt, /gifted collaboration/);
    assert.match(prompt, /绝不能因为属于履约就归 payment/);
    return { parsed: { summary: '查询发货和物流', category: 'payment', priority: 'urgent', reason: '物流属于付款问题' } };
  };
  await triage.analyze(1);
  assert.match(query.sql, /mailbox_id <=> \?/);
  assert.match(query.sql, /INTERVAL 60 DAY/);
  assert.deepEqual(query.params.slice(0, 3), [7, 2, 'creator@example.com']);
  assert.deepEqual(query.params.slice(6, 9), [7, 2, 'creator@example.com']);
  const saved = calls.find(c => c.sql.includes('SET ai_summary'));
  assert.equal(saved.params[2], 'execution_issue');
  assert.equal(saved.params[3], 'important');
});
