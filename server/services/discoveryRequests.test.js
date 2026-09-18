const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiscoveryService } = require('./discoveryRequests');

function fixture() {
  const rows = [];
  let taskCount = 0;
  let serial = Promise.resolve();
  const transaction = (fn) => {
    const result = serial.then(() => fn({ LOCK: { UPDATE: 'UPDATE' } }));
    serial = result.catch(() => {});
    return result;
  };
  const match = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
  const model = {
    findOne: async ({ where }) => rows.find((r) => match(r, where)) || null,
    findAll: async ({ where }) => rows.filter((r) => match(r, where)),
    create: async (data) => {
      if (rows.some((r) => r.owner_user_id === data.owner_user_id && r.request_key === data.request_key)) throw Object.assign(new Error('duplicate'), { name: 'SequelizeUniqueConstraintError' });
      const row = { ...data, id: rows.length + 1, save: async () => {},
        toJSON() { const { save, toJSON, ...result } = this; return result; } };
      rows.push(row);
      return row;
    }
  };
  const service = createDiscoveryService({ model, sequelize: { transaction },
    query: async (sql, params) => sql.includes('FROM discovery_requests') ? rows.filter((r) => r.owner_user_id === params[0]).map((r) => r.toJSON())
      : sql.includes('COUNT(*)') ? [{ candidate_count: 3 }]
      : params[0] === 1 ? [{ id: 1, campaign_id: 2, campaign_product_id: 3, campaign_name: 'Campaign', product_name: 'Product' }] : [],
    createFinderTask: async (options) => {
      assert.equal(options.autoStart, false);
      assert.ok(options.transaction);
      return { id: ++taskCount };
    }
  });
  const body = { request_key: 'request-0001', strategy_id: 1, target_platform: 'tiktok', target_count: 10, requirements: 'US home creators' };
  return { service, rows, body, taskCount: () => taskCount };
}

test('saving a request makes no Finder task; retries are idempotent and mismatched retries conflict', async () => {
  const f = fixture();
  const first = await f.service.create(1, f.body);
  const second = await f.service.create(1, f.body);
  assert.equal(first.id, second.id);
  assert.equal(f.taskCount(), 0);
  assert.equal(first.status, 'queued');
  await assert.rejects(f.service.create(1, { ...f.body, requirements: 'different' }), { statusCode: 409 });
});
test('concurrent identical submissions create one request', async () => {
  const f = fixture();
  const result = await Promise.all([f.service.create(1, f.body), f.service.create(1, f.body)]);
  assert.equal(result[0].id, result[1].id);
  assert.equal(f.rows.length, 1);
});
test('ownership isolates list, detail, claim, progress and user controls', async () => {
  const f = fixture();
  await f.service.create(1, f.body);
  assert.deepEqual(await f.service.list(2), []);
  for (const call of [() => f.service.get(2, 1), () => f.service.claim(2, 1, { execution_id: 'runner-0001' }),
    () => f.service.control(2, 1, 'cancel'), () => f.service.progress(2, 1, { execution_id: 'runner-0001', stage: 'searching' })]) {
    await assert.rejects(call(), { statusCode: 404 });
  }
});
test('serialized claims give only one execution the task; its retries reuse the task', async () => {
  const f = fixture();
  await f.service.create(1, f.body);
  const outcomes = await Promise.allSettled(['runner-0001', 'runner-0002'].map((execution_id) => f.service.claim(1, 1, { execution_id })));
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((r) => r.status === 'rejected').reason.statusCode, 409);
  await f.service.claim(1, 1, { execution_id: 'runner-0001' });
  assert.equal(f.taskCount(), 1);
  assert.equal((await f.service.get(1, 1)).execution_id, undefined);
});
test('stopping denies new writes and stale progress; requeue retains existing work', async () => {
  const f = fixture();
  await f.service.create(1, f.body);
  await f.service.claim(1, 1, { execution_id: 'runner-0001' });
  await f.service.control(1, 1, 'cancel');
  await assert.rejects(f.service.active(1, 1, 'runner-0001'), { statusCode: 409 });
  await assert.rejects(f.service.progress(1, 1, { execution_id: 'runner-0001', stage: 'writing' }), { statusCode: 409 });
  await f.service.control(1, 1, 'retry');
  await f.service.claim(1, 1, { execution_id: 'runner-0002' });
  await assert.rejects(f.service.active(1, 1, 'runner-0001'), { statusCode: 409 });
  assert.equal(f.taskCount(), 1);
});
test('completion retries are safe and result count comes from stored Raw candidates', async () => {
  const f = fixture();
  await f.service.create(1, f.body);
  await f.service.claim(1, 1, { execution_id: 'runner-0001' });
  const body = { execution_id: 'runner-0001', status: 'completed', stage: 'done', note: 'Only 3 qualified creators found', candidate_count: 99 };
  assert.equal((await f.service.progress(1, 1, body)).candidate_count, 3);
  assert.equal((await f.service.progress(1, 1, body)).status, 'completed');
  await assert.rejects(f.service.progress(1, 1, { ...body, note: 'overwrite' }), { statusCode: 409 });
});
test('invalid scope, oversized input and unsupported platform are rejected before work', async () => {
  const f = fixture();
  for (const change of [{ strategy_id: 2 }, { target_platform: 'all' }, { target_count: 51 }, { target_count: NaN }, { requirements: ' ' }, { requirements: 'a'.repeat(5001) }]) {
    await assert.rejects(f.service.create(1, { ...f.body, ...change }));
  }
  assert.equal(f.rows.length, 0);
  assert.equal(f.taskCount(), 0);
});
