// 审批后的 AI 自动流转编排（老板工作台阶段 C3，spec 第十节“审批后的自动工作流”）。
// 人工决定的即时副作用由 decisionDispatcher 完成后，异步调用 continueAfterDecision：
//   strategy  approve → 复用 finderTasks.createFinderTask 自动创建达人搜索任务
//                        （与 POST /api/finder-tasks 同一条创建路径，含 Ready Strategy 绑定校验）
//   candidate approve → emailDrafter.draftForCustomer 生成 kind='first_touch' 草稿进审批队列
//   reply     approve → 复用 /api/emails/replies/:id/draft-reply 逻辑生成 kind='reply' 回复草稿
//   exception retry   → finder 异常复用 runVideoEvidenceDiscovery 重跑；email send_failed 本阶段只记录
//   budget    approve → 寄样/合同执行属 P3，本阶段只记录
//
// 失败隔离：单步失败（缺绑定、无邮箱、快照回抓失败等）只记录日志并写入 auto_followup 条目，
// 绝不向决定路径抛错。每次触发结果以 { key: 'auto_followup', ... } 追加到
// approval_items.actions_json，供工作台展示“AI 已继续执行”。
const { dbOperations } = require('../database');
const emailDrafter = require('./emailDrafter');
const finderTasks = require('../routes/finderTasks');

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
    sourceReplyId: reply.id,
    feedback: `对方回复内容：${(reply.body_text || '').slice(0, 2000)}`
  });
  if (!result.ok) {
    return followupEntry('draft_reply', false, `回复草稿生成失败：${result.error}`);
  }
  return followupEntry('draft_reply', true,
    `已自动生成回复草稿 #${result.draftId}，待审批`,
    { draft_id: result.draftId });
}

// exception retry（finder）→ 复用既有重跑入口重新执行失败的 Finder 任务。
async function runRetryFinder(item) {
  const task = await dbOperations.get('SELECT id, status FROM finder_tasks WHERE id = ?', [item.subject_id]);
  if (!task) return followupEntry('retry_finder', false, 'Finder 任务不存在，无法重跑');
  await finderTasks.runVideoEvidenceDiscovery(task.id, {});
  return followupEntry('retry_finder', true,
    `已重新执行 Finder 任务 #${task.id}`,
    { finder_task_id: task.id });
}

// 人工决定 → 自动执行映射（spec 第十节）；无映射的决定（reject 等）返回 null 不触发。
function resolveFollowUp(item, decision) {
  if (item.type === 'strategy' && decision === 'approve') {
    return { action: 'create_finder_task', run: runCreateFinderTask };
  }
  if (item.type === 'candidate' && decision === 'approve') {
    return { action: 'draft_first_touch', run: runDraftFirstTouch };
  }
  if (item.type === 'reply' && decision === 'approve') {
    return { action: 'draft_reply', run: runDraftReply };
  }
  if (item.type === 'exception' && decision === 'retry') {
    if (item.subject_type === 'finder') return { action: 'retry_finder', run: runRetryFinder };
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
  try {
    await appendAutoFollowup(item.approval_item_id, entry);
  } catch (error) {
    console.error(`auto follow-up 记录失败 (approval_item ${item.approval_item_id}):`, error.message);
  }
  return entry;
}

module.exports = { continueAfterDecision };
