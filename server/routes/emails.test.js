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

test('GET /settings masks stored password', async () => {
  await withPatchedDb({
    get: async () => ({ id: 1, smtp_host: 'smtp.qiye.aliyun.com', username: 'u@x.com', password: 'secret' })
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/settings');
    const response = await callHandler(handler);
    assert.equal(response.payload.data.password, '••••••••');
  });
});

test('PUT /settings keeps stored password when masked value submitted', async () => {
  const statements = [];
  await withPatchedDb({
    get: async () => ({ id: 1, password: 'real-secret' }),
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'put', '/settings');
    await callHandler(handler, { body: { smtp_host: 'smtp.qiye.aliyun.com', username: 'u@x.com', password: '••••••••' } });
    const update = statements.find((s) => /UPDATE email_settings/.test(s.sql));
    assert.ok(update, 'should update existing row');
    assert.ok(update.params.includes('real-secret'));
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
      if (/FROM campaign_kols/.test(sql)) return { id: 77, internal_notes: '旧备注' };
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
  const updateReply = statements.find((s) => /UPDATE email_replies/.test(s.sql));
  assert.match(updateReply.sql, /confirm_status = 'confirmed'/);
});

test('POST /replies/:id/confirm maps other to negotiating without changing the email todo', async () => {
  const statements = [];
  await withPatchedDb({
    get: async (sql) => {
      if (/FROM email_replies/.test(sql)) {
        return { id: 15, campaign_id: 2, customer_id: 7, ai_intent: 'other', ai_summary: 'needs review' };
      }
      if (/FROM campaign_kols/.test(sql)) return { id: 78, internal_notes: null };
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
      if (/FROM campaign_kols/.test(sql)) return { id: 78, internal_notes: null };
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
});

test('POST /replies/:id/retry-summary re-runs summarizeReply and returns updated reply', async () => {
  const poller = require('../services/emailReplyPoller');
  const original = poller.summarizeReply;
  const seen = [];
  poller.summarizeReply = async (id) => { seen.push(id); };
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
  assert.match(seen[0].feedback, /佣金细节/);
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

test('PUT /settings persists sync_mode and restarts the listener', async () => {
  const emailLiveSync = require('../services/emailLiveSync');
  let restarted = 0;
  const original = emailLiveSync.restartEmailSync;
  emailLiveSync.restartEmailSync = async () => { restarted += 1; };
  const statements = [];
  try {
    await withPatchedDb({
      get: async () => ({ id: 1, password: 'real-secret', sync_mode: 'poll' }),
      run: async (sql, params) => { statements.push({ sql, params }); return { changes: 1 }; }
    }, async () => {
      const handler = findHandler(require('./emails'), 'put', '/settings');
      const response = await callHandler(handler, { body: { username: 'u@x.com', sync_mode: 'idle' } });
      assert.equal(response.payload.success, true);
      assert.match(response.payload.message, /收信监听已重启/);
      const update = statements.find((s) => /UPDATE email_settings/.test(s.sql));
      assert.ok(update.params.includes('idle'), 'sync_mode written to settings');
    });
  } finally {
    emailLiveSync.restartEmailSync = original;
  }
  assert.equal(restarted, 1, 'listener restarts after settings change');
});

test('GET /settings/sync-status returns the live sync state', async () => {
  const handler = findHandler(require('./emails'), 'get', '/settings/sync-status');
  const response = await callHandler(handler);
  assert.equal(response.payload.success, true);
  assert.ok('mode' in response.payload.data);
  assert.ok('status' in response.payload.data);
  assert.ok('last_error' in response.payload.data);
});

test('POST /settings/sync-now reports fetch counts', async () => {
  const emailLiveSync = require('../services/emailLiveSync');
  const original = emailLiveSync.syncNow;
  emailLiveSync.syncNow = async () => ({ fetched: 3, matched: 2, unmatched: 1 });
  try {
    const handler = findHandler(require('./emails'), 'post', '/settings/sync-now');
    const response = await callHandler(handler);
    assert.equal(response.payload.success, true);
    assert.match(response.payload.message, /新收 3，匹配 2，未识别 1/);
  } finally {
    emailLiveSync.syncNow = original;
  }
});

test('POST /settings/test-imap reports mailbox info', async () => {
  const emailLiveSync = require('../services/emailLiveSync');
  const original = emailLiveSync.testImapConnection;
  emailLiveSync.testImapConnection = async () => ({ exists: 261, uidNext: 262 });
  try {
    const handler = findHandler(require('./emails'), 'post', '/settings/test-imap');
    const response = await callHandler(handler);
    assert.equal(response.payload.success, true);
    assert.match(response.payload.message, /IMAP 连接成功/);
    assert.equal(response.payload.data.exists, 261);
  } finally {
    emailLiveSync.testImapConnection = original;
  }
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
