const test = require('node:test');
const assert = require('node:assert/strict');

const { dbOperations } = require('../database');
const mailer = require('./mailer');
const emailThreader = require('./emailThreader');
const emailDraftSender = require('./emailDraftSender');

const originalRun = dbOperations.run;
const originalGet = dbOperations.get;
const originalSendMail = mailer.sendMail;
const originalAssignRecordThread = emailThreader.assignRecordThread;

test.afterEach(() => {
  dbOperations.run = originalRun;
  dbOperations.get = originalGet;
  mailer.sendMail = originalSendMail;
  emailThreader.assignRecordThread = originalAssignRecordThread;
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
  assert.ok(writes.some(({ sql, params }) =>
    sql.includes('UPDATE approval_items') && params.includes(55)
  ));
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
  // 普通草稿（非 follow_up）不应递增 follow_up_count
  const increment = writes.find(({ sql }) => /UPDATE campaign_kols/.test(sql) && /follow_up_count/.test(sql));
  assert.equal(increment, undefined, 'first_touch manual confirm must not bump follow_up_count');
});

test('confirmManuallySent on a follow_up draft bumps follow_up_count to prevent duplicate auto-drafts', async () => {
  const writes = [];
  dbOperations.get = async (sql) => {
    if (sql.includes('FROM email_drafts')) {
      return { id: 11, status: 'sending', kind: 'follow_up', campaign_id: 2, customer_id: 4, subject: 'Re: Hi', body_text: 'Body' };
    }
    if (sql.includes('FROM customers')) return { id: 4, name: 'Creator', email: 'creator@example.com' };
    return null;
  };
  dbOperations.run = async (sql, params) => {
    writes.push({ sql, params });
    return { changes: 1 };
  };

  const result = await emailDraftSender.confirmManuallySent(11);

  assert.equal(result.manually_confirmed, true);
  const increment = writes.find(({ sql }) => /UPDATE campaign_kols/.test(sql) && /follow_up_count/.test(sql));
  assert.ok(increment, 'follow_up manual confirm must bump follow_up_count');
  assert.deepEqual(increment.params, [2, 4], 'must target the same campaign/customer');
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

// ---- 阶段 3：reply 草稿作为真正的线程回复发送 ----

test('buildReplySendContext prefers clean_body_text, dedupes references, returns null without reply', () => {
  assert.equal(emailDraftSender.buildReplySendContext({ subject: 'x' }, null), null);
  const ctx = emailDraftSender.buildReplySendContext(
    { subject: '', body_text: 'hi' },
    {
      message_id: '<m@x>',
      references_json: '["<m@x>"]',
      subject: 'hello',
      from_address: 'a@b',
      received_at: new Date(2026, 0, 1, 8, 0),
      body_text: 'raw body',
      clean_body_text: '   '
    }
  );
  // clean_body_text 为空白时回退 body_text
  assert.ok(ctx.text.includes('> raw body'));
  assert.equal(ctx.subject, 'Re: hello');
  assert.deepEqual(ctx.references, ['<m@x>']);
  assert.equal(ctx.inReplyTo, '<m@x>');
  assert.equal(ctx.threadingMissing, false);
});

test('sendApprovedDraft sends a reply draft as a threaded reply with quote', async () => {
  const writes = [];
  const assigned = [];
  dbOperations.run = async (sql, params) => {
    writes.push({ sql, params });
    if (sql.includes('INSERT INTO email_records')) return { changes: 1, id: 99 };
    return { changes: 1 };
  };
  dbOperations.get = async (sql) => {
    if (sql.includes('FROM email_drafts')) {
      return {
        id: 20, status: 'sending', kind: 'reply', source_reply_id: 55,
        campaign_id: 2, customer_id: 3, subject: 'Re: Re: 合作', body_text: '好的，我们期待合作'
      };
    }
    if (sql.includes('FROM email_replies')) {
      return {
        id: 55, message_id: '<abc@x>', references_json: JSON.stringify(['<root@x>']),
        subject: '合作', from_address: 'creator@example.com',
        received_at: new Date(2026, 6, 29, 18, 32),
        body_text: '原始正文', clean_body_text: '干净正文\n第二行'
      };
    }
    if (sql.includes('FROM email_settings')) return { username: 'sender@example.com', default_cc: '' };
    if (sql.includes('FROM customers')) return { id: 3, name: 'Creator', email: 'creator@example.com' };
    return null;
  };
  let mailOptions = null;
  mailer.sendMail = async (opts) => {
    mailOptions = opts;
    return { messageId: 'message-20' };
  };
  emailThreader.assignRecordThread = async (id) => {
    assigned.push(id);
    return { threadId: 1 };
  };

  const result = await emailDraftSender.sendApprovedDraft(20);

  assert.equal(mailOptions.inReplyTo, '<abc@x>');
  assert.deepEqual(mailOptions.references, ['<root@x>', '<abc@x>']);
  assert.equal(mailOptions.subject, 'Re: 合作');
  assert.ok(mailOptions.text.startsWith(
    '好的，我们期待合作\n\nOn 2026/7/29 18:32, creator@example.com wrote:\n\n> 干净正文\n> 第二行'
  ));
  assert.ok(mailOptions.html.includes('<blockquote'));
  assert.ok(mailOptions.html.includes('干净正文<br>第二行'));
  assert.equal(result.threading_missing, undefined);

  const recordInsert = writes.find(({ sql }) => sql.includes('INSERT INTO email_records'));
  assert.ok(recordInsert.sql.includes('in_reply_to'));
  assert.equal(recordInsert.params[9], '<abc@x>');
  assert.equal(recordInsert.params[10], JSON.stringify(['<root@x>', '<abc@x>']));
  assert.deepEqual(assigned, [99]);
});

test('sendApprovedDraft degrades gracefully when the source reply has no message_id', async () => {
  const writes = [];
  dbOperations.run = async (sql, params) => {
    writes.push({ sql, params });
    if (sql.includes('INSERT INTO email_records')) return { changes: 1, id: 100 };
    return { changes: 1 };
  };
  dbOperations.get = async (sql) => {
    if (sql.includes('FROM email_drafts')) {
      return {
        id: 21, status: 'sending', kind: 'reply', source_reply_id: 56,
        campaign_id: 2, customer_id: 3, subject: '合作事宜', body_text: '回复正文'
      };
    }
    if (sql.includes('FROM email_replies')) {
      return {
        id: 56, message_id: null, references_json: null,
        subject: '合作事宜', from_address: 'creator@example.com',
        received_at: new Date(2026, 6, 29, 18, 32),
        body_text: '来信正文', clean_body_text: null
      };
    }
    if (sql.includes('FROM email_settings')) return { username: 'sender@example.com', default_cc: '' };
    if (sql.includes('FROM customers')) return { id: 3, name: 'Creator', email: 'creator@example.com' };
    return null;
  };
  let mailOptions = null;
  mailer.sendMail = async (opts) => {
    mailOptions = opts;
    return { messageId: 'message-21' };
  };
  // 会话归属出错不得影响发送结果
  emailThreader.assignRecordThread = async () => {
    throw new Error('thread boom');
  };

  const result = await emailDraftSender.sendApprovedDraft(21);

  assert.equal(mailOptions.inReplyTo, undefined);
  assert.equal(mailOptions.references, undefined);
  assert.equal(mailOptions.subject, 'Re: 合作事宜');
  assert.ok(mailOptions.text.includes('> 来信正文'));
  assert.equal(result.threading_missing, true);

  const recordInsert = writes.find(({ sql }) => sql.includes('INSERT INTO email_records'));
  assert.equal(recordInsert.params[9], null);
  assert.equal(recordInsert.params[10], null);
});
test('sendApprovedDraft sends via the draft bound mailbox and records its mailbox_id', async () => {
  const writes = [];
  dbOperations.run = async (sql, params) => { writes.push({ sql, params }); return { id: 902, changes: 1 }; };
  dbOperations.get = async (sql) => {
    if (sql.includes('FROM email_drafts')) {
      return { id: 7, status: 'sending', campaign_id: 2, customer_id: 3, subject: 'Hello', body_text: 'Body', mailbox_id: 9 };
    }
    if (sql.includes('FROM email_settings WHERE id = ?')) return { id: 9, username: 'b@x.com', default_cc: '', enabled: 1 };
    if (sql.includes('FROM customers')) return { id: 3, name: 'Creator', email: 'creator@example.com' };
    return null;
  };
  let sentOptions = null;
  mailer.sendMail = async (options) => { sentOptions = options; return { messageId: 'message-1' }; };

  const result = await emailDraftSender.sendApprovedDraft(7);

  assert.equal(sentOptions.settings.username, 'b@x.com', '发件用草稿绑定的邮箱');
  const record = writes.find(({ sql }) => sql.includes('INSERT INTO email_records') && sql.includes("'success'"));
  assert.equal(record.params.at(-1), 9, 'email_records 落 mailbox_id');
});

test('sendApprovedDraft falls back to the default mailbox when the bound one is disabled', async () => {
  const writes = [];
  dbOperations.run = async (sql, params) => { writes.push({ sql, params }); return { id: 902, changes: 1 }; };
  dbOperations.get = async (sql) => {
    if (sql.includes('FROM email_drafts')) {
      return { id: 7, status: 'sending', campaign_id: 2, customer_id: 3, subject: 'Hello', body_text: 'Body', mailbox_id: 9 };
    }
    if (sql.includes('FROM email_settings WHERE id = ?')) return { id: 9, username: 'b@x.com', enabled: 0 };
    if (sql.includes('WHERE is_default = 1')) return { id: 1, username: 'a@x.com', default_cc: '', enabled: 1 };
    if (sql.includes('FROM customers')) return { id: 3, name: 'Creator', email: 'creator@example.com' };
    return null;
  };
  let sentOptions = null;
  mailer.sendMail = async (options) => { sentOptions = options; return { messageId: 'message-1' }; };

  const result = await emailDraftSender.sendApprovedDraft(7);

  assert.equal(sentOptions.settings.username, 'a@x.com', '绑定邮箱停用时回退默认邮箱');
  assert.match(result.warning || '', /已改用默认邮箱/, '回退时返回 warning 供审批台提示');
  const record = writes.find(({ sql }) => sql.includes('INSERT INTO email_records') && sql.includes("'success'"));
  assert.equal(record.params.at(-1), 1);
});

test('buildFollowUpSendContext threads under the previous successful outreach without quoting it', () => {
  const ctx = emailDraftSender.buildFollowUpSendContext(
    { subject: 'New follow-up subject', body_text: 'Short follow-up body' },
    {
      subject: 'Creator collaboration',
      smtp_message_id: '<first@x>',
      references_json: JSON.stringify(['<root@x>'])
    }
  );
  assert.equal(ctx.subject, 'Re: Creator collaboration');
  assert.equal(ctx.text, 'Short follow-up body');
  assert.equal(ctx.inReplyTo, '<first@x>');
  assert.deepEqual(ctx.references, ['<root@x>', '<first@x>']);
  assert.equal(ctx.text.includes('wrote:'), false);
  assert.equal(ctx.threadingMissing, false);
});

test('sendApprovedDraft sends follow-up in the most recent successful outreach thread', async () => {
  const writes = [];
  dbOperations.run = async (sql, params) => {
    writes.push({ sql, params });
    if (sql.includes('INSERT INTO email_records')) return { changes: 1, id: 101 };
    return { changes: 1 };
  };
  dbOperations.get = async (sql) => {
    if (sql.includes('FROM email_drafts')) {
      return { id: 30, status: 'sending', kind: 'follow_up', campaign_id: 2, customer_id: 3, subject: 'Follow up', body_text: 'Concise reminder' };
    }
    if (sql.includes('FROM email_records')) {
      return { subject: 'BILT HARD collaboration', smtp_message_id: '<first@x>', references_json: null };
    }
    if (sql.includes('FROM email_settings')) return { username: 'sender@example.com', default_cc: '' };
    if (sql.includes('FROM customers')) return { id: 3, name: 'Creator', email: 'creator@example.com' };
    return null;
  };
  let mailOptions = null;
  mailer.sendMail = async (opts) => { mailOptions = opts; return { messageId: '<follow@x>' }; };
  emailThreader.assignRecordThread = async () => ({ threadId: 1 });

  const result = await emailDraftSender.sendApprovedDraft(30);

  assert.equal(mailOptions.subject, 'Re: BILT HARD collaboration');
  assert.equal(mailOptions.text, 'Concise reminder');
  assert.equal(mailOptions.inReplyTo, '<first@x>');
  assert.deepEqual(mailOptions.references, ['<first@x>']);
  assert.equal(result.threading_missing, undefined);
  const recordInsert = writes.find(({ sql }) => sql.includes('INSERT INTO email_records'));
  assert.equal(recordInsert.params[9], '<first@x>');
  assert.equal(recordInsert.params[10], JSON.stringify(['<first@x>']));
});

test('sendApprovedDraft uses the campaign-bound mailbox when the draft has no mailbox binding', async () => {
  const writes = [];
  dbOperations.run = async (sql, params) => { writes.push({ sql, params }); return { id: 903, changes: 1 }; };
  dbOperations.get = async (sql, params) => {
    if (sql.includes('FROM email_drafts')) {
      return { id: 77, status: 'sending', campaign_id: 3, customer_id: 5, subject: 'Hello', body_text: 'Body', mailbox_id: null };
    }
    if (sql.includes('SELECT mailbox_id FROM campaigns')) return { mailbox_id: 9 };
    if (sql.includes('FROM email_settings WHERE id = ?')) return { id: 9, username: 'bilthard@example.com', default_cc: '', enabled: 1 };
    if (sql.includes('WHERE is_default = 1')) return { id: 1, username: 'default@example.com', default_cc: '', enabled: 1 };
    if (sql.includes('FROM customers')) return { id: 5, name: 'Creator', email: 'creator@example.com' };
    return null;
  };
  let sentOptions = null;
  mailer.sendMail = async (options) => { sentOptions = options; return { messageId: 'message-77' }; };

  const result = await emailDraftSender.sendApprovedDraft(77);

  assert.equal(sentOptions.settings.username, 'bilthard@example.com', '草稿未绑定时按活动邮箱发送');
  assert.equal(result.warning, null, '使用活动邮箱时不弹默认邮箱警告');
  const record = writes.find(({ sql }) => sql.includes('INSERT INTO email_records') && sql.includes("'success'"));
  assert.equal(record.params.at(-1), 9, 'email_records 落活动邮箱 mailbox_id');
});

test('sendApprovedDraft warns when neither the draft nor the campaign has a usable mailbox', async () => {
  const writes = [];
  dbOperations.run = async (sql, params) => { writes.push({ sql, params }); return { id: 904, changes: 1 }; };
  dbOperations.get = async (sql, params) => {
    if (sql.includes('FROM email_drafts')) {
      return { id: 78, status: 'sending', campaign_id: 4, customer_id: 6, subject: 'Hello', body_text: 'Body', mailbox_id: null };
    }
    if (sql.includes('SELECT mailbox_id FROM campaigns')) return { mailbox_id: null };
    if (sql.includes('WHERE is_default = 1')) return { id: 1, username: 'default@example.com', default_cc: '', enabled: 1 };
    if (sql.includes('FROM customers')) return { id: 6, name: 'Creator', email: 'creator@example.com' };
    return null;
  };
  let sentOptions = null;
  mailer.sendMail = async (options) => { sentOptions = options; return { messageId: 'message-78' }; };

  const result = await emailDraftSender.sendApprovedDraft(78);

  assert.equal(sentOptions.settings.username, 'default@example.com');
  assert.match(result.warning || '', /已改用默认邮箱/);
  const record = writes.find(({ sql }) => sql.includes('INSERT INTO email_records') && sql.includes("'success'"));
  assert.equal(record.params.at(-1), 1);
});
