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

export async function approveDraft(id) {
  await axios.post(`/api/emails/drafts/${id}/approve`);
}

export async function rejectDraft(id, reason) {
  await axios.post(`/api/emails/drafts/${id}/reject`, { reason });
}

export async function sendDraft(id) {
  const res = await axios.post(`/api/emails/drafts/${id}/send`);
  return res.data.data;
}

export async function generateDrafts({ campaign_id, customer_ids, kind = 'first_touch' }) {
  const res = await axios.post('/api/emails/drafts/generate', { campaign_id, customer_ids, kind });
  return res.data.data;
}

// ---- 发送记录 ----

export async function getEmailRecords(status) {
  const res = await axios.get('/api/emails/records', { params: status ? { status } : {} });
  return res.data.data;
}

// ---- 回复 ----

export async function getEmailReplies(confirmStatus) {
  const res = await axios.get('/api/emails/replies', { params: confirmStatus ? { confirm_status: confirmStatus } : {} });
  return res.data.data || [];
}

export async function confirmReply(id, summary) {
  await axios.post(`/api/emails/replies/${id}/confirm`, { summary });
}

export async function ignoreReply(id) {
  await axios.post(`/api/emails/replies/${id}/ignore`);
}

export async function retryReplySummary(id) {
  await axios.post(`/api/emails/replies/${id}/retry-summary`);
}

export async function draftReply(id) {
  await axios.post(`/api/emails/replies/${id}/draft-reply`);
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
