import axios from 'axios';

// UI 评审阶段：true 使用内置假数据，不调后端；
// 后端接口就绪后改为 false 即切换到真实 API（或删除 mock 分支）。
export const USE_MOCK = true;

const mockDelay = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 假数据 ----

let mockSettings = {
  smtp_host: 'smtp.qiye.aliyun.com',
  smtp_port: 465,
  smtp_secure: true,
  imap_host: 'imap.qiye.aliyun.com',
  imap_port: 993,
  imap_secure: true,
  username: 'marketing@example.com',
  password: '••••••••',
  sender_name: 'MOOER Marketing',
  default_cc: 'boss@example.com',
  poll_interval_minutes: 5
};

let mockTemplates = [
  {
    id: 1,
    name: '外联邮件写作规范 v1',
    kind: 'style_guide',
    subject: '',
    body_html: '三段式：首句自我介绍+引用达人1-2条真实视频；中段说明提供免费寄样、5%佣金、无固定费、一条完播视频及截止日期；结尾CTA。自然段落，不用列表符号和破折号，不超过120个英文单词。只允许引用真实视频数据，禁止编造。草坪养护类达人CTA需确认是否有15-45HP PTO拖拉机。',
    created_at: '2026-07-24 08:00:00'
  },
  {
    id: 2,
    name: '固定模板 - 规格说明书索取回复',
    kind: 'fixed',
    subject: 'Re: {{campaign_name}} - 产品规格',
    body_html: '<p>Hi {{contact_name}},</p><p>感谢回复，附件是 {{product_names}} 的规格说明书。</p>',
    created_at: '2026-07-24 08:01:00'
  }
];

const mockVariables = {
  kol_name: 'KOL名称',
  contact_name: '联系人姓名',
  campaign_name: '项目名称',
  product_names: '合作产品',
  cooperation_type: '合作方式',
  sender_name: '发件人署名'
};

let mockDrafts = [
  {
    id: 103,
    campaign_id: 1,
    customer_id: 13,
    kind: 'first_touch',
    kol_name: 'LawnCare Daily',
    campaign_name: 'TMB-1401 割草机海外推广',
    subject: 'Your Honda vs Toro breakdown was exactly what homeowners need',
    body_text: 'Hi Jake, I am Lily from TMB. Your Honda vs Toro zero-turn comparison last week was the clearest breakdown I have seen, and 210K viewers seem to agree. We make the TMB-1401 robotic mower and would love to send you one to keep, plus 5% commission on sales from your video. To be upfront, there is no fixed fee on this one. We would need one full review within 30 days of delivery. Do you have a 15-45HP PTO tractor on hand for the terrain test? Reply and I will send the full specs.',
    status: 'approved',
    risk_level: 'none',
    risk_reasons: [],
    evidence: {
      snapshot_date: '2026-07-23',
      videos: [
        { youtube_video_id: 'lc901', title: 'Honda vs Toro zero-turn: honest 2026 comparison', views: 210000, published_at: '2026-07-18' },
        { youtube_video_id: 'lc902', title: 'Why your mower stripes look bad (and how to fix)', views: 156000, published_at: '2026-07-09' }
      ],
      match_reason: '草坪养护垂直达人，近30天6条视频均播17万，受众为北美家庭用户，与TMB-1401目标市场一致。',
      metrics: { followers: '186K', avg_views_30d: 172000, median_views_30d: 165000, posts_30d: 6 }
    },
    generated_at: '2026-07-24 08:33:00'
  },
  {
    id: 101,
    campaign_id: 1,
    customer_id: 11,
    kind: 'first_touch',
    kol_name: 'PedalLab',
    campaign_name: 'TMB-1401 割草机海外推广',
    subject: 'Loved your robotic mower stress test — TMB-1401 collab?',
    body_text: 'Hi team, I am Lily from TMB. Your robotic mower stress test hit 1.2M views and for good reason. We make the TMB-1401 and would love you to review it. We can offer $800 for a dedicated video, plus a free unit and 5% commission. Reply if interested and I will send specs.',
    status: 'pending_review',
    risk_level: 'high',
    risk_reasons: [
      { code: 'PRICE_COMMITMENT', message: '正文出现 "$800" 金额承诺，违反无固定费口径' },
      { code: 'METRIC_MISMATCH', message: '正文引用播放量 1.2M，快照实际为 980K' },
      { code: 'MISSING_REQUIRED_TERM', message: '缺少"无固定费"与截止日期说明' }
    ],
    evidence: {
      snapshot_date: '2026-07-22',
      videos: [
        { youtube_video_id: 'pl101', title: 'I tortured a robotic mower for 30 days', views: 980000, published_at: '2026-07-05' },
        { youtube_video_id: 'pl102', title: 'Robotic mower vs riding mower: the math', views: 640000, published_at: '2026-06-28' }
      ],
      match_reason: '园艺工具评测频道，近30天5条视频均播62万，受众DIY家庭用户占比高。',
      metrics: { followers: '412K', avg_views_30d: 620000, median_views_30d: 580000, posts_30d: 5 }
    },
    generated_at: '2026-07-24 08:30:00'
  },
  {
    id: 102,
    campaign_id: 1,
    customer_id: 12,
    kind: 'first_touch',
    kol_name: 'GuitarBoi',
    campaign_name: 'TMB-1401 割草机海外推广',
    subject: 'Quick collab idea for your backyard series',
    body_text: 'Hi Alex, I am Lily from TMB. Your backyard workshop series has a great vibe. We make the TMB-1401 robotic mower and would like to send you one to keep, plus 5% commission on sales from your video. There is no fixed fee on this one. We would need one full video within 30 days of delivery. Want me to send the specs?',
    status: 'pending_review',
    risk_level: 'low',
    risk_reasons: [
      { code: 'STALE_SNAPSHOT', message: '起草所用快照为 10 天前，超过 7 天新鲜度阈值' },
      { code: 'MISSING_VIDEO_REFERENCE', message: '正文未引用任何真实视频标题' }
    ],
    evidence: {
      snapshot_date: '2026-07-14',
      videos: [
        { youtube_video_id: 'gb201', title: 'Building a backyard studio shed in 7 days', views: 88000, published_at: '2026-07-02' }
      ],
      match_reason: '内容偏木工/DIY，与割草机品类相关性弱，建议人工判断是否继续。',
      metrics: { followers: '95K', avg_views_30d: 76000, median_views_30d: 71000, posts_30d: 4 }
    },
    generated_at: '2026-07-24 08:31:00'
  }
];

let mockRecords = [
  { id: 3, kol_name: 'GuitarBoi', to_address: 'guitarboi@gmail.com', subject: 'Quick collab idea...', status: 'success', error: null, created_at: '2026-07-23 14:02:11' },
  { id: 2, kol_name: 'PedalLab', to_address: 'hello@pedallab.com', subject: 'Loved your robotic mower stress test', status: 'success', error: null, created_at: '2026-07-23 14:02:10' },
  { id: 1, kol_name: 'AmpQueen', to_address: null, subject: '合作邀约', status: 'failed', error: '无收件人地址', created_at: '2026-07-23 14:02:09' }
];

let mockReplies = [
  {
    id: 2,
    kol_name: 'PedalLab',
    campaign_name: 'TMB-1401 割草机海外推广',
    from_address: 'hello@pedallab.com',
    subject: 'Re: Loved your robotic mower stress test',
    body_text: 'Hi Lily, thanks for reaching out! The TMB-1401 looks interesting. A few questions: do you ship to Canada? And just to confirm, the 5% commission is on top of the free unit, right?',
    received_at: '2026-07-24 09:12:00',
    ai_summary: '对方有兴趣，询问是否寄送加拿大、5%佣金是否含免费样机。',
    ai_intent: 'question',
    ai_status: 'success',
    confirm_status: 'pending'
  },
  {
    id: 1,
    kol_name: 'GuitarBoi',
    campaign_name: 'TMB-1401 割草机海外推广',
    from_address: 'guitarboi@gmail.com',
    subject: 'Re: Quick collab idea for your backyard series',
    body_text: 'Hey Lily, appreciate the offer but I am going to pass - mowers are a bit far from my usual content. Good luck with the launch!',
    received_at: '2026-07-24 08:40:00',
    ai_summary: '对方婉拒：割草机与其内容方向不符。',
    ai_intent: 'rejected',
    ai_status: 'success',
    confirm_status: 'pending'
  }
];

const renderMock = (text, vars) => String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g,
  (m, key) => (vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : ''));

// ---- 邮箱配置 ----

export async function getEmailSettings() {
  if (USE_MOCK) { await mockDelay(); return { ...mockSettings }; }
  const res = await axios.get('/api/emails/settings');
  return res.data.data;
}

export async function saveEmailSettings(values) {
  if (USE_MOCK) { await mockDelay(); mockSettings = { ...mockSettings, ...values }; return; }
  await axios.put('/api/emails/settings', values);
}

export async function testEmailSettings() {
  if (USE_MOCK) { await mockDelay(800); return 'SMTP 连接成功（模拟数据）'; }
  const res = await axios.post('/api/emails/settings/test');
  return res.data.message;
}

// ---- 模板与口径 ----

export async function getEmailTemplates() {
  if (USE_MOCK) { await mockDelay(); return [...mockTemplates]; }
  const res = await axios.get('/api/emails/templates');
  return res.data.data || [];
}

export async function getEmailVariables() {
  if (USE_MOCK) { await mockDelay(100); return { ...mockVariables }; }
  const res = await axios.get('/api/emails/templates/variables');
  return res.data.data || {};
}

export async function createEmailTemplate(values) {
  if (USE_MOCK) {
    await mockDelay();
    mockTemplates = [{ id: Date.now(), ...values, created_at: new Date().toISOString() }, ...mockTemplates];
    return;
  }
  await axios.post('/api/emails/templates', values);
}

export async function updateEmailTemplate(id, values) {
  if (USE_MOCK) {
    await mockDelay();
    mockTemplates = mockTemplates.map((t) => (t.id === id ? { ...t, ...values } : t));
    return;
  }
  await axios.put(`/api/emails/templates/${id}`, values);
}

export async function deleteEmailTemplate(id) {
  if (USE_MOCK) { await mockDelay(); mockTemplates = mockTemplates.filter((t) => t.id !== id); return; }
  await axios.delete(`/api/emails/templates/${id}`);
}

// ---- 草稿（审批台） ----

const draftCounts = () => ({
  pending_review: mockDrafts.filter((d) => d.status === 'pending_review').length,
  high_risk: mockDrafts.filter((d) => d.status === 'pending_review' && d.risk_level === 'high').length,
  approved: mockDrafts.filter((d) => d.status === 'approved').length
});

export async function getDrafts(filters = {}) {
  if (USE_MOCK) {
    await mockDelay();
    let list = [...mockDrafts];
    if (filters.status) list = list.filter((d) => d.status === filters.status);
    if (filters.kind) list = list.filter((d) => d.kind === filters.kind);
    if (filters.risk_level) list = list.filter((d) => d.risk_level === filters.risk_level);
    return { drafts: list, counts: draftCounts() };
  }
  const res = await axios.get('/api/emails/drafts', { params: filters });
  return res.data.data;
}

export async function getDraft(id) {
  if (USE_MOCK) { await mockDelay(100); return mockDrafts.find((d) => d.id === id) || null; }
  const res = await axios.get(`/api/emails/drafts/${id}`);
  return res.data.data;
}

export async function saveDraft(id, { subject, body_text }) {
  if (USE_MOCK) {
    await mockDelay();
    mockDrafts = mockDrafts.map((d) => (d.id === id ? { ...d, subject, body_text } : d));
    return;
  }
  await axios.put(`/api/emails/drafts/${id}`, { subject, body_text });
}

export async function regenerateDraft(id, feedback) {
  if (USE_MOCK) {
    await mockDelay(1200);
    mockDrafts = mockDrafts.map((d) => (d.id === id ? {
      ...d,
      body_text: `${d.body_text}\n\n[已根据反馈重新生成${feedback ? `：${feedback}` : ''}，此处为新 AI 正文]`,
      risk_level: 'low',
      risk_reasons: [{ code: 'MISSING_VIDEO_REFERENCE', message: '重新生成后未引用真实视频（模拟）' }],
      generated_at: new Date().toISOString()
    } : d));
    return mockDrafts.find((d) => d.id === id);
  }
  const res = await axios.post(`/api/emails/drafts/${id}/regenerate`, { feedback });
  return res.data.data;
}

export async function approveDraft(id) {
  if (USE_MOCK) {
    await mockDelay();
    mockDrafts = mockDrafts.map((d) => (d.id === id ? { ...d, status: 'approved' } : d));
    return;
  }
  await axios.post(`/api/emails/drafts/${id}/approve`);
}

export async function rejectDraft(id, reason) {
  if (USE_MOCK) {
    await mockDelay();
    mockDrafts = mockDrafts.map((d) => (d.id === id ? { ...d, status: 'rejected', reviewer_note: reason } : d));
    return;
  }
  await axios.post(`/api/emails/drafts/${id}/reject`, { reason });
}

export async function sendDraft(id) {
  if (USE_MOCK) {
    await mockDelay(800);
    const draft = mockDrafts.find((d) => d.id === id);
    if (!draft || draft.status !== 'approved') {
      const error = new Error('草稿未批准，不能发送');
      error.response = { status: 409, data: { error: '草稿未批准，不能发送' } };
      throw error;
    }
    mockDrafts = mockDrafts.map((d) => (d.id === id ? { ...d, status: 'sent' } : d));
    mockRecords = [{
      id: Date.now(), kol_name: draft.kol_name, to_address: 'creator@example.com',
      subject: draft.subject, status: 'success', error: null, created_at: new Date().toISOString()
    }, ...mockRecords];
    return { status: 'sent' };
  }
  const res = await axios.post(`/api/emails/drafts/${id}/send`);
  return res.data.data;
}

export async function generateDrafts({ campaign_id, customer_ids, kind = 'first_touch' }) {
  if (USE_MOCK) {
    await mockDelay(1500);
    return {
      results: customer_ids.map((id) => ({ customer_id: id, ok: true, draft_id: Date.now() + id }))
    };
  }
  const res = await axios.post('/api/emails/drafts/generate', { campaign_id, customer_ids, kind });
  return res.data.data;
}

// ---- 发送记录 ----

export async function getEmailRecords(status) {
  if (USE_MOCK) {
    await mockDelay();
    const records = status ? mockRecords.filter((r) => r.status === status) : [...mockRecords];
    return { records, total: records.length };
  }
  const res = await axios.get('/api/emails/records', { params: status ? { status } : {} });
  return res.data.data;
}

// ---- 回复 ----

export async function getEmailReplies(confirmStatus) {
  if (USE_MOCK) {
    await mockDelay();
    return confirmStatus ? mockReplies.filter((r) => r.confirm_status === confirmStatus) : [...mockReplies];
  }
  const res = await axios.get('/api/emails/replies', { params: confirmStatus ? { confirm_status: confirmStatus } : {} });
  return res.data.data || [];
}

export async function confirmReply(id, summary) {
  if (USE_MOCK) { await mockDelay(); mockReplies = mockReplies.filter((r) => r.id !== id); return; }
  await axios.post(`/api/emails/replies/${id}/confirm`, { summary });
}

export async function ignoreReply(id) {
  if (USE_MOCK) { await mockDelay(); mockReplies = mockReplies.filter((r) => r.id !== id); return; }
  await axios.post(`/api/emails/replies/${id}/ignore`);
}

export async function retryReplySummary(id) {
  if (USE_MOCK) {
    await mockDelay(800);
    mockReplies = mockReplies.map((r) => (r.id === id ? {
      ...r, ai_summary: '（重试生成的模拟摘要）', ai_intent: 'other', ai_status: 'success'
    } : r));
    return;
  }
  await axios.post(`/api/emails/replies/${id}/retry-summary`);
}

export async function draftReply(id) {
  if (USE_MOCK) {
    await mockDelay(1200);
    const reply = mockReplies.find((r) => r.id === id);
    mockDrafts = [{
      id: Date.now(),
      campaign_id: 1,
      customer_id: reply?.id || 0,
      kind: 'reply',
      kol_name: reply?.kol_name || '未知',
      campaign_name: reply?.campaign_name || '',
      subject: `Re: ${reply?.subject || ''}`,
      body_text: 'Hi, thanks for the questions. Yes, we ship to Canada, and the 5% commission is on top of the free unit. I will send over the spec sheet and the commission agreement draft now.',
      status: 'pending_review',
      risk_level: 'low',
      risk_reasons: [{ code: 'MISSING_REQUIRED_TERM', message: '回复草稿未含截止日期说明（模拟）' }],
      evidence: null,
      generated_at: new Date().toISOString()
    }, ...mockDrafts];
    return;
  }
  await axios.post(`/api/emails/replies/${id}/draft-reply`);
}

// ---- 固定模板预览/发送（原发邮件入口，kind='fixed'） ----

export async function previewEmail({ campaignKolId, templateId, kol }) {
  if (USE_MOCK) {
    await mockDelay();
    const template = mockTemplates.find((t) => t.id === templateId);
    if (!template) throw new Error('模板不存在');
    const vars = {
      kol_name: kol?.kol_name || kol?.kol_name_snapshot || '示例KOL',
      contact_name: kol?.contact_name || kol?.contact_name_snapshot || kol?.kol_name_snapshot || 'Creator',
      campaign_name: kol?.campaign_name || 'TMB-1401 割草机海外推广',
      product_names: kol?.product_name || kol?.product_sku || 'TMB-1401',
      cooperation_type: '付费＋产品',
      sender_name: mockSettings.sender_name || ''
    };
    return {
      to: kol?.contact_email_override || kol?.email_snapshot || kol?.email || 'creator@example.com',
      subject: renderMock(template.subject, vars),
      body_html: renderMock(template.body_html, vars)
    };
  }
  const res = await axios.post('/api/emails/preview', { campaignKolId, templateId });
  return res.data.data;
}

export async function sendEmails(payload) {
  if (USE_MOCK) {
    await mockDelay(900);
    const total = payload.campaignKolIds.length;
    return { total, success: total, failed: 0, errors: [] };
  }
  const res = await axios.post('/api/emails/send', payload);
  return res.data.data;
}
