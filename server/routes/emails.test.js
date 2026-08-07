const assert = require('node:assert/strict');
const test = require('node:test');
const { dbOperations } = require('../database');

function findHandler(router, method, path) {
  const layer = router.stack.find((item) => (
    item.route?.path === path && item.route?.methods?.[method]
  ));
  assert.ok(layer, `Missing ${method.toUpperCase()} ${path} handler`);
  return layer.route.stack[0].handle;
}

function callHandler(handler, { body = {}, params = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; resolve(this); return this; }
    };
    Promise.resolve(handler({ body, params, query }, response, reject)).catch(reject);
  });
}

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
const M = '\u2022'.repeat(8);
const z1 = '\u4e0d\u80fd\u5220\u9664\u9ed8\u8ba4\u90ae\u7bb1';
const z2 = '\u8bf7\u5148\u505c\u7528';


test('GET /settings returns mailbox list with masked passwords', async () => {
  await withPatchedDb({
    query: async () => [
      { id: 1, smtp_host: 'smtp.qiye.aliyun.com', username: 'u@x.com', password: 'secret', is_default: 1, enabled: 1 },
      { id: 2, smtp_host: 'smtp.qiye.aliyun.com', username: 'v@x.com', password: 'secret2', is_default: 0, enabled: 1 }
    ]
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/settings');
    const response = await callHandler(handler);
    assert.equal(response.payload.success, true);
    assert.equal(response.payload.data.length, 2);
    assert.equal(response.payload.data[0].password, M);
    assert.equal(response.payload.data[1].password, M);
  });
});

test('POST /settings creates a mailbox and makes the first one default', async () => {
  const statements = [];
  await withPatchedDb({
    query: async () => [],
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 7, changes: 1 }; },
    get: async (sql) => {
      if (/FROM email_settings WHERE id/.test(sql)) return { id: 7, username: 'new@x.com', is_default: 1, enabled: 1 };
      return null;
    }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/settings');
    const response = await callHandler(handler, { body: { smtp_host: 'smtp.qiye.aliyun.com', username: 'new@x.com', label: 'B' } });
    assert.equal(response.payload.success, true);
    const insert = statements.find((s) => /INSERT INTO email_settings/.test(s.sql));
    assert.ok(insert, 'should insert a new mailbox row');
    assert.ok(insert.params.includes('new@x.com'));
    assert.equal(insert.params[insert.params.length - 2], 1, 'first mailbox should be default');
  });
});

test('PUT /settings/:id updates the specified mailbox and restarts listener', async () => {
  const emailLiveSync = require('../services/emailLiveSync');
  const original = emailLiveSync.restartEmailSync;
  let restartedWith = null;
  emailLiveSync.restartEmailSync = async (id) => { restartedWith = id; };
  const statements = [];
  try {
    await withPatchedDb({
      get: async () => ({ id: 2, password: 'real-secret', sync_mode: 'poll', label: 'A' }),
      run: async (sql, params) => { statements.push({ sql, params }); return { changes: 1 }; }
    }, async () => {
      const handler = findHandler(require('./emails'), 'put', '/settings/:id');
      const response = await callHandler(handler, { params: { id: 2 }, body: { username: 'v@x.com', sync_mode: 'idle' } });
      assert.equal(response.payload.success, true);
      const update = statements.find((s) => /UPDATE email_settings/.test(s.sql));
      assert.ok(update, 'should update existing row');
      assert.ok(update.params.includes('v@x.com'));
      assert.ok(update.params.includes('idle'), 'sync_mode written to settings');
    });
  } finally {
    emailLiveSync.restartEmailSync = original;
  }
  assert.equal(restartedWith, 2, 'restarts listener for the updated mailbox id');
});

test('PUT /settings without id keeps stored password via default mailbox compat path', async () => {
  const statements = [];
  await withPatchedDb({
    get: async (sql) => {
      if (/WHERE is_default = 1/.test(sql)) return { id: 1, password: 'real-secret', sync_mode: 'poll' };
      if (/FROM email_settings WHERE id/.test(sql)) return { id: 1, password: 'real-secret', sync_mode: 'poll' };
      return null;
    },
    run: async (sql, params) => { statements.push({ sql, params }); return { changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'put', '/settings');
    await callHandler(handler, { body: { smtp_host: 'smtp.qiye.aliyun.com', username: 'u@x.com', password: M } });
    const update = statements.find((s) => /UPDATE email_settings/.test(s.sql));
    assert.ok(update, 'should update existing row');
    assert.ok(update.params.includes('real-secret'));
  });
});

test('DELETE /settings/:id rejects deleting the default mailbox', async () => {
  await withPatchedDb({
    get: async () => ({ id: 1, is_default: 1 })
  }, async () => {
    const handler = findHandler(require('./emails'), 'delete', '/settings/:id');
    const response = await callHandler(handler, { params: { id: 1 } });
    assert.equal(response.statusCode, 409);
    assert.match(response.payload.error, new RegExp(z1));
  });
});

test('DELETE /settings/:id rejects deleting a mailbox with records', async () => {
  await withPatchedDb({
    get: async (sql) => {
      if (/FROM email_settings WHERE id/.test(sql)) return { id: 2, is_default: 0 };
      return { id: 9 };
    }
  }, async () => {
    const handler = findHandler(require('./emails'), 'delete', '/settings/:id');
    const response = await callHandler(handler, { params: { id: 2 } });
    assert.equal(response.statusCode, 409);
    assert.match(response.payload.error, new RegExp(z2));
  });
});

test('DELETE /settings/:id deletes a mailbox without records', async () => {
  const statements = [];
  await withPatchedDb({
    get: async (sql) => {
      if (/FROM email_settings WHERE id/.test(sql)) return { id: 3, is_default: 0 };
      return null;
    },
    run: async (sql, params) => { statements.push({ sql, params }); return { changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'delete', '/settings/:id');
    const response = await callHandler(handler, { params: { id: 3 } });
    assert.equal(response.payload.success, true);
    const del = statements.find((s) => /DELETE FROM email_settings/.test(s.sql));
    assert.ok(del, 'should delete the mailbox row');
  });
});

test('POST /settings/:id/default clears other defaults and sets the target', async () => {
  const statements = [];
  await withPatchedDb({
    get: async () => ({ id: 2, is_default: 0 }),
    run: async (sql, params) => { statements.push({ sql, params }); return { changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/settings/:id/default');
    const response = await callHandler(handler, { params: { id: 2 } });
    assert.equal(response.payload.success, true);
    const clears = statements.filter((s) => /UPDATE email_settings SET is_default = 0/.test(s.sql));
    assert.equal(clears.length, 1, 'clears all defaults first');
    const sets = statements.find((s) => /is_default = 1 WHERE id/.test(s.sql));
    assert.ok(sets, 'sets the target as default');
  });
});

test('POST /templates validates kind and required fields', async () => {
  await withPatchedDb({ run: async () => ({ id: 1, changes: 1 }) }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/templates');
    const bad = await callHandler(handler, { body: { name: 'x', kind: 'fixed' } });
    assert.equal(bad.statusCode, 400);
    const ok = await callHandler(handler, { body: { name: 'x', kind: 'style_guide', body_html: '规范内容' } });
    assert.equal(ok.payload.success, true);
  });
});

test('GET /records joins draft kol name and filters status', async () => {
  let seenSql = '';
  await withPatchedDb({
    get: async () => ({ total: 1 }),
    query: async (sql, params) => {
      seenSql = sql;
      assert.deepEqual(params, ['failed']);
      return [{ id: 1, kol_name: 'Alice', status: 'failed' }];
    }
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/records');
    const response = await callHandler(handler, { query: { status: 'failed' } });
    assert.equal(response.payload.data.total, 1);
    assert.match(seenSql, /LEFT JOIN email_drafts/);
  });
});

test('POST /drafts/:id/send returns 409 when draft not approved', async () => {
  await withPatchedDb({
    get: async (sql) => {
      if (/email_drafts/.test(sql)) return { id: 9, status: 'pending_review', customer_id: 1, campaign_id: 1 };
      return null;
    },
    // claim 更新（approved → sending）不命中：返回 changes 0，且避免落真实数据库
    run: async () => ({ id: 0, changes: 0 })
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/drafts/:id/send');
    const response = await callHandler(handler, { params: { id: 9 } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error, '仅已批准或发送失败的草稿可发送');
  });
});

test('POST /drafts/:id/send sends approved draft and writes back campaign_kols', async () => {
  const mailer = require('../services/mailer');
  const originalSendMail = mailer.sendMail;
  mailer.sendMail = async () => ({ messageId: 'm-1@smtp' });
  const statements = [];
  try {
    await withPatchedDb({
      get: async (sql) => {
        if (/FROM email_drafts/.test(sql)) {
          return { id: 10, status: 'approved', customer_id: 1, campaign_id: 2, subject: 'Hi', body_text: 'body' };
        }
        if (/FROM customers/.test(sql)) return { id: 1, name: 'Alice', email: 'alice@x.com' };
        if (/email_settings/.test(sql)) return { id: 1, username: 'u@x.com', default_cc: '' };
        return null;
      },
      run: async (sql, params) => { statements.push({ sql, params }); return { id: 5, changes: 1 }; }
    }, async () => {
      const handler = findHandler(require('./emails'), 'post', '/drafts/:id/send');
      const response = await callHandler(handler, { params: { id: 10 } });
      assert.equal(response.payload.success, true);
    });
  } finally {
    mailer.sendMail = originalSendMail;
  }
  const insertRecord = statements.find((s) => /INSERT INTO email_records/.test(s.sql));
  assert.ok(insertRecord, 'should insert email_records');
  assert.ok(insertRecord.params.includes('alice@x.com'));
  const updateKol = statements.find((s) => /UPDATE campaign_kols/.test(s.sql));
  assert.ok(updateKol, 'should update campaign_kols');
  assert.ok(updateKol.params.includes('contacted'));
  assert.match(updateKol.sql, /sync_status = 'sync_pending'/);
  // 第一条 UPDATE 是 approved → sending 的乐观锁 claim，断言最终 sent 的那条
  const updateDraft = statements.find((s) => /UPDATE email_drafts/.test(s.sql) && /status = 'sent'/.test(s.sql));
  assert.ok(updateDraft, 'should mark draft as sent after SMTP accept');
});

test('PUT /drafts/:id only allows editing pending_review and stores human version', async () => {
  const statements = [];
  await withPatchedDb({
    get: async () => ({ id: 11, status: 'approved' }),
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'put', '/drafts/:id');
    const conflict = await callHandler(handler, { params: { id: 11 }, body: { subject: 's', body_text: 'b' } });
    assert.equal(conflict.statusCode, 409);
  });
});

test('PUT /drafts/:id edits pending_review draft and stores human version', async () => {
  const statements = [];
  await withPatchedDb({
    get: async () => ({ id: 12, status: 'pending_review' }),
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'put', '/drafts/:id');
    const response = await callHandler(handler, { params: { id: 12 }, body: { subject: 's', body_text: 'b' } });
    assert.equal(response.payload.success, true);
  });
  const version = statements.find((s) => /INSERT INTO email_draft_versions/.test(s.sql));
  assert.ok(version, 'should store human version');
  assert.match(version.sql, /'human'/);
  const update = statements.find((s) => /UPDATE email_drafts/.test(s.sql));
  assert.ok(update.params.includes('s') && update.params.includes('b'));
});

test('GET /drafts returns counts', async () => {
  await withPatchedDb({
    query: async () => [
      { id: 1, status: 'pending_review', risk_level: 'high', kind: 'first_touch' },
      { id: 2, status: 'pending_review', risk_level: 'low', kind: 'first_touch' },
      { id: 3, status: 'approved', risk_level: 'none', kind: 'first_touch' }
    ]
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/drafts');
    const response = await callHandler(handler, { query: {} });
    assert.deepEqual(response.payload.data.counts, { pending_review: 2, high_risk: 1, approved: 1 });
  });
});

test('GET /replies filters by confirm_status', async () => {
  let seenSql = '';
  await withPatchedDb({
    query: async (sql, params) => {
      seenSql = sql;
      assert.deepEqual(params, ['pending']);
      return [{ id: 1, confirm_status: 'pending', kol_name: 'Alice' }];
    }
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/replies');
    const response = await callHandler(handler, { query: { confirm_status: 'pending' } });
    assert.equal(response.payload.success, true);
    assert.equal(response.payload.data.length, 1);
  });
  assert.match(seenSql, /er\.confirm_status = \?/);
  assert.match(seenSql, /FROM email_replies er/);
});

test('POST /replies/:id/confirm maps intent and writes back campaign_kols', async () => {
  const statements = [];
  await withPatchedDb({
    get: async (sql) => {
      if (/FROM email_replies/.test(sql)) {
        return { id: 5, customer_id: 1, campaign_id: 2, ai_intent: 'question', ai_summary: '询问寄送', confirm_status: 'pending' };
      }
      if (/FROM campaign_kol_events/.test(sql)) return { outreach_status: 'negotiating', summary: '询问寄送' };
      if (/FROM campaign_kols/.test(sql)) return { id: 77, campaign_id: 2, customer_id: 1, outreach_status: 'contacted' };
      return null;
    },
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/replies/:id/confirm');
    const response = await callHandler(handler, { params: { id: 5 }, body: {} });
    assert.equal(response.payload.success, true);
  });
  const updateKol = statements.find((s) => /UPDATE campaign_kols/.test(s.sql));
  assert.ok(updateKol.params.includes('negotiating'), 'question intent maps to negotiating while the email todo stays separate');
  assert.ok(updateKol.params.includes('询问寄送'));
  assert.match(updateKol.sql, /sync_status = 'sync_pending'/);
  assert.doesNotMatch(updateKol.sql, /internal_notes|project_notes/);
  assert.ok(statements.some((s) => /INSERT INTO campaign_kol_events/.test(s.sql)));
  const updateReply = statements.find((s) => /UPDATE email_replies/.test(s.sql));
  assert.match(updateReply.sql, /confirm_status = 'confirmed'/);
  assert.equal(
    statements.some((s) => /UPDATE approval_items/.test(s.sql)),
    false,
    'confirming intent must keep the reply todo open until we respond'
  );
});

test('POST /replies/:id/confirm maps other to negotiating without changing the email todo', async () => {
  const statements = [];
  await withPatchedDb({
    get: async (sql) => {
      if (/FROM email_replies/.test(sql)) {
        return { id: 15, campaign_id: 2, customer_id: 7, ai_intent: 'other', ai_summary: 'needs review' };
      }
      if (/FROM campaign_kol_events/.test(sql)) return { outreach_status: 'negotiating', summary: 'needs review' };
      if (/FROM campaign_kols/.test(sql)) return { id: 78, campaign_id: 2, customer_id: 7, outreach_status: 'contacted' };
      return null;
    },
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/replies/:id/confirm');
    const response = await callHandler(handler, { params: { id: 15 }, body: {} });
    assert.equal(response.payload.data.outreach_status, 'negotiating');
  });
  const updateKol = statements.find((s) => /UPDATE campaign_kols/.test(s.sql));
  assert.ok(updateKol.params.includes('negotiating'));
  assert.doesNotMatch(updateKol.sql, /needs_reply/);
});

test('POST /replies/:id/confirm uses body summary override and maps interested to interested', async () => {
  const statements = [];
  await withPatchedDb({
    get: async (sql) => {
      if (/FROM email_replies/.test(sql)) {
        return { id: 6, customer_id: 1, campaign_id: 2, ai_intent: 'interested', ai_summary: 'AI摘要', confirm_status: 'pending' };
      }
      if (/FROM campaign_kol_events/.test(sql)) return { outreach_status: 'interested', summary: '人工修正摘要' };
      if (/FROM campaign_kols/.test(sql)) return { id: 78, campaign_id: 2, customer_id: 1, outreach_status: 'contacted' };
      return null;
    },
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/replies/:id/confirm');
    const response = await callHandler(handler, { params: { id: 6 }, body: { summary: '人工修正摘要' } });
    assert.equal(response.payload.data.outreach_status, 'interested');
  });
  const updateKol = statements.find((s) => /UPDATE campaign_kols/.test(s.sql));
  assert.ok(updateKol.params.includes('interested'));
  assert.ok(updateKol.params.includes('人工修正摘要'));
});

test('POST /replies/:id/confirm lets human intent override the AI classification', async () => {
  const statements = [];
  await withPatchedDb({
    get: async (sql) => {
      if (/FROM email_replies/.test(sql)) {
        return { id: 16, customer_id: 1, campaign_id: 2, ai_intent: 'interested', ai_summary: 'AI says yes', received_at: '2026-07-30 09:00:00' };
      }
      if (/FROM campaign_kol_events/.test(sql)) return { outreach_status: 'terminated', summary: '人工判断拒绝' };
      if (/FROM campaign_kols/.test(sql)) return { id: 79, campaign_id: 2, customer_id: 1, outreach_status: 'contacted' };
      return null;
    },
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 1, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/replies/:id/confirm');
    const response = await callHandler(handler, {
      params: { id: 16 }, body: { summary: '人工判断拒绝', intent: 'rejected' }
    });
    assert.equal(response.payload.data.confirmed_intent, 'rejected');
    assert.equal(response.payload.data.outreach_status, 'terminated');
  });
  const eventInsert = statements.find((s) => /INSERT INTO campaign_kol_events/.test(s.sql));
  assert.ok(eventInsert.params.includes('interested'), 'keeps the original AI intent');
  assert.ok(eventInsert.params.includes('rejected'), 'stores the human-confirmed intent');
  const replyUpdate = statements.find((s) => /UPDATE email_replies/.test(s.sql));
  assert.ok(replyUpdate.params.includes('rejected'));
});

test('POST /replies/:id/ignore sets confirm_status ignored', async () => {
  const statements = [];
  await withPatchedDb({
    get: async () => ({ id: 7, campaign_id: 2, customer_id: 3, received_at: '2026-07-29 10:00:00', confirm_status: 'pending' }),
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/replies/:id/ignore');
    const response = await callHandler(handler, { params: { id: 7 } });
    assert.equal(response.payload.success, true);
  });
  assert.match(statements[0].sql, /confirm_status = 'ignored'/);
  assert.match(statements[1].sql, /needs_reply = 0/);
  assert.deepEqual(statements[1].params, [2, 3, 2, 3, '2026-07-29 10:00:00', '2026-07-29 10:00:00', 7]);
  assert.ok(statements.some((s) =>
    /UPDATE approval_items/.test(s.sql) && s.params.includes(7)
  ));
});

test('POST /replies/:id/manually-replied closes the todo without sending an email', async () => {
  const statements = [];
  await withPatchedDb({
    get: async (sql) => {
      if (/FROM email_replies/.test(sql)) {
        return {
          id: 17, campaign_id: 2, customer_id: 3,
          received_at: '2026-07-29 10:00:00', confirm_status: 'confirmed'
        };
      }
      return null;
    },
    run: async (sql, params) => { statements.push({ sql: String(sql), params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/replies/:id/manually-replied');
    const response = await callHandler(handler, {
      params: { id: 17 }, body: { handled_by: 'Celeste' }
    });
    assert.equal(response.payload.success, true);
    assert.equal(response.payload.data.confirm_status, 'manually_replied');
  });
  const updateReply = statements.find((statement) => /UPDATE email_replies/.test(statement.sql));
  assert.match(updateReply.sql, /confirm_status = 'manually_replied'/);
  assert.match(updateReply.sql, /handled_at = NOW\(\)/);
  assert.deepEqual(updateReply.params, ['Celeste', 17]);
  const updateKol = statements.find((statement) => /UPDATE campaign_kols/.test(statement.sql));
  assert.match(updateKol.sql, /needs_reply = 0/);
  assert.match(updateKol.sql, /NOT IN \('ignored', 'manually_replied'\)/);
  assert.equal(statements.some((statement) => /email_records|email_drafts/.test(statement.sql)), false);
  assert.ok(statements.some((statement) =>
    /UPDATE approval_items/.test(statement.sql) && statement.params.includes(17)
  ));
});

test('POST /replies/:id/retry-summary re-runs summarizeReply and returns updated reply', async () => {
  const poller = require('../services/emailReplyPoller');
  const original = poller.summarizeReply;
  const seen = [];
  poller.summarizeReply = async (id) => { seen.push(id); return { success: true }; };
  try {
    await withPatchedDb({
      get: async () => ({ id: 8, ai_status: 'success', ai_summary: '重试后的摘要' })
    }, async () => {
      const handler = findHandler(require('./emails'), 'post', '/replies/:id/retry-summary');
      const response = await callHandler(handler, { params: { id: 8 } });
      assert.equal(response.payload.success, true);
      assert.equal(response.payload.data.ai_summary, '重试后的摘要');
    });
  } finally {
    poller.summarizeReply = original;
  }
  assert.deepEqual(seen, [8]);
});

test('POST /replies/:id/draft-reply generates reply draft into review queue', async () => {
  const drafter = require('../services/emailDrafter');
  const original = drafter.draftForCustomer;
  const seen = [];
  drafter.draftForCustomer = async (args) => { seen.push(args); return { ok: true, draftId: 99 }; };
  try {
    await withPatchedDb({
      get: async () => ({ id: 9, campaign_id: 2, customer_id: 1, body_text: '我想了解一下佣金细节' })
    }, async () => {
      const handler = findHandler(require('./emails'), 'post', '/replies/:id/draft-reply');
      const response = await callHandler(handler, { params: { id: 9 } });
      assert.equal(response.payload.success, true);
      assert.equal(response.payload.data.draftId, 99);
    });
  } finally {
    drafter.draftForCustomer = original;
  }
  assert.equal(seen[0].kind, 'reply');
  assert.equal(seen[0].sourceReplyId, 9);
  assert.equal(seen[0].feedback, undefined, '邮件原文不再塞进 feedback，由 drafter 内部走会话上下文');
});

test('POST /drafts/generate dedupes existing pending drafts and queues the rest as a background run', async () => {
  const automationRuns = require('../services/automationRuns');
  const originalCreate = automationRuns.createRun;
  const originalExec = automationRuns.executeEmailDraftBatch;
  const executed = [];
  automationRuns.createRun = async (fields) => ({ id: 42, ...fields });
  automationRuns.executeEmailDraftBatch = async (runId, items) => { executed.push({ runId, items }); };
  try {
    await withPatchedDb({
      query: async (sql) => (/FROM email_drafts/i.test(sql) ? [{ customer_id: 2 }] : [])
    }, async () => {
      const handler = findHandler(require('./emails'), 'post', '/drafts/generate');
      const response = await callHandler(handler, { body: { campaign_id: 1, customer_ids: [1, 2] } });
      assert.equal(response.payload.data.run_id, 42);
      assert.equal(response.payload.data.total_requested, 2);
      assert.equal(response.payload.data.queued, 1);
      assert.deepEqual(response.payload.data.skipped, [{ customer_id: 2, reason: '已存在待审阅的同类型草稿' }]);
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executed.length, 1);
    assert.equal(executed[0].runId, 42);
    assert.deepEqual(executed[0].items.map((item) => item.customerId), [1]);
  } finally {
    automationRuns.createRun = originalCreate;
    automationRuns.executeEmailDraftBatch = originalExec;
  }
});

test('GET /records supports campaign_id filter alongside status', async () => {
  const statements = [];
  await withPatchedDb({
    get: async (sql, params) => { statements.push({ sql, params }); return { total: 0 }; },
    query: async (sql, params) => { statements.push({ sql, params }); return []; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/records');
    const response = await callHandler(handler, { query: { status: 'sent', campaign_id: '5' } });
    assert.equal(response.payload.success, true);
    assert.ok(statements.every((s) => /er\.status = \?/.test(s.sql) && /er\.campaign_id = \?/.test(s.sql)));
    assert.deepEqual(statements[0].params, ['sent', '5']);
  });
});

test('GET /records without campaign_id keeps unfiltered query', async () => {
  const statements = [];
  await withPatchedDb({
    get: async (sql, params) => { statements.push({ sql, params }); return { total: 0 }; },
    query: async (sql, params) => { statements.push({ sql, params }); return []; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/records');
    await callHandler(handler, { query: {} });
    assert.ok(statements.every((s) => !/campaign_id/.test(s.sql)));
    assert.deepEqual(statements[0].params, []);
  });
});

// ---- 准实时收信：收信模式 / 连接状态 / 立即同步 / 未识别回复绑定 ----

test('GET /settings/sync-status returns per-mailbox state array', async () => {
  const emailLiveSync = require('../services/emailLiveSync');
  const original = emailLiveSync.getEmailSyncStatus;
  emailLiveSync.getEmailSyncStatus = () => [{ mailbox_id: 1, status: 'connected' }];
  try {
    const handler = findHandler(require('./emails'), 'get', '/settings/sync-status');
    const response = await callHandler(handler);
    assert.equal(response.payload.success, true);
    assert.ok(Array.isArray(response.payload.data));
    assert.equal(response.payload.data[0].mailbox_id, 1);
  } finally {
    emailLiveSync.getEmailSyncStatus = original;
  }
});

test('POST /settings/sync-now with id syncs the specified mailbox', async () => {
  const emailLiveSync = require('../services/emailLiveSync');
  const original = emailLiveSync.syncNow;
  let syncedWith = null;
  emailLiveSync.syncNow = async (id) => { syncedWith = id; return { fetched: 3, matched: 2, unmatched: 1 }; };
  try {
    await withPatchedDb({ get: async () => ({ id: 2 }) }, async () => {
      const handler = findHandler(require('./emails'), 'post', '/settings/sync-now');
      const response = await callHandler(handler, { body: { id: 2 } });
      assert.equal(response.payload.success, true);
      assert.equal(response.payload.data.fetched, 3);
    });
  } finally {
    emailLiveSync.syncNow = original;
  }
  assert.equal(syncedWith, 2, 'syncs the requested mailbox');
});

test('POST /settings/sync-now without id syncs all enabled mailboxes', async () => {
  const emailLiveSync = require('../services/emailLiveSync');
  const original = emailLiveSync.syncNow;
  let calledWithoutId = false;
  emailLiveSync.syncNow = async () => { calledWithoutId = true; return { fetched: 3, matched: 2, unmatched: 1 }; };
  try {
    const handler = findHandler(require('./emails'), 'post', '/settings/sync-now');
    const response = await callHandler(handler);
    assert.equal(response.payload.success, true);
  } finally {
    emailLiveSync.syncNow = original;
  }
  assert.equal(calledWithoutId, true, 'syncs all when no id supplied');
});

test('POST /settings/test-imap with id tests the specified mailbox', async () => {
  const emailLiveSync = require('../services/emailLiveSync');
  const original = emailLiveSync.testImapConnection;
  let testedSettings = null;
  emailLiveSync.testImapConnection = async (settings) => { testedSettings = settings; return { exists: 261, uidNext: 262 }; };
  try {
    await withPatchedDb({ get: async () => ({ id: 2, username: 'v@x.com' }) }, async () => {
      const handler = findHandler(require('./emails'), 'post', '/settings/test-imap');
      const response = await callHandler(handler, { body: { id: 2 } });
      assert.equal(response.payload.success, true);
      assert.match(response.payload.message, /IMAP/);
      assert.equal(response.payload.data.exists, 261);
    });
  } finally {
    emailLiveSync.testImapConnection = original;
  }
  assert.equal(testedSettings.username, 'v@x.com', 'tests the specified mailbox');
});

test('GET /replies scope=unmatched filters replies without a KOL', async () => {
  const queries = [];
  await withPatchedDb({
    query: async (sql) => { queries.push(String(sql)); return []; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/replies');
    await callHandler(handler, { query: { scope: 'unmatched' } });
    assert.match(queries[0], /er\.customer_id IS NULL/);
  });
});

test('GET /replies supports project communication filtering', async () => {
  let captured;
  await withPatchedDb({
    query: async (sql, params) => { captured = { sql: String(sql), params }; return []; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/replies');
    const response = await callHandler(handler, { query: { campaign_id: '1404' } });
    assert.equal(response.payload.success, true);
  });
  assert.match(captured.sql, /er\.campaign_id = \?/);
  assert.deepEqual(captured.params, [1404]);
});

test('GET /replies scope=needs_reply returns the latest actionable inbound email', async () => {
  const queries = [];
  await withPatchedDb({
    query: async (sql) => { queries.push(String(sql)); return []; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/replies');
    await callHandler(handler, { query: { scope: 'needs_reply' } });
  });
  assert.match(queries[0], /ck\.needs_reply = 1/);
  assert.match(queries[0], /LEFT JOIN campaign_kols ck/);
  assert.match(queries[0], /ORDER BY er2\.received_at DESC, er2\.id DESC LIMIT 1/);
});

test('POST /replies/:id/bind assigns a KOL, defaults campaign and triggers summary', async () => {
  const emailReplyPoller = require('../services/emailReplyPoller');
  let summarized = null;
  const originalSummary = emailReplyPoller.summarizeReply;
  emailReplyPoller.summarizeReply = async (id) => { summarized = id; };
  const writes = [];
  try {
    await withPatchedDb({
      get: async (sql, params = []) => {
        const text = String(sql);
        if (text.includes('FROM email_replies WHERE id = ?')) {
          return writes.length
            ? { id: 5, customer_id: 7, campaign_id: 2 }
            : { id: 5, customer_id: null, campaign_id: null };
        }
        if (text.includes('FROM customers WHERE id = ?')) return { id: params[0] };
        if (text.includes('FROM campaign_kols WHERE customer_id = ?')) return { campaign_id: 2, customer_id: params[0] };
        return null;
      },
      run: async (sql, params) => { writes.push({ sql: String(sql), params }); return { changes: 1 }; }
    }, async () => {
      const handler = findHandler(require('./emails'), 'post', '/replies/:id/bind');
      const response = await callHandler(handler, { params: { id: '5' }, body: { customer_id: 7 } });
      assert.equal(response.payload.success, true);
      const update = writes.find((w) => w.sql.includes('UPDATE email_replies SET customer_id'));
      assert.deepEqual(update.params, [7, 2, 5], 'binds customer and defaults campaign from latest relation');
      const outreachUpdate = writes.find((w) => w.sql.includes('needs_reply = 1'));
      assert.ok(outreachUpdate, 'binding an inbound message should create a reply todo');
      assert.deepEqual(outreachUpdate.params, [2, 7]);
      assert.equal(response.payload.data.customer_id, 7);
    });
  } finally {
    emailReplyPoller.summarizeReply = originalSummary;
  }
  assert.equal(summarized, 5, 'summary runs after binding');
});

test('POST /replies/:id/bind validates reply and KOL existence', async () => {
  await withPatchedDb({
    get: async (sql) => {
      const text = String(sql);
      if (text.includes('FROM email_replies WHERE id = ?')) return null;
      return null;
    }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/replies/:id/bind');
    const missing = await callHandler(handler, { params: { id: '404' }, body: { customer_id: 7 } });
    assert.equal(missing.statusCode, 404);
  });

  await withPatchedDb({
    get: async (sql) => {
      const text = String(sql);
      if (text.includes('FROM email_replies WHERE id = ?')) return { id: 5, customer_id: null };
      return null; // customers 查不到
    }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/replies/:id/bind');
    const missingKol = await callHandler(handler, { params: { id: '5' }, body: { customer_id: 9999 } });
    assert.equal(missingKol.statusCode, 404);
    assert.match(missingKol.payload.error, /KOL 不存在/);
    const badBody = await callHandler(handler, { params: { id: '5' }, body: {} });
    assert.equal(badBody.statusCode, 400);
  });
});

test('POST /replies/:id/bind only binds to a KOL in the selected project', async () => {
  await withPatchedDb({
    get: async (sql, params = []) => {
      const text = String(sql);
      if (text.includes('FROM email_replies WHERE id = ?')) return { id: 5, customer_id: null };
      if (text.includes('FROM customers WHERE id = ?')) return { id: params[0] };
      if (text.includes('FROM campaign_kols WHERE campaign_id = ?')) return null;
      return null;
    }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/replies/:id/bind');
    const response = await callHandler(handler, {
      params: { id: '5' }, body: { customer_id: 7, campaign_id: 1404 }
    });
    assert.equal(response.statusCode, 409);
    assert.match(response.payload.error, /不在当前项目/);
  });
});

test('POST /replies/:id/bind rejects a KOL with no project relation', async () => {
  await withPatchedDb({
    get: async (sql, params = []) => {
      const text = String(sql);
      if (text.includes('FROM email_replies WHERE id = ?')) return { id: 5, customer_id: null };
      if (text.includes('FROM customers WHERE id = ?')) return { id: params[0] };
      return null; // campaign_kols 查不到任何项目关系
    }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/replies/:id/bind');
    const response = await callHandler(handler, { params: { id: '5' }, body: { customer_id: 7 } });
    assert.equal(response.statusCode, 409);
    assert.match(response.payload.error, /不在任何项目/);
  });
});

// ---- 审批台顶部指标卡 ----

test('GET /approval-dashboard/summary returns aggregated stats from the dashboard service', async () => {
  // 用模块替换方式注入稳定的 buildSummary，绕过真实 DB 调用
  const dashboardSummary = require('../services/emailDashboardSummary');
  const originalBuild = dashboardSummary.buildSummary;
  dashboardSummary.buildSummary = async () => ({
    todayContactedKols: 12,
    weekContactedKols: 48,
    previousWeekContactedKols: 39,
    weekDifference: 9,
    replyRate30d: 8.6,
    repliedKols30d: 6,
    deliveredKols30d: 70,
    denominatorType: 'sent_success',
    timezone: 'Asia/Shanghai',
    replyWindowDays: 30,
    generatedAt: '2026-07-28T01:30:00.000Z'
  });
  try {
    const handler = findHandler(require('./emails'), 'get', '/approval-dashboard/summary');
    const response = await callHandler(handler);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.success, true);
    assert.equal(response.payload.data.todayContactedKols, 12);
    assert.equal(response.payload.data.weekContactedKols, 48);
    assert.equal(response.payload.data.replyRate30d, 8.6);
    assert.equal(response.payload.data.denominatorType, 'sent_success');
  } finally {
    dashboardSummary.buildSummary = originalBuild;
  }
});

test('GET /approval-dashboard/summary still returns 200 with nulls when the service throws', async () => {
  const dashboardSummary = require('../services/emailDashboardSummary');
  const originalBuild = dashboardSummary.buildSummary;
  dashboardSummary.buildSummary = async () => { throw new Error('boom'); };
  try {
    const handler = findHandler(require('./emails'), 'get', '/approval-dashboard/summary');
    const response = await callHandler(handler);
    assert.equal(response.statusCode, 200, 'summary failure must not break approval tab');
    assert.equal(response.payload.success, true);
    assert.equal(response.payload.data.todayContactedKols, null);
    assert.equal(response.payload.data.weekContactedKols, null);
    assert.equal(response.payload.data.replyRate30d, null);
    assert.equal(response.payload.data.error, 'boom');
  } finally {
    dashboardSummary.buildSummary = originalBuild;
  }
});

test('GET /replies returns parsed fields as-is for newly parsed rows', async () => {
  const parsedRow = {
    id: 1,
    confirm_status: 'pending',
    body_text: '完整正文含引用',
    clean_body_text: '本次新写内容',
    body_html: '<p>本次新写内容</p>',
    quoted_body_text: '> 引用',
    signature_text: null,
    thread_id: 9,
    in_reply_to: '<sent-1@test>',
    parse_status: 'ok'
  };
  await withPatchedDb({
    query: async () => [parsedRow]
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/replies');
    const response = await callHandler(handler, { query: {} });
    const row = response.payload.data[0];
    assert.equal(row.body_text, '完整正文含引用', '已解析行不重跑旧解析器');
    assert.equal(row.clean_body_text, '本次新写内容');
    assert.equal(row.body_html, '<p>本次新写内容</p>');
    assert.equal(row.quoted_body_text, '> 引用');
    assert.equal(row.thread_id, 9);
    assert.equal(row.in_reply_to, '<sent-1@test>');
    assert.equal(row.parse_status, 'ok');
  });
});

test('GET /replies re-runs the legacy parser only for legacy rows without clean_body_text', async () => {
  const legacyRow = {
    id: 2,
    confirm_status: 'pending',
    body_text: 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n原始正文',
    clean_body_text: null,
    parse_status: 'legacy'
  };
  const failedRow = {
    id: 3,
    confirm_status: 'pending',
    body_text: '回退时已清洗的正文',
    clean_body_text: null,
    parse_status: 'failed'
  };
  await withPatchedDb({
    query: async () => [legacyRow, failedRow]
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/replies');
    const response = await callHandler(handler, { query: {} });
    const [legacy, failed] = response.payload.data;
    assert.equal(legacy.body_text, '原始正文', 'legacy 行走旧兼容清洗');
    assert.equal(failed.body_text, '回退时已清洗的正文', 'failed 行入库时已清洗，不再重跑');
  });
});

// ---- 邮件会话（thread）API ----

test('GET /threads applies campaign/customer filters and paginates', async () => {
  const seen = [];
  await withPatchedDb({
    get: async (sql, params = []) => {
      seen.push({ sql: String(sql), params });
      if (/COUNT\(\*\)/.test(String(sql))) return { total: 1 };
      // 每页的 lastReply/lastRecord 查询
      if (/FROM email_replies WHERE thread_id/.test(String(sql))) {
        return { id: 5, subject: 'Re: Hi', from_address: 'kol@x.com', received_at: '2026-07-29 10:00:00', ai_summary: '问报价', clean_body_text: null, body_text: '报价多少', confirm_status: 'pending' };
      }
      return null; // lastRecord 无
    },
    query: async (sql, params = []) => {
      seen.push({ sql: String(sql), params });
      return [{ id: 9, campaign_id: 2, customer_id: 7, message_count: 3, last_message_at: '2026-07-29 10:00:00', campaign_name: 'Everglow', customer_name: 'Casey' }];
    }
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/threads');
    const response = await callHandler(handler, { query: { campaign_id: '2', customer_id: '7', needs_reply: '1', page: '2', pageSize: '10' } });
    assert.equal(response.payload.success, true);
    assert.equal(response.payload.data.total, 1);
    assert.equal(response.payload.data.page, 2);
    assert.equal(response.payload.data.items[0].last_message.direction, 'inbound');
    assert.equal(response.payload.data.items[0].last_message.summary, '问报价');
  });
  const listQuery = seen.find((s) => /FROM email_threads t/.test(s.sql) && /LIMIT \? OFFSET \?/.test(s.sql));
  assert.match(listQuery.sql, /t\.campaign_id = \?/);
  assert.match(listQuery.sql, /t\.customer_id = \?/);
  assert.match(listQuery.sql, /ck\.needs_reply = 1/);
  assert.deepEqual(listQuery.params, [2, 7, 10, 10]);
});

test('GET /threads/:id returns thread, timeline, pending draft and campaign/customer', async () => {
  await withPatchedDb({
    get: async (sql, params = []) => {
      const text = String(sql);
      if (/FROM email_threads WHERE id = \?/.test(text)) return { id: 9, campaign_id: 2, customer_id: 7, context_summary: '摘要' };
      if (/FROM campaigns WHERE id = \?/.test(text)) return { id: 2, name: 'Everglow' };
      if (/FROM customers WHERE id = \?/.test(text)) return { id: 7, name: 'Casey', email: 'kol@x.com' };
      if (/FROM email_drafts WHERE thread_id = \?/.test(text)) {
        return { id: 21, status: 'pending_review', context_message_ids: '["<r1@x>"]', context_summary_snapshot: '摘要' };
      }
      return null;
    },
    query: async (sql) => {
      const text = String(sql);
      if (/FROM email_replies WHERE thread_id = \?/.test(text)) {
        return [{
          id: 5, message_id: '<r1@x>', subject: 'Re: Hi', from_address: 'kol@x.com',
          received_at: '2026-07-29 10:00:00', body_text: '正文', clean_body_text: '清洗正文',
          body_html: '<p>清洗正文</p>', quoted_body_text: '> 引用', signature_text: 'Casey',
          parse_status: 'ok', ai_summary: null, confirm_status: 'pending'
        }];
      }
      if (/FROM email_records WHERE thread_id = \?/.test(text)) return [];
      throw new Error(`Unexpected query: ${text}`);
    }
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/threads/:id');
    const response = await callHandler(handler, { params: { id: 9 } });
    const data = response.payload.data;
    assert.equal(data.thread.id, 9);
    assert.equal(data.campaign.name, 'Everglow');
    assert.equal(data.customer.name, 'Casey');
    assert.equal(data.timeline.length, 1);
    assert.equal(data.timeline[0].direction, 'inbound');
    assert.equal(data.timeline[0].parseStatus, 'ok');
    assert.equal(data.timeline[0].reply.body_html, '<p>清洗正文</p>');
    assert.equal(data.timeline[0].reply.quoted_body_text, '> 引用');
    assert.equal(data.pending_draft.id, 21);
    assert.equal(data.pending_draft.context_summary_snapshot, '摘要');
  });
});

test('GET /threads/:id returns 404 for unknown thread', async () => {
  await withPatchedDb({ get: async () => null }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/threads/:id');
    const response = await callHandler(handler, { params: { id: 404 } });
    assert.equal(response.statusCode, 404);
  });
});

test('POST /threads/:id/draft-reply drafts against the latest inbound and passes feedback through', async () => {
  const drafter = require('../services/emailDrafter');
  const original = drafter.draftForCustomer;
  const seen = [];
  drafter.draftForCustomer = async (args) => { seen.push(args); return { ok: true, draftId: 77 }; };
  try {
    await withPatchedDb({
      get: async (sql) => {
        const text = String(sql);
        if (/FROM email_threads WHERE id = \?/.test(text)) return { id: 9, campaign_id: 2, customer_id: 7 };
        if (/FROM email_replies WHERE thread_id = \?/.test(text)) return { id: 5, thread_id: 9 };
        return null;
      }
    }, async () => {
      const handler = findHandler(require('./emails'), 'post', '/threads/:id/draft-reply');
      const response = await callHandler(handler, { params: { id: 9 }, body: { feedback: '语气再随和一点' } });
      assert.equal(response.payload.success, true);
      assert.equal(response.payload.data.draftId, 77);
    });
  } finally {
    drafter.draftForCustomer = original;
  }
  assert.deepEqual(seen[0], {
    campaignId: 2, customerId: 7, kind: 'reply', sourceReplyId: 5, feedback: '语气再随和一点'
  });
});

test('POST /threads/:id/draft-reply reuses existing draft when drafter skips', async () => {
  const drafter = require('../services/emailDrafter');
  const original = drafter.draftForCustomer;
  drafter.draftForCustomer = async () => ({ ok: true, skipped: true, draftId: 66, reason: '已有 pending_review 草稿' });
  try {
    await withPatchedDb({
      get: async (sql) => {
        const text = String(sql);
        if (/FROM email_threads WHERE id = \?/.test(text)) return { id: 9, campaign_id: 2, customer_id: 7 };
        if (/FROM email_replies WHERE thread_id = \?/.test(text)) return { id: 5, thread_id: 9 };
        return null;
      }
    }, async () => {
      const handler = findHandler(require('./emails'), 'post', '/threads/:id/draft-reply');
      const response = await callHandler(handler, { params: { id: 9 } });
      assert.equal(response.payload.success, true);
      assert.match(response.payload.message, /复用现有/);
      assert.equal(response.payload.data.draftId, 66);
    });
  } finally {
    drafter.draftForCustomer = original;
  }
});

test('POST /threads/:id/context/refresh returns refreshed summary', async () => {
  const builder = require('../services/emailContextBuilder');
  const original = builder.generateThreadSummary;
  builder.generateThreadSummary = async (threadId) => {
    assert.equal(threadId, 9);
    return { summary: '刷新后的摘要', throughMessageId: '<r2@x>', updated: true };
  };
  try {
    const handler = findHandler(require('./emails'), 'post', '/threads/:id/context/refresh');
    const response = await callHandler(handler, { params: { id: 9 } });
    assert.equal(response.payload.success, true);
    assert.equal(response.payload.data.context_summary, '刷新后的摘要');
    assert.equal(response.payload.data.summary_through_message_id, '<r2@x>');
  } finally {
    builder.generateThreadSummary = original;
  }
});

test('POST /threads/:id/context/refresh falls back to stored summary when AI fails', async () => {
  const builder = require('../services/emailContextBuilder');
  const original = builder.generateThreadSummary;
  builder.generateThreadSummary = async () => null;
  try {
    await withPatchedDb({
      get: async () => ({ context_summary: '已存摘要', summary_through_message_id: '<r1@x>' })
    }, async () => {
      const handler = findHandler(require('./emails'), 'post', '/threads/:id/context/refresh');
      const response = await callHandler(handler, { params: { id: 9 } });
      assert.equal(response.payload.success, true);
      assert.match(response.payload.message, /AI 摘要生成失败/);
      assert.equal(response.payload.data.context_summary, '已存摘要');
    });
  } finally {
    builder.generateThreadSummary = original;
  }
});

