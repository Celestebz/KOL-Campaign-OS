const assert = require('node:assert/strict');
const test = require('node:test');
const approvalItemService = require('../services/approvalItemService');

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

function withPatchedService(patch, fn) {
  const originals = {};
  for (const key of Object.keys(patch)) {
    originals[key] = approvalItemService[key];
    approvalItemService[key] = patch[key];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of Object.keys(originals)) approvalItemService[key] = originals[key];
  });
}

const sampleItem = {
  id: 'outreach:4', approval_item_id: 41, type: 'outreach', subject_type: 'email_draft',
  subject_id: 4, campaign_id: 10, campaign_name: '春季推广', title: 'Carol · 触达邮件待审批',
  status: 'pending', risk_level: 'high', version: 2, facts: [], opinion: '', risks: [],
  actions: [], decision: null, decision_note: null, decided_by: null, decided_at: null,
  dedupe_key: 'outreach:email_draft:4', created_at: null, updated_at: null
};

test('GET / 返回 items + summary，并把 status/type 过滤传给 service', async () => {
  const seen = [];
  await withPatchedService({
    listApprovalItems: async (filters) => { seen.push(filters); return [sampleItem]; },
    getSummary: async () => ({ pending: 1, high_risk: 1, exceptions: 0, handled_today: 0 })
  }, async () => {
    const handler = findHandler(require('./approvals'), 'get', '/');
    const response = await callHandler(handler, { query: { status: 'pending', type: 'outreach' } });
    assert.equal(response.payload.success, true);
    assert.deepEqual(seen, [{ status: 'pending', type: 'outreach' }]);
    assert.equal(response.payload.data.items.length, 1);
    assert.equal(response.payload.data.items[0].approval_item_id, 41);
    assert.deepEqual(response.payload.data.summary, { pending: 1, high_risk: 1, exceptions: 0, handled_today: 0 });
  });
});

test('GET / 无效过滤值透传 service 的 400', async () => {
  await withPatchedService({
    listApprovalItems: async () => {
      const error = new Error('无效的 status：bogus');
      error.statusCode = 400;
      throw error;
    },
    getSummary: async () => ({ pending: 0, high_risk: 0, exceptions: 0, handled_today: 0 })
  }, async () => {
    const handler = findHandler(require('./approvals'), 'get', '/');
    const response = await callHandler(handler, { query: { status: 'bogus' } });
    assert.equal(response.statusCode, 400);
    assert.match(response.payload.error, /无效的 status/);
  });
});

test('GET /:id 命中返回详情，未命中返回 404', async () => {
  await withPatchedService({
    getApprovalItem: async (id) => (Number(id) === 41 ? sampleItem : null)
  }, async () => {
    const handler = findHandler(require('./approvals'), 'get', '/:id');
    const ok = await callHandler(handler, { params: { id: 41 } });
    assert.equal(ok.payload.success, true);
    assert.equal(ok.payload.data.dedupe_key, 'outreach:email_draft:4');
    const missing = await callHandler(handler, { params: { id: 999 } });
    assert.equal(missing.statusCode, 404);
    assert.match(missing.payload.error, /审核事项不存在/);
  });
});

test('POST /:id/decision 成功返回更新后的事项', async () => {
  const seen = [];
  await withPatchedService({
    submitDecision: async (id, payload) => {
      seen.push({ id, payload });
      return { ...sampleItem, status: 'approved', decision: 'approve' };
    }
  }, async () => {
    const handler = findHandler(require('./approvals'), 'post', '/:id/decision');
    const response = await callHandler(handler, {
      params: { id: 41 },
      body: { decision: 'approve', note: '可以发', version: 2, decided_by: 'boss' }
    });
    assert.equal(response.payload.success, true);
    assert.equal(response.payload.data.status, 'approved');
    assert.deepEqual(seen, [{ id: 41, payload: { decision: 'approve', note: '可以发', version: 2, decided_by: 'boss' } }]);
  });
});

test('POST /:id/decision version 冲突返回 409 与 current_version', async () => {
  await withPatchedService({
    submitDecision: async () => {
      const error = new Error('该事项已更新，请查看最新版本后重新决定');
      error.statusCode = 409;
      error.currentVersion = 5;
      throw error;
    }
  }, async () => {
    const handler = findHandler(require('./approvals'), 'post', '/:id/decision');
    const response = await callHandler(handler, {
      params: { id: 41 },
      body: { decision: 'approve', version: 2 }
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error, '该事项已更新，请查看最新版本后重新决定');
    assert.equal(response.payload.current_version, 5);
  });
});

test('POST /:id/decision 不支持的决定类型返回 400', async () => {
  await withPatchedService({
    submitDecision: async () => {
      const error = new Error('不支持的决定类型：explode');
      error.statusCode = 400;
      throw error;
    }
  }, async () => {
    const handler = findHandler(require('./approvals'), 'post', '/:id/decision');
    const response = await callHandler(handler, {
      params: { id: 41 },
      body: { decision: 'explode', version: 1 }
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.payload.error, /不支持的决定类型/);
  });
});
