const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('./emailBounceService');

test('detects Aliyun support notices as bounce system mail', () => {
  assert.deepEqual(service.detectSystemMail({
    fromAddress: 'no-reply@mailsupport.aliyun.com',
    subject: '退信通知',
    bodyText: '邮件无法投递'
  }), { isSystem: true, systemMailType: 'bounce' });
});

test('parses standard hard bounce recipient, status, reason and message id', () => {
  const parsed = service.parseBounce({
    fromAddress: 'MAILER-DAEMON@example.com',
    subject: 'Delivery Status Notification (Failure)',
    bodyText: [
      'Final-Recipient: rfc822; missing@example.net',
      'Status: 5.1.1',
      'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
      'Original-Message-ID: <outbound-7@example.com>'
    ].join('\n')
  });
  assert.equal(parsed.recipient, 'missing@example.net');
  assert.equal(parsed.statusCode, '5.1.1');
  assert.equal(parsed.bounceType, 'hard');
  assert.equal(parsed.originalMessageId, '<outbound-7@example.com>');
  assert.match(parsed.reason, /User unknown/);
});

test('parses mailbox-full notices as soft bounces', () => {
  const parsed = service.parseBounce({
    fromAddress: 'postmaster@example.com',
    subject: 'Undeliverable',
    bodyText: 'Original-Recipient: creator@example.net\nStatus: 4.2.2\nDiagnostic-Code: smtp; mailbox full'
  });
  assert.equal(parsed.recipient, 'creator@example.net');
  assert.equal(parsed.bounceType, 'soft');
});

test('findEmailRecord prefers original message id and falls back to recipient', async () => {
  const calls = [];
  const dbById = {
    async get(sql, params) {
      calls.push({ sql, params });
      return { id: 12, smtp_message_id: '<outbound-7@example.com>' };
    }
  };
  assert.equal((await service.findEmailRecord({
    originalMessageId: '<outbound-7@example.com>', recipient: 'creator@example.net'
  }, new Date(), dbById)).id, 12);
  assert.match(calls[0].sql, /smtp_message_id/);

  const fallbackCalls = [];
  const dbFallback = {
    async get(sql, params) {
      fallbackCalls.push({ sql, params });
      return { id: 13, to_address: 'creator@example.net' };
    }
  };
  assert.equal((await service.findEmailRecord({
    originalMessageId: '', recipient: 'creator@example.net'
  }, new Date('2026-07-30T00:00:00Z'), dbFallback)).id, 13);
  assert.match(fallbackCalls[0].sql, /LOWER\(to_address\)/);
});

test('processSystemMail links a bounce and upserts one bounce event', async () => {
  const writes = [];
  const reply = {
    id: 5,
    from_address: 'no-reply@mailsupport.aliyun.com',
    subject: '退信通知',
    body_text: 'Final-Recipient: rfc822; bad@example.net\nStatus: 5.1.1\n失败原因: user unknown',
    received_at: new Date('2026-07-30T00:00:00Z')
  };
  const db = {
    async get(sql) {
      if (sql.includes('FROM email_replies')) return reply;
      if (sql.includes('FROM email_records')) return { id: 22, campaign_id: 3, customer_id: 9 };
      return null;
    },
    async run(sql, params) { writes.push({ sql, params }); return { changes: 1 }; }
  };
  const result = await service.processSystemMail(5, db);
  assert.equal(result.bounceType, 'hard');
  assert.equal(result.emailRecordId, 22);
  assert.ok(writes.some(({ sql }) => sql.includes("system_mail_type = 'bounce'")));
  assert.ok(writes.some(({ sql }) => sql.includes('INSERT INTO email_bounces') && sql.includes('ON DUPLICATE KEY UPDATE')));
});
