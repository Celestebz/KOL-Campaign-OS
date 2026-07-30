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

// 按 SQL 分发到可覆盖的场景数据，模拟 detail 聚合的全部查询
function makeDetailDb(overrides = {}) {
  const state = {
    campaign: { id: 5, name: '龙虾路演', brand: 'Lobster', product: '小龙虾' },
    products: [],
    strategy: null,
    kolAgg: { kols_total: 0, contacted: 0, replied: 0, candidates: 0 },
    contactedTotal: 0,
    repliedKols: 0,
    statusRows: [],
    draftsPending: 0,
    highRiskDrafts: 0,
    repliesPending: 0,
    finderRunning: 0,
    finderFailed: 0,
    runsFailed: 0,
    ...overrides
  };
  return {
    get: async (sql) => {
      if (/FROM campaigns WHERE id/.test(sql)) return state.campaign;
      if (/FROM kol_strategies/.test(sql)) return state.strategy;
      if (/COUNT\(DISTINCT touched\.customer_id\)/.test(sql)) return { count: state.contactedTotal };
      if (/COUNT\(DISTINCT customer_id\)/.test(sql) && /FROM email_replies/.test(sql)) return { count: state.repliedKols };
      if (/FROM campaign_kols/.test(sql)) return state.kolAgg;
      if (/automation_runs/.test(sql)) {
        return { finder_failed: state.finderFailed, runs_failed: state.runsFailed };
      }
      if (/risk_level = 'high'/.test(sql)) return { count: state.highRiskDrafts };
      if (/FROM email_drafts/.test(sql)) return { count: state.draftsPending };
      if (/FROM email_replies/.test(sql)) return { count: state.repliesPending };
      if (/FROM finder_tasks/.test(sql) && /status = 'running'/.test(sql)) {
        return { count: state.finderRunning };
      }
      throw new Error(`unexpected get: ${sql}`);
    },
    query: async (sql) => {
      if (/FROM campaign_products/.test(sql)) return state.products;
      if (/GROUP BY project_status/.test(sql)) return state.statusRows;
      throw new Error(`unexpected query: ${sql}`);
    }
  };
}

async function callDetail(db, id = '5') {
  const handler = findHandler(require('./campaigns'), 'get', '/:id/detail');
  return withPatchedDb(db, () => callHandler(handler, { params: { id } }));
}

test('GET /:id/detail 项目不存在返回 404', async () => {
  const response = await callDetail(makeDetailDb({ campaign: null }));
  assert.equal(response.statusCode, 404);
  assert.equal(response.payload.success, false);
  assert.match(response.payload.error, /not found/);
});

test('GET /:id/detail 非法 id 返回 400', async () => {
  const response = await callDetail(makeDetailDb(), 'abc');
  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.success, false);
});

test('GET /:id/detail 空项目（无产品无策略无 KOL）不报错且全零', async () => {
  const response = await callDetail(makeDetailDb());
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.success, true);
  const { data } = response.payload;
  assert.equal(data.campaign.id, 5);
  assert.deepEqual(data.products, []);
  assert.equal(data.strategy, null);
  assert.deepEqual(data.summary, {
    kols_total: 0,
    kols_candidate: 0,
    kols_confirmed: 0,
    candidates_pending_review: 0,
    by_project_status: {
      pending_confirmation: 0, pending_shipping: 0, shipped: 0, delivered: 0,
      content_preparation: 0, pending_publish: 0, published: 0, cancelled: 0
    },
    contacted: 0,
    replied: 0,
    drafts_pending: 0,
    replies_pending: 0,
    finder_tasks_running: 0,
    exceptions: 0
  });
  assert.deepEqual(data.risks, []);
  assert.match(data.next_step, /尚无达人策略/);
});

test('GET /:id/detail summary 各计数口径正确', async () => {
  const response = await callDetail(makeDetailDb({
    products: [{
      id: 9, campaign_id: 5, product_id: 3, role: 'hero', priority: 10,
      campaign_brief: '主推', status: 'active',
      product_brand: 'Lobster', product_name: '麻辣小龙虾', product_sku: 'SKU-1',
      product_category: '食品', product_url: 'https://x.com/p',
      product_price: '88.00', product_currency: 'USD',
      product_description: 'desc', product_selling_points: '辣', product_status: 'active'
    }],
    strategy: { id: 1, status: 'ready', target_market: 'US', campaign_goal: 'g', product_context: 'c' },
    kolAgg: { kols_total: 25, candidates: 0, kols_candidate: 20, kols_confirmed: 5 },
    contactedTotal: 3,
    repliedKols: 1,
    statusRows: [
      { project_status: 'pending_confirmation', count: 24 },
      { project_status: 'published', count: 1 }
    ],
    draftsPending: 2,
    repliesPending: 1,
    finderRunning: 0,
    finderFailed: 1,
    runsFailed: 0
  }));
  const { data } = response.payload;
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].product.name, '麻辣小龙虾');
  assert.equal(data.products[0].product.sku, 'SKU-1');
  assert.equal(data.products[0].product.price, '88.00');
  assert.equal(data.products[0].product.currency, 'USD');
  assert.equal(data.strategy.status, 'ready');
  assert.equal(data.summary.kols_total, 25);
  assert.equal(data.summary.kols_candidate, 20);
  assert.equal(data.summary.kols_confirmed, 5);
  assert.equal(data.summary.candidates_pending_review, 0);
  assert.equal(data.summary.by_project_status.pending_confirmation, 24);
  assert.equal(data.summary.by_project_status.published, 1);
  assert.equal(data.summary.by_project_status.shipped, 0);
  assert.equal(data.summary.contacted, 3);
  assert.equal(data.summary.replied, 1);
  assert.equal(data.summary.drafts_pending, 2);
  assert.equal(data.summary.replies_pending, 1);
  assert.equal(data.summary.finder_tasks_running, 0);
  assert.equal(data.summary.exceptions, 1);
});

test('GET /:id/detail 已联系和已回复使用累计达人去重事实口径', async () => {
  const captured = [];
  const db = makeDetailDb({
    strategy: { id: 1, status: 'ready' },
    kolAgg: { kols_total: 237, candidates: 0, kols_candidate: 237, kols_confirmed: 0 },
    contactedTotal: 188,
    repliedKols: 11,
    repliesPending: 14
  });
  const originalGet = db.get;
  db.get = async (sql) => { captured.push(String(sql)); return originalGet(sql); };
  const response = await callDetail(db);
  const { summary } = response.payload.data;
  assert.equal(summary.contacted, 188);
  assert.equal(summary.replied, 11, '同一达人多封回复只按一位累计');
  assert.equal(summary.replies_pending, 14, '待确认继续按邮件条数统计');
  assert.ok(captured.some((sql) => /COUNT\(DISTINCT customer_id\)/.test(sql) && /classification/.test(sql)));
  assert.ok(captured.some((sql) => /email_records/.test(sql) && /status = 'success'/.test(sql)));
});

test('GET /:id/detail exceptions = finder 失败 + automation_runs 失败', async () => {
  const response = await callDetail(makeDetailDb({
    strategy: { id: 1, status: 'ready' },
    kolAgg: { kols_total: 2, contacted: 0, replied: 0, candidates: 0 },
    finderFailed: 1,
    runsFailed: 2
  }));
  assert.equal(response.payload.data.summary.exceptions, 3);
  assert.ok(response.payload.data.risks.some((r) => /达人寻找任务执行失败/.test(r)));
  assert.ok(response.payload.data.risks.some((r) => /自动化任务执行失败/.test(r)));
});

test('GET /:id/detail risks 覆盖高风险草稿与 candidate 积压', async () => {
  const response = await callDetail(makeDetailDb({
    strategy: { id: 1, status: 'ready' },
    kolAgg: { kols_total: 3, contacted: 0, replied: 0, candidates: 2 },
    highRiskDrafts: 1,
    draftsPending: 1
  }));
  const { risks } = response.payload.data;
  assert.ok(risks.some((r) => /高风险邮件草稿/.test(r)));
  // drafts_pending > 0 时不报 candidate 积压（有别的待处理事项）
  assert.ok(!risks.some((r) => /积压/.test(r)));

  const backlog = await callDetail(makeDetailDb({
    strategy: { id: 1, status: 'ready' },
    kolAgg: { kols_total: 3, contacted: 0, replied: 0, candidates: 2 }
  }));
  assert.ok(backlog.payload.data.risks.some((r) => /候选达人积压/.test(r)));
});

test('GET /:id/detail next_step 推导分支', async () => {
  const base = { strategy: { id: 1, status: 'ready' } };

  // 有待批准策略 → 去批准策略
  let response = await callDetail(makeDetailDb({
    strategy: { id: 1, status: 'draft' },
    kolAgg: { kols_total: 5, contacted: 0, replied: 0, candidates: 3 },
    draftsPending: 1
  }));
  assert.match(response.payload.data.next_step, /工作台处理/);

  // 有 candidate → 去审核达人（优先于草稿/回复）
  response = await callDetail(makeDetailDb({
    ...base,
    kolAgg: { kols_total: 5, contacted: 0, replied: 0, candidates: 3 },
    draftsPending: 1,
    repliesPending: 1
  }));
  assert.match(response.payload.data.next_step, /工作台处理/);

  // 无 candidate 有待审草稿 → 去审批台
  response = await callDetail(makeDetailDb({
    ...base,
    kolAgg: { kols_total: 5, contacted: 0, replied: 0, candidates: 0 },
    draftsPending: 2,
    repliesPending: 1
  }));
  assert.match(response.payload.data.next_step, /工作台处理/);

  // 只剩回复 → 去确认
  response = await callDetail(makeDetailDb({
    ...base,
    kolAgg: { kols_total: 5, contacted: 0, replied: 0, candidates: 0 },
    repliesPending: 1
  }));
  assert.match(response.payload.data.next_step, /工作台处理/);

  // 都没有且无达人 → 提示先找达人
  response = await callDetail(makeDetailDb({ ...base }));
  assert.match(response.payload.data.next_step, /开始寻找达人/);

  // 都没有但有达人 → 持续跟进
  response = await callDetail(makeDetailDb({
    ...base,
    kolAgg: { kols_total: 4, contacted: 1, replied: 0, candidates: 0 }
  }));
  assert.match(response.payload.data.next_step, /持续跟进/);

  // finder 运行中 → 提示稍后查看新候选
  response = await callDetail(makeDetailDb({
    ...base,
    kolAgg: { kols_total: 4, contacted: 1, replied: 0, candidates: 0 },
    finderRunning: 1
  }));
  assert.match(response.payload.data.next_step, /达人寻找任务运行中/);
});

test('GET / 默认只返回进行中的当前项目，历史项目需显式 scope 查询', async () => {
  const handler = findHandler(require('./campaigns'), 'get', '/');
  const captured = [];
  const db = {
    query: async (sql) => { captured.push(String(sql)); return []; }
  };

  await withPatchedDb(db, async () => {
    let response = await callHandler(handler, { query: {} });
    assert.equal(response.statusCode, 200);
    assert.match(captured[0], /c\.campaign_type = 'active_project' AND c\.status = 'active'/);

    response = await callHandler(handler, { query: { scope: 'historical' } });
    assert.equal(response.statusCode, 200);
    assert.match(captured[1], /c\.campaign_type = 'historical_archive'/);
    assert.doesNotMatch(captured[1], /active_project/);

    response = await callHandler(handler, { query: { scope: 'all' } });
    assert.equal(response.statusCode, 200);
    assert.doesNotMatch(captured[2], /campaign_type =/);

    response = await callHandler(handler, { query: { scope: 'bogus' } });
    assert.equal(response.statusCode, 200);
    assert.match(captured[3], /active_project/, 'unknown scope falls back to active projects');
  });
});
