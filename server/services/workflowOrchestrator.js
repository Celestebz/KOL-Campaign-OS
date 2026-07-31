// 审批后的 AI 自动流转编排（老板工作台阶段 C3，spec 第十节“审批后的自动工作流”）。
// 人工决定的即时副作用由 decisionDispatcher 完成后，异步调用 continueAfterDecision：
//   strategy  approve → 复用 finderTasks.createFinderTask 自动创建达人搜索任务
//                        （与 POST /api/finder-tasks 同一条创建路径，含 Ready Strategy 绑定校验）
//   candidate approve → emailDrafter.draftForCustomer 生成 kind='first_touch' 草稿进审批队列
//   reply     approve → 复用 /api/emails/replies/:id/draft-reply 逻辑生成 kind='reply' 回复草稿
//   exception retry   → finder 异常复用 runVideoEvidenceDiscovery 重跑；email send_failed 本阶段只记录；
//                        automation_run 异常调 automationRuns.retryFailedItems 只重跑失败项（阶段 D1）；
//                        auto_followup 异常按父项类型与当时失败的 action 真重跑（见 runRetryAutoFollowup）
//   budget    approve → 寄样/合同执行属 P3，本阶段只记录
//
// 失败隔离：单步失败（缺绑定、无邮箱、快照回抓失败等）只记录日志并写入 auto_followup 条目，
// 绝不向决定路径抛错。每次触发结果以 { key: 'auto_followup', ... } 追加到
// approval_items.actions_json，供工作台展示“AI 已继续执行”。
//
// 失败可见化（阶段 C4）：entry.ok === false 时除 actions_json 记录外，另建（或按 dedupe_key 复用）
// 一张 type='exception' / subject_type='auto_followup' 的审批卡，老板可在工作台重试/跳过/停止。
// dedupe_key = exception:auto_followup:{父 approval_item id}，该前缀不属于任何 builder 产出，
// 因此 syncApprovalItems 的 source_gone GC 不会误取消这类手工卡（豁免逻辑见 approvalItemService）。
const { dbOperations } = require('../database');
const emailDrafter = require('./emailDrafter');
const finderTasks = require('../routes/finderTasks');
const automationRuns = require('./automationRuns');

function parseJsonColumn(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch {
    return fallback;
  }
}

function followupEntry(action, ok, summary, extra = {}) {
  return { key: 'auto_followup', at: new Date().toISOString(), action, ok, summary, ...extra };
}

// 读取最新 actions_json 并追加一条 auto_followup 记录。
async function appendAutoFollowup(approvalItemId, entry) {
  const row = await dbOperations.get('SELECT actions_json FROM approval_items WHERE id = ?', [approvalItemId]);
  if (!row) return;
  const actions = parseJsonColumn(row.actions_json, []);
  const next = [...(Array.isArray(actions) ? actions : []), entry];
  await dbOperations.run(
    'UPDATE approval_items SET actions_json = ?, updated_at = NOW() WHERE id = ?',
    [JSON.stringify(next), approvalItemId]
  );
}

// ---- 失败可见化：auto_followup exception 审批卡 ----

// dedupe_key 前缀：与六类 builder 的 dedupe_key 前缀（exception:finder: / exception:email: 等）错开，
// approvalItemService 的 source_gone GC 只对 builder 前缀生效，这类手工卡天然豁免。
const AUTO_FOLLOWUP_EXCEPTION_PREFIX = 'exception:auto_followup:';

const ACTION_LABELS = {
  create_finder_task: '创建达人搜索任务',
  draft_first_touch: '生成首轮触达邮件草稿',
  draft_reply: '生成回复草稿',
  retry_finder: '重跑 Finder 任务',
  retry_run: '重跑后台任务失败项',
  record_only: '记录决定'
};

const TYPE_LABELS = {
  strategy: '策略', candidate: '达人候选', budget: '预算',
  outreach: '触达邮件', reply: '达人回复', exception: '异常'
};

const DECISION_LABELS = {
  approve: '批准', reject: '驳回', request_changes: '要求修改',
  pause: '暂缓', retry: '重试', skip: '跳过', stop: '停止'
};

// 按失败动作给老板的恢复建议
const RETRY_OPINIONS = {
  draft_first_touch: '检查达人平台信息（主页链接/邮箱）后可点击重试。',
  create_finder_task: '检查策略绑定（Campaign Product 等）后可点击重试。',
  draft_reply: '检查回复内容与达人信息后可点击重试。',
  retry_finder: '检查 Finder 任务配置后可点击重试。',
  retry_run: '排查失败原因后可点击重试（仍只重跑失败项）。'
};

// 父项类型 → 卡片“去处理”跳转（与 approvalItemService 的 href 口径一致）
function parentHref(parentRow) {
  if (!parentRow) return '/';
  if (parentRow.type === 'exception') return parentRow.subject_type === 'finder' ? '/finder' : '/emails';
  return { strategy: '/strategy', candidate: '/campaign-kols', budget: '/campaign-kols', outreach: '/emails', reply: '/emails' }[parentRow.type] || '/';
}

// 卡片四段快照（与 builder 产出同构：facts_json 内带 title/campaign_name）
function autoFollowupExceptionSnapshot(parentRow, decision, entry) {
  const parentFacts = parseJsonColumn(parentRow?.facts_json, {}) || {};
  const parentTitle = parentFacts.title || `${parentRow?.type || '事项'} #${parentRow?.subject_id ?? ''}`;
  return {
    facts: {
      title: `${parentTitle} · 自动执行失败`,
      campaign_name: parentFacts.campaign_name || '',
      facts: [
        `原决定：${TYPE_LABELS[parentRow?.type] || parentRow?.type || '未知'} · ${DECISION_LABELS[decision] || decision}`,
        `对象：${parentTitle}`,
        `尝试动作：${ACTION_LABELS[entry.action] || entry.action}`,
        `失败原因：${entry.summary}`,
        `时间：${entry.at}`
      ]
    },
    opinion: RETRY_OPINIONS[entry.action] || '排查失败原因后可点击重试，或跳过/停止该自动动作。',
    risks: ['重复失败将重复消耗 AI 额度', '后续自动流程未推进'],
    actions: [{ key: 'open', label: '去处理', href: parentHref(parentRow) }]
  };
}

// 自动后续动作失败时建卡/更新卡（幂等）：
//   - 无卡 → 插入 pending，version 1；
//   - 已有 pending 卡（同一父项未处理前重复失败）→ 命中 dedupe_key 唯一索引，
//     走 upsert 语义更新快照 + version+1，不重复建行；
//   - 老板已处理（非 pending）→ 不复活该卡，仅保留父项 actions_json 里的失败记录。
async function upsertAutoFollowupException(item, decision, entry) {
  const parentId = item.approval_item_id;
  const dedupeKey = `${AUTO_FOLLOWUP_EXCEPTION_PREFIX}${parentId}`;
  const parentRow = await dbOperations.get('SELECT * FROM approval_items WHERE id = ?', [parentId]);
  const snapshot = autoFollowupExceptionSnapshot(parentRow, decision, entry);
  const campaignId = parentRow ? parentRow.campaign_id : (item.campaign_id ?? null);
  const existing = await dbOperations.get('SELECT * FROM approval_items WHERE dedupe_key = ?', [dedupeKey]);
  if (!existing) {
    await dbOperations.run(
      `INSERT INTO approval_items
       (campaign_id, type, subject_type, subject_id, status, priority,
        facts_json, opinion_json, risks_json, actions_json, version, dedupe_key, created_at, updated_at)
       VALUES (?, 'exception', 'auto_followup', ?, 'pending', 'high', ?, ?, ?, ?, 1, ?, NOW(), NOW())`,
      [
        campaignId ?? null, parentId,
        JSON.stringify(snapshot.facts), JSON.stringify(snapshot.opinion),
        JSON.stringify(snapshot.risks), JSON.stringify(snapshot.actions),
        dedupeKey
      ]
    );
  } else if (existing.status === 'pending') {
    await dbOperations.run(
      `UPDATE approval_items
       SET campaign_id = ?, priority = 'high', facts_json = ?, opinion_json = ?, risks_json = ?, actions_json = ?,
           version = version + 1, updated_at = NOW()
       WHERE id = ?`,
      [
        campaignId ?? null,
        JSON.stringify(snapshot.facts), JSON.stringify(snapshot.opinion),
        JSON.stringify(snapshot.risks), JSON.stringify(snapshot.actions),
        existing.id
      ]
    );
  }
}

// 目标平台选择对齐 agent.js suggestedTargetPlatforms：primary → secondary → handoff.required_platforms，
// 过滤合法平台后取第一个，全部缺失时回退 youtube（与 agent brief 口径一致）。
const TARGET_PLATFORMS = ['youtube', 'instagram', 'tiktok'];

function pickTargetPlatform(strategy) {
  const handoff = parseJsonColumn(strategy.finder_handoff, {}) || {};
  const secondary = parseJsonColumn(strategy.secondary_platforms, []);
  const saved = [
    strategy.primary_platform,
    ...(Array.isArray(secondary) ? secondary : []),
    ...(Array.isArray(handoff.required_platforms) ? handoff.required_platforms : [])
  ].map((p) => String(p || '').trim().toLowerCase());
  return saved.find((p) => TARGET_PLATFORMS.includes(p)) || 'youtube';
}

// strategy approve → 自动创建该策略的 Finder 达人搜索任务。
// 绑定前置不满足（无有效 Campaign Product 等）时 createFinderTask 抛错，由调用方记为失败条目。
async function runCreateFinderTask(item) {
  const strategy = await dbOperations.get(
    'SELECT id, primary_platform, secondary_platforms, finder_handoff FROM kol_strategies WHERE id = ?',
    [item.subject_id]
  );
  if (!strategy) return followupEntry('create_finder_task', false, '策略不存在，无法创建达人搜索任务');
  const targetPlatform = pickTargetPlatform(strategy);
  const task = await finderTasks.createFinderTask({
    strategyId: strategy.id,
    targetPlatform,
    notes: '工作台批准后自动创建'
  });
  return followupEntry('create_finder_task', true,
    `已自动创建达人搜索任务 #${task.id}（${targetPlatform}）`,
    { finder_task_id: task.id });
}

// candidate approve → 首轮触达邮件草稿进审批队列（draftForCustomer 失败语义：返回 ok:false 不抛错）。
async function runDraftFirstTouch(item) {
  const kol = await dbOperations.get(
    'SELECT id, campaign_id, customer_id FROM campaign_kols WHERE id = ?',
    [item.subject_id]
  );
  if (!kol) return followupEntry('draft_first_touch', false, '合作记录不存在，无法生成触达邮件草稿');
  const result = await emailDrafter.draftForCustomer({
    campaignId: kol.campaign_id,
    customerId: kol.customer_id,
    kind: 'first_touch'
  });
  if (!result.ok) {
    return followupEntry('draft_first_touch', false, `触达邮件草稿生成失败：${result.error}`);
  }
  return followupEntry('draft_first_touch', true,
    `已自动生成首轮触达邮件草稿 #${result.draftId}，待审批`,
    { draft_id: result.draftId });
}

// reply approve（确认回复）→ 生成 kind='reply' 回复草稿（与 /replies/:id/draft-reply 同一逻辑）。
async function runDraftReply(item) {
  const reply = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [item.subject_id]);
  if (!reply) return followupEntry('draft_reply', false, '回复不存在，无法生成回复草稿');
  const result = await emailDrafter.draftForCustomer({
    campaignId: reply.campaign_id,
    customerId: reply.customer_id,
    kind: 'reply',
    sourceReplyId: reply.id
  });
  if (!result.ok) {
    return followupEntry('draft_reply', false, `回复草稿生成失败：${result.error}`);
  }
  return followupEntry('draft_reply', true,
    `已自动生成回复草稿 #${result.draftId}，待审批`,
    { draft_id: result.draftId });
}

// exception retry（finder）→ 复用既有重跑入口重新执行失败的 Finder 任务。
// 阶段 D2 起该入口按 finder_tasks.checkpoint_json 断点续跑：已完成节点（搜索/导入）不重跑，
// 只补未完成部分，不重复消耗供应商额度。
async function runRetryFinder(item) {
  const task = await dbOperations.get('SELECT id, status FROM finder_tasks WHERE id = ?', [item.subject_id]);
  if (!task) return followupEntry('retry_finder', false, 'Finder 任务不存在，无法重跑');
  await finderTasks.runVideoEvidenceDiscovery(task.id, {});
  return followupEntry('retry_finder', true,
    `已重新执行 Finder 任务 #${task.id}`,
    { finder_task_id: task.id });
}

// exception retry（automation_run，阶段 D1）→ retryFailedItems 只重跑 checkpoint 里 ok:false 的条目。
// 重跑后 run 恢复 success/partial_failed/failed；仍失败时 builder 下次 sync 会按最新状态重建异常卡。
async function runRetryAutomationRun(item) {
  const run = await automationRuns.retryFailedItems(item.subject_id);
  const progress = run.progress || {};
  if (run.status === 'success') {
    return followupEntry('retry_run', true,
      `已重跑后台任务 #${run.id} 的失败项，全部成功（共 ${progress.total ?? 0} 条）`,
      { run_id: run.id });
  }
  return followupEntry('retry_run', false,
    `后台任务 #${run.id} 重跑后仍有 ${progress.failed ?? 0} 条失败${run.last_error ? `：${run.last_error}` : ''}`,
    { run_id: run.id });
}

// auto_followup exception 卡 retry 时，按当时失败的 action 复用对应入口真重跑（以父项为参数）。
const RETRYABLE_ACTIONS = {
  draft_first_touch: runDraftFirstTouch,
  create_finder_task: runCreateFinderTask,
  draft_reply: runDraftReply,
  retry_finder: runRetryFinder,
  retry_run: runRetryAutomationRun
};

// 重跑成功：卡关闭。decision='resolved' 是系统写入值（老板只能发 retry/skip/stop），
// 语义为“异常已通过重试解决”；status 沿用 cancelled（同 retry/skip/stop 的终态映射）。
async function resolveAutoFollowupException(exceptionItemId) {
  await dbOperations.run(
    `UPDATE approval_items
     SET status = 'cancelled', decision = 'resolved', decided_at = NOW(), updated_at = NOW()
     WHERE id = ?`,
    [exceptionItemId]
  );
}

// 重跑仍失败：卡恢复 pending 并 version+1（前端按 version 变化刷新），快照更新为最新失败原因。
// decision 保留 'retry'（与 request_changes 同款“有最近决定但仍在 pending”语义），老板可再次决定。
async function reopenAutoFollowupException(item, parentRow, entry) {
  const snapshot = autoFollowupExceptionSnapshot(parentRow, 'retry', entry);
  await dbOperations.run(
    `UPDATE approval_items
     SET status = 'pending', priority = 'high',
         facts_json = ?, opinion_json = ?, risks_json = ?, actions_json = ?,
         version = version + 1, updated_at = NOW()
     WHERE id = ?`,
    [
      JSON.stringify(snapshot.facts), JSON.stringify(snapshot.opinion),
      JSON.stringify(snapshot.risks), JSON.stringify(snapshot.actions),
      item.approval_item_id
    ]
  );
}

// auto_followup exception 卡 retry：读父项 actions_json 中最后一条 ok:false 的 auto_followup，
// 按其 action 重跑。该路径自包含记录（父项追加 + 本卡状态更新），continueAfterDecision 不再追加。
async function runRetryAutoFollowup(item) {
  const parentId = item.subject_id;
  const parentRow = await dbOperations.get('SELECT * FROM approval_items WHERE id = ?', [parentId]);
  let entry;
  if (!parentRow) {
    entry = followupEntry('retry_auto_followup', false, '原审批事项不存在，无法重跑');
  } else {
    const parentActions = parseJsonColumn(parentRow.actions_json, []);
    const lastFailure = [...(Array.isArray(parentActions) ? parentActions : [])].reverse()
      .find((a) => a && a.key === 'auto_followup' && a.ok === false);
    const rerun = lastFailure && RETRYABLE_ACTIONS[lastFailure.action];
    if (!rerun) {
      entry = followupEntry('retry_auto_followup', false, '未找到可重跑的失败动作记录');
    } else {
      const parentItem = {
        approval_item_id: parentRow.id,
        type: parentRow.type,
        subject_type: parentRow.subject_type,
        subject_id: parentRow.subject_id,
        campaign_id: parentRow.campaign_id
      };
      try {
        entry = await rerun(parentItem);
      } catch (error) {
        console.error(`auto follow-up 重跑失败 (approval_item ${parentId}):`, error.message);
        entry = followupEntry(lastFailure.action, false, `AI 自动执行失败：${error.message}`);
      }
    }
  }
  if (parentRow) {
    try {
      await appendAutoFollowup(parentId, entry);
    } catch (error) {
      console.error(`auto follow-up 重跑记录失败 (approval_item ${parentId}):`, error.message);
    }
  }
  try {
    if (entry.ok) await resolveAutoFollowupException(item.approval_item_id);
    else await reopenAutoFollowupException(item, parentRow, entry);
  } catch (error) {
    console.error(`auto followup exception 卡状态更新失败 (approval_item ${item.approval_item_id}):`, error.message);
  }
  return entry;
}

// 人工决定 → 自动执行映射（spec 第十节）；无映射的决定（reject 等）返回 null 不触发。
function resolveFollowUp(item, decision) {
  if (item.type === 'strategy' && decision === 'approve') {
    return { action: 'create_finder_task', run: runCreateFinderTask };
  }
  if (item.type === 'reply' && decision === 'approve') {
    return { action: 'draft_reply', run: runDraftReply };
  }
  if (item.type === 'exception' && decision === 'retry') {
    if (item.subject_type === 'auto_followup') {
      // 自动后续动作失败卡：按父项与当时失败的 action 真重跑（自包含记录，见 runRetryAutoFollowup）
      return { action: 'retry_auto_followup', run: runRetryAutoFollowup, selfRecorded: true };
    }
    if (item.subject_type === 'finder') return { action: 'retry_finder', run: runRetryFinder };
    if (item.subject_type === 'automation_run') return { action: 'retry_run', run: runRetryAutomationRun };
    return {
      action: 'record_only',
      run: async () => followupEntry('record_only', true, '邮件发送失败的重试属后续阶段，本阶段仅记录决定')
    };
  }
  if (item.type === 'budget' && decision === 'approve') {
    return {
      action: 'record_only',
      run: async () => followupEntry('record_only', true, '预算已批准；寄样、合同与内容执行属后续阶段（P3），本阶段仅记录')
    };
  }
  return null;
}

// 决定副作用成功后的编排入口。永不抛错：单步失败降级为 ok:false 条目。
async function continueAfterDecision(item, { decision } = {}) {
  const followUp = resolveFollowUp(item, decision);
  if (!followUp) return null;
  let entry;
  try {
    entry = await followUp.run(item);
  } catch (error) {
    console.error(`auto follow-up ${followUp.action} failed (approval_item ${item.approval_item_id}):`, error.message);
    entry = followupEntry(followUp.action, false, `AI 自动执行失败：${error.message}`);
  }
  // selfRecorded 路径（auto_followup exception 的 retry 重跑）已在 run 内部完成
  // 父项 actions_json 追加与 exception 卡状态更新，这里不再重复记录，也不触发建卡。
  if (followUp.selfRecorded) return entry;
  try {
    await appendAutoFollowup(item.approval_item_id, entry);
  } catch (error) {
    console.error(`auto follow-up 记录失败 (approval_item ${item.approval_item_id}):`, error.message);
  }
  // 失败可见化：除 actions_json 记录外，在工作台建一张 exception 审批卡（幂等 upsert）。
  // 建卡失败只记日志，绝不向决定路径抛错。
  if (!entry.ok) {
    try {
      await upsertAutoFollowupException(item, decision, entry);
    } catch (error) {
      console.error(`auto followup exception 建卡失败 (approval_item ${item.approval_item_id}):`, error.message);
    }
  }
  return entry;
}

module.exports = { continueAfterDecision };
