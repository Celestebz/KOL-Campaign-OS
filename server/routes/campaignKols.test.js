const assert = require('node:assert/strict');
const test = require('node:test');
const { dbOperations } = require('../database');
const confirmCooperationSync = require('../services/confirmCooperationSync');

// 确认合作路由会触发飞书同步；单测只验证本地确认逻辑，避免真实网络调用。
confirmCooperationSync.syncConfirmedToFeishu = async () => ({ targets: [] });

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
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        resolve(this);
        return this;
      }
    };
    Promise.resolve(handler({ body, params, query }, response, reject)).catch(reject);
  });
}

// Drives POST /:id/confirm-cooperation with a mocked database. `row` is mutated
// by the mocked UPDATE so the follow-up SELECT reflects the confirmed state.
async function runConfirmCooperation(initialRow, { id = initialRow?.id ?? 1 } = {}) {
  const writes = [];
  const state = { row: initialRow ? { ...initialRow } : null };
  const originalGet = dbOperations.get;
  const originalRun = dbOperations.run;

  dbOperations.get = async (sql, params = []) => {
    if (String(sql).includes('FROM campaign_kols WHERE id = ?')) {
      return state.row && state.row.id === params[0] ? { ...state.row } : null;
    }
    return null;
  };
  dbOperations.run = async (sql, params = []) => {
    const text = String(sql);
    writes.push({ sql: text, params });
    if (text.includes('UPDATE campaign_kols') && text.includes("pipeline_stage = 'confirmed'")) {
      state.row = {
        ...state.row,
        pipeline_stage: 'confirmed',
        project_status: 'pending_shipping',
        outreach_status: 'confirmed',
        confirmed_at: '2026-07-27 02:00:00',
        sync_status: 'sync_pending'
      };
    }
    return { changes: 1 };
  };

  try {
    const handler = findHandler(require('./campaignKols'), 'post', '/:id/confirm-cooperation');
    const response = await callHandler(handler, { params: { id: String(id) } });
    return { response, writes, finalRow: state.row };
  } finally {
    dbOperations.get = originalGet;
    dbOperations.run = originalRun;
  }
}

const candidateRow = {
  id: 42,
  campaign_id: 3,
  customer_id: 11,
  pipeline_stage: 'candidate',
  project_status: 'pending_confirmation',
  confirmed_at: null,
  sync_status: 'synced'
};

test('confirm-cooperation moves a candidate to confirmed with pending_shipping and sync_pending', async () => {
  const { response, writes, finalRow } = await runConfirmCooperation(candidateRow);

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.success, true);
  assert.equal(response.payload.message, 'KOL cooperation confirmed');

  const update = writes.find((write) => write.sql.includes('UPDATE campaign_kols'));
  assert.ok(update, 'expected an UPDATE on campaign_kols');
  assert.ok(update.sql.includes("pipeline_stage = 'confirmed'"));
  assert.ok(update.sql.includes("project_status = 'pending_shipping'"));
  assert.ok(update.sql.includes("outreach_status = 'confirmed'"));
  assert.ok(update.sql.includes('confirmed_at = CURRENT_TIMESTAMP'));
  assert.ok(update.sql.includes("sync_status = 'sync_pending'"));
  assert.deepEqual(update.params, [42]);

  assert.equal(finalRow.pipeline_stage, 'confirmed');
  assert.equal(finalRow.project_status, 'pending_shipping');
  assert.equal(finalRow.outreach_status, 'confirmed');
  assert.ok(finalRow.confirmed_at, 'confirmed_at must be written');
  assert.equal(finalRow.sync_status, 'sync_pending');
  assert.equal(response.payload.data.pipeline_stage, 'confirmed');
  assert.equal(response.payload.data.project_status, 'pending_shipping');

  const customerUpdate = writes.find((write) => write.sql.includes('UPDATE customers'));
  assert.ok(customerUpdate, 'expected the KOL master sync_status to be marked pending');
  assert.deepEqual(customerUpdate.params, [11]);
});

test('confirm-cooperation is idempotent for an already confirmed KOL', async () => {
  const confirmedRow = {
    ...candidateRow,
    pipeline_stage: 'confirmed',
    project_status: 'pending_shipping',
    confirmed_at: '2026-07-27 01:00:00',
    sync_status: 'synced'
  };
  const { response, writes, finalRow } = await runConfirmCooperation(confirmedRow);

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.success, true);
  assert.equal(response.payload.message, 'KOL cooperation already confirmed');
  assert.equal(writes.length, 0, 'repeat confirmation must not issue any UPDATE');
  assert.equal(finalRow.confirmed_at, '2026-07-27 01:00:00', 'confirmed_at must stay untouched');
});

test('confirm-cooperation returns 404 for a missing record', async () => {
  const { response, writes } = await runConfirmCooperation(null, { id: 9999 });

  assert.equal(response.statusCode, 404);
  assert.equal(response.payload.success, false);
  assert.ok(response.payload.error.includes('not found'));
  assert.equal(writes.length, 0);
});

test('confirm-cooperation rejects a non-numeric id', async () => {
  const handler = findHandler(require('./campaignKols'), 'post', '/:id/confirm-cooperation');
  const response = await callHandler(handler, { params: { id: 'abc' } });

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.success, false);
});

test('confirm-cooperation rejects historical cooperation records', async () => {
  const historicalRow = {
    ...candidateRow,
    pipeline_stage: 'historical',
    project_status: 'pending_confirmation'
  };
  const { response, writes } = await runConfirmCooperation(historicalRow);

  assert.equal(response.statusCode, 409);
  assert.equal(response.payload.success, false);
  assert.ok(response.payload.error.includes('历史合作记录不能确认合作'));
  assert.equal(writes.length, 0, 'historical records must not be modified');
});

test('confirm-cooperation rejects terminated candidates', async () => {
  const { response, writes } = await runConfirmCooperation({ ...candidateRow, outreach_status: 'terminated' });

  assert.equal(response.statusCode, 409);
  assert.equal(response.payload.success, false);
  assert.ok(response.payload.error.includes('已终止'));
  assert.equal(writes.length, 0, 'terminated candidates must not be modified');

  const legacy = await runConfirmCooperation({ ...candidateRow, outreach_status: 'rejected' });
  assert.equal(legacy.response.statusCode, 409, 'legacy rejected is treated as terminated');
});

// ---- PATCH /:id 阶段字段白名单 ----
async function runPatch(row, body) {
  const writes = [];
  const originalGet = dbOperations.get;
  const originalRun = dbOperations.run;
  dbOperations.get = async (sql, params = []) => {
    if (String(sql).includes('FROM campaign_kols WHERE id = ?')) return { ...row };
    return null;
  };
  dbOperations.run = async (sql, params = []) => {
    writes.push({ sql: String(sql), params });
    return { changes: 1 };
  };
  try {
    const handler = findHandler(require('./campaignKols'), 'patch', '/:id');
    const response = await callHandler(handler, { body, params: { id: String(row.id) } });
    return { response, writes };
  } finally {
    dbOperations.get = originalGet;
    dbOperations.run = originalRun;
  }
}

test('PATCH applies outreach_status for candidates and ignores project_status', async () => {
  const { response, writes } = await runPatch(
    { ...candidateRow, outreach_status: 'not_contacted' },
    { project_status: 'shipped', outreach_status: 'contacted' }
  );

  assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
  const update = writes.find((write) => write.sql.includes('UPDATE campaign_kols SET'));
  assert.ok(update.sql.includes('outreach_status = ?'), 'candidate edit may update outreach_status');
  assert.ok(!update.sql.includes('project_status = ?'), 'candidate edit must not overwrite project_status');
  assert.ok(update.params.includes('contacted'));
});

test('PATCH rejects cooperation-only fields for candidates without changing legacy data', async () => {
  const legacyCandidate = {
    ...candidateRow,
    shipping_address: '历史地址',
    content_format: '历史内容形式'
  };
  const { response, writes } = await runPatch(legacyCandidate, {
    shipping_address: '新地址',
    content_format: '新内容形式',
    expected_publish_at: '2026-08-01',
    shipping_date: '2026-07-30',
    tracking_number: 'SF999'
  });

  assert.equal(response.statusCode, 409);
  assert.ok(response.payload.error.includes('仅可在 KOL 合作阶段维护'));
  assert.equal(writes.length, 0, 'candidate collaboration fields must not be written');
});

test('database migration creates confirmed-only views without rewriting historical rows', async () => {
  const statements = [];
  const migration = require('../migrations/20260729000002-enforce-collaboration-stage-fields');
  const queryInterface = {
    sequelize: { query: async (sql) => statements.push(String(sql)) }
  };

  await migration.up(queryInterface);

  assert.equal(statements.some((sql) => /^\s*(UPDATE|DELETE)\s/i.test(sql)), false);
  assert.ok(statements.some((sql) => sql.includes('CREATE VIEW confirmed_campaign_kol_collaboration')));
  assert.ok(statements.some((sql) => sql.includes('CREATE VIEW confirmed_campaign_kol_videos')));
  assert.ok(statements.some((sql) => sql.includes("pipeline_stage = 'confirmed'")));
});

test('PATCH normalizes legacy outreach values on write', async () => {
  const { response, writes } = await runPatch(candidateRow, { outreach_status: 'replied' });

  assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
  const update = writes.find((write) => write.sql.includes('UPDATE campaign_kols SET'));
  assert.ok(update.sql.includes('outreach_status = ?'));
  assert.ok(update.params.includes('negotiating'), 'legacy replied is written as negotiating');
});

test('PATCH applies project_status for confirmed rows and ignores outreach_status', async () => {
  const confirmedRow = {
    ...candidateRow,
    pipeline_stage: 'confirmed',
    project_status: 'pending_shipping',
    outreach_status: 'confirmed'
  };
  const { response, writes } = await runPatch(confirmedRow, { project_status: 'shipped', outreach_status: 'terminated' });

  assert.equal(response.statusCode, 200, JSON.stringify(response.payload));
  const update = writes.find((write) => write.sql.includes('UPDATE campaign_kols SET'));
  assert.ok(update.sql.includes('project_status = ?'), 'confirmed edit may update project_status');
  assert.ok(!update.sql.includes('outreach_status = ?'), 'confirmed edit must not overwrite outreach_status');
  assert.ok(update.params.includes('shipped'));
});

test('PATCH rejects contact_name_override so contacts stay owned by KOL management', async () => {
  const { response, writes } = await runPatch(candidateRow, { contact_name_override: 'Project Contact' });

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.error, 'No editable fields provided');
  assert.equal(writes.length, 0);
});

test('PATCH rejects invalid outreach_status values', async () => {
  const { response } = await runPatch(candidateRow, { outreach_status: 'best_friends' });

  assert.equal(response.statusCode, 400);
  assert.ok(response.payload.error.includes('Invalid outreach_status'));
});

test('published-video endpoints reject candidate-stage records', async () => {
  const originalGet = dbOperations.get;
  const originalQuery = dbOperations.query;
  const originalRun = dbOperations.run;
  dbOperations.get = async () => ({ ...candidateRow });
  dbOperations.query = async () => [];
  dbOperations.run = async () => ({ changes: 0 });
  try {
    const router = require('./campaignKols');
    const getResponse = await callHandler(
      findHandler(router, 'get', '/:id/published-videos'),
      { params: { id: String(candidateRow.id) } }
    );
    const putResponse = await callHandler(
      findHandler(router, 'put', '/:id/published-videos'),
      { params: { id: String(candidateRow.id) }, body: { urls: ['https://youtu.be/test'] } }
    );

    assert.equal(getResponse.statusCode, 409);
    assert.equal(putResponse.statusCode, 409);
    assert.ok(getResponse.payload.error.includes('KOL 合作阶段'));
    assert.ok(putResponse.payload.error.includes('KOL 合作阶段'));
  } finally {
    dbOperations.get = originalGet;
    dbOperations.query = originalQuery;
    dbOperations.run = originalRun;
  }
});

test('POST /:id/products/switch assigns a Product already attached to the Campaign and pauses the previous assignment', async () => {
  const originalGet = dbOperations.get;
  const originalRun = dbOperations.run;
  const writes = [];
  dbOperations.get = async (sql, params = []) => {
    const text = String(sql);
    if (text.includes('FROM campaign_kols WHERE id = ?')) {
      return { id: 7, campaign_id: 2, customer_id: 11 };
    }
    if (text.includes('FROM products WHERE id = ?')) {
      return { id: 42, sku: 'TMB-1404', name: '53-inch PTO Flail Mower', status: 'active' };
    }
    if (text.includes('FROM campaign_products WHERE campaign_id = ? AND product_id = ?')) {
      return { id: 9, status: 'active' };
    }
    if (text.includes('FROM campaign_kol_products WHERE campaign_kol_id = ? AND campaign_product_id = ?')) {
      return null;
    }
    if (text.includes('FROM campaign_kol_products ckp')) {
      return {
        id: 77,
        campaign_kol_id: 7,
        campaign_product_id: 9,
        fit_status: 'approved',
        assignment_status: 'active',
        product_sku: 'TMB-1404',
        product_name: '53-inch PTO Flail Mower'
      };
    }
    return null;
  };
  dbOperations.run = async (sql) => {
    writes.push({ sql: String(sql) });
    if (/INSERT INTO campaign_products\b/.test(sql)) return { id: 9 };
    if (/INSERT INTO campaign_kol_products\b/.test(sql)) return { id: 77 };
    return { changes: 1 };
  };
  try {
    const router = require('./campaignKols');
    const response = await callHandler(findHandler(router, 'post', '/:id/products/switch'), {
      params: { id: '7' },
      body: { product_id: 42 }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.data.product_sku, 'TMB-1404');
    assert.ok(!writes.some((item) => /INSERT INTO campaign_products\b/.test(item.sql)));
    assert.ok(writes.some((item) => /INSERT INTO campaign_kol_products\b/.test(item.sql)));
    assert.ok(writes.some((item) => item.sql.includes("assignment_status = 'paused'")));
    assert.ok(writes.some((item) => item.sql.includes("campaign_kols SET sync_status = 'sync_pending'")));
  } finally {
    dbOperations.get = originalGet;
    dbOperations.run = originalRun;
  }
});

test('PATCH /:id switches communication product when product_id is provided', async () => {
  const originalGet = dbOperations.get;
  const originalRun = dbOperations.run;
  const writes = [];
  dbOperations.get = async (sql, params = []) => {
    const text = String(sql);
    if (text.includes('FROM campaign_kols WHERE id = ?')) {
      return { id: 7, campaign_id: 2, customer_id: 11, pipeline_stage: 'candidate', outreach_status: 'not_contacted' };
    }
    if (text.includes('FROM products WHERE id = ?')) {
      return { id: 42, sku: 'TMB-1404', name: '53-inch PTO Flail Mower', status: 'active' };
    }
    if (text.includes('FROM campaign_products WHERE campaign_id = ? AND product_id = ?')) {
      return { id: 9, status: 'active' };
    }
    if (text.includes('FROM campaign_kol_products WHERE campaign_kol_id = ? AND campaign_product_id = ?')) {
      return null;
    }
    if (text.includes('FROM campaign_kol_products ckp')) {
      return {
        id: 77,
        campaign_kol_id: 7,
        campaign_product_id: 9,
        fit_status: 'approved',
        assignment_status: 'active',
        product_sku: 'TMB-1404',
        product_name: '53-inch PTO Flail Mower'
      };
    }
    return null;
  };
  dbOperations.run = async (sql) => {
    writes.push({ sql: String(sql) });
    if (/INSERT INTO campaign_products\b/.test(sql)) return { id: 9 };
    if (/INSERT INTO campaign_kol_products\b/.test(sql)) return { id: 77 };
    return { changes: 1 };
  };
  try {
    const router = require('./campaignKols');
    const response = await callHandler(findHandler(router, 'patch', '/:id'), {
      params: { id: '7' },
      body: { product_id: 42, project_notes: 'switch to flail mower' }
    });
    assert.equal(response.statusCode, 200);
    assert.ok(!writes.some((item) => /INSERT INTO campaign_products\b/.test(item.sql)));
    assert.ok(writes.some((item) => item.sql.includes("assignment_status = 'paused'")));
    assert.ok(writes.some((item) => item.sql.includes('project_notes = ?')));
  } finally {
    dbOperations.get = originalGet;
    dbOperations.run = originalRun;
  }
});

test('GET / filters by outreach_status with legacy alias expansion', async () => {
  const queries = [];
  const originalQuery = dbOperations.query;
  dbOperations.query = async (sql, params = []) => {
    queries.push({ sql: String(sql), params });
    return [];
  };
  try {
    const handler = findHandler(require('./campaignKols'), 'get', '/');

    await callHandler(handler, { query: { outreach_status: 'waiting_reply' } });
    assert.ok(queries[0].sql.includes('ck.outreach_status IN (?, ?)'), 'waiting_reply expands to legacy alias');
    assert.deepEqual(queries[0].params, ['waiting_reply', 'replied', 50, 0]);

    queries.length = 0;
    await callHandler(handler, { query: { outreach_status: 'contacted' } });
    assert.ok(queries[0].sql.includes('ck.outreach_status = ?'));
    assert.deepEqual(queries[0].params, ['contacted', 50, 0]);

    queries.length = 0;
    await callHandler(handler, { query: { outreach_status: 'bogus' } });
    assert.ok(!queries[0].sql.includes('AND ck.outreach_status'), 'invalid outreach_status is ignored');
  } finally {
    dbOperations.query = originalQuery;
  }
});

test('GET / uses bounded server pagination and a narrow list projection', async () => {
  const queries = [];
  const originalQuery = dbOperations.query;
  dbOperations.query = async (sql, params = []) => {
    queries.push({ sql: String(sql), params });
    if (String(sql).includes('COUNT(*) AS total')) return [{ total: 1220 }];
    return [{ ...candidateRow, kol_name: 'Alice' }];
  };
  try {
    const response = await callHandler(findHandler(require('./campaignKols'), 'get', '/'), {
      query: { campaign_id: '3', pipeline_stage: 'candidate', page: '2', page_size: '200' }
    });
    const listQuery = queries.find((item) => item.sql.includes('LIMIT ? OFFSET ?'));
    assert.ok(listQuery);
    assert.ok(!/SELECT\s+ck\.\*/i.test(listQuery.sql));
    assert.deepEqual(listQuery.params.slice(-2), [100, 100], 'page size is capped at 100');
    assert.deepEqual(response.payload.pagination, { page: 2, page_size: 100, total: 1220 });
  } finally {
    dbOperations.query = originalQuery;
  }
});

test('GET / hides cooperation-only values for candidates while preserving project notes', async () => {
  const originalQuery = dbOperations.query;
  dbOperations.query = async () => [{
    ...candidateRow,
    shipping_address: '历史地址',
    content_format: '历史内容形式',
    expected_publish_at: '2026-08-01',
    shipping_date: '2026-07-30',
    tracking_number: 'SF-LEGACY',
    published_video_count: 2,
    project_notes: '候选备注'
  }];
  try {
    const response = await callHandler(findHandler(require('./campaignKols'), 'get', '/'));
    const row = response.payload.data[0];
    assert.equal(response.statusCode, 200);
    for (const field of ['shipping_address', 'content_format', 'expected_publish_at', 'shipping_date', 'tracking_number']) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, field), false, `${field} should be hidden`);
    }
    assert.equal(row.published_video_count, 0);
    assert.equal(row.project_notes, '候选备注');
  } finally {
    dbOperations.query = originalQuery;
  }
});

// ---- POST /:id/record-manual-outreach ----

async function runRecordManualOutreach({ id = 42, body = {}, rowOverrides = {}, getOverrides = {}, notFound = false } = {}) {
  const writes = [];
  const queries = [];
  const originalGet = dbOperations.get;
  const originalRun = dbOperations.run;
  const originalQuery = dbOperations.query;
  const updates = {};
  const baseRow = notFound ? null : {
    id,
    campaign_id: 3,
    customer_id: 11,
    follow_up_count: 0,
    outreach_status: 'waiting_reply',
    pipeline_stage: 'candidate',
    ...rowOverrides
  };

  // getOverrides: { substrings: [str,str,...] → fn}
  const overrideEntries = Object.entries(getOverrides).map(([key, fn]) => {
    const tokens = key.split('|').map((s) => s.trim()).filter(Boolean);
    return { tokens, fn };
  });

  dbOperations.get = async (sql, params = []) => {
    const text = String(sql);
    for (const { tokens, fn } of overrideEntries) {
      if (tokens.every((t) => text.includes(t))) return fn(params);
    }
    if (text.includes('FROM campaign_kols WHERE id = ?')) {
      if (!baseRow) return null;
      return updates.id === params[0] ? { ...baseRow, ...updates } : { ...baseRow };
    }
    if (text.includes('FROM customers WHERE id = ?')) {
      return { id: 11, name: 'Creator', email: 'creator@example.com' };
    }
    return null;
  };
  dbOperations.run = async (sql, params = []) => {
    const text = String(sql);
    writes.push({ sql: text, params });
    if (text.includes('UPDATE campaign_kols') && text.includes('follow_up_count')) {
      updates.follow_up_count = (baseRow.follow_up_count || 0) + 1;
      updates.last_outreach_at = 'NOW()';
      updates.outreach_status = 'waiting_reply';
    }
    return { changes: 1 };
  };
  dbOperations.query = async (sql, params = []) => {
    queries.push({ sql: String(sql), params });
    return [];
  };

  try {
    const handler = findHandler(require('./campaignKols'), 'post', '/:id/record-manual-outreach');
    const response = await callHandler(handler, { params: { id: String(id) }, body });
    return { response, writes, queries };
  } finally {
    dbOperations.get = originalGet;
    dbOperations.run = originalRun;
    dbOperations.query = originalQuery;
  }
}

test('record-manual-outreach bumps follow_up_count and writes a manual outreach record', async () => {
  const { response, writes } = await runRecordManualOutreach({
    body: { subject: 'Re: Hi', body_text: 'Just checking in', note: '邮件已发' }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.success, true);

  const update = writes.find((w) => w.sql.includes('UPDATE campaign_kols') && w.sql.includes('follow_up_count'));
  assert.ok(update, 'expected follow_up_count increment UPDATE');
  assert.deepEqual(update.params, [42]);

  const insert = writes.find((w) => w.sql.includes('INSERT INTO email_records'));
  assert.ok(insert, 'expected email_records audit insert');
  // Params: [campaign_id, customer_id, kol_name, to_address, subject, body_text, error_note]
  assert.equal(insert.params[0], 3, 'campaign_id');
  assert.equal(insert.params[1], 11, 'customer_id');
  assert.equal(insert.params[2], 'Creator', 'kol_name');
  assert.equal(insert.params[3], 'creator@example.com', 'to_address');
  assert.equal(insert.params[4], 'Re: Hi', 'subject');
  assert.equal(insert.params[5], 'Just checking in', 'body_text');
  assert.equal(insert.params[6], '邮件已发', 'note');
});

test('record-manual-outreach skips email_records audit when no subject/body/note supplied', async () => {
  const { response, writes } = await runRecordManualOutreach({ body: {} });
  assert.equal(response.statusCode, 200);
  const insert = writes.find((w) => w.sql.includes('INSERT INTO email_records'));
  assert.equal(insert, undefined, 'should not write email_records without audit fields');
  const update = writes.find((w) => w.sql.includes('UPDATE campaign_kols') && w.sql.includes('follow_up_count'));
  assert.ok(update, 'still must increment follow_up_count');
});

test('record-manual-outreach rejects a non-existent candidate', async () => {
  const { response, writes } = await runRecordManualOutreach({ id: 9999, notFound: true });
  assert.equal(response.statusCode, 404);
  assert.equal(response.payload.success, false);
  assert.equal(writes.length, 0);
});

test('record-manual-outreach rejects a candidate already in confirmed reply state', async () => {
  const { response } = await runRecordManualOutreach({
    getOverrides: {
      'FROM email_replies | confirm_status = \'confirmed\' | LIMIT 1': () => ({ id: 1 })
    }
  });
  assert.equal(response.statusCode, 409);
  assert.ok(response.payload.error.includes('已有确认回复'));
});

test('record-manual-outreach rejects when the kol already has a hard bounce', async () => {
  const { response } = await runRecordManualOutreach({
    getOverrides: {
      'FROM email_bounces | bounce_type = \'hard\' | LIMIT 1': () => ({ id: 1 })
    }
  });
  assert.equal(response.statusCode, 409);
  assert.ok(response.payload.error.includes('硬退信'));
});

test('record-manual-outreach rejects when follow_up_count already at cap', async () => {
  const { response } = await runRecordManualOutreach({ rowOverrides: { follow_up_count: 2 } });
  assert.equal(response.statusCode, 409);
  assert.ok(response.payload.error.includes('上限'));
});

test('record-manual-outreach rejects a non-numeric id', async () => {
  const handler = findHandler(require('./campaignKols'), 'post', '/:id/record-manual-outreach');
  const response = await callHandler(handler, { params: { id: 'abc' } });
  assert.equal(response.statusCode, 400);
});
