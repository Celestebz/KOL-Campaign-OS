// 后台任务运行器（老板工作台阶段 D 第一轮，spec 第十一节“任务失败恢复”）。
// 职责：
//   createRun()               建行 status='running'，idempotency_key 命中已有行时直接复用（幂等）；
//   executeEmailDraftBatch()  批量起草后台执行：并发 ≤3 复用 emailDrafter.draftForCustomer，
//                             每条完成即写 progress_json / checkpoint_json（服务重启后状态仍在），
//                             终态 success（全成）/ partial_failed（有失败）/ failed（全败或异常中断）；
//   resumeInterruptedRuns()   服务启动时把遗留 running 标记 failed（last_error='服务重启中断'），
//                             本轮不做断点续跑，只做安全标记（交由工作台异常卡人工重试）；
//   retryFailedItems()        只对 checkpoint 里 ok:false 的条目重跑（已完成的不重复，spec 11.3 恢复原则）。
const { dbOperations } = require('../database');
const emailDrafter = require('./emailDrafter');

const RUN_CONCURRENCY = 3;
const DEFAULT_MAX_RETRIES = 3;

function parseJsonColumn(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function toRun(row) {
  if (!row) return null;
  return {
    ...row,
    checkpoint: parseJsonColumn(row.checkpoint_json, { done_customer_ids: [], items: [] }),
    progress: parseJsonColumn(row.progress_json, { total: 0, completed: 0, succeeded: 0, failed: 0 })
  };
}

async function getRun(runId) {
  const row = await dbOperations.get('SELECT * FROM automation_runs WHERE id = ?', [runId]);
  return toRun(row);
}

async function createRun({ run_type, campaign_id = null, subject_type = null, subject_id = null, current_node = null, idempotency_key = null, total = 0, max_retries = DEFAULT_MAX_RETRIES }) {
  if (idempotency_key) {
    const existing = await dbOperations.get('SELECT id FROM automation_runs WHERE idempotency_key = ?', [idempotency_key]);
    if (existing) return getRun(existing.id);
  }
  const result = await dbOperations.run(
    `INSERT INTO automation_runs
     (campaign_id, run_type, subject_type, subject_id, current_node, status, checkpoint_json, progress_json,
      retry_count, max_retries, started_at, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, 0, ?, NOW(), ?, NOW(), NOW())`,
    [
      campaign_id, run_type, subject_type, subject_id, current_node,
      JSON.stringify({ done_customer_ids: [], items: [] }),
      JSON.stringify({ total, completed: 0, succeeded: 0, failed: 0 }),
      max_retries, idempotency_key
    ]
  );
  return getRun(result.id);
}

async function saveCheckpoint(runId, checkpoint, progress) {
  await dbOperations.run(
    'UPDATE automation_runs SET checkpoint_json = ?, progress_json = ?, updated_at = NOW() WHERE id = ?',
    [JSON.stringify(checkpoint), JSON.stringify(progress), runId]
  );
}

async function finishRun(runId, status, lastError) {
  await dbOperations.run(
    'UPDATE automation_runs SET status = ?, last_error = ?, finished_at = NOW(), updated_at = NOW() WHERE id = ?',
    [status, lastError || null, runId]
  );
}

// 终态判定：全成 success；有成功有失败 partial_failed；全败 failed
function terminalStatus(progress) {
  if (progress.failed === 0) return 'success';
  return progress.succeeded > 0 ? 'partial_failed' : 'failed';
}

function summarizeErrors(items) {
  const errors = items.filter((item) => !item.ok).map((item) => `达人 ${item.customer_id}：${item.error}`);
  const text = errors.join('；');
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

// 并发 ≤ RUN_CONCURRENCY 逐条执行 task(item)，每条完成即写检查点（与 emailDrafter.draftBatch 同款分块）。
// task 必须返回 { customer_id, kind, ok, draft_id?, error? }，不抛错。
async function runItemsWithCheckpoint(run, items, task) {
  const checkpoint = run.checkpoint || { done_customer_ids: [], items: [] };
  const progress = { ...(run.progress || { total: items.length, completed: 0, succeeded: 0, failed: 0 }) };
  for (let i = 0; i < items.length; i += RUN_CONCURRENCY) {
    const chunk = items.slice(i, i + RUN_CONCURRENCY);
    const results = await Promise.all(chunk.map((item) => task(item)));
    for (const result of results) {
      const entry = {
        customer_id: result.customer_id,
        kind: result.kind,
        ok: result.ok,
        draft_id: result.draftId ?? null,
        error: result.ok ? null : (result.error || '未知错误')
      };
      // 重跑时替换同 customer_id 旧条目，已完成成功项不重复执行
      checkpoint.items = checkpoint.items.filter((old) => Number(old.customer_id) !== Number(entry.customer_id));
      checkpoint.items.push(entry);
      if (!checkpoint.done_customer_ids.some((id) => Number(id) === Number(entry.customer_id))) {
        checkpoint.done_customer_ids.push(entry.customer_id);
      }
      progress.completed += 1;
      if (result.ok) progress.succeeded += 1;
      else progress.failed += 1;
    }
    await saveCheckpoint(run.id, checkpoint, progress);
  }
  return { checkpoint, progress };
}

async function executeEmailDraftBatch(runId, items) {
  const run = await getRun(runId);
  if (!run) throw new Error(`任务运行记录不存在：${runId}`);
  try {
    const { checkpoint, progress } = await runItemsWithCheckpoint(run, items, (item) =>
      emailDrafter.draftForCustomer(item));
    const status = terminalStatus(progress);
    await finishRun(runId, status, status === 'success' ? null : summarizeErrors(checkpoint.items));
  } catch (error) {
    console.error(`批量邮件起草中断 (run ${runId}):`, error.message);
    await finishRun(runId, 'failed', error.message);
  }
  return getRun(runId);
}

// 服务启动恢复：遗留 running 说明进程在任务中途退出，本轮只做安全标记（不续跑）。
async function resumeInterruptedRuns() {
  const result = await dbOperations.run(
    `UPDATE automation_runs SET status = 'failed', last_error = '服务重启中断', finished_at = NOW(), updated_at = NOW()
     WHERE status = 'running'`
  );
  return result.changes || 0;
}

// 只重跑 checkpoint 里 ok:false 的条目；全部已成功则直接返回（幂等）。
// 返回重跑后的 run；run 不存在或类型不支持时抛错（由调用方记为失败）。
async function retryFailedItems(runId) {
  const run = await getRun(runId);
  if (!run) throw new Error(`任务运行记录不存在：${runId}`);
  if (run.run_type !== 'email_draft_batch') throw new Error(`暂不支持重跑该任务类型：${run.run_type}`);
  const failedItems = (run.checkpoint.items || []).filter((item) => item.ok === false);
  if (!failedItems.length) return run;

  await dbOperations.run(
    `UPDATE automation_runs SET status = 'running', retry_count = retry_count + 1, last_error = NULL, finished_at = NULL, updated_at = NOW()
     WHERE id = ?`,
    [runId]
  );
  // 进度基线：去掉待重跑条目的旧计数，重跑结果由 runItemsWithCheckpoint 重新累计
  const baseline = {
    total: run.progress.total,
    completed: run.progress.completed - failedItems.length,
    succeeded: run.progress.succeeded,
    failed: run.progress.failed - failedItems.length
  };
  const items = failedItems.map((item) => ({
    campaignId: run.campaign_id, customerId: item.customer_id, kind: item.kind || 'first_touch'
  }));
  try {
    const { checkpoint, progress } = await runItemsWithCheckpoint({ id: run.id, checkpoint: run.checkpoint, progress: baseline }, items, (item) =>
      emailDrafter.draftForCustomer(item));
    const status = terminalStatus(progress);
    await finishRun(runId, status, status === 'success' ? null : summarizeErrors(checkpoint.items));
  } catch (error) {
    console.error(`批量邮件起草重跑中断 (run ${runId}):`, error.message);
    await finishRun(runId, 'failed', error.message);
  }
  return getRun(runId);
}

module.exports = {
  RUN_CONCURRENCY,
  createRun,
  getRun,
  executeEmailDraftBatch,
  resumeInterruptedRuns,
  retryFailedItems
};
