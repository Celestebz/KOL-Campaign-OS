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
    }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/drafts/:id/send');
    const response = await callHandler(handler, { params: { id: 9 } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error, '草稿未批准，不能发送');
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
  const updateDraft = statements.find((s) => /UPDATE email_drafts/.test(s.sql));
  assert.match(updateDraft.sql, /status = 'sent'/);
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

test('POST /drafts/generate calls drafter per customer and returns per-item results', async () => {
  const drafter = require('../services/emailDrafter');
  const original = drafter.draftBatch;
  const seen = [];
  drafter.draftBatch = async (items) => {
    seen.push(...items);
    return items.map((item) => ({ ok: item.customerId !== 2, customer_id: item.customerId, draftId: 100 + item.customerId, error: item.customerId === 2 ? 'AI 超时' : undefined }));
  };
  try {
    await withPatchedDb({}, async () => {
      const handler = findHandler(require('./emails'), 'post', '/drafts/generate');
      const response = await callHandler(handler, { body: { campaign_id: 1, customer_ids: [1, 2] } });
      assert.equal(response.payload.data.results.length, 2);
      assert.equal(response.payload.data.results[1].ok, false);
      assert.equal(response.payload.data.results[1].error, 'AI 超时');
    });
  } finally {
    drafter.draftBatch = original;
  }
  assert.deepEqual(seen.map((i) => i.customerId), [1, 2]);
});
