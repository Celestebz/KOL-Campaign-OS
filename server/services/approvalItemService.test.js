const assert = require('node:assert/strict');
const test = require('node:test');
const { dbOperations } = require('../database');
const approvalItemService = require('./approvalItemService');

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

// ---- 内存版 approval_items 仓库 + 按 SQL 内容分发的六类源数据 ----
function createFakeDb({ sources = {}, initialItems = [] } = {}) {
  const store = new Map();
  let nextId = 1;
  for (const item of initialItems) {
    store.set(item.id, { ...item });
    nextId = Math.max(nextId, item.id + 1);
  }
  const statements = [];

  const query = async (sql, params = []) => {
    if (/FROM kol_strategies/.test(sql)) return sources.strategies || [];
    if (/FROM campaign_kols ck/.test(sql) && /budget_approval_status/.test(sql)) return sources.budgets || [];
    if (/FROM campaign_kols ck/.test(sql)) return sources.candidates || [];
    if (/FROM finder_tasks/.test(sql)) return sources.finderExceptions || [];
    if (/FROM automation_runs/.test(sql)) return sources.runExceptions || [];
    if (/FROM email_drafts d/.test(sql) && /send_failed/.test(sql)) return sources.emailExceptions || [];
    if (/FROM email_drafts d/.test(sql)) return sources.outreaches || [];
    if (/FROM email_replies/.test(sql)) return sources.replies || [];
    if (/FROM approval_items/.test(sql)) {
      let rows = [...store.values()];
      if (/decision IS NOT NULL/.test(sql)) {
        rows = rows.filter((r) => r.decision && r.decision !== 'source_gone' && r.decided_at);
      }
      if (/status = \?/.test(sql)) rows = rows.filter((r) => r.status === params[0]);
      else if (/WHERE status = 'pending'/.test(sql)) rows = rows.filter((r) => r.status === 'pending');
      if (/type = \?/.test(sql)) rows = rows.filter((r) => r.type === params[params.length - 1]);
      return rows;
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  const get = async (sql, params = []) => {
    if (/FROM approval_items WHERE id = \?/.test(sql)) return store.get(Number(params[0])) || null;
    if (/FROM email_drafts WHERE id = \?/.test(sql)) {
      return sources.draftRow || { id: Number(params[0]), status: 'pending_review' };
    }
    if (/FROM campaign_kols WHERE campaign_id = \? AND customer_id = \?/.test(sql)) return sources.kolRow || null;
    if (/FROM campaign_kols WHERE id = \?/.test(sql)) {
      return sources.campaignKolRow || { id: Number(params[0]), customer_id: 1 };
    }
    if (/SUM\(CASE/.test(sql)) return sources.summaryRow || null;
    throw new Error(`Unexpected get: ${sql}`);
  };

  const run = async (sql, params = []) => {
    statements.push({ sql, params });
    if (/INSERT INTO approval_items/.test(sql)) {
      const [campaignId, type, subjectType, subjectId, priority,
        factsJson, opinionJson, risksJson, actionsJson, dedupeKey] = params;
      const row = {
        id: nextId++, campaign_id: campaignId, type, subject_type: subjectType, subject_id: subjectId,
        status: 'pending', priority, facts_json: factsJson, opinion_json: opinionJson,
        risks_json: risksJson, actions_json: actionsJson, version: 1,
        decision: null, decision_note: null, decided_by: null, decided_at: null,
        dedupe_key: dedupeKey, created_at: new Date(), updated_at: new Date()
      };
      store.set(row.id, row);
      return { id: row.id, changes: 1 };
    }
    if (/UPDATE approval_items/.test(sql) && /decision = 'source_gone'/.test(sql)) {
      const row = store.get(Number(params[0]));
      Object.assign(row, { status: 'cancelled', decision: 'source_gone', decided_at: new Date() });
      return { id: 0, changes: 1 };
    }
    if (/UPDATE approval_items/.test(sql) && /SET status = \?, decision = \?/.test(sql)) {
      const [status, decision, decisionNote, decidedBy, id] = params;
      const row = store.get(Number(id));
      Object.assign(row, {
        status, decision, decision_note: decisionNote, decided_by: decidedBy, decided_at: new Date()
      });
      if (/version = version \+ 1/.test(sql)) row.version += 1;
      return { id: 0, changes: 1 };
    }
    if (/UPDATE approval_items/.test(sql) && /facts_json = \?/.test(sql)) {
      const [campaignId, subjectType, subjectId, priority,
        factsJson, opinionJson, risksJson, actionsJson, id] = params;
      const row = store.get(Number(id));
      Object.assign(row, {
        campaign_id: campaignId, subject_type: subjectType, subject_id: subjectId, priority,
        facts_json: factsJson, opinion_json: opinionJson, risks_json: risksJson,
        actions_json: actionsJson, version: row.version + 1
      });
      return { id: 0, changes: 1 };
    }
    // 副作用 SQL（email_drafts / email_replies / campaign_kols / customers）只记录不模拟
    return { id: 0, changes: 1 };
  };

  return { query, get, run, store, statements };
}

const fullSources = {
  strategies: [{
    id: 1, campaign_id: 10, campaign_name: '春季推广', name: 'TRA 策略', brand: 'MOOER', product: '碎枝机',
    category: '园林工具', target_market: '美国', campaign_goal: '提升新品曝光', finder_handoff: null,
    source_material_summary: null, updated_at: '2026-07-25 08:00:00'
  }],
  candidates: [{
    id: 2, campaign_id: 10, customer_id: 20, campaign_name: '春季推广', kol_name: 'Alice',
    kol_name_snapshot: 'Alice', target_platform: 'youtube', youtube_followers_snapshot: '12.3万',
    instagram_followers_snapshot: null, tiktok_followers_snapshot: null, country_region_snapshot: 'US',
    median_views_30d_snapshot: 8400, posts_30d_snapshot: 4,
    evidence_summary: JSON.stringify({ match_reason: '真实农场场景', videos: [{ id: 1 }] }),
    priority_level: 't1', candidate_priority_score: 88, updated_at: '2026-07-25 07:00:00'
  }],
  budgets: [{
    id: 3, campaign_id: 10, customer_id: 21, campaign_name: '春季推广', kol_name: 'Bob',
    kol_name_snapshot: 'Bob', quoted_fee: '500', final_fee: null, currency: 'USD',
    cooperation_type: 'paid_product', deliverables: '1 条视频', estimated_total_cost_usd: 500,
    expected_views: 50000, estimated_cpm: 10, updated_at: '2026-07-25 06:00:00'
  }],
  outreaches: [{
    id: 4, campaign_id: 10, customer_id: 22, campaign_name: '春季推广', kol_name: 'Carol',
    kind: 'first_touch', subject: '合作邀请', risk_level: 'high',
    risk_reasons: JSON.stringify([{ code: 'NO_EMAIL', message: '达人邮箱缺失' }]),
    evidence: JSON.stringify({
      snapshot_date: '2026-07-20',
      videos: [{ youtube_video_id: 'v1' }, { youtube_video_id: 'v2' }],
      match_reason: '频道与产品高度匹配',
      metrics: { followers: '5.6万', avg_views_30d: 9000 }
    }),
    generated_at: '2026-07-25 05:00:00', updated_at: '2026-07-25 05:00:00'
  }],
  replies: [{
    id: 5, campaign_id: 10, customer_id: 23, campaign_name: '春季推广', kol_name: 'Dave',
    subject: 'Re: 合作邀请', body_text: '我对合作很感兴趣，想了解一下佣金细节。',
    received_at: '2026-07-25 04:00:00', ai_summary: '询问佣金细节', ai_intent: 'question',
    updated_at: '2026-07-25 04:00:00'
  }],
  finderExceptions: [{
    id: 6, campaign_id: 10, campaign_name: '春季推广', name: 'Finder-美国', platform: 'youtube',
    status: 'failed', error_message: 'API quota exceeded', success_count: 0, failed_count: 5,
    updated_at: '2026-07-25 03:00:00'
  }]
};

function seededPendingItem(overrides = {}) {
  return {
    id: 90, campaign_id: 10, type: 'outreach', subject_type: 'email_draft', subject_id: 4,
    status: 'pending', priority: 'none',
    facts_json: JSON.stringify({ title: 'Carol · 触达邮件待审批', campaign_name: '春季推广', facts: [] }),
    opinion_json: JSON.stringify(''), risks_json: JSON.stringify([]), actions_json: JSON.stringify([]),
    version: 1, decision: null, decision_note: null, decided_by: null, decided_at: null,
    dedupe_key: 'outreach:email_draft:4', created_at: new Date(), updated_at: new Date(),
    ...overrides
  };
}

test('syncApprovalItems 迁移后为六类来源各生成一条 pending approval_item', async () => {
  const fake = createFakeDb({ sources: fullSources });
  await withPatchedDb(fake, async () => {
    const result = await approvalItemService.syncApprovalItems();
    assert.equal(result.scanned, 6);
    assert.equal(result.inserted, 6);

    const rows = [...fake.store.values()];
    assert.equal(rows.length, 6);
    const byType = new Map(rows.map((row) => [row.dedupe_key, row]));
    for (const key of [
      'strategy:kol_strategy:1', 'candidate:campaign_kol:2', 'budget:campaign_kol:3',
      'outreach:email_draft:4', 'reply:email_reply:5', 'exception:finder:6'
    ]) {
      assert.ok(byType.has(key), `missing dedupe_key ${key}`);
      assert.equal(byType.get(key).status, 'pending');
      assert.equal(byType.get(key).version, 1);
    }
    const outreach = byType.get('outreach:email_draft:4');
    assert.equal(outreach.priority, 'high');
    const factsSnap = JSON.parse(outreach.facts_json);
    assert.equal(factsSnap.title, 'Carol · 触达邮件待审批');
    assert.equal(factsSnap.campaign_name, '春季推广');
    assert.ok(factsSnap.facts.some((f) => f.includes('引用视频数：2')));
    assert.deepEqual(JSON.parse(outreach.risks_json), ['达人邮箱缺失']);
  });
});

test('syncApprovalItems dedupe 幂等：重复扫描不重复建行、version 不变', async () => {
  const fake = createFakeDb({ sources: fullSources });
  await withPatchedDb(fake, async () => {
    await approvalItemService.syncApprovalItems();
    const sizeAfterFirst = fake.store.size;
    fake.statements.length = 0;
    const second = await approvalItemService.syncApprovalItems();
    assert.equal(fake.store.size, sizeAfterFirst);
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.cancelled, 0);
    assert.ok(!fake.statements.some((s) => /INSERT INTO approval_items/.test(s.sql)));
    for (const row of fake.store.values()) assert.equal(row.version, 1);
  });
});

test('syncApprovalItems 对 MySQL JSON key 重排不敏感（稳定指纹，不误判变化）', async () => {
  const fake = createFakeDb({ sources: fullSources });
  await withPatchedDb(fake, async () => {
    await approvalItemService.syncApprovalItems();
    // 模拟 MySQL JSON 列读回时对象 key 按字典序重排
    for (const row of fake.store.values()) {
      const parsed = JSON.parse(row.facts_json);
      const shuffled = {};
      for (const key of Object.keys(parsed).sort()) shuffled[key] = parsed[key];
      row.facts_json = JSON.stringify(shuffled);
    }
    const result = await approvalItemService.syncApprovalItems();
    assert.equal(result.updated, 0);
    for (const row of fake.store.values()) assert.equal(row.version, 1);
  });
});

test('syncApprovalItems 源数据变化时更新快照并 version+1', async () => {
  const fake = createFakeDb({ sources: fullSources });
  await withPatchedDb(fake, async () => {
    await approvalItemService.syncApprovalItems();
    // 草稿被编辑：主题变化 → opinion 变化
    fullSources.outreaches[0].subject = '合作邀请 v2';
    const result = await approvalItemService.syncApprovalItems();
    assert.equal(result.updated, 1);
    const row = [...fake.store.values()].find((r) => r.dedupe_key === 'outreach:email_draft:4');
    assert.equal(row.version, 2);
    assert.match(JSON.parse(row.opinion_json), /合作邀请 v2/);
    fullSources.outreaches[0].subject = '合作邀请';
  });
});

test('syncApprovalItems 已决定（非 pending）项即使源变化也不动', async () => {
  const decided = seededPendingItem({
    id: 99, status: 'rejected', decision: 'reject', decided_at: new Date(),
    facts_json: JSON.stringify({ title: '旧快照', campaign_name: '', facts: ['旧事实'] })
  });
  const fake = createFakeDb({ sources: fullSources, initialItems: [decided] });
  await withPatchedDb(fake, async () => {
    await approvalItemService.syncApprovalItems();
    const row = fake.store.get(99);
    assert.equal(row.status, 'rejected');
    assert.equal(row.version, 1);
    assert.match(row.facts_json, /旧快照/);
    // 其余五类照常插入，outreach 因 dedupe 已存在（已决定）不重复建行
    assert.equal(fake.store.size, 6);
  });
});

test('syncApprovalItems 源已消失的 pending 项标记 cancelled（decision=source_gone）', async () => {
  const fake = createFakeDb({ sources: fullSources });
  await withPatchedDb(fake, async () => {
    await approvalItemService.syncApprovalItems();
  });
  // 第二次扫描：源全部消失
  const fake2 = createFakeDb({ sources: {}, initialItems: [...fake.store.values()] });
  await withPatchedDb(fake2, async () => {
    const result = await approvalItemService.syncApprovalItems();
    assert.equal(result.cancelled, 6);
    for (const row of fake2.store.values()) {
      assert.equal(row.status, 'cancelled');
      assert.equal(row.decision, 'source_gone');
    }
  });
});

test('submitDecision version 冲突抛 409 并带 currentVersion', async () => {
  const fake = createFakeDb({ initialItems: [seededPendingItem({ version: 3 })] });
  await withPatchedDb(fake, async () => {
    await assert.rejects(
      approvalItemService.submitDecision(90, { decision: 'approve', version: 1 }),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.message, '该事项已更新，请查看最新版本后重新决定');
        assert.equal(error.currentVersion, 3);
        return true;
      }
    );
    // 冲突时不写任何决定
    assert.equal(fake.store.get(90).decision, null);
  });
});

test('submitDecision outreach approve → email_drafts 变 approved 且事项变 approved', async () => {
  const fake = createFakeDb({ initialItems: [seededPendingItem()] });
  await withPatchedDb(fake, async () => {
    const item = await approvalItemService.submitDecision(90, {
      decision: 'approve', note: '可以发', version: 1, decided_by: 'boss'
    });
    assert.equal(item.status, 'approved');
    assert.equal(item.decision, 'approve');
    const draftUpdate = fake.statements.find((s) => /UPDATE email_drafts SET status = 'approved'/.test(s.sql));
    assert.ok(draftUpdate, '应复用邮件 approve 逻辑把 email_drafts 置为 approved');
    assert.deepEqual(draftUpdate.params, [4]);
    const row = fake.store.get(90);
    assert.equal(row.decision_note, '可以发');
    assert.equal(row.decided_by, 'boss');
  });
});

test('submitDecision candidate approve → campaign_kols.status 变 approved', async () => {
  const fake = createFakeDb({
    initialItems: [seededPendingItem({
      type: 'candidate', subject_type: 'campaign_kol', subject_id: 2,
      dedupe_key: 'candidate:campaign_kol:2'
    })],
    sources: { campaignKolRow: { id: 2, customer_id: 20 } }
  });
  await withPatchedDb(fake, async () => {
    const item = await approvalItemService.submitDecision(90, { decision: 'approve', version: 1 });
    assert.equal(item.status, 'approved');
    const kolUpdate = fake.statements.find((s) => /UPDATE campaign_kols SET status = \?/.test(s.sql));
    assert.ok(kolUpdate, '应更新 campaign_kols.status');
    assert.deepEqual(kolUpdate.params.slice(0, 1), ['approved']);
  });
});

test('submitDecision request_changes → 保持 pending 且 version+1', async () => {
  const fake = createFakeDb({
    initialItems: [seededPendingItem({
      type: 'budget', subject_type: 'campaign_kol', subject_id: 3,
      dedupe_key: 'budget:campaign_kol:3'
    })]
  });
  await withPatchedDb(fake, async () => {
    const item = await approvalItemService.submitDecision(90, {
      decision: 'request_changes', note: '报价再谈', version: 1
    });
    assert.equal(item.status, 'pending');
    assert.equal(item.version, 2);
    assert.equal(item.decision, 'request_changes');
    assert.equal(item.decision_note, '报价再谈');
  });
});

test('submitDecision 非 pending 事项不能重复决定', async () => {
  const fake = createFakeDb({ initialItems: [seededPendingItem({ status: 'approved', decision: 'approve' })] });
  await withPatchedDb(fake, async () => {
    await assert.rejects(
      approvalItemService.submitDecision(90, { decision: 'reject', version: 1 }),
      (error) => error.statusCode === 409 && /不能重复决定/.test(error.message)
    );
  });
});

test('getSummary 口径：pending 不含 exception，handled_today 取当日决定数', async () => {
  const fake = createFakeDb({
    sources: { summaryRow: { pending: '5', high_risk: '1', exceptions: '2', handled_today: '3' } }
  });
  await withPatchedDb(fake, async () => {
    const summary = await approvalItemService.getSummary();
    assert.deepEqual(summary, { pending: 5, high_risk: 1, exceptions: 2, handled_today: 3 });
  });
});

test('listPendingWorkbenchItems 输出契约字段（legacy id + approval_item_id + version）', async () => {
  const fake = createFakeDb({
    initialItems: [
      seededPendingItem({ id: 91 }),
      seededPendingItem({
        id: 92, type: 'exception', subject_type: 'finder', subject_id: 6,
        dedupe_key: 'exception:finder:6'
      }),
      seededPendingItem({ id: 93, status: 'approved', decision: 'approve' })
    ]
  });
  await withPatchedDb(fake, async () => {
    const items = await approvalItemService.listPendingWorkbenchItems();
    assert.equal(items.length, 2);
    const outreach = items.find((i) => i.type === 'outreach');
    assert.equal(outreach.id, 'outreach:4');
    assert.equal(outreach.approval_item_id, 91);
    assert.equal(outreach.version, 1);
    assert.equal(outreach.title, 'Carol · 触达邮件待审批');
    const exception = items.find((i) => i.type === 'exception');
    assert.equal(exception.id, 'exception:finder:6');
  });
});

test('listRecentDecisions 输出中文决定标签与跳转 href', async () => {
  const fake = createFakeDb({
    initialItems: [
      seededPendingItem({
        id: 94, status: 'approved', decision: 'approve', decided_at: new Date('2026-07-25T02:00:00Z')
      }),
      seededPendingItem({
        id: 95, status: 'cancelled', decision: 'source_gone', decided_at: new Date('2026-07-25T03:00:00Z'),
        dedupe_key: 'exception:finder:7', type: 'exception', subject_type: 'finder', subject_id: 7
      })
    ]
  });
  await withPatchedDb(fake, async () => {
    const decisions = await approvalItemService.listRecentDecisions();
    assert.equal(decisions.length, 1, 'source_gone 自动取消不计入人工决定');
    assert.equal(decisions[0].decision, '已通过');
    assert.equal(decisions[0].href, '/emails');
    assert.equal(decisions[0].title, 'Carol · 触达邮件待审批');
  });
});

test('syncApprovalItems GC 豁免：手工创建的 auto_followup 异常卡不被 source_gone 取消', async () => {
  // workflowOrchestrator 失败可见化建的手工卡（非 builder 来源）
  const manualCard = seededPendingItem({
    id: 98, type: 'exception', subject_type: 'auto_followup', subject_id: 90,
    priority: 'high',
    facts_json: JSON.stringify({ title: 'Alice · 自动执行失败', campaign_name: '春季推广', facts: [] }),
    dedupe_key: 'exception:auto_followup:90'
  });
  const fake = createFakeDb({ sources: fullSources, initialItems: [manualCard] });
  await withPatchedDb(fake, async () => {
    const result = await approvalItemService.syncApprovalItems();
    assert.equal(result.inserted, 6);
    assert.equal(result.cancelled, 0, '手工卡不在 builder 产出集合里也不应被取消');
    const card = fake.store.get(98);
    assert.equal(card.status, 'pending');
    assert.equal(card.version, 1);
  });
  // 第二次扫描：builder 源全部消失 → 六类 builder 卡被取消，手工卡仍然豁免
  const fake2 = createFakeDb({ sources: {}, initialItems: [...fake.store.values()] });
  await withPatchedDb(fake2, async () => {
    const result = await approvalItemService.syncApprovalItems();
    assert.equal(result.cancelled, 6, 'builder 来源卡照常 GC');
    const card = fake2.store.get(98);
    assert.equal(card.status, 'pending', '手工卡豁免 source_gone');
    assert.equal(card.decision, null);
  });
});

// ---- 阶段 D1：automation_runs 失败进异常队列 ----

function failedRunRow(overrides = {}) {
  return {
    id: 31, campaign_id: 10, campaign_name: '春季推广', run_type: 'email_draft_batch',
    status: 'failed', progress_json: JSON.stringify({ total: 3, completed: 3, succeeded: 0, failed: 3 }),
    last_error: '达人 2：邮箱缺失', updated_at: '2026-07-25 03:00:00',
    ...overrides
  };
}

test('syncApprovalItems failed/partial_failed 的 automation_run 进异常队列', async () => {
  const fake = createFakeDb({
    sources: {
      runExceptions: [
        failedRunRow(),
        failedRunRow({
          id: 32, status: 'partial_failed',
          progress_json: JSON.stringify({ total: 5, completed: 5, succeeded: 4, failed: 1 })
        })
      ]
    }
  });
  await withPatchedDb(fake, async () => {
    const result = await approvalItemService.syncApprovalItems();
    assert.equal(result.inserted, 2);
    const byKey = new Map([...fake.store.values()].map((row) => [row.dedupe_key, row]));

    const failed = byKey.get('exception:run:31');
    assert.ok(failed, 'failed run 应建卡');
    assert.equal(failed.type, 'exception');
    assert.equal(failed.subject_type, 'automation_run');
    assert.equal(failed.subject_id, 31);
    assert.equal(failed.campaign_id, 10);
    assert.equal(failed.priority, 'high');
    const failedFacts = JSON.parse(failed.facts_json);
    assert.match(failedFacts.title, /批量邮件起草 #31 · 执行失败/);
    assert.equal(failedFacts.campaign_name, '春季推广');
    assert.ok(failedFacts.facts.some((f) => /失败节点：后台任务（批量邮件起草）/.test(f)));
    assert.ok(failedFacts.facts.some((f) => /进度：3\/3 完成，成功 0 条，失败 3 条/.test(f)));
    assert.ok(failedFacts.facts.some((f) => /达人 2：邮箱缺失/.test(f)));
    assert.match(JSON.parse(failed.opinion_json), /重试失败项/);
    assert.deepEqual(JSON.parse(failed.actions_json), [{ key: 'open', label: '去处理', href: '/emails' }]);

    const partial = byKey.get('exception:run:32');
    assert.ok(partial, 'partial_failed run 也要进队列（有失败项需处理）');
    assert.match(JSON.parse(partial.facts_json).title, /部分失败/);
    assert.ok(JSON.parse(partial.facts_json).facts.some((f) => /成功 4 条，失败 1 条/.test(f)));
  });
});

test('syncApprovalItems 未知 run_type 的 href 回退 /', async () => {
  const fake = createFakeDb({
    sources: { runExceptions: [failedRunRow({ run_type: 'video_evidence_batch' })] }
  });
  await withPatchedDb(fake, async () => {
    await approvalItemService.syncApprovalItems();
    const row = [...fake.store.values()][0];
    assert.deepEqual(JSON.parse(row.actions_json), [{ key: 'open', label: '去处理', href: '/' }]);
    assert.ok(JSON.parse(row.facts_json).facts.some((f) => /video_evidence_batch/.test(f)));
  });
});

test('run 恢复后异常卡被 source_gone GC，auto_followup 手工卡不误伤', async () => {
  // 失败 run 建卡 + 一张 workflowOrchestrator 手工建的 auto_followup 卡
  const manualCard = seededPendingItem({
    id: 98, type: 'exception', subject_type: 'auto_followup', subject_id: 90,
    priority: 'high',
    facts_json: JSON.stringify({ title: 'Alice · 自动执行失败', campaign_name: '春季推广', facts: [] }),
    dedupe_key: 'exception:auto_followup:90'
  });
  const fake = createFakeDb({ sources: { runExceptions: [failedRunRow()] }, initialItems: [manualCard] });
  await withPatchedDb(fake, async () => {
    const result = await approvalItemService.syncApprovalItems();
    assert.equal(result.inserted, 1);
    assert.equal(result.cancelled, 0);
  });
  // run 重跑恢复（不再 failed/partial_failed）→ builder 不再产出 → 卡 source_gone 取消；手工卡豁免
  const fake2 = createFakeDb({ sources: {}, initialItems: [...fake.store.values()] });
  await withPatchedDb(fake2, async () => {
    const result = await approvalItemService.syncApprovalItems();
    assert.equal(result.cancelled, 1, '只有 exception:run: 卡被 GC');
    const runCard = [...fake2.store.values()].find((row) => row.dedupe_key === 'exception:run:31');
    assert.equal(runCard.status, 'cancelled');
    assert.equal(runCard.decision, 'source_gone');
    const card = fake2.store.get(98);
    assert.equal(card.status, 'pending', 'exception:run: 前缀不得误伤 exception:auto_followup: 手工卡');
    assert.equal(card.decision, null);
  });
});

test('listPendingWorkbenchItems automation_run 异常卡 legacy id 为 exception:run:{id}', async () => {
  const fake = createFakeDb({
    initialItems: [seededPendingItem({
      id: 96, type: 'exception', subject_type: 'automation_run', subject_id: 31,
      priority: 'high',
      facts_json: JSON.stringify({ title: '批量邮件起草 #31 · 执行失败', campaign_name: '春季推广', facts: [] }),
      dedupe_key: 'exception:run:31'
    })]
  });
  await withPatchedDb(fake, async () => {
    const items = await approvalItemService.listPendingWorkbenchItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'exception:run:31');
    assert.equal(items[0].subject_type, 'automation_run');
    assert.equal(items[0].title, '批量邮件起草 #31 · 执行失败');
  });
});
