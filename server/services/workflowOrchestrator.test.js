const assert = require('node:assert/strict');
const test = require('node:test');
const { dbOperations } = require('../database');
const emailDrafter = require('./emailDrafter');
const finderTasks = require('../routes/finderTasks');
const workflowOrchestrator = require('./workflowOrchestrator');
const approvalItemService = require('./approvalItemService');

// 通用 monkey-patch：把 patch 的键临时写到目标模块对象上，结束后还原（同 approvalItemService.test.js 惯例）
function withPatched(target, patch, fn) {
  const originals = {};
  for (const key of Object.keys(patch)) {
    originals[key] = target[key];
    target[key] = patch[key];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of Object.keys(originals)) target[key] = originals[key];
  });
}

function silenceConsoleError(fn) {
  const original = console.error;
  console.error = () => {};
  return Promise.resolve().then(fn).finally(() => { console.error = original; });
}

// ---- 内存版最小仓库：approval_items + 各业务源表行 ----
function createFakeDb({ items = [], strategies = {}, campaignKols = {}, replies = {}, finderTaskRows = {} } = {}) {
  const store = new Map(items.map((item) => [item.id, { ...item }]));
  const statements = [];

  const get = async (sql, params = []) => {
    if (/SELECT actions_json FROM approval_items WHERE id = \?/.test(sql)) return store.get(Number(params[0])) || null;
    if (/FROM approval_items WHERE id = \?/.test(sql)) return store.get(Number(params[0])) || null;
    if (/FROM kol_strategies WHERE id = \?/.test(sql)) return strategies[Number(params[0])] || null;
    if (/FROM campaign_kols WHERE id = \?/.test(sql)) return campaignKols[Number(params[0])] || null;
    if (/FROM email_replies WHERE id = \?/.test(sql)) return replies[Number(params[0])] || null;
    if (/FROM finder_tasks WHERE id = \?/.test(sql)) return finderTaskRows[Number(params[0])] || null;
    throw new Error(`Unexpected get: ${sql}`);
  };

  const run = async (sql, params = []) => {
    statements.push({ sql, params });
    if (/UPDATE approval_items SET actions_json = \?/.test(sql)) {
      const row = store.get(Number(params[1]));
      if (row) row.actions_json = params[0];
      return { id: 0, changes: 1 };
    }
    if (/UPDATE approval_items/.test(sql) && /SET status = \?, decision = \?/.test(sql)) {
      const [status, decision, decisionNote, decidedBy, id] = params;
      const row = store.get(Number(id));
      Object.assign(row, {
        status, decision, decision_note: decisionNote, decided_by: decidedBy, decided_at: new Date()
      });
      return { id: 0, changes: 1 };
    }
    // 业务副作用 SQL（campaign_kols / customers 等）只记录不模拟
    return { id: 0, changes: 1 };
  };

  return { get, run, store, statements };
}

function seededItem(overrides = {}) {
  return {
    id: 90, campaign_id: 10, type: 'strategy', subject_type: 'kol_strategy', subject_id: 1,
    status: 'pending', priority: 'none',
    facts_json: JSON.stringify({ title: 'TRA 策略待审批', campaign_name: '春季推广', facts: [] }),
    opinion_json: JSON.stringify(''), risks_json: JSON.stringify([]), actions_json: JSON.stringify([]),
    version: 1, decision: null, decision_note: null, decided_by: null, decided_at: null,
    dedupe_key: 'strategy:kol_strategy:1', created_at: new Date(), updated_at: new Date(),
    ...overrides
  };
}

// submitDecision 传入的 item 形态（toApiItem 输出）：
function apiItem(row) {
  return {
    id: `${row.type}:${row.subject_id}`,
    approval_item_id: row.id,
    type: row.type,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    campaign_id: row.campaign_id
  };
}

function appendedEntries(fake, id) {
  return JSON.parse(fake.store.get(id).actions_json || '[]');
}

test('strategy approve → 复用 createFinderTask 自动创建搜索任务并记录 auto_followup', async () => {
  const fake = createFakeDb({
    items: [seededItem()],
    strategies: { 1: { id: 1, primary_platform: 'youtube', secondary_platforms: null, finder_handoff: null } }
  });
  const calls = [];
  await withPatched(dbOperations, fake, () =>
    withPatched(finderTasks, {
      createFinderTask: async (args) => { calls.push(args); return { id: 77 }; }
    }, async () => {
      const entry = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision: 'approve' });
      assert.equal(entry.ok, true);
      assert.equal(entry.action, 'create_finder_task');
      assert.equal(entry.finder_task_id, 77);
      assert.deepEqual(calls, [{
        strategyId: 1, targetPlatform: 'youtube', notes: '工作台批准后自动创建'
      }]);
      const actions = appendedEntries(fake, 90);
      assert.equal(actions.length, 1);
      assert.equal(actions[0].key, 'auto_followup');
      assert.equal(actions[0].ok, true);
      assert.match(actions[0].summary, /#77/);
    }));
});

test('strategy approve 平台选择回退：primary 缺失时取 handoff.required_platforms，再回退 youtube', async () => {
  const fake = createFakeDb({
    items: [seededItem()],
    strategies: {
      1: {
        id: 1, primary_platform: '', secondary_platforms: JSON.stringify(['podcast']),
        finder_handoff: JSON.stringify({ required_platforms: ['tiktok'] })
      }
    }
  });
  const calls = [];
  await withPatched(dbOperations, fake, () =>
    withPatched(finderTasks, {
      createFinderTask: async (args) => { calls.push(args); return { id: 78 }; }
    }, async () => {
      await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision: 'approve' });
      assert.equal(calls[0].targetPlatform, 'tiktok');
    }));
});

test('strategy approve 前置不满足（绑定校验抛错）→ 记录失败原因，不向外抛错', async () => {
  const fake = createFakeDb({
    items: [seededItem()],
    strategies: { 1: { id: 1, primary_platform: 'youtube', secondary_platforms: null, finder_handoff: null } }
  });
  await withPatched(dbOperations, fake, () =>
    withPatched(finderTasks, {
      createFinderTask: async () => { throw new Error('Strategy must be bound to an active Campaign Product'); }
    }, () =>
      silenceConsoleError(async () => {
        const entry = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision: 'approve' });
        assert.equal(entry.ok, false);
        assert.match(entry.summary, /AI 自动执行失败/);
        assert.match(entry.summary, /Campaign Product/);
        const actions = appendedEntries(fake, 90);
        assert.equal(actions.length, 1);
        assert.equal(actions[0].ok, false);
      })));
});

test('candidate approve → draftForCustomer 生成 first_touch 草稿并记录 draft_id', async () => {
  const fake = createFakeDb({
    items: [seededItem({ type: 'candidate', subject_type: 'campaign_kol', subject_id: 2 })],
    campaignKols: { 2: { id: 2, campaign_id: 10, customer_id: 20 } }
  });
  const calls = [];
  await withPatched(dbOperations, fake, () =>
    withPatched(emailDrafter, {
      draftForCustomer: async (args) => { calls.push(args); return { ok: true, draftId: 501 }; }
    }, async () => {
      const entry = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision: 'approve' });
      assert.equal(entry.ok, true);
      assert.equal(entry.draft_id, 501);
      assert.deepEqual(calls, [{ campaignId: 10, customerId: 20, kind: 'first_touch' }]);
      const actions = appendedEntries(fake, 90);
      assert.equal(actions[0].action, 'draft_first_touch');
      assert.match(actions[0].summary, /#501/);
    }));
});

test('candidate approve 起草失败（ok:false 语义）→ 记录失败原因，不抛错', async () => {
  const fake = createFakeDb({
    items: [seededItem({ type: 'candidate', subject_type: 'campaign_kol', subject_id: 2 })],
    campaignKols: { 2: { id: 2, campaign_id: 10, customer_id: 20 } }
  });
  await withPatched(dbOperations, fake, () =>
    withPatched(emailDrafter, {
      draftForCustomer: async () => ({ ok: false, error: '达人邮箱缺失' })
    }, async () => {
      const entry = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision: 'approve' });
      assert.equal(entry.ok, false);
      assert.match(entry.summary, /达人邮箱缺失/);
      assert.equal(appendedEntries(fake, 90)[0].ok, false);
    }));
});

test('reply approve → 复用 draft-reply 逻辑生成 kind=reply 回复草稿', async () => {
  const fake = createFakeDb({
    items: [seededItem({ type: 'reply', subject_type: 'email_reply', subject_id: 5 })],
    replies: { 5: { id: 5, campaign_id: 10, customer_id: 23, body_text: '我对合作很感兴趣' } }
  });
  const calls = [];
  await withPatched(dbOperations, fake, () =>
    withPatched(emailDrafter, {
      draftForCustomer: async (args) => { calls.push(args); return { ok: true, draftId: 502 }; }
    }, async () => {
      const entry = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision: 'approve' });
      assert.equal(entry.ok, true);
      assert.equal(entry.action, 'draft_reply');
      assert.equal(entry.draft_id, 502);
      assert.equal(calls[0].kind, 'reply');
      assert.equal(calls[0].sourceReplyId, 5);
      assert.equal(calls[0].campaignId, 10);
      assert.equal(calls[0].customerId, 23);
      assert.match(calls[0].feedback, /我对合作很感兴趣/);
    }));
});

test('exception retry（finder）→ 复用 runVideoEvidenceDiscovery 重跑失败任务', async () => {
  const fake = createFakeDb({
    items: [seededItem({ type: 'exception', subject_type: 'finder', subject_id: 6 })],
    finderTaskRows: { 6: { id: 6, status: 'failed' } }
  });
  const calls = [];
  await withPatched(dbOperations, fake, () =>
    withPatched(finderTasks, {
      runVideoEvidenceDiscovery: async (taskId, options) => { calls.push([taskId, options]); }
    }, async () => {
      const entry = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision: 'retry' });
      assert.equal(entry.ok, true);
      assert.equal(entry.action, 'retry_finder');
      assert.deepEqual(calls, [[6, {}]]);
      assert.match(appendedEntries(fake, 90)[0].summary, /#6/);
    }));
});

test('exception retry（email send_failed）→ 本阶段只记录，不重跑也不起草', async () => {
  const fake = createFakeDb({
    items: [seededItem({ type: 'exception', subject_type: 'email_draft', subject_id: 7 })]
  });
  await withPatched(dbOperations, fake, () =>
    withPatched(finderTasks, {
      runVideoEvidenceDiscovery: async () => { throw new Error('不应被调用'); }
    }, () =>
      withPatched(emailDrafter, {
        draftForCustomer: async () => { throw new Error('不应被调用'); }
      }, async () => {
        const entry = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision: 'retry' });
        assert.equal(entry.ok, true);
        assert.equal(entry.action, 'record_only');
        assert.match(entry.summary, /仅记录/);
        assert.equal(appendedEntries(fake, 90)[0].action, 'record_only');
      })));
});

test('budget approve → 无后续自动化，仅记录说明', async () => {
  const fake = createFakeDb({
    items: [seededItem({ type: 'budget', subject_type: 'campaign_kol', subject_id: 3 })]
  });
  await withPatched(dbOperations, fake, () =>
    withPatched(finderTasks, {
      createFinderTask: async () => { throw new Error('不应被调用'); }
    }, () =>
      withPatched(emailDrafter, {
        draftForCustomer: async () => { throw new Error('不应被调用'); }
      }, async () => {
        const entry = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision: 'approve' });
        assert.equal(entry.ok, true);
        assert.equal(entry.action, 'record_only');
        assert.match(entry.summary, /寄样/);
      })));
});

test('reject / request_changes 等无映射决定不触发任何自动执行', async () => {
  const fake = createFakeDb({ items: [seededItem()] });
  await withPatched(dbOperations, fake, async () => {
    for (const decision of ['reject', 'request_changes', 'pause', 'skip']) {
      const result = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision });
      assert.equal(result, null);
    }
    assert.deepEqual(appendedEntries(fake, 90), []);
  });
});

test('端到端：submitDecision 编排异步失败时决定仍生效，失败原因记入 actions_json', async () => {
  const fake = createFakeDb({
    items: [seededItem({ type: 'candidate', subject_type: 'campaign_kol', subject_id: 2 })],
    campaignKols: { 2: { id: 2, campaign_id: 10, customer_id: 20 } }
  });
  await withPatched(dbOperations, fake, () =>
    withPatched(emailDrafter, {
      draftForCustomer: async () => { throw new Error('LLM 服务不可用'); }
    }, () =>
      silenceConsoleError(async () => {
        const item = await approvalItemService.submitDecision(90, {
          decision: 'approve', note: '这个人可以', version: 1, decided_by: 'boss'
        });
        // 决定不受编排影响：状态已落库为 approved
        assert.equal(item.status, 'approved');
        assert.equal(item.decision, 'approve');
        // 编排是 setImmediate 异步触发：轮询等待 auto_followup 条目写入
        let actions = [];
        for (let i = 0; i < 50; i++) {
          await new Promise((resolve) => setImmediate(resolve));
          actions = appendedEntries(fake, 90);
          if (actions.length) break;
        }
        assert.equal(actions.length, 1, '编排失败后应追加 auto_followup 条目');
        assert.equal(actions[0].key, 'auto_followup');
        assert.equal(actions[0].ok, false);
        assert.match(actions[0].summary, /LLM 服务不可用/);
        // 决定记录本身保持有效
        assert.equal(fake.store.get(90).status, 'approved');
      })));
});
