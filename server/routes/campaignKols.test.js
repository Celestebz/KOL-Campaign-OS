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

function callHandler(handler, { body = {}, params = {} } = {}) {
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
    Promise.resolve(handler({ body, params }, response, reject)).catch(reject);
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
  assert.ok(update.sql.includes('confirmed_at = CURRENT_TIMESTAMP'));
  assert.ok(update.sql.includes("sync_status = 'sync_pending'"));
  assert.deepEqual(update.params, [42]);

  assert.equal(finalRow.pipeline_stage, 'confirmed');
  assert.equal(finalRow.project_status, 'pending_shipping');
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
