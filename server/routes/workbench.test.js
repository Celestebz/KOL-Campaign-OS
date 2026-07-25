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

// 阶段 C：workbench 改为先 sync 再读 approval_items，测试改为 monkey-patch approvalItemService
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
  id: 'outreach:4',
  approval_item_id: 41,
  type: 'outreach',
  subject_type: 'email_draft',
  subject_id: 4,
  campaign_id: 10,
  campaign_name: '春季推广',
  title: 'Carol · 触达邮件待审批',
  status: 'pending',
  risk_level: 'high',
  version: 2,
  facts: ['粉丝数：5.6万'],
  opinion: '主题：合作邀请',
  risks: ['达人邮箱缺失'],
  actions: [{ key: 'open', label: '去处理', href: '/emails' }],
  decision: null,
  decision_note: null,
  decided_by: null,
  decided_at: null,
  dedupe_key: 'outreach:email_draft:4',
  created_at: '2026-07-25T05:00:00.000Z',
  updated_at: '2026-07-25T05:00:00.000Z'
};

test('GET / 先 sync 再从 approval_items 组装，契约不变且 items 带 approval_item_id/version', async () => {
  const calls = [];
  await withPatchedService({
    syncApprovalItems: async () => { calls.push('sync'); return { scanned: 1, inserted: 1, updated: 0, cancelled: 0 }; },
    listPendingWorkbenchItems: async () => { calls.push('items'); return [sampleItem]; },
    getSummary: async () => { calls.push('summary'); return { pending: 1, high_risk: 1, exceptions: 0, handled_today: 0 }; },
    listRecentDecisions: async () => { calls.push('recent'); return [{ title: 'X', decision: '已通过', decided_at: '2026-07-25T02:00:00.000Z', href: '/emails' }]; }
  }, async () => {
    const handler = findHandler(require('./workbench'), 'get', '/');
    const response = await callHandler(handler);
    assert.equal(calls[0], 'sync', '必须先调用 syncApprovalItems');
    assert.deepEqual(response.payload.summary, { pending: 1, high_risk: 1, exceptions: 0, handled_today: 0 });
    assert.equal(response.payload.items.length, 1);
    const item = response.payload.items[0];
    // 阶段 B 契约字段保持
    assert.equal(item.id, 'outreach:4');
    assert.equal(item.type, 'outreach');
    assert.equal(item.risk_level, 'high');
    assert.deepEqual(item.actions, [{ key: 'open', label: '去处理', href: '/emails' }]);
    // 阶段 C 新增字段
    assert.equal(item.approval_item_id, 41);
    assert.equal(item.version, 2);
    assert.equal(response.payload.recent_decisions.length, 1);
    assert.equal(response.payload.recent_decisions[0].decision, '已通过');
  });
});

test('GET / 空数据返回全零 summary 且不报错', async () => {
  await withPatchedService({
    syncApprovalItems: async () => ({ scanned: 0, inserted: 0, updated: 0, cancelled: 0 }),
    listPendingWorkbenchItems: async () => [],
    getSummary: async () => ({ pending: 0, high_risk: 0, exceptions: 0, handled_today: 0 }),
    listRecentDecisions: async () => []
  }, async () => {
    const handler = findHandler(require('./workbench'), 'get', '/');
    const response = await callHandler(handler);
    assert.deepEqual(response.payload.summary, { pending: 0, high_risk: 0, exceptions: 0, handled_today: 0 });
    assert.deepEqual(response.payload.items, []);
    assert.deepEqual(response.payload.recent_decisions, []);
  });
});

test('GET / sync 失败返回 500', async () => {
  await withPatchedService({
    syncApprovalItems: async () => { throw new Error('db down'); }
  }, async () => {
    const handler = findHandler(require('./workbench'), 'get', '/');
    const response = await callHandler(handler);
    assert.equal(response.statusCode, 500);
    assert.match(response.payload.error, /db down/);
  });
});
