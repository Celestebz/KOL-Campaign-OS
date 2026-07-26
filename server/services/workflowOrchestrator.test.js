const assert = require('node:assert/strict');
const test = require('node:test');
const { dbOperations } = require('../database');
const emailDrafter = require('./emailDrafter');
const finderTasks = require('../routes/finderTasks');
const automationRuns = require('./automationRuns');
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
  let nextId = Math.max(0, ...items.map((item) => item.id)) + 1;
  const statements = [];

  const get = async (sql, params = []) => {
    if (/SELECT actions_json FROM approval_items WHERE id = \?/.test(sql)) return store.get(Number(params[0])) || null;
    if (/FROM approval_items WHERE dedupe_key = \?/.test(sql)) {
      return [...store.values()].find((row) => row.dedupe_key === params[0]) || null;
    }
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
    // 失败可见化建卡（workflowOrchestrator.upsertAutoFollowupException）
    if (/INSERT INTO approval_items/.test(sql)) {
      const [campaignId, subjectId, factsJson, opinionJson, risksJson, actionsJson, dedupeKey] = params;
      const row = {
        id: nextId++, campaign_id: campaignId, type: 'exception', subject_type: 'auto_followup',
        subject_id: subjectId, status: 'pending', priority: 'high',
        facts_json: factsJson, opinion_json: opinionJson, risks_json: risksJson, actions_json: actionsJson,
        version: 1, decision: null, decision_note: null, decided_by: null, decided_at: null,
        dedupe_key: dedupeKey, created_at: new Date(), updated_at: new Date()
      };
      store.set(row.id, row);
      return { id: row.id, changes: 1 };
    }
    // retry 重跑成功：卡关闭 decision='resolved'
    if (/UPDATE approval_items/.test(sql) && /decision = 'resolved'/.test(sql)) {
      const row = store.get(Number(params[0]));
      Object.assign(row, { status: 'cancelled', decision: 'resolved', decided_at: new Date() });
      return { id: 0, changes: 1 };
    }
    // retry 重跑仍失败：卡恢复 pending + version+1 + 快照更新
    if (/UPDATE approval_items/.test(sql) && /SET status = 'pending'/.test(sql) && /facts_json = \?/.test(sql)) {
      const [factsJson, opinionJson, risksJson, actionsJson, id] = params;
      const row = store.get(Number(id));
      Object.assign(row, {
        status: 'pending', facts_json: factsJson, opinion_json: opinionJson,
        risks_json: risksJson, actions_json: actionsJson, version: row.version + 1
      });
      return { id: 0, changes: 1 };
    }
    // 重复失败：已有 pending 卡 upsert 更新快照 + version+1
    if (/UPDATE approval_items/.test(sql) && /SET campaign_id = \?, priority = 'high'/.test(sql)) {
      const [campaignId, factsJson, opinionJson, risksJson, actionsJson, id] = params;
      const row = store.get(Number(id));
      Object.assign(row, {
        campaign_id: campaignId, facts_json: factsJson, opinion_json: opinionJson,
        risks_json: risksJson, actions_json: actionsJson, version: row.version + 1
      });
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

// ---- 失败可见化：auto_followup exception 审批卡 ----

// 造一张“自动执行失败”异常卡（老板点 retry 后的状态：cancelled + decision=retry）
function seededExceptionCard(overrides = {}) {
  return seededItem({
    id: 91, type: 'exception', subject_type: 'auto_followup', subject_id: 90,
    status: 'cancelled', decision: 'retry', decided_at: new Date(),
    priority: 'high',
    facts_json: JSON.stringify({ title: 'Alice · 自动执行失败', campaign_name: '春季推广', facts: [] }),
    actions_json: JSON.stringify([{ key: 'open', label: '去处理', href: '/campaign-kols' }]),
    dedupe_key: 'exception:auto_followup:90',
    ...overrides
  });
}

// 父项（candidate 已批准）里已有一条 draft_first_touch 失败记录
function failedParentItem(overrides = {}) {
  return seededItem({
    type: 'candidate', subject_type: 'campaign_kol', subject_id: 2,
    status: 'approved', decision: 'approve', decided_at: new Date(),
    facts_json: JSON.stringify({ title: 'Alice · 达人候选待审批', campaign_name: '春季推广', facts: [] }),
    actions_json: JSON.stringify([
      { key: 'auto_followup', at: '2026-07-25T08:00:00.000Z', action: 'draft_first_touch', ok: false, summary: '触达邮件草稿生成失败：KOL 没有 YouTube 主页链接' }
    ]),
    ...overrides
  });
}

test('失败可见化：自动后续动作 ok:false 时创建 exception 审批卡', async () => {
  const fake = createFakeDb({
    items: [seededItem({ type: 'candidate', subject_type: 'campaign_kol', subject_id: 2 })],
    campaignKols: { 2: { id: 2, campaign_id: 10, customer_id: 20 } }
  });
  await withPatched(dbOperations, fake, () =>
    withPatched(emailDrafter, {
      draftForCustomer: async () => ({ ok: false, error: 'KOL 没有 YouTube 主页链接' })
    }, async () => {
      const entry = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision: 'approve' });
      assert.equal(entry.ok, false);
      const cards = [...fake.store.values()].filter((row) => row.type === 'exception');
      assert.equal(cards.length, 1);
      const card = cards[0];
      assert.equal(card.subject_type, 'auto_followup');
      assert.equal(card.subject_id, 90, 'subject_id 指向父 approval_item');
      assert.equal(card.dedupe_key, 'exception:auto_followup:90');
      assert.equal(card.status, 'pending');
      assert.equal(card.priority, 'high');
      assert.equal(card.campaign_id, 10, 'campaign_id 继承父项');
      assert.equal(card.version, 1);
      const facts = JSON.parse(card.facts_json);
      assert.match(facts.title, /自动执行失败/);
      assert.equal(facts.campaign_name, '春季推广');
      assert.ok(facts.facts.some((f) => /原决定：达人候选 · 批准/.test(f)));
      assert.ok(facts.facts.some((f) => /尝试动作：生成首轮触达邮件草稿/.test(f)));
      assert.ok(facts.facts.some((f) => /失败原因：.*KOL 没有 YouTube 主页链接/.test(f)));
      assert.ok(facts.facts.some((f) => /^时间：/.test(f)));
      assert.match(JSON.parse(card.opinion_json), /重试/);
      assert.ok(JSON.parse(card.risks_json).some((r) => /AI 额度/.test(r)));
      assert.deepEqual(JSON.parse(card.actions_json), [{ key: 'open', label: '去处理', href: '/campaign-kols' }]);
    }));
});

test('失败可见化：同一父项重复失败只更新快照 + version+1，不重复建行', async () => {
  const fake = createFakeDb({
    items: [seededItem({ type: 'candidate', subject_type: 'campaign_kol', subject_id: 2 })],
    campaignKols: { 2: { id: 2, campaign_id: 10, customer_id: 20 } }
  });
  let error = '第一次失败';
  await withPatched(dbOperations, fake, () =>
    withPatched(emailDrafter, {
      draftForCustomer: async () => ({ ok: false, error })
    }, async () => {
      await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision: 'approve' });
      error = '第二次失败';
      await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision: 'approve' });
      const cards = [...fake.store.values()].filter((row) => row.type === 'exception');
      assert.equal(cards.length, 1, '同一 dedupe_key 不重复建行');
      assert.equal(cards[0].version, 2, 'upsert 语义 version+1');
      assert.match(cards[0].facts_json, /第二次失败/);
      assert.ok(!cards[0].facts_json.includes('第一次失败'));
    }));
});

test('失败可见化：成功路径不建卡', async () => {
  const fake = createFakeDb({
    items: [seededItem({ type: 'candidate', subject_type: 'campaign_kol', subject_id: 2 })],
    campaignKols: { 2: { id: 2, campaign_id: 10, customer_id: 20 } }
  });
  await withPatched(dbOperations, fake, () =>
    withPatched(emailDrafter, {
      draftForCustomer: async () => ({ ok: true, draftId: 501 })
    }, async () => {
      await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision: 'approve' });
      assert.equal([...fake.store.values()].filter((row) => row.type === 'exception').length, 0);
    }));
});

test('auto_followup exception retry 重跑成功 → 卡 resolved + 父项追加 ok:true 记录', async () => {
  const fake = createFakeDb({
    items: [failedParentItem(), seededExceptionCard()],
    campaignKols: { 2: { id: 2, campaign_id: 10, customer_id: 20 } }
  });
  const calls = [];
  await withPatched(dbOperations, fake, () =>
    withPatched(emailDrafter, {
      draftForCustomer: async (args) => { calls.push(args); return { ok: true, draftId: 600 }; }
    }, async () => {
      const entry = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(91)), { decision: 'retry' });
      assert.equal(entry.ok, true);
      assert.equal(entry.action, 'draft_first_touch', '按父项当时失败的 action 重跑');
      assert.deepEqual(calls, [{ campaignId: 10, customerId: 20, kind: 'first_touch' }]);
      // 父项追加 ok:true 记录
      const parentActions = appendedEntries(fake, 90);
      assert.equal(parentActions.length, 2);
      assert.equal(parentActions[1].ok, true);
      assert.equal(parentActions[1].action, 'draft_first_touch');
      assert.equal(parentActions[1].draft_id, 600);
      // 卡关闭：status=cancelled + decision=resolved
      const card = fake.store.get(91);
      assert.equal(card.status, 'cancelled');
      assert.equal(card.decision, 'resolved');
      // selfRecorded：exception 卡自身的 actions（open href）不被 auto_followup 条目污染
      assert.deepEqual(JSON.parse(card.actions_json), [{ key: 'open', label: '去处理', href: '/campaign-kols' }]);
    }));
});

test('auto_followup exception retry 重跑仍失败 → 卡恢复 pending + version+1，父项追加最新失败', async () => {
  const fake = createFakeDb({
    items: [failedParentItem(), seededExceptionCard()],
    campaignKols: { 2: { id: 2, campaign_id: 10, customer_id: 20 } }
  });
  await withPatched(dbOperations, fake, () =>
    withPatched(emailDrafter, {
      draftForCustomer: async () => ({ ok: false, error: 'LLM 服务超时' })
    }, async () => {
      const entry = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(91)), { decision: 'retry' });
      assert.equal(entry.ok, false);
      // 父项追加最新失败记录
      const parentActions = appendedEntries(fake, 90);
      assert.equal(parentActions.length, 2);
      assert.equal(parentActions[1].ok, false);
      assert.match(parentActions[1].summary, /LLM 服务超时/);
      // 卡恢复 pending，version+1，decision 保留 retry，快照更新为最新失败原因
      const card = fake.store.get(91);
      assert.equal(card.status, 'pending');
      assert.equal(card.version, 2);
      assert.equal(card.decision, 'retry');
      assert.match(card.facts_json, /LLM 服务超时/);
      // 不另建新卡
      assert.equal([...fake.store.values()].filter((row) => row.type === 'exception').length, 1);
    }));
});

test('auto_followup exception retry：父项无可重跑动作 → 卡恢复 pending 并记录原因', async () => {
  const fake = createFakeDb({
    items: [failedParentItem({ actions_json: JSON.stringify([]) }), seededExceptionCard()]
  });
  await withPatched(dbOperations, fake, () =>
    withPatched(emailDrafter, {
      draftForCustomer: async () => { throw new Error('不应被调用'); }
    }, async () => {
      const entry = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(91)), { decision: 'retry' });
      assert.equal(entry.ok, false);
      assert.match(entry.summary, /未找到可重跑/);
      const card = fake.store.get(91);
      assert.equal(card.status, 'pending');
      assert.equal(card.version, 2);
    }));
});

test('auto_followup exception skip/stop 只记录决定，编排层不触发任何重跑', async () => {
  const fake = createFakeDb({
    items: [failedParentItem(), seededExceptionCard({ status: 'pending', decision: null, decided_at: null })]
  });
  await withPatched(dbOperations, fake, () =>
    withPatched(emailDrafter, {
      draftForCustomer: async () => { throw new Error('不应被调用'); }
    }, async () => {
      for (const decision of ['skip', 'stop']) {
        const result = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(91)), { decision });
        assert.equal(result, null, `${decision} 无自动执行映射`);
      }
      // 父项与卡均无变化
      assert.equal(appendedEntries(fake, 90).length, 1);
      assert.equal(fake.store.get(91).status, 'pending');
      assert.equal(fake.store.get(91).version, 1);
    }));
});

// ---- 阶段 D1：automation_run 异常卡 retry → retryFailedItems 真重跑 ----

test('exception retry（automation_run）→ 调 retryFailedItems 重跑，全部成功后记录 ok:true', async () => {
  const fake = createFakeDb({
    items: [seededItem({
      type: 'exception', subject_type: 'automation_run', subject_id: 31,
      dedupe_key: 'exception:run:31'
    })]
  });
  const calls = [];
  await withPatched(dbOperations, fake, () =>
    withPatched(automationRuns, {
      retryFailedItems: async (runId) => {
        calls.push(runId);
        return { id: runId, status: 'success', progress: { total: 3, completed: 3, succeeded: 3, failed: 0 } };
      }
    }, async () => {
      const entry = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision: 'retry' });
      assert.equal(entry.ok, true);
      assert.equal(entry.action, 'retry_run');
      assert.equal(entry.run_id, 31);
      assert.deepEqual(calls, [31], '以 run id 调 retryFailedItems（只重跑失败项由该函数保证）');
      assert.match(entry.summary, /全部成功/);
      assert.equal(appendedEntries(fake, 90)[0].action, 'retry_run');
      // 重跑成功不建 auto_followup 失败卡
      assert.equal([...fake.store.values()].filter((row) => row.type === 'exception').length, 1);
    }));
});

test('exception retry（automation_run）重跑仍失败 → 记录失败原因并建 auto_followup 异常卡', async () => {
  const fake = createFakeDb({
    items: [seededItem({
      type: 'exception', subject_type: 'automation_run', subject_id: 31,
      dedupe_key: 'exception:run:31'
    })]
  });
  await withPatched(dbOperations, fake, () =>
    withPatched(automationRuns, {
      retryFailedItems: async (runId) => ({
        id: runId, status: 'partial_failed',
        progress: { total: 3, completed: 3, succeeded: 2, failed: 1 },
        last_error: '达人 3：LLM 超时'
      })
    }, async () => {
      const entry = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision: 'retry' });
      assert.equal(entry.ok, false);
      assert.equal(entry.action, 'retry_run');
      assert.match(entry.summary, /仍有 1 条失败/);
      assert.match(entry.summary, /LLM 超时/);
      // 父项（run 异常卡）追加失败记录
      assert.equal(appendedEntries(fake, 90)[0].ok, false);
      // 失败可见化：建 auto_followup 异常卡，可再次重试（retry_run 已注册进 RETRYABLE_ACTIONS）
      const cards = [...fake.store.values()].filter((row) => row.subject_type === 'auto_followup');
      assert.equal(cards.length, 1);
      assert.equal(cards[0].dedupe_key, 'exception:auto_followup:90');
      assert.ok(JSON.parse(cards[0].facts_json).facts.some((f) => /尝试动作：重跑后台任务失败项/.test(f)));
    }));
});

test('exception skip/stop（automation_run）只记录决定，不触发 retryFailedItems', async () => {
  const fake = createFakeDb({
    items: [seededItem({
      type: 'exception', subject_type: 'automation_run', subject_id: 31,
      dedupe_key: 'exception:run:31'
    })]
  });
  await withPatched(dbOperations, fake, () =>
    withPatched(automationRuns, {
      retryFailedItems: async () => { throw new Error('不应被调用'); }
    }, async () => {
      for (const decision of ['skip', 'stop']) {
        const result = await workflowOrchestrator.continueAfterDecision(apiItem(fake.store.get(90)), { decision });
        assert.equal(result, null, `${decision} 无自动执行映射`);
      }
      assert.deepEqual(appendedEntries(fake, 90), []);
    }));
});
