const test = require('node:test');
const assert = require('node:assert/strict');

const { dbOperations } = require('../database');
const mailer = require('./mailer');
const emailDraftSender = require('./emailDraftSender');

const originalRun = dbOperations.run;
const originalGet = dbOperations.get;
const originalSendMail = mailer.sendMail;

test.afterEach(() => {
  dbOperations.run = originalRun;
  dbOperations.get = originalGet;
  mailer.sendMail = originalSendMail;
});

test('sendApprovedDraft claims, sends, records, and completes an approved draft', async () => {
  const writes = [];
  dbOperations.run = async (sql, params) => {
    writes.push({ sql, params });
    if (sql.includes("status = 'sending'")) return { changes: 1 };
    return { changes: 1 };
  };
  dbOperations.get = async (sql) => {
    if (sql.includes('FROM email_drafts')) {
      return { id: 7, status: 'sending', campaign_id: 2, customer_id: 3, subject: 'Hello', body_text: 'Body' };
    }
    if (sql.includes('FROM email_settings')) return { username: 'sender@example.com', default_cc: '' };
    if (sql.includes('FROM customers')) return { id: 3, name: 'Creator', email: 'creator@example.com' };
    return null;
  };
  let sent = 0;
  mailer.sendMail = async () => {
    sent += 1;
    return { messageId: 'message-7' };
  };

  const result = await emailDraftSender.sendApprovedDraft(7);

  assert.equal(sent, 1);
  assert.equal(result.message_id, 'message-7');
  assert.ok(writes.some(({ sql }) => sql.includes("status = 'sent'")));
  assert.ok(writes.some(({ sql }) => sql.includes('UPDATE campaign_kols')));
  const outreachUpdate = writes.find(({ sql }) => sql.includes('UPDATE campaign_kols'));
  assert.equal(outreachUpdate.params[0], 'contacted');
  assert.match(outreachUpdate.sql, /needs_reply = CASE/);
  assert.equal(outreachUpdate.params[1], '');
});

test('sendApprovedDraft marks a reply as negotiating', async () => {
  const writes = [];
  dbOperations.run = async (sql, params) => {
    writes.push({ sql, params });
    return { changes: 1 };
  };
  dbOperations.get = async (sql) => {
    if (sql.includes('FROM email_drafts')) {
      return { id: 12, status: 'sending', kind: 'reply', source_reply_id: 55, campaign_id: 2, customer_id: 3, subject: 'Re: Hello', body_text: 'Body' };
    }
    if (sql.includes('FROM email_settings')) return { username: 'sender@example.com', default_cc: '' };
    if (sql.includes('FROM customers')) return { id: 3, name: 'Creator', email: 'creator@example.com' };
    return null;
  };
  mailer.sendMail = async () => ({ messageId: 'message-12' });

  await emailDraftSender.sendApprovedDraft(12);

  const outreachUpdate = writes.find(({ sql }) => sql.includes('UPDATE campaign_kols'));
  assert.equal(outreachUpdate.params[0], 'negotiating');
  assert.equal(outreachUpdate.params[1], 'reply');
  assert.equal(outreachUpdate.params[2], 55);
  assert.match(outreachUpdate.sql, /WHEN outreach_status IN \('interested', 'confirmed', 'terminated', 'rejected'\) THEN outreach_status/);
});

test('outreachStatusAfterSend keeps non-reply mail as contacted', () => {
  assert.equal(emailDraftSender.outreachStatusAfterSend('reply'), 'negotiating');
  assert.equal(emailDraftSender.outreachStatusAfterSend('first_touch'), 'contacted');
  assert.equal(emailDraftSender.outreachStatusAfterSend('follow_up'), 'contacted');
});

test('sendApprovedDraft blocks a duplicate send before SMTP', async () => {
  dbOperations.run = async () => ({ changes: 0 });
  dbOperations.get = async () => ({ status: 'sent' });
  let sent = 0;
  mailer.sendMail = async () => {
    sent += 1;
    return { messageId: 'unexpected' };
  };

  await assert.rejects(
    () => emailDraftSender.sendApprovedDraft(7),
    (error) => error.statusCode === 409 && error.message.includes('已经发送')
  );
  assert.equal(sent, 0);
});

test('sendApprovedDraft records SMTP failure and marks the draft failed', async () => {
  const writes = [];
  dbOperations.run = async (sql, params) => {
    writes.push({ sql, params });
    if (sql.includes("status = 'sending'")) return { changes: 1 };
    return { changes: 1 };
  };
  dbOperations.get = async (sql) => {
    if (sql.includes('FROM email_drafts')) {
      return { id: 8, status: 'sending', campaign_id: 2, customer_id: 4, subject: 'Hello', body_text: 'Body' };
    }
    if (sql.includes('FROM email_settings')) return { username: 'sender@example.com', default_cc: '' };
    if (sql.includes('FROM customers')) return { id: 4, name: 'Creator', email: 'creator@example.com' };
    return null;
  };
  mailer.sendMail = async () => {
    throw new Error('SMTP unavailable');
  };

  await assert.rejects(
    () => emailDraftSender.sendApprovedDraft(8),
    (error) => error.statusCode === 500 && error.message.includes('SMTP unavailable')
  );
  assert.ok(writes.some(({ sql }) => sql.includes("'failed'")));
  assert.ok(writes.some(({ sql }) => sql.includes("status = 'send_failed'")));
});

test('sendApprovedDraft marks timeout as unknown and does not make it automatically retryable', async () => {
  const writes = [];
  dbOperations.run = async (sql, params) => {
    writes.push({ sql, params });
    if (sql.includes("status = 'sending'")) return { changes: 1 };
    return { changes: 1 };
  };
  dbOperations.get = async (sql) => {
    if (sql.includes('FROM email_drafts')) return { id: 9, campaign_id: 2, customer_id: 4, subject: 'Hello', body_text: 'Body' };
    if (sql.includes('FROM email_settings')) return { username: 'sender@example.com', default_cc: '' };
    if (sql.includes('FROM customers')) return { id: 4, name: 'Creator', email: 'creator@example.com' };
    return null;
  };
  mailer.sendMail = async () => {
    const error = new Error('Connection timeout');
    error.code = 'ETIMEDOUT';
    throw error;
  };

  await assert.rejects(
    () => emailDraftSender.sendApprovedDraft(9),
    (error) => error.statusCode === 504 && error.message.includes('待确认')
  );
  assert.ok(writes.some(({ sql }) => sql.includes("status = 'send_unknown'")));
});

test('confirmManuallySent records the manual send and updates outreach status', async () => {
  const writes = [];
  dbOperations.get = async (sql) => {
    if (sql.includes('FROM email_drafts')) {
      return { id: 10, status: 'sending', campaign_id: 2, customer_id: 4, subject: 'Hello', body_text: 'Body' };
    }
    if (sql.includes('FROM customers')) return { id: 4, name: 'Creator', email: 'creator@example.com' };
    return null;
  };
  dbOperations.run = async (sql, params) => {
    writes.push({ sql, params });
    return { changes: 1 };
  };

  const result = await emailDraftSender.confirmManuallySent(10);

  assert.equal(result.manually_confirmed, true);
  assert.ok(writes.some(({ sql }) => sql.includes("status = 'sent'")));
  assert.ok(writes.some(({ sql, params }) => sql.includes('INSERT INTO email_records') && params.includes('已由人工确认通过网页邮箱发送')));
  assert.ok(writes.some(({ sql }) => sql.includes('UPDATE campaign_kols')));
});

test('confirmNotSent restores an unresolved draft to pending review', async () => {
  const writes = [];
  dbOperations.get = async () => ({ id: 11, status: 'send_unknown', updated_at: new Date() });
  dbOperations.run = async (sql, params) => {
    writes.push({ sql, params });
    return { changes: 1 };
  };

  const result = await emailDraftSender.confirmNotSent(11);

  assert.equal(result.status, 'pending_review');
  assert.ok(writes.some(({ sql }) => sql.includes("status = 'pending_review'") && sql.includes('reviewed_at = NULL')));
});

// ---- P1 竞态修复：confirmNotSent 安全时限 + markFailed/markUnknown 状态守卫 ----

test('confirmNotSent rejects a fresh sending draft (in-flight SMTP race)', async () => {
  dbOperations.get = async () => ({
    id: 7, status: 'sending', updated_at: new Date()
  });
  dbOperations.run = async () => ({ changes: 1 });

  await assert.rejects(
    () => emailDraftSender.confirmNotSent(7),
    (error) => error.statusCode === 409 && error.message.includes('2 分钟')
  );
});

test('confirmNotSent restores a stale sending draft past the safety timeout', async () => {
  const writes = [];
  dbOperations.get = async () => ({
    id: 7, status: 'sending', updated_at: new Date(Date.now() - 10 * 60 * 1000)
  });
  dbOperations.run = async (sql, params) => {
    writes.push({ sql, params });
    return { changes: 1 };
  };

  const result = await emailDraftSender.confirmNotSent(7);
  assert.equal(result.status, 'pending_review');
  assert.ok(writes.some(({ sql }) => sql.includes("status IN ('sending', 'send_unknown')")));
});

test('confirmNotSent allows send_unknown at any time (human verified outbox)', async () => {
  dbOperations.get = async () => ({ id: 7, status: 'send_unknown', updated_at: new Date() });
  dbOperations.run = async () => ({ changes: 1 });

  const result = await emailDraftSender.confirmNotSent(7);
  assert.equal(result.status, 'pending_review');
});

test('confirmNotSent rejects statuses outside sending/send_unknown', async () => {
  dbOperations.get = async () => ({ id: 7, status: 'approved', updated_at: new Date() });
  dbOperations.run = async () => ({ changes: 1 });

  await assert.rejects(
    () => emailDraftSender.confirmNotSent(7),
    (error) => error.statusCode === 409
  );
});

test('markFailed and markUnknown only write while status is sending', async () => {
  const writes = [];
  dbOperations.run = async (sql, params) => {
    writes.push({ sql, params });
    return { changes: 1 };
  };
  dbOperations.get = async (sql) => {
    if (sql.includes('FROM email_drafts')) {
      return { id: 7, status: 'sending', campaign_id: 2, customer_id: 3, subject: 'Hi', body_text: 'B' };
    }
    if (sql.includes('FROM email_settings')) return { username: 'sender@example.com', default_cc: '' };
    if (sql.includes('FROM customers')) return { id: 3, name: 'C', email: 'c@example.com' };
    return null;
  };
  mailer.sendMail = async () => {
    const error = new Error('Invalid login: 535 authentication failed');
    throw error;
  };

  await assert.rejects(() => emailDraftSender.sendApprovedDraft(7), /发送失败/);
  const failureUpdate = writes.find(({ sql }) => sql.includes("status = 'send_failed'"));
  assert.ok(failureUpdate, 'expected a markFailed write');
  assert.ok(failureUpdate.sql.includes("AND status = 'sending'"), 'markFailed must be guarded by current status');
});
