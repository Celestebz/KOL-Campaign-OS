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
