import axios from 'axios';

// 邮件中心前端 API 封装：全部走真实后端接口（/api/emails/*）。

// ---- 邮箱配置 ----

export async function getEmailSettings() {
  const res = await axios.get('/api/emails/settings');
  return res.data.data;
}

export async function saveEmailSettings(values) {
  await axios.put('/api/emails/settings', values);
}

export async function testEmailSettings() {
  const res = await axios.post('/api/emails/settings/test');
  return res.data.message;
}

export async function testImapSettings() {
  const res = await axios.post('/api/emails/settings/test-imap');
  return res.data.message;
}

export async function syncEmailNow() {
  const res = await axios.post('/api/emails/settings/sync-now');
  return res.data.message;
}

export async function getEmailSyncStatus() {
  const res = await axios.get('/api/emails/settings/sync-status');
  return res.data.data;
}

// ---- 模板与口径 ----

export async function getEmailTemplates() {
  const res = await axios.get('/api/emails/templates');
  return res.data.data || [];
}

export async function getEmailVariables() {
  const res = await axios.get('/api/emails/templates/variables');
  return res.data.data || {};
}

export async function createEmailTemplate(values) {
  await axios.post('/api/emails/templates', values);
}

export async function updateEmailTemplate(id, values) {
  await axios.put(`/api/emails/templates/${id}`, values);
}

export async function deleteEmailTemplate(id) {
  await axios.delete(`/api/emails/templates/${id}`);
}

// ---- 草稿（审批台） ----

export async function getDrafts(filters = {}) {
  const res = await axios.get('/api/emails/drafts', { params: filters });
  return res.data.data;
}

export async function getDraft(id) {
  const res = await axios.get(`/api/emails/drafts/${id}`);
  return res.data.data;
}

export async function saveDraft(id, { subject, body_text }) {
  await axios.put(`/api/emails/drafts/${id}`, { subject, body_text });
}

export async function regenerateDraft(id, feedback) {
  const res = await axios.post(`/api/emails/drafts/${id}/regenerate`, { feedback });
  return res.data.data;
}

// 返回发送结果 data（含 threading_missing 标记），调用方可据此提示线程归属风险
export async function approveDraft(id) {
  const res = await axios.post(`/api/emails/drafts/${id}/approve`, undefined, { timeout: 60000 });
  return res.data.data;
}
export async function rejectDraft(id, reason) {
  await axios.post(`/api/emails/drafts/${id}/reject`, { reason });
}

export async function sendDraft(id) {
  const res = await axios.post(`/api/emails/drafts/${id}/send`, undefined, { timeout: 60000 });
  return res.data.data;
}

export async function confirmManualSent(id) {
  const res = await axios.post(`/api/emails/drafts/${id}/confirm-manual-sent`);
  return res.data.data;
}

export async function confirmNotSent(id) {
  const res = await axios.post(`/api/emails/drafts/${id}/confirm-not-sent`);
  return res.data.data;
}

// 异步后台起草：接口立即返回 run_id + 排队/跳过明细，不再同步等待生成结果。
export async function generateDrafts({ campaign_id, customer_ids, kind = 'first_touch' }) {
  const res = await axios.post('/api/emails/drafts/generate', { campaign_id, customer_ids, kind });
  const data = res.data.data || {};
  return {
    run_id: data.run_id ?? null,
    total_requested: data.total_requested ?? (customer_ids || []).length,
    queued: data.queued ?? 0,
    skipped: Array.isArray(data.skipped) ? data.skipped : []
  };
}

// 轮询后台起草任务进度（GET /api/automation-runs/:id）。
export async function getAutomationRun(id) {
  const res = await axios.get(`/api/automation-runs/${id}`);
  return res.data.data;
}

// ---- 审批台顶部指标卡 ----
// 单接口出错返回 200 + 字段为 null 的 payload；这里统一给前端兜底空对象，
// 避免调用方每次都要判 res.data.success。
export async function getApprovalDashboardSummary() {
  const res = await axios.get('/api/emails/approval-dashboard/summary');
  const data = res.data?.data || {};
  return {
    todayContactedKols: data.todayContactedKols ?? null,
    weekContactedKols: data.weekContactedKols ?? null,
    previousWeekContactedKols: data.previousWeekContactedKols ?? null,
    weekDifference: data.weekDifference ?? null,
    replyRate30d: data.replyRate30d ?? null,
    repliedKols30d: data.repliedKols30d ?? null,
    deliveredKols30d: data.deliveredKols30d ?? null,
    bounceRate30d: data.bounceRate30d ?? null,
    bouncedEmails30d: data.bouncedEmails30d ?? null,
    hardBounces30d: data.hardBounces30d ?? null,
    softBounces30d: data.softBounces30d ?? null,
    sentEmails30d: data.sentEmails30d ?? null,
    denominatorType: data.denominatorType ?? 'sent_success',
    timezone: data.timezone ?? 'Asia/Shanghai'
  };
}

// ---- 发送记录 ----

export async function getEmailRecords(status, params = {}) {
  const res = await axios.get('/api/emails/records', { params: { ...(status ? { status } : {}), ...params } });
  return res.data.data;
}

// ---- 回复 ----

export async function getEmailReplies(confirmStatus) {
  const res = await axios.get('/api/emails/replies', { params: confirmStatus ? { confirm_status: confirmStatus } : {} });
  return res.data.data || [];
}

export async function getReplyTodos() {
  const res = await axios.get('/api/emails/replies', { params: { scope: 'needs_reply' } });
  return res.data.data || [];
}

export async function getUnmatchedReplies() {
  const res = await axios.get('/api/emails/replies', { params: { scope: 'unmatched' } });
  return res.data.data || [];
}

export async function getCampaignReplies(campaignId) {
  const res = await axios.get('/api/emails/replies', { params: { campaign_id: campaignId } });
  return res.data.data || [];
}

export async function bindReply(id, customerId, campaignId) {
  const res = await axios.post(`/api/emails/replies/${id}/bind`, {
    customer_id: customerId,
    ...(campaignId ? { campaign_id: campaignId } : {})
  });
  return res.data.data;
}

export async function confirmReply(id, summary, intent) {
  await axios.post(`/api/emails/replies/${id}/confirm`, { summary, intent });
}

export async function getBlockedReplies() {
  const res = await axios.get('/api/emails/replies', { params: { scope: 'blocked' } });
  return res.data.data || [];
}

export async function getSystemEmails() {
  const res = await axios.get('/api/emails/replies', { params: { scope: 'system' } });
  return res.data.data || [];
}

export async function blockReply(id, blockScope) {
  const res = await axios.post(`/api/emails/replies/${id}/block`, { block_scope: blockScope, handled_by: 'boss' });
  return res.data.data;
}

export async function restoreReply(id) {
  await axios.post(`/api/emails/replies/${id}/restore`);
}

export async function getEmailFilterRules() {
  const res = await axios.get('/api/emails/filter-rules');
  return res.data.data || [];
}

export async function createEmailFilterRule(ruleType, ruleValue) {
  const res = await axios.post('/api/emails/filter-rules', { rule_type: ruleType, rule_value: ruleValue });
  return res.data.data;
}

export async function setEmailFilterRuleActive(id, active) {
  await axios.put(`/api/emails/filter-rules/${id}`, { active });
}

export async function deleteEmailFilterRule(id) {
  await axios.delete(`/api/emails/filter-rules/${id}`);
}

export async function ignoreReply(id) {
  await axios.post(`/api/emails/replies/${id}/ignore`);
}

export async function markReplyManuallyHandled(id) {
  const res = await axios.post(`/api/emails/replies/${id}/manually-replied`, { handled_by: 'boss' });
  return res.data.data;
}

export async function retryReplySummary(id) {
  await axios.post(`/api/emails/replies/${id}/retry-summary`);
}

// 返回完整响应（含 message 与 data.draftId），便于调用方直接加载草稿详情
export async function draftReply(id) {
  const res = await axios.post(`/api/emails/replies/${id}/draft-reply`);
  return res.data;
}

// ---- 邮件会话（thread）工作台 ----

// 会话详情：thread + campaign + customer + 合并时间线 + 当前待审草稿
export async function getThread(id) {
  const res = await axios.get(`/api/emails/threads/${id}`);
  return res.data.data;
}

// 会话内起草回复：已有待审草稿时后端复用并返回 message='已有草稿，复用现有'
export async function draftThreadReply(id, { feedback, reply_id } = {}) {
  const res = await axios.post(`/api/emails/threads/${id}/draft-reply`, {
    ...(feedback ? { feedback } : {}),
    ...(reply_id ? { reply_id } : {})
  });
  return res.data;
}

// 手动刷新会话滚动摘要
export async function refreshThreadContext(id) {
  const res = await axios.post(`/api/emails/threads/${id}/context/refresh`);
  return res.data;
}

// 人工归属：把回复绑到指定项目/KOL/会话
export async function reassignReply(id, payload) {
  const res = await axios.post(`/api/emails/replies/${id}/reassign`, payload);
  return res.data.data;
}

// ---- 固定模板预览/发送（原发邮件入口，kind='fixed'） ----

const renderTemplate = (text, vars) => String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g,
  (m, key) => (vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : ''));

// 纯前端变量填充预览：后端无预览接口，模板对象由调用方传入（来自真实模板列表）。
export async function previewEmail({ kol, template }) {
  const tpl = template;
  if (!tpl) throw new Error('模板不存在');
  let senderName = '';
  try {
    const settings = await getEmailSettings();
    senderName = settings?.sender_name || '';
  } catch (error) {
    senderName = '';
  }
  const vars = {
    kol_name: kol?.kol_name || kol?.kol_name_snapshot || '示例KOL',
    contact_name: kol?.contact_name || kol?.contact_name_snapshot || kol?.kol_name_snapshot || 'Creator',
    campaign_name: kol?.campaign_name || '',
    product_names: kol?.product_name || kol?.product_sku || '',
    cooperation_type: '付费＋产品',
    sender_name: senderName
  };
  return {
    to: kol?.contact_email_override || kol?.email_snapshot || kol?.email || '',
    subject: renderTemplate(tpl.subject, vars),
    body_html: renderTemplate(tpl.body_html, vars)
  };
}

// 后端 P1 没有固定模板"直接发送"接口：如实提示并引导走 AI 起草 + 审批台流程。
export async function sendEmails() {
  throw new Error('固定模板直接发送暂未开放（P2）。请改用「AI 起草邮件」，在「邮件中心 → 审批台」批准后发送。');
}
