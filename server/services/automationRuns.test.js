const assert = require('node:assert/strict');
const test = require('node:test');
const { dbOperations } = require('../database');
const emailDrafter = require('./emailDrafter');
const automationRuns = require('./automationRuns');

// 通用 monkey-patch（同 workflowOrchestrator.test.js 惯例）
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

// 内存版 automation_runs 单行仓库：get 读行，run 按 SQL 形态更新行字段
function createFakeDb(runRow) {
  const row = { ...runRow };
  const statements = [];
  const get = async (sql, params = []) => {
    if (/FROM automation_runs WHERE id = \?/.test(sql)) {
      return Number(params[0]) === row.id ? row : null;
    }
    throw new Error(`Unexpected get: ${sql}`);
  };
  const run = async (sql, params = []) => {
    statements.push({ sql, params });
    // saveCheckpoint
    if (/SET checkpoint_json = \?, progress_json = \?/.test(sql)) {
      row.checkpoint_json = params[0];
      row.progress_json = params[1];
      return { id: 0, changes: 1 };
    }
    // finishRun
    if (/SET status = \?, last_error = \?/.test(sql)) {
      row.status = params[0];
      row.last_error = params[1];
      return { id: 0, changes: 1 };
    }
    // retryFailedItems 重跑前置：running + retry_count+1
    if (/SET status = 'running', retry_count = retry_count \+ 1/.test(sql)) {
      row.status = 'running';
      row.retry_count += 1;
      row.last_error = null;
      return { id: 0, changes: 1 };
    }
    return { id: 0, changes: 1 };
  };
  return { get, run, row, statements };
}

function failedRunRow(overrides = {}) {
  return {
    id: 31, campaign_id: 10, run_type: 'email_draft_batch', status: 'partial_failed',
    checkpoint_json: JSON.stringify({
      done_customer_ids: [1, 2, 3],
      items: [
        { customer_id: 1, kind: 'first_touch', ok: true, draft_id: 101, error: null },
        { customer_id: 2, kind: 'first_touch', ok: false, draft_id: null, error: '达人邮箱缺失' },
        { customer_id: 3, kind: 'first_touch', ok: false, draft_id: null, error: 'LLM 超时' }
      ]
    }),
    progress_json: JSON.stringify({ total: 3, completed: 3, succeeded: 1, failed: 2 }),
    retry_count: 0, last_error: '达人 2：达人邮箱缺失；达人 3：LLM 超时',
    ...overrides
  };
}

test('retryFailedItems 只对 checkpoint 里 ok:false 的条目重跑，成功项不重复执行', async () => {
  const fake = createFakeDb(failedRunRow());
  const calls = [];
  await withPatched(dbOperations, fake, () =>
    withPatched(emailDrafter, {
      // 返回形态对齐真实 draftForCustomer：{ ok, customer_id, draftId }
      draftForCustomer: async (args) => { calls.push(args); return { ok: true, customer_id: args.customerId, draftId: 200 }; }
    }, async () => {
      const run = await automationRuns.retryFailedItems(31);
      assert.deepEqual(calls.map((c) => c.customerId).sort(), [2, 3], '只重跑失败条目');
      assert.ok(calls.every((c) => c.campaignId === 10 && c.kind === 'first_touch'));
      assert.equal(run.status, 'success');
      assert.equal(run.retry_count, 1);
      assert.equal(run.last_error, null);
      assert.deepEqual(run.progress, { total: 3, completed: 3, succeeded: 3, failed: 0 });
      // 检查点：成功项保留原 draft_id，失败项被替换为重跑结果
      const byCustomer = new Map(run.checkpoint.items.map((item) => [item.customer_id, item]));
      assert.equal(byCustomer.get(1).draft_id, 101, '已成功条目不动');
      assert.equal(byCustomer.get(2).draft_id, 200);
      assert.equal(byCustomer.get(2).ok, true);
    }));
});

test('retryFailedItems 重跑仍失败 → run 变 partial_failed/failed 并保留错误摘要', async () => {
  const fake = createFakeDb(failedRunRow());
  await withPatched(dbOperations, fake, () =>
    withPatched(emailDrafter, {
      draftForCustomer: async (args) => (args.customerId === 2
        ? { ok: true, customer_id: args.customerId, draftId: 201 }
        : { ok: false, customer_id: args.customerId, error: 'LLM 仍超时' })
    }, async () => {
      const run = await automationRuns.retryFailedItems(31);
      assert.equal(run.status, 'partial_failed');
      assert.deepEqual(run.progress, { total: 3, completed: 3, succeeded: 2, failed: 1 });
      assert.match(run.last_error, /达人 3：LLM 仍超时/);
    }));
});

test('retryFailedItems 无失败条目时直接返回（幂等），不调用 draftForCustomer', async () => {
  const fake = createFakeDb(failedRunRow({
    status: 'success',
    checkpoint_json: JSON.stringify({
      done_customer_ids: [1],
      items: [{ customer_id: 1, kind: 'first_touch', ok: true, draft_id: 101, error: null }]
    }),
    progress_json: JSON.stringify({ total: 1, completed: 1, succeeded: 1, failed: 0 })
  }));
  await withPatched(dbOperations, fake, () =>
    withPatched(emailDrafter, {
      draftForCustomer: async () => { throw new Error('不应被调用'); }
    }, async () => {
      const run = await automationRuns.retryFailedItems(31);
      assert.equal(run.status, 'success');
      assert.ok(!fake.statements.some((s) => /retry_count = retry_count \+ 1/.test(s.sql)), '不进入重跑流程');
    }));
});

test('retryFailedItems run 不存在或不支持的类型时抛错（由调用方记为失败）', async () => {
  const fake = createFakeDb(failedRunRow({ run_type: 'video_evidence_batch' }));
  await withPatched(dbOperations, fake, async () => {
    await assert.rejects(automationRuns.retryFailedItems(999), /任务运行记录不存在：999/);
    await assert.rejects(automationRuns.retryFailedItems(31), /暂不支持重跑该任务类型：video_evidence_batch/);
  });
});
