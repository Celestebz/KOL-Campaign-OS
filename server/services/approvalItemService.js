// 统一审核事项服务（老板工作台阶段 C）。
// 职责：
//   syncApprovalItems()  跑六类 builder，按 dedupe_key upsert 到 approval_items（快照语义见 spec 第九节）；
//   list/get/summary     供 /api/approvals 与 /api/workbench 读取；
//   submitDecision()     统一决定入口：version 乐观锁 + 状态映射 + 既有业务副作用。
const { dbOperations } = require('../database');
const { buildAllApprovalItems } = require('./approvalBuilders');
const decisionDispatcher = require('./decisionDispatcher');
const { iso } = require('./approvalBuilders/shared');

const APPROVAL_TYPES = new Set(['strategy', 'candidate', 'outreach', 'reply', 'budget', 'exception']);

// decision → status 映射（spec 8.1：待审核/已批准/已驳回/已取消）
const DECISION_TO_STATUS = {
  approve: 'approved',
  reject: 'rejected',
  request_changes: 'pending', // 留在待审核并 version+1，等待 AI 按意见更新
  pause: 'cancelled',
  retry: 'cancelled',
  skip: 'cancelled',
  stop: 'cancelled'
};

const DECISION_LABELS = {
  approve: '已通过',
  reject: '已驳回',
  request_changes: '要求修改',
  pause: '已暂缓',
  retry: '重试',
  skip: '已跳过',
  stop: '已停止',
  resolved: '已解决' // 系统写入：auto_followup exception 卡 retry 重跑成功（workflowOrchestrator）
};

// builder 产出的 dedupe_key 前缀（六类来源）。source_gone GC 只对这些前缀生效：
// 手工创建的卡（如 workflowOrchestrator 失败可见化建的 exception:auto_followup:{id}）
// 及未来任何非 builder 来源的卡不参与“源已消失”取消，避免被 sync 误伤。
const BUILDER_DEDUPE_PREFIXES = [
  'strategy:', 'candidate:', 'budget:', 'outreach:', 'reply:',
  'exception:finder:', 'exception:email:', 'exception:run:'
];

const TYPE_HREFS = {
  strategy: '/strategy',
  candidate: '/campaign-kols',
  budget: '/campaign-kols',
  outreach: '/emails',
  reply: '/emails'
};

function serviceError(message, statusCode, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function parseJsonColumn(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch {
    // mysql2 会把 JSON 列里的字符串标量直接读成未加引号的纯文本（如 opinion），
    // 此时 JSON.parse 必然失败，原样返回该字符串即可
    return typeof value === 'string' ? value : fallback;
  }
}

// 工作台卡片 legacy id（阶段 B 契约）：strategy:1 / exception:finder:6 / exception:run:31 等；
// auto_followup 失败卡沿用其 dedupe_key 形态，避免与 exception:email:{draft_id} 撞 id
function legacyItemId(row) {
  if (row.type === 'exception') {
    if (row.subject_type === 'auto_followup') return `exception:auto_followup:${row.subject_id}`;
    if (row.subject_type === 'automation_run') return `exception:run:${row.subject_id}`;
    return `exception:${row.subject_type === 'finder' ? 'finder' : 'email'}:${row.subject_id}`;
  }
  return `${row.type}:${row.subject_id}`;
}

// builder 产出 → 四段快照。title/campaign_name 是老板决定时看到的卡片标题，
// 属于“当时基于什么事实做决定”的一部分，随 facts_json 一起保存。
function snapshotOf(built) {
  return {
    facts: { title: built.title || '', campaign_name: built.campaign_name || '', facts: built.facts || [] },
    opinion: built.opinion || '',
    risks: built.risks || [],
    actions: built.actions || []
  };
}

// 变化指纹：只覆盖展示内容，不含源 updated_at（避免纯时间戳触碰引发无谓 version 递增）。
// 注意 MySQL JSON 列会按 key 排序存储，读回后 key 顺序与写入时不一致，
// 因此指纹必须用 key 排序后的稳定序列化，否则每次 sync 都会误判"已变化"。
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function fingerprintOf(priority, snapshot) {
  return stableStringify({ priority, ...snapshot });
}

function fingerprintFromRow(row) {
  return stableStringify({
    priority: row.priority || 'none',
    facts: parseJsonColumn(row.facts_json, null),
    opinion: parseJsonColumn(row.opinion_json, null),
    risks: parseJsonColumn(row.risks_json, null),
    actions: parseJsonColumn(row.actions_json, null)
  });
}

function toApiItem(row) {
  const factsSnap = parseJsonColumn(row.facts_json, {}) || {};
  return {
    id: legacyItemId(row),
    approval_item_id: row.id,
    type: row.type,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    campaign_id: row.campaign_id,
    campaign_name: factsSnap.campaign_name || '',
    title: factsSnap.title || '',
    status: row.status,
    risk_level: row.priority || 'none',
    version: row.version,
    facts: Array.isArray(factsSnap.facts) ? factsSnap.facts : [],
    opinion: parseJsonColumn(row.opinion_json, '') ?? '',
    risks: parseJsonColumn(row.risks_json, []) || [],
    actions: parseJsonColumn(row.actions_json, []) || [],
    decision: row.decision || null,
    decision_note: row.decision_note || null,
    decided_by: row.decided_by || null,
    decided_at: iso(row.decided_at),
    dedupe_key: row.dedupe_key,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at)
  };
}

// ---- 同步：六类 builder → approval_items ----
async function syncApprovalItems() {
  const built = await buildAllApprovalItems();
  const existingRows = await dbOperations.query('SELECT * FROM approval_items');
  const byDedupeKey = new Map(existingRows.map((row) => [row.dedupe_key, row]));
  const seenKeys = new Set();
  let inserted = 0;
  let updated = 0;
  let cancelled = 0;

  for (const item of built) {
    seenKeys.add(item.dedupe_key);
    const snapshot = snapshotOf(item);
    const existing = byDedupeKey.get(item.dedupe_key);
    if (!existing) {
      // 新待办：插入 pending 快照
      await dbOperations.run(
        `INSERT INTO approval_items
         (campaign_id, type, subject_type, subject_id, status, priority,
          facts_json, opinion_json, risks_json, actions_json, version, dedupe_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 1, ?, NOW(), NOW())`,
        [
          item.campaign_id ?? null, item.type, item.subject_type, item.subject_id,
          item.risk_level || 'none',
          JSON.stringify(snapshot.facts), JSON.stringify(snapshot.opinion),
          JSON.stringify(snapshot.risks), JSON.stringify(snapshot.actions),
          item.dedupe_key
        ]
      );
      inserted += 1;
    } else if (existing.status === 'pending'
      && fingerprintOf(item.risk_level || 'none', snapshot) !== fingerprintFromRow(existing)) {
      // 待审核且源数据已变化（如草稿被编辑）：更新快照并 version+1
      await dbOperations.run(
        `UPDATE approval_items
         SET campaign_id = ?, subject_type = ?, subject_id = ?, priority = ?,
             facts_json = ?, opinion_json = ?, risks_json = ?, actions_json = ?,
             version = version + 1, updated_at = NOW()
         WHERE id = ?`,
        [
          item.campaign_id ?? null, item.subject_type, item.subject_id, item.risk_level || 'none',
          JSON.stringify(snapshot.facts), JSON.stringify(snapshot.opinion),
          JSON.stringify(snapshot.risks), JSON.stringify(snapshot.actions),
          existing.id
        ]
      );
      updated += 1;
    }
    // 已决定的（非 pending）不动：保留老板决定时的快照
  }

  // 源已消失的 pending 项标记 cancelled（仅 builder 来源；手工卡豁免，见 BUILDER_DEDUPE_PREFIXES）
  for (const row of existingRows) {
    if (row.status === 'pending' && !seenKeys.has(row.dedupe_key)
      && BUILDER_DEDUPE_PREFIXES.some((prefix) => String(row.dedupe_key || '').startsWith(prefix))) {
      await dbOperations.run(
        `UPDATE approval_items
         SET status = 'cancelled', decision = 'source_gone', decided_at = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [row.id]
      );
      cancelled += 1;
    }
  }

  return { scanned: built.length, inserted, updated, cancelled };
}

// ---- 查询 ----
async function getApprovalItem(id) {
  const row = await dbOperations.get('SELECT * FROM approval_items WHERE id = ?', [id]);
  return row ? toApiItem(row) : null;
}

async function listApprovalItems({ status, type } = {}) {
  if (status && !['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
    throw serviceError(`无效的 status：${status}`, 400);
  }
  if (type && !APPROVAL_TYPES.has(type)) {
    throw serviceError(`无效的 type：${type}`, 400);
  }
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (type) { conditions.push('type = ?'); params.push(type); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await dbOperations.query(
    `SELECT * FROM approval_items ${where} ORDER BY updated_at DESC, id DESC LIMIT 200`,
    params
  );
  return rows.map(toApiItem);
}

// 工作台待审核列表：保持阶段 B 的类型分组顺序（strategy→candidate→budget→outreach→reply→exception）
async function listPendingWorkbenchItems() {
  const rows = await dbOperations.query(
    `SELECT ai.* FROM approval_items ai
     LEFT JOIN campaigns c ON c.id = ai.campaign_id
     WHERE ai.status = 'pending' AND (ai.campaign_id IS NULL OR c.status = 'active')
     ORDER BY FIELD(ai.type, 'strategy', 'candidate', 'budget', 'outreach', 'reply', 'exception'),
              ai.updated_at DESC, ai.id DESC`
  );
  return rows.map(toApiItem);
}

function exceptionText(item) {
  return [item.title, item.opinion, ...(item.facts || []), ...(item.risks || [])]
    .filter(Boolean).join('｜');
}

function exceptionCategory(item) {
  const text = exceptionText(item);
  if (/无法连接 AI 接口|connect EACCES|api\.minimaxi\.com/i.test(text)) {
    return {
      key: 'ai_service_unavailable',
      title: 'AI 邮件生成服务暂时不可用',
      what_happened: '系统已完成达人审核，但暂时无法调用 AI 生成触达邮件或回复草稿。',
      recommendation: '先检查 AI 服务网络连接；恢复后再统一重试，不需要逐条修改达人资料。',
      urgency: 'high'
    };
  }
  if (/YouTube API Key 未配置|YouTube.*API Key/i.test(text)) {
    return {
      key: 'youtube_api_key_missing',
      title: 'YouTube 数据服务尚未配置',
      what_happened: '达人搜索需要读取 YouTube 数据，但系统没有可用的 API Key。',
      recommendation: '到系统设置补充 YouTube API Key，然后重试达人搜索。',
      urgency: 'medium'
    };
  }
  if (/Authorization|API secret key|binding failed|login fail/i.test(text)) {
    return {
      key: 'finder_authorization_failed',
      title: '达人搜索服务鉴权失败',
      what_happened: '搜索已经产生部分结果，但保存或收尾时没有通过服务鉴权。',
      recommendation: '检查 Finder 的 Authorization 配置；已有搜索结果无需重新抓取。',
      urgency: 'medium'
    };
  }
  const normalized = text.replace(/#?\d+/g, '#').slice(0, 120);
  return {
    key: `other:${item.subject_type}:${normalized}`,
    title: item.subject_type === 'automation_run' ? '后台自动任务未完成' : '自动流程未完成',
    what_happened: '系统未能完成预定的自动步骤。',
    recommendation: item.opinion || '查看技术详情，确认原因后再决定是否重试。',
    urgency: item.risk_level === 'high' ? 'high' : 'medium'
  };
}

function summarizeExceptionGroups(items) {
  const groups = new Map();
  items.filter((item) => item.type === 'exception').forEach((item) => {
    const category = exceptionCategory(item);
    if (!groups.has(category.key)) groups.set(category.key, {
      ...category,
      affected_count: 0,
      campaigns: [],
      item_ids: [],
      technical_details: []
    });
    const group = groups.get(category.key);
    group.affected_count += 1;
    group.item_ids.push(item.id);
    if (item.campaign_name && !group.campaigns.includes(item.campaign_name)) group.campaigns.push(item.campaign_name);
    const detail = (item.facts || []).find((fact) => /失败原因|错误信息|失败节点/.test(fact));
    if (detail && !group.technical_details.includes(detail)) group.technical_details.push(detail);
  });
  const urgencyOrder = { high: 0, medium: 1, low: 2 };
  return [...groups.values()].sort((a, b) =>
    (urgencyOrder[a.urgency] ?? 9) - (urgencyOrder[b.urgency] ?? 9)
      || b.affected_count - a.affected_count
  );
}

// summary 口径与阶段 B 一致：pending 不含 exception；handled_today 为 approval_items 当日人工决定数
async function getSummary() {
  const [row, unmatchedReplyRow] = await Promise.all([
    dbOperations.get(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'pending' AND type <> 'exception' THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN status = 'pending' AND type <> 'exception' AND priority = 'high' THEN 1 ELSE 0 END), 0) AS high_risk,
       COALESCE(SUM(CASE WHEN status = 'pending' AND type = 'exception' THEN 1 ELSE 0 END), 0) AS exceptions,
       COALESCE(SUM(CASE WHEN decision IS NOT NULL AND decision <> 'source_gone'
                          AND decided_at IS NOT NULL AND DATE(decided_at) = CURDATE() THEN 1 ELSE 0 END), 0) AS handled_today
     FROM approval_items`
    ),
    dbOperations.get(
      `SELECT COUNT(*) AS unmatched_replies
       FROM email_replies
       WHERE confirm_status = 'pending' AND campaign_id IS NULL`
    )
  ]);
  return {
    pending: Number(row?.pending || 0),
    high_risk: Number(row?.high_risk || 0),
    exceptions: Number(row?.exceptions || 0),
    handled_today: Number(row?.handled_today || 0),
    unmatched_replies: Number(unmatchedReplyRow?.unmatched_replies || 0)
  };
}

function runLabel(runType) {
  return { email_draft_batch: '批量生成邮件草稿' }[runType] || runType || '后台任务';
}

// 只读聚合当前正在运行的自动化与达人寻找任务，不要求老板手工维护状态。
async function listActiveRuns() {
  const [runs, finderTasks] = await Promise.all([
    dbOperations.query(
      `SELECT r.*, c.name AS campaign_name
       FROM automation_runs r LEFT JOIN campaigns c ON c.id = r.campaign_id
       WHERE r.status = 'running' AND c.status = 'active' ORDER BY r.started_at DESC, r.id DESC`
    ),
    dbOperations.query(
      `SELECT f.*, c.name AS campaign_name
       FROM finder_tasks f LEFT JOIN campaigns c ON c.id = f.campaign_id
       WHERE f.status = 'running' AND c.status = 'active' ORDER BY f.started_at DESC, f.id DESC`
    )
  ]);
  const automation = runs.map((row) => {
    const progress = parseJsonColumn(row.progress_json, {}) || {};
    return {
      id: row.id, source: 'automation_run', campaign_id: row.campaign_id,
      campaign_name: row.campaign_name || '', task_name: runLabel(row.run_type),
      current_node: row.current_node || '执行中', total: Number(progress.total || 0),
      completed: Number(progress.completed || 0), started_at: iso(row.started_at),
      next_step: '完成后进入下一审核节点；失败则进入异常处理'
    };
  });
  const finder = finderTasks.map((row) => ({
    id: row.id, source: 'finder_task', campaign_id: row.campaign_id,
    campaign_name: row.campaign_name || '', task_name: row.name || '寻找候选达人',
    current_node: '搜索与验证达人', total: Number(row.result_count || 0),
    completed: Number(row.success_count || 0) + Number(row.failed_count || 0),
    started_at: iso(row.started_at), next_step: '生成候选达人，等待人工审核'
  }));
  return [...automation, ...finder].sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
}

// 最近 10 条人工决定（含 request_changes 这类仍为 pending 的决定；不含 source_gone 自动取消）
async function listRecentDecisions(limit = 10) {
  const rows = await dbOperations.query(
    `SELECT * FROM approval_items
     WHERE decision IS NOT NULL AND decision <> 'source_gone' AND decided_at IS NOT NULL
     ORDER BY decided_at DESC, id DESC
     LIMIT ?`,
    [limit]
  );
  return rows.map((row) => {
    const item = toApiItem(row);
    const followup = [...(item.actions || [])].reverse().find((action) => action && action.key === 'auto_followup');
    const href = row.type === 'exception'
      ? (row.subject_type === 'finder' ? '/finder' : '/emails')
      : (TYPE_HREFS[row.type] || '/');
    return {
      title: item.title,
      decision: DECISION_LABELS[row.decision] || row.decision,
      decided_at: item.decided_at,
      followup_summary: followup ? followup.summary : '',
      href
    };
  });
}

// ---- 决定 ----
async function submitDecision(id, { decision, note, version, decided_by } = {}) {
  if (!DECISION_TO_STATUS[decision]) {
    throw serviceError(`不支持的决定类型：${decision}`, 400);
  }
  const row = await dbOperations.get('SELECT * FROM approval_items WHERE id = ?', [id]);
  if (!row) throw serviceError('审核事项不存在', 404);
  if (row.status !== 'pending') throw serviceError('该事项已处理，不能重复决定', 409);
  if (Number(version) !== Number(row.version)) {
    throw serviceError('该事项已更新，请查看最新版本后重新决定', 409, { currentVersion: row.version });
  }

  // 先执行既有业务副作用，成功后再记录决定，避免决定与业务状态分叉。
  // 副作用失败（如策略缺必填字段、草稿已被处理）将阻止决定写入并返回对应错误。
  await decisionDispatcher.dispatchDecisionSideEffects(toApiItem(row), { decision, note });

  const nextStatus = DECISION_TO_STATUS[decision];
  const versionBump = decision === 'request_changes' ? ', version = version + 1' : '';
  await dbOperations.run(
    `UPDATE approval_items
     SET status = ?, decision = ?, decision_note = ?, decided_by = ?, decided_at = NOW(), updated_at = NOW()${versionBump}
     WHERE id = ?`,
    [nextStatus, decision, note || null, decided_by || null, id]
  );
  return getApprovalItem(id);
}

async function submitCandidateDecisions(items, { decision, note, decided_by } = {}) {
  if (!['approve', 'reject'].includes(decision)) {
    throw serviceError('候选达人批量审核只支持通过或淘汰', 400);
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
    throw serviceError('请选择 1–100 位候选达人', 400);
  }
  const results = [];
  for (const entry of items) {
    const row = await dbOperations.get('SELECT * FROM approval_items WHERE id = ?', [entry.id]);
    if (!row || row.type !== 'candidate') {
      results.push({ id: entry.id, success: false, error: '候选审核事项不存在' });
      continue;
    }
    try {
      const item = await submitDecision(entry.id, {
        decision, note, version: entry.version, decided_by
      });
      results.push({ id: entry.id, success: true, item });
    } catch (error) {
      results.push({ id: entry.id, success: false, error: error.message });
    }
  }
  return {
    succeeded: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    results
  };
}

module.exports = {
  APPROVAL_TYPES,
  DECISION_TO_STATUS,
  syncApprovalItems,
  getApprovalItem,
  listApprovalItems,
  listPendingWorkbenchItems,
  summarizeExceptionGroups,
  getSummary,
  listActiveRuns,
  listRecentDecisions,
  submitDecision,
  submitCandidateDecisions
};
