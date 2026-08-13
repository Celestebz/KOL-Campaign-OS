import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Descriptions, Divider, Drawer, Dropdown, Empty, Form, Input, InputNumber, List, message, Modal, Popconfirm, Progress, Select, Space, Spin, Table, Tag } from 'antd';
import { CheckOutlined, DeleteOutlined, EditOutlined, MailOutlined, ReloadOutlined, RobotOutlined, SyncOutlined } from '@ant-design/icons';
import axios from 'axios';
import { describeSyncResult } from './campaignKolSyncResult';
import { getMainStatus, getSubStatusLabel, SUB_STATUS_LABELS } from './campaignKolStatus';
import { getEmailTemplates, previewEmail, sendEmails, generateDrafts, getAutomationRun } from './emailApi';

const { TextArea } = Input;

// 细分状态仍用于编辑表单/筛选；列表与详情展示收敛为主状态（见 campaignKolStatus.js）。
// eslint-disable-next-line no-unused-vars
const statusOptions = Object.entries(SUB_STATUS_LABELS).map(([value, label]) => ({ value, label }));

const priorityOptions = [
  { value: 't1', label: 'T1｜优先联系' },
  { value: 't2', label: 'T2｜中等优先' },
  { value: 't3', label: 'T3｜候补' },
  { value: 't4', label: 'T4｜不建议继续' }
];

const currencyOptions = [
  { value: 'GBP', label: 'GBP（£ 英镑）' },
  { value: 'USD', label: 'USD（$ 美元）' },
  { value: 'EUR', label: 'EUR（€ 欧元）' },
  { value: 'CNY', label: 'CNY（¥ 人民币）' }
];

const cooperationTypeOptions = [
  { value: 'paid_product', label: '付费＋产品' },
  { value: 'product_exchange', label: '产品置换' },
  { value: 'other', label: '其他' }
];

const platformOptions = ['YouTube', 'Instagram', 'TikTok', 'Facebook', 'X']
  .map((value) => ({ value, label: value }));

const assignmentStatusOptions = [
  { value: 'active', label: '进行中' },
  { value: 'paused', label: '已暂停' },
  { value: 'completed', label: '已完成' },
  { value: 'archived', label: '已归档' }
];

const sampleStatusOptions = [
  { value: 'pending', label: '待处理' },
  { value: 'sent', label: '已寄出' },
  { value: 'received', label: '已收到' },
  { value: 'returned', label: '已退回' }
];

const contentStatusOptions = [
  { value: 'pending', label: '待处理' },
  { value: 'draft', label: '草稿' },
  { value: 'review', label: '审核中' },
  { value: 'published', label: '已发布' }
];

const cooperationTypeLabel = (value) => (
  cooperationTypeOptions.find((item) => item.value === value)?.label || '付费＋产品'
);

const normalizeCurrency = (value) => ({
  英镑: 'GBP', '£': 'GBP',
  美元: 'USD', '$': 'USD',
  欧元: 'EUR', '€': 'EUR',
  人民币: 'CNY', '¥': 'CNY', RMB: 'CNY'
}[value] || value || undefined);

const formatFee = (value, currency) => {
  if (value === undefined || value === null || value === '') return '-';
  const number = Number(value);
  const code = normalizeCurrency(currency);
  if (!Number.isFinite(number) || !currencyOptions.some((item) => item.value === code)) {
    return `${value}${code ? ` ${code}` : ''}`;
  }
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: code }).format(number);
};

const parsePlatforms = (value, fallback = []) => {
  let values = fallback;
  if (Array.isArray(value)) values = value;
  else if (value) {
    try { values = JSON.parse(value); } catch (error) { values = fallback; }
  }
  const labels = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', x: 'X', twitter: 'X' };
  return values.map((item) => labels[String(item).toLowerCase()] || item).filter(Boolean);
};

// 项目名历史上以「项目｜产品」合并文本存储（半角 | 与全角 ｜ 混用），
// 列表与筛选需要拆成独立的项目名与产品两段。
export const splitCampaignName = (name) => {
  const text = String(name || '').trim();
  const parts = text.split(/[｜|]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return { project: text, product: '' };
  return { project: parts[0], product: parts.slice(1).join(' | ') };
};

export const normalizeLegacyProjectStatus = (value) => ({
  confirmed: 'pending_shipping',
  candidate: 'pending_confirmation'
}[String(value || '').toLowerCase()] || value);

export const normalizeLegacyPriority = (value) => ({
  normal: 't2'
}[String(value || '').toLowerCase()] || String(value || '').toLowerCase() || undefined);

const EMAIL_PLACEHOLDERS = new Set(['没邮箱', '没有邮箱', '无邮箱', '暂无邮箱', '无', '-', 'n/a', 'none']);

export const displayEmail = (currentEmail, snapshotEmail) => (
  [currentEmail, snapshotEmail]
    .map((value) => String(value || '').trim())
    .find((value) => value && !EMAIL_PLACEHOLDERS.has(value.toLowerCase()))
  || '-'
);

// 外联阶段不包含邮件待办；waiting_reply/replied 仅用于旧数据兼容展示。
export const OUTREACH_STATUS_OPTIONS = [
  { value: 'not_contacted', label: '待联系' },
  { value: 'contacted', label: '已联系' },
  { value: 'negotiating', label: '沟通中' },
  { value: 'interested', label: '有意向' },
  { value: 'confirmed', label: '已确认' },
  { value: 'terminated', label: '已终止' }
];

// UI preview: outreach phase and email work queue are separate dimensions.
export const OUTREACH_PHASE_OPTIONS = OUTREACH_STATUS_OPTIONS;

export const hasPendingEmail = (row) => Boolean(
  row?.needs_reply ?? ['waiting_reply', 'replied'].includes(String(row?.outreach_status || '').toLowerCase())
);

export const outreachPhaseForDisplay = (value) => (
  ['waiting_reply', 'replied'].includes(String(value || '').toLowerCase()) ? 'negotiating' : (value || 'not_contacted')
);

export const OUTREACH_STATUS_LABELS = {
  not_contacted: '待联系',
  contacted: '已联系',
  replied: '待回复',
  waiting_reply: '待回复',
  negotiating: '沟通中',
  interested: '有意向',
  confirmed: '已确认',
  rejected: '已终止',
  terminated: '已终止'
};

export const OUTREACH_STATUS_COLORS = {
  contacted: 'blue',
  replied: 'gold',
  waiting_reply: 'gold',
  negotiating: 'orange',
  interested: 'green',
  confirmed: 'cyan',
  rejected: 'red',
  terminated: 'red'
};

const INTENT_OPTIONS = [
  { value: 'interested', label: '有意向' },
  { value: 'question', label: '需要沟通' },
  { value: 'unclear', label: '暂不明确' },
  { value: 'rejected', label: '已拒绝' }
];
const INTENT_LABELS = Object.fromEntries(INTENT_OPTIONS.map((item) => [item.value, item.label]));

export const PROJECT_STATUS_OPTIONS = [
  { value: 'pending_shipping', label: '待发货' },
  { value: 'shipped', label: '已发货' },
  { value: 'delivered', label: '已签收' },
  { value: 'content_preparation', label: '内容准备中' },
  { value: 'pending_publish', label: '待上线' },
  { value: 'published', label: '已上线' },
  { value: 'cancelled', label: '已取消' }
];

export const normalizeLegacyOutreach = (value) => ({
  replied: 'negotiating',
  waiting_reply: 'negotiating',
  rejected: 'terminated'
}[String(value || '').toLowerCase()] || value);

export const defaultCooperationType = (value) => value || 'product_exchange';

const RUN_TERMINAL_STATUSES = ['success', 'partial_failed', 'failed'];
const RUN_STATUS_LABEL = { running: '进行中', success: '已完成', partial_failed: '部分失败', failed: '失败' };
const RUN_POLL_INTERVAL_MS = 5000;

const CampaignKols = ({ view = 'cooperation' }) => {
  const isCandidatePool = view === 'candidate';
  const [rows, setRows] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [sheetSyncing, setSheetSyncing] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailTemplates, setEmailTemplates] = useState([]);
  const [emailTemplateId, setEmailTemplateId] = useState();
  const [emailPreviewTo, setEmailPreviewTo] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailContent, setEmailContent] = useState('');
  const [emailCc, setEmailCc] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [emailResult, setEmailResult] = useState(null);
  const [aiDrafting, setAiDrafting] = useState(false);
  const [draftRunOpen, setDraftRunOpen] = useState(false);
  const [draftRun, setDraftRun] = useState(null);
  const [draftRunError, setDraftRunError] = useState('');
  const draftPollTimerRef = useRef(null);
  const [filters, setFilters] = useState({});
  const [skuFilter, setSkuFilter] = useState();
  const [editing, setEditing] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmingId, setConfirmingId] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailRow, setDetailRow] = useState(null);
  const [masterDetail, setMasterDetail] = useState(null);
  const [history, setHistory] = useState([]);
  const [events, setEvents] = useState([]);
  const [correctingIntent, setCorrectingIntent] = useState(false);
  const [correctedIntent, setCorrectedIntent] = useState('unclear');
  const [correctionSummary, setCorrectionSummary] = useState('');
  const [savingCorrection, setSavingCorrection] = useState(false);
  const [productAssignments, setProductAssignments] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [editingAssignment, setEditingAssignment] = useState(null);
  const [assignmentForm] = Form.useForm();
  const [editProducts, setEditProducts] = useState([]);
  const [form] = Form.useForm();
  const cooperationType = Form.useWatch('cooperation_type', form);

  const campaignOptions = useMemo(() => campaigns.map((item) => ({
    value: item.id,
    label: splitCampaignName(item.name).project || item.name
  })), [campaigns]);

  // SKU 筛选在前端做：候选行一次全量返回，SKU 选项也从当前行集合去重得出。
  const skuOptions = useMemo(() => (
    [...new Set(rows.map((row) => row.product_sku).filter(Boolean))]
      .map((sku) => ({ value: sku, label: sku }))
  ), [rows]);

  const visibleRows = useMemo(() => (
    skuFilter ? rows.filter((row) => row.product_sku === skuFilter) : rows
  ), [rows, skuFilter]);

  useEffect(() => {
    fetchCampaigns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 组件卸载时清理 AI 起草进度轮询定时器。
  useEffect(() => () => {
    if (draftPollTimerRef.current) clearTimeout(draftPollTimerRef.current);
  }, []);

  const fetchCampaigns = async () => {
    const res = await axios.get('/api/campaigns');
    setCampaigns(res.data.data || []);
  };

  const fetchRows = async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/campaign-kols', {
        params: { ...filters, pipeline_stage: isCandidatePool ? 'candidate' : 'confirmed' }
      });
      setRows(res.data.data || []);
    } catch (error) {
      message.error(error.response?.data?.error || '获取项目 KOL 失败');
    } finally {
      setLoading(false);
    }
  };

  const updateFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value || undefined }));
  };

  const openEdit = async (record) => {
    setEditing(record);
    const values = { ...record };
    values.currency = normalizeCurrency(values.currency);
    values.expected_publish_at = values.expected_publish_at ? String(values.expected_publish_at).slice(0, 10) : undefined;
    values.shipping_date = values.shipping_date ? String(values.shipping_date).slice(0, 10) : undefined;
    values.project_status = normalizeLegacyProjectStatus(values.project_status);
    values.outreach_status = normalizeLegacyOutreach(values.outreach_status) || 'not_contacted';
    values.priority_level = normalizeLegacyPriority(values.priority_level);
    values.cooperation_type = defaultCooperationType(values.cooperation_type);
    values.cooperation_platforms = parsePlatforms(values.cooperation_platforms, [values.platform_account_platform].filter(Boolean));
    if (values.project_override && typeof values.project_override === 'object') {
      values.project_override = JSON.stringify(values.project_override, null, 2);
    }
    if (!isCandidatePool) {
      try {
        const response = await axios.get(`/api/campaign-kols/${record.id}/published-videos`);
        values.published_video_urls = (response.data.data || [])
          .map((video) => video.canonical_url || video.source_url)
          .join('\n');
      } catch (error) {
        values.published_video_urls = '';
        message.error('获取合作发布视频失败');
      }
    }
    try {
      const [productsResponse, campaignProductsResponse] = await Promise.all([
        axios.get('/api/products'),
        axios.get(`/api/campaigns/${record.campaign_id}/products`)
      ]);
      const attachedIds = new Set((campaignProductsResponse.data.data || []).map((item) => item.product_id));
      const productOptions = (productsResponse.data.data || [])
        .filter((item) => item.status !== 'archived')
        .map((item) => ({
          value: item.id,
          label: `${item.sku || item.name}${attachedIds.has(item.id) ? '' : '（未挂项目）'}`,
          sku: item.sku
        }));
      const currentSku = record.product_sku || splitCampaignName(record.campaign_name).product;
      const current = productOptions.find((item) => item.sku === currentSku) || null;
      values.product_id = current?.value;
      setEditProducts(productOptions);
    } catch (error) {
      setEditProducts([]);
      message.error(error.response?.data?.error || '获取产品列表失败');
    }
    form.setFieldsValue(values);
  };

  useEffect(() => {
    fetchRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.campaign_id, filters.status, filters.outreach_status, filters.sync_status, isCandidatePool]);

  const confirmCooperation = async (record) => {
    setConfirmingId(record.id);
    try {
      const response = await axios.post(`/api/campaign-kols/${record.id}/confirm-cooperation`);
      const syncs = response.data?.syncs || [];
      const succeeded = syncs.filter((item) => item.success);
      const failed = syncs.filter((item) => !item.success);
      if (succeeded.length && !failed.length) {
        const labels = [...new Set(succeeded.map((item) => item.label || '飞书'))];
        message.success(`已确认合作，并同步到${labels.join('、')}`);
      } else if (failed.length) {
        const labels = [...new Set(failed.map((item) => item.label || '飞书'))];
        const reasons = failed.map((item) => item.error || '未知错误').join('；');
        message.warning(`已确认合作，但${labels.join('、')}同步失败：${reasons}`);
      } else {
        message.warning('已确认合作，但未配置飞书导出目标，请先在设置中配置普通表格或多维表格');
      }
      fetchRows();
    } catch (error) {
      message.error(error.response?.data?.error || error.message || '确认合作失败');
    } finally {
      setConfirmingId(null);
    }
  };

  const openDetail = async (record) => {
    setDetailOpen(true);
    setDetailRow(record);
    setMasterDetail(null);
    setHistory([]);
    setEvents([]);
    setProductAssignments([]);
    setDetailError('');
    setDetailLoading(true);
    try {
      const [master, projectHistory, assignments, timelineResponse] = await Promise.all([
        axios.get(`/api/customers/${record.customer_id}`),
        axios.get(`/api/customers/${record.customer_id}/project-history`),
        axios.get(`/api/campaign-kols/${record.id}/products`),
        axios.get(`/api/campaign-kols/${record.id}/events`)
      ]);
      setMasterDetail(master.data.data);
      setHistory(projectHistory.data.data || []);
      setProductAssignments(assignments.data.data || []);
      setEvents(timelineResponse.data.data || []);
    } catch (error) {
      setDetailError('KOL 详情加载失败，请稍后重试');
    } finally {
      setDetailLoading(false);
    }
  };

  const openIntentCorrection = () => {
    setCorrectedIntent('unclear');
    setCorrectionSummary(detailRow?.last_reply_summary || '');
    setCorrectingIntent(true);
  };

  const saveIntentCorrection = async () => {
    if (!detailRow) return;
    setSavingCorrection(true);
    try {
      const response = await axios.post(`/api/campaign-kols/${detailRow.id}/events/intent-correction`, {
        intent: correctedIntent, summary: correctionSummary
      });
      const status = response.data.data.outreach_status;
      setDetailRow((row) => ({ ...row, outreach_status: status, last_reply_summary: correctionSummary, sync_status: 'sync_pending' }));
      const timelineResponse = await axios.get(`/api/campaign-kols/${detailRow.id}/events`);
      setEvents(timelineResponse.data.data || []);
      setCorrectingIntent(false);
      message.success('意向已更正');
      fetchRows();
    } catch (error) {
      message.error(error.response?.data?.error || '更正意向失败');
    } finally {
      setSavingCorrection(false);
    }
  };

  const saveEdit = async () => {
    if (!editing || savingEdit) return;
    setSavingEdit(true);
    try {
      const formValues = await form.validateFields();
      const publishedVideoUrls = formValues.published_video_urls || '';
      const values = { ...formValues };
      delete values.published_video_urls;
      // 阶段字段白名单：候选只提交外联状态，合作只提交项目状态
      if (isCandidatePool) {
        delete values.project_status;
        delete values.shipping_address;
        delete values.content_format;
        delete values.expected_publish_at;
        delete values.shipping_date;
        delete values.tracking_number;
      } else delete values.outreach_status;
      if (values.cooperation_type === 'product_exchange') {
        values.final_fee = 0;
        values.currency = null;
      }
      await axios.patch(`/api/campaign-kols/${editing.id}`, values);
      if (isCandidatePool) {
        message.success('项目 KOL 已更新');
      } else {
        try {
          await axios.put(`/api/campaign-kols/${editing.id}/published-videos`, {
            urls: publishedVideoUrls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean)
          });
          message.success('项目 KOL 已更新');
        } catch (videoError) {
          message.warning(`合作信息已保存，但发布视频保存失败：${videoError.response?.data?.error || videoError.message || '未知错误'}`);
        }
      }
      setEditing(null);
      fetchRows();
    } catch (error) {
      if (error?.errorFields) return;
      message.error(error.response?.data?.error || error.message || '保存 KOL 合作失败');
    } finally {
      setSavingEdit(false);
    }
  };

  const openEditAssignment = (record) => {
    setEditingAssignment(record);
    assignmentForm.setFieldsValue({
      assignment_status: record.assignment_status || 'active',
      sample_status: record.sample_status || 'pending',
      content_status: record.content_status || 'pending',
      quoted_fee: record.quoted_fee || ''
    });
  };

  const saveAssignment = async () => {
    if (!editingAssignment || !detailRow) return;
    const values = await assignmentForm.validateFields();
    try {
      await axios.put(`/api/campaign-kols/${detailRow.id}/products/${editingAssignment.campaign_product_id}`, values);
      message.success('产品合作状态已更新');
      setEditingAssignment(null);
      const res = await axios.get(`/api/campaign-kols/${detailRow.id}/products`);
      setProductAssignments(res.data.data || []);
    } catch (error) {
      message.error(error.response?.data?.error || '更新失败');
    }
  };

  const deleteOne = async (id) => {
    await axios.delete(`/api/campaign-kols/${id}`);
    message.success('已删除');
    fetchRows();
  };

  const batchDelete = async () => {
    await axios.delete('/api/campaign-kols/batch', { data: { ids: selectedRowKeys } });
    message.success('已删除选中记录');
    setSelectedRowKeys([]);
    fetchRows();
  };

  const syncSelected = async () => {
    setSyncing(true);
    try {
      const ids = selectedRowKeys.length
        ? selectedRowKeys
        : rows.filter((row) => !row.sync_status || ['sync_pending', 'sync_failed'].includes(row.sync_status)).map((row) => row.id);
      const res = await axios.post('/api/sync/feishu/push', {
        scope: 'campaign_kols',
        ids
      });
      const data = res.data.data;
      const result = describeSyncResult(data);
      message[result.type](result.content);
      fetchRows();
    } catch (error) {
      message.warning(error.response?.data?.error || '飞书未配置或同步失败，本地数据已保留');
    } finally {
      setSyncing(false);
    }
  };

  const syncOrdinarySheet = async () => {
    if (!filters.campaign_id) {
      message.warning('请先选择项目，再同步飞书普通表格');
      return;
    }
    const ids = selectedRowKeys.length ? selectedRowKeys : rows.map((row) => row.id);
    const sheetPurpose = isCandidatePool ? 'candidate_pool' : 'cooperation_tracking';
    const sheetLabel = isCandidatePool ? '达人资源库' : '项目合作跟进';
    if (!ids.length) {
      message.warning('当前没有可同步的 KOL');
      return;
    }
    setSheetSyncing(true);
    try {
      const preview = await axios.post('/api/sync/feishu-sheet/preview', { ids, campaign_id: filters.campaign_id, sheet_purpose: sheetPurpose });
      const summary = preview.data.data || {};
      Modal.confirm({
        title: `同步到飞书普通表格 · ${sheetLabel}`,
        content: `预计新增 ${summary.created || 0} 条、更新 ${summary.updated || 0} 条。`,
        okText: '确认同步',
        cancelText: '取消',
        onOk: async () => {
          const response = await axios.post('/api/sync/feishu-sheet/push', { ids, campaign_id: filters.campaign_id, sheet_purpose: sheetPurpose });
          const result = response.data.data || {};
          message.success(`普通表格同步完成：新增 ${result.created || 0}，更新 ${result.updated || 0}`);
        }
      });
    } catch (error) {
      message.warning(error.response?.data?.error || '飞书普通表格未配置或连接失败');
    } finally {
      setSheetSyncing(false);
    }
  };

  const feishuSyncMenu = {
    items: [
      {
        key: 'sheet',
        label: isCandidatePool ? '普通表格 · 达人资源库' : '普通表格 · 项目合作跟进'
      },
      {
        key: 'bitable',
        label: isCandidatePool ? '多维表格 · 项目候选池' : '多维表格 · 项目跟进表'
      }
    ],
    onClick: ({ key }) => {
      if (key === 'sheet') syncOrdinarySheet();
      if (key === 'bitable') syncSelected();
    }
  };

  const platformLink = (url, followers) => {
    if (!url && !followers) return '-';
    return (
      <Space direction="vertical" size={2} align="start" style={{ width: '100%' }}>
        {url ? <a style={{ display: 'block' }} href={url} target="_blank" rel="noreferrer">主页</a> : <span>-</span>}
        {followers ? <span style={{ color: '#666', display: 'block', overflowWrap: 'anywhere' }}>{followers}</span> : null}
      </Space>
    );
  };

  const openEmailModal = async () => {
    if (!selectedRowKeys.length) {
      message.warning('请先勾选要发送的 KOL');
      return;
    }
    setEmailResult(null);
    setEmailPreviewTo('');
    setEmailSubject('');
    setEmailContent('');
    setEmailCc('');
    setEmailTemplateId(undefined);
    setEmailModalOpen(true);
    try {
      setEmailTemplates(await getEmailTemplates());
    } catch (error) {
      message.error('获取邮件模板失败');
    }
  };

  const handlePreviewEmail = async (templateId) => {
    try {
      const kol = rows.find((r) => r.id === selectedRowKeys[0]) || null;
      const template = emailTemplates.find((t) => t.id === templateId) || null;
      const preview = await previewEmail({ campaignKolId: selectedRowKeys[0], templateId, kol, template });
      setEmailPreviewTo(preview.to || '');
      setEmailSubject(preview.subject || '');
      setEmailContent(preview.body_html || '');
    } catch (error) {
      message.error(error.response?.data?.error || error.message || '预览失败');
    }
  };

  const handleSendEmails = async () => {
    setEmailSending(true);
    setEmailResult(null);
    try {
      const result = await sendEmails({
        campaignKolIds: selectedRowKeys,
        templateId: emailTemplateId,
        customSubject: emailSubject || undefined,
        customContent: emailContent || undefined,
        overrideCc: emailCc || undefined
      });
      setEmailResult(result);
      if (result.failed === 0) message.success(`全部发送成功（${result.success} 封）`);
      else message.warning(`成功 ${result.success} 封，失败 ${result.failed} 封`);
      fetchRows();
    } catch (error) {
      message.warning(error.response?.data?.error || error.message || '发送失败');
    } finally {
      setEmailSending(false);
    }
  };

  const kolNameByCustomerId = (customerId) => {
    const row = rows.find((r) => r.customer_id === customerId);
    return (row && (row.kol_name || row.kol_name_snapshot)) || `KOL #${customerId}`;
  };

  const stopDraftPolling = () => {
    if (draftPollTimerRef.current) {
      clearTimeout(draftPollTimerRef.current);
      draftPollTimerRef.current = null;
    }
  };

  const pollDraftRun = async (runId) => {
    try {
      const run = await getAutomationRun(runId);
      setDraftRun(run);
      setDraftRunError('');
      if (RUN_TERMINAL_STATUSES.includes(run?.status)) return;
    } catch (error) {
      // 单次轮询失败不中断：提示后继续重试，Modal 不卡死。
      setDraftRunError('进度查询失败，将继续重试；也可稍后到「邮件中心 → 审批台」查看结果');
    }
    draftPollTimerRef.current = setTimeout(() => pollDraftRun(runId), RUN_POLL_INTERVAL_MS);
  };

  const openDraftRunModal = (runId) => {
    stopDraftPolling();
    setDraftRun(null);
    setDraftRunError('');
    setDraftRunOpen(true);
    pollDraftRun(runId);
  };

  const closeDraftRunModal = () => {
    stopDraftPolling();
    setDraftRunOpen(false);
  };

  const handleAiDraft = async () => {
    if (!selectedRowKeys.length) {
      message.warning('请先勾选要起草的 KOL');
      return;
    }
    const selectedRows = rows.filter((r) => selectedRowKeys.includes(r.id));
    const customerIds = [...new Set(selectedRows.map((r) => r.customer_id).filter(Boolean))];
    if (!customerIds.length) {
      message.warning('选中的 KOL 缺少 customer_id，无法起草');
      return;
    }
    setAiDrafting(true);
    try {
      const result = await generateDrafts({
        campaign_id: selectedRows[0]?.campaign_id,
        customer_ids: customerIds,
        kind: 'first_touch'
      });
      const queued = result?.queued ?? 0;
      const skipped = result?.skipped || [];
      const reasonSummary = [...new Set(skipped.map((item) => item.reason || '已有待审草稿'))].join('、');
      if (skipped.length) {
        Modal.info({
          title: `${skipped.length} 位 KOL 已跳过`,
          width: 520,
          content: (
            <List
              size="small"
              dataSource={skipped}
              renderItem={(item) => (
                <List.Item>{kolNameByCustomerId(item.customer_id)}：{item.reason || '已有待审草稿'}</List.Item>
              )}
            />
          ),
          okText: '知道了'
        });
      }
      if (result?.run_id) {
        message.success(skipped.length
          ? `成功提交后台起草 ${queued} 封（跳过 ${skipped.length} 封：${reasonSummary}）`
          : `成功提交后台起草 ${queued} 封`);
        openDraftRunModal(result.run_id);
      } else {
        message.info(skipped.length
          ? `选中的 KOL 全部被跳过（${reasonSummary}），未创建后台起草任务`
          : '没有可起草的 KOL，未创建后台起草任务');
      }
    } catch (error) {
      message.error('AI 起草提交失败');
    } finally {
      setAiDrafting(false);
    }
  };

  const columns = [
    { title: '项目', key: 'campaign_project', width: 130, fixed: 'left', render: (_, r) => splitCampaignName(r.campaign_name).project || '-' },
    { title: '产品SKU', key: 'campaign_product_sku', width: 130, render: (_, r) => r.product_sku || splitCampaignName(r.campaign_name).product || r.product_name || '-' },
    {
      title: 'KOL',
      key: 'kol',
      width: 190,
      fixed: 'left',
      render: (_, r) => (
        <Space direction="vertical" size={4} align="start" style={{ width: '100%', minWidth: 0 }}>
          <Button
            type="link"
            style={{ padding: 0, height: 'auto', maxWidth: '100%', whiteSpace: 'normal', textAlign: 'left', overflowWrap: 'anywhere' }}
            onClick={() => openDetail(r)}
          >
            <strong>{r.kol_name || r.kol_name_snapshot}</strong>
          </Button>
        </Space>
      )
    },
    { title: '联系人', key: 'contact_name', width: 130, render: (_, r) => r.contact_name || '-' },
    { title: 'YouTube', key: 'youtube', width: 130, render: (_, r) => platformLink(r.youtube_url || r.youtube_url_snapshot, r.youtube_followers || r.youtube_followers_snapshot) },
    { title: 'Instagram', key: 'instagram', width: 130, render: (_, r) => platformLink(r.instagram_url || r.instagram_url_snapshot, r.instagram_followers || r.instagram_followers_snapshot) },
    { title: 'TikTok', key: 'tiktok', width: 130, render: (_, r) => platformLink(r.tiktok_url || r.tiktok_url_snapshot, r.tiktok_followers || r.tiktok_followers_snapshot) },
    { title: 'Email', dataIndex: 'email_snapshot', key: 'email_snapshot', width: 200, render: (v, r) => displayEmail(r.email, v) },
    { title: '国家地区', dataIndex: 'country_region_snapshot', key: 'country_region_snapshot', width: 120, render: (v, r) => v || r.country_region || '-' },
    { title: '平台账号', key: 'platform_account', width: 150, render: (_, r) => (
      r.platform_account_url
        ? <Space direction="vertical" size={0}>
            <a href={r.platform_account_url} target="_blank" rel="noreferrer">{r.platform_account_platform || '主页'}</a>
            {r.platform_account_followers ? <span style={{ color: '#666' }}>{r.platform_account_followers}</span> : null}
          </Space>
        : '-'
    )},
    { title: '合作方式', dataIndex: 'cooperation_type', key: 'cooperation_type', width: 120, render: (v) => <Tag>{cooperationTypeLabel(v)}</Tag> },
    ...(isCandidatePool ? [{ title: '外联状态', dataIndex: 'outreach_status', key: 'outreach_status', width: 110, render: (v) => {
      const value = outreachPhaseForDisplay(v);
      return <Tag color={OUTREACH_STATUS_COLORS[value] || 'default'}>{OUTREACH_STATUS_LABELS[value] || value}</Tag>;
    } }, {
      title: '邮件待办', key: 'email_todo', width: 110,
      render: (_, record) => hasPendingEmail(record)
        ? <Tag color="gold" icon={<MailOutlined />}>待回复</Tag>
        : <span style={{ color: '#bfbfbf' }}>—</span>
    }] : []),
    { title: '合作平台', dataIndex: 'cooperation_platforms', key: 'cooperation_platforms', width: 180, render: (v, r) => {
      const values = parsePlatforms(v, [r.platform_account_platform].filter(Boolean));
      return values.length ? <Space wrap size={[4, 4]}>{values.map((value) => <Tag key={value}>{value}</Tag>)}</Space> : '-';
    } },
    { title: '优先级', dataIndex: 'priority_level', key: 'priority_level', width: 150, render: (v) => priorityOptions.find((item) => item.value === v)?.label || v || '-' },
    { title: 'KOL合作费', dataIndex: 'final_fee', key: 'final_fee', width: 140, render: (v, r) => r.cooperation_type === 'product_exchange' ? '现金 0' : formatFee(v || r.price_rmb, r.currency || 'USD') },
    ...(isCandidatePool ? [] : [    { title: '项目状态', dataIndex: 'project_status', key: 'project_status', width: 150, render: (v) => {
      const main = getMainStatus(v);
      const sub = getSubStatusLabel(v);
      return (
        <Space size={4}>
          <Tag color={main.color}>{main.label}</Tag>
          {sub && sub !== main.label && <span style={{ fontSize: 12, color: '#999' }}>{sub}</span>}
        </Space>
      );
    } }]),
    { title: '跟进人', dataIndex: 'owner', key: 'owner', width: 100, render: (v) => v || '-' },
    { title: '物流单号', dataIndex: 'tracking_number', key: 'tracking_number', width: 150, render: (v) => v || '-' },
    { title: '合作发布视频', dataIndex: 'published_video_count', key: 'published_video_count', width: 130, render: (v) => `${v || 0} 条` },
    { title: '飞书同步状态', dataIndex: 'sync_status', key: 'sync_status', width: 130, render: (v) => <Tag>{({
      sync_pending: '待同步',
      synced: '已同步',
      sync_failed: '同步失败'
    })[v] || '待同步'}</Tag> },
    { title: '项目备注', dataIndex: 'project_notes', key: 'project_notes', width: 220, ellipsis: true, render: (v, r) => v || r.notes || '-' },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      fixed: 'right',
      render: (_, record) => (
        <Space direction="vertical" size={0} align="start">
          {isCandidatePool && (
            <Popconfirm title="确认后将进入 KOL 合作，并按项目配置同步到飞书普通表格或多维表格；候选池记录会保留。" onConfirm={() => confirmCooperation(record)}>
              <Button type="link" icon={<CheckOutlined />} loading={confirmingId === record.id}>确认合作</Button>
            </Popconfirm>
          )}
          <Button type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
          <Popconfirm title="确定从项目中删除这个 KOL？" onConfirm={() => deleteOne(record.id)}>
            <Button type="link" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  const draftRunProgress = draftRun?.progress || {};
  const draftRunTotal = draftRunProgress.total ?? 0;
  const draftRunCompleted = draftRunProgress.completed ?? 0;
  const draftRunSucceeded = draftRunProgress.succeeded ?? 0;
  const draftRunFailedCount = draftRunProgress.failed ?? 0;
  const draftRunTerminal = Boolean(draftRun && RUN_TERMINAL_STATUSES.includes(draftRun.status));
  const draftRunFailedItems = (draftRun?.items || []).filter((item) => !item.ok);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{isCandidatePool ? '项目候选池' : 'KOL 合作'}</h1>
        <p className="page-subtitle">{isCandidatePool
          ? '人工确认入池、正在联络与沟通的项目候选；确认合作后转入项目跟进。'
          : '仅显示已经人工确认合作、进入发货与内容履约流程的 KOL。'}</p>
      </div>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select allowClear placeholder="项目" value={filters.campaign_id} onChange={(v) => updateFilter('campaign_id', v)} options={campaignOptions} style={{ width: 160 }} />
          <Select allowClear showSearch placeholder="产品SKU" value={skuFilter} onChange={(v) => setSkuFilter(v || undefined)} options={skuOptions} style={{ width: 150 }} />
          {isCandidatePool ? (
            <>
              <Select allowClear placeholder="外联状态" value={filters.outreach_status} onChange={(v) => updateFilter('outreach_status', v)} options={OUTREACH_PHASE_OPTIONS} style={{ width: 150 }} />
            </>
          ) : (
            <Select allowClear placeholder="项目状态" value={filters.status} onChange={(v) => updateFilter('status', v)} options={PROJECT_STATUS_OPTIONS} style={{ width: 150 }} />
          )}
          <Select allowClear placeholder="飞书同步状态" value={filters.sync_status} onChange={(v) => updateFilter('sync_status', v)} options={[
            { value: 'sync_pending', label: '待同步' },
            { value: 'synced', label: '已同步' },
            { value: 'sync_failed', label: '同步失败' }
          ]} style={{ width: 160 }} />
          <Input.Search allowClear placeholder="搜索 KOL、Email、国家、备注、视频链接" value={filters.search} onChange={(e) => updateFilter('search', e.target.value)} onSearch={fetchRows} style={{ width: 320 }} />
          <Button icon={<ReloadOutlined />} onClick={fetchRows}>刷新</Button>
          <Dropdown menu={feishuSyncMenu} trigger={['click']}>
            <Button icon={<SyncOutlined />} loading={syncing || sheetSyncing}>
              {selectedRowKeys.length ? `同步选中 ${selectedRowKeys.length} 条到飞书` : '同步到飞书'}
            </Button>
          </Dropdown>
          <Button icon={<MailOutlined />} onClick={openEmailModal} disabled={!selectedRowKeys.length}>发邮件</Button>
          <Button type="primary" icon={<RobotOutlined />} loading={aiDrafting} onClick={handleAiDraft} disabled={!selectedRowKeys.length}>AI 起草邮件</Button>
          <Popconfirm title="确定删除选中的项目 KOL？" onConfirm={batchDelete}>
            <Button danger icon={<DeleteOutlined />} disabled={!selectedRowKeys.length}>批量删除</Button>
          </Popconfirm>
        </Space>
      </Card>

      <Card className="content-card">
        <Table
          rowKey="id"
          columns={columns}
          dataSource={visibleRows}
          loading={loading}
          rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys, preserveSelectedRowKeys: true }}
          scroll={{ x: 2100 }}
          pagination={{ defaultPageSize: 10, showSizeChanger: true }}
        />
      </Card>

      <Drawer title={detailRow ? `${detailRow.kol_name || detailRow.kol_name_snapshot} · 合作详情` : 'KOL 合作详情'}
        width={760} open={detailOpen} onClose={() => setDetailOpen(false)}
        extra={detailRow && <Button icon={<EditOutlined />} onClick={() => openEdit(detailRow)}>编辑当前项目</Button>}>
        {detailLoading ? <Spin /> : detailError ? <Alert type="error" message={detailError} /> : detailRow && (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Descriptions title="KOL 主档" bordered column={2} size="small">
              <Descriptions.Item label="KOL">{masterDetail?.name || detailRow.kol_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="国家地区">{masterDetail?.country_region || detailRow.country_region || '-'}</Descriptions.Item>
              <Descriptions.Item label="Email">{masterDetail?.email || detailRow.email || '-'}</Descriptions.Item>
              <Descriptions.Item label="电话">{masterDetail?.phone || detailRow.phone || '-'}</Descriptions.Item>
              <Descriptions.Item label="默认报价">{masterDetail?.video_price || masterDetail?.price_rmb || '-'}</Descriptions.Item>
              <Descriptions.Item label="合作风险">{masterDetail?.cooperation_risk_reason || '-'}</Descriptions.Item>
            </Descriptions>
            <Descriptions title="当前项目" bordered column={2} size="small">
              <Descriptions.Item label="项目">{detailRow.campaign_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="项目状态"><Tag color={getMainStatus(detailRow.project_status).color}>{getMainStatus(detailRow.project_status).label}</Tag></Descriptions.Item>
              <Descriptions.Item label="细分阶段">{getSubStatusLabel(detailRow.project_status) || '-'}</Descriptions.Item>
              <Descriptions.Item label="合作方式">{cooperationTypeLabel(detailRow.cooperation_type)}</Descriptions.Item>
              <Descriptions.Item label="合作平台">{parsePlatforms(detailRow.cooperation_platforms, [detailRow.platform_account_platform].filter(Boolean)).join('、') || '-'}</Descriptions.Item>
              <Descriptions.Item label="KOL合作费">{formatFee(detailRow.final_fee || detailRow.price_rmb, detailRow.currency || 'USD')}</Descriptions.Item>
              <Descriptions.Item label="优先级">{priorityOptions.find((item) => item.value === detailRow.priority_level)?.label || detailRow.priority_level || '-'}</Descriptions.Item>
              <Descriptions.Item label="物流单号">{detailRow.tracking_number || '-'}</Descriptions.Item>
              <Descriptions.Item label="跟进人">{detailRow.owner || '-'}</Descriptions.Item>
              <Descriptions.Item label="项目备注">{detailRow.project_notes || detailRow.notes || '-'}</Descriptions.Item>
            </Descriptions>
            <div>
              <h3>产品合作分配</h3>
              {productAssignments.length ? (
                <Table size="small" rowKey="id" pagination={false} dataSource={productAssignments} columns={[
                  { title: '产品', dataIndex: 'product_name' },
                  { title: '角色', dataIndex: 'role', render: (v) => v || '-' },
                  { title: '分配状态', dataIndex: 'assignment_status', render: (v) => assignmentStatusOptions.find((item) => item.value === v)?.label || v || '-' },
                  { title: '样品状态', dataIndex: 'sample_status', render: (v) => sampleStatusOptions.find((item) => item.value === v)?.label || v || '-' },
                  { title: '内容状态', dataIndex: 'content_status', render: (v) => contentStatusOptions.find((item) => item.value === v)?.label || v || '-' },
                  { title: '报价', dataIndex: 'quoted_fee', render: (v) => v || '-' },
                  { title: '匹配分', dataIndex: 'fit_score', render: (v) => v ?? '-' },
                  {
                    title: '操作',
                    key: 'action',
                    render: (_, record) => (
                      <Button type="link" icon={<EditOutlined />} onClick={() => openEditAssignment(record)}>编辑</Button>
                    )
                  }
                ]} />
              ) : <Empty description="暂无产品分配" />}
            </div>
            <div>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <h3 style={{ margin: 0 }}>跟进时间线</h3>
                {isCandidatePool && <Button size="small" onClick={openIntentCorrection}>更正意向</Button>}
              </Space>
              {events.length ? <List size="small" dataSource={events} renderItem={(event) => (
                <List.Item>
                  <List.Item.Meta
                    title={<Space wrap>
                      <span>{new Date(event.occurred_at).toLocaleString('zh-CN')}</span>
                      <Tag>{event.event_type === 'intent_corrected' ? '人工更正意向' : '邮件回复确认'}</Tag>
                      {event.confirmed_intent && <Tag color="blue">{INTENT_LABELS[event.confirmed_intent] || event.confirmed_intent}</Tag>}
                      {event.ai_intent && event.ai_intent !== event.confirmed_intent && <span style={{ color: '#999' }}>AI：{INTENT_LABELS[event.ai_intent] || event.ai_intent}</span>}
                    </Space>}
                    description={event.summary || '无摘要'}
                  />
                </List.Item>
              )} /> : <Empty description="暂无跟进记录" />}
            </div>
            <div><h3>全部项目历史</h3>
              {history.length ? <Table size="small" rowKey="id" pagination={false} dataSource={history}
                columns={[
                  { title: '项目', dataIndex: 'campaign_name' },
                  { title: '状态', dataIndex: 'project_status' },
                  { title: '合作费用', dataIndex: 'final_fee', render: (v, r) => formatFee(v, r.currency) },
                  { title: '跟进人', dataIndex: 'owner' }
                ]} /> : <Empty description="暂无其他项目记录" />}
            </div>
          </Space>
        )}
      </Drawer>

      <Modal title="更正合作意向" open={correctingIntent}
        onCancel={() => setCorrectingIntent(false)} onOk={saveIntentCorrection}
        confirmLoading={savingCorrection} okText="确认更正">
        <Form layout="vertical">
          <Form.Item label="人工确认意向" required>
            <Select value={correctedIntent} onChange={setCorrectedIntent} options={INTENT_OPTIONS} />
          </Form.Item>
          <Form.Item label="更正说明/跟进摘要">
            <Input.TextArea rows={4} value={correctionSummary} onChange={(event) => setCorrectionSummary(event.target.value)} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={`编辑产品合作 - ${editingAssignment?.product_name || ''}`} open={Boolean(editingAssignment)} onCancel={() => setEditingAssignment(null)} onOk={saveAssignment} width={560}>
        <Form form={assignmentForm} layout="vertical">
          <Form.Item label="分配状态" name="assignment_status" rules={[{ required: true }]}>
            <Select options={assignmentStatusOptions} />
          </Form.Item>
          <Form.Item label="样品状态" name="sample_status">
            <Select options={sampleStatusOptions} allowClear />
          </Form.Item>
          <Form.Item label="内容状态" name="content_status">
            <Select options={contentStatusOptions} allowClear />
          </Form.Item>
          <Form.Item label="产品报价" name="quoted_fee">
            <Input placeholder="可选" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`发邮件给 ${selectedRowKeys.length} 位 KOL`}
        open={emailModalOpen}
        onCancel={() => setEmailModalOpen(false)}
        width={720}
        footer={[
          <Button key="cancel" onClick={() => setEmailModalOpen(false)}>关闭</Button>,
          <Button key="send" type="primary" loading={emailSending} onClick={handleSendEmails}
            disabled={!emailTemplateId && !emailSubject}>
            发送
          </Button>
        ]}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Select
            style={{ width: '100%' }}
            placeholder="选择邮件模板（仅固定模板；个性化起草请用「AI 起草邮件」）"
            value={emailTemplateId}
            onChange={(value) => { setEmailTemplateId(value); handlePreviewEmail(value); }}
            options={emailTemplates.filter((t) => t.kind === 'fixed').map((t) => ({ value: t.id, label: t.name }))}
          />
          {emailSubject !== '' && (
            <>
              <div style={{ color: '#888' }}>预览（第一位 KOL：{emailPreviewTo || '无收件人地址'}），修改主题/正文将应用于全部收件人：</div>
              <Input
                addonBefore="主题"
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
              />
              <TextArea
                rows={8}
                value={emailContent}
                onChange={(e) => setEmailContent(e.target.value)}
              />
              <Input
                addonBefore="抄送"
                placeholder="留空使用默认抄送"
                value={emailCc}
                onChange={(e) => setEmailCc(e.target.value)}
              />
            </>
          )}
          {emailResult && (
            <>
              <Divider style={{ margin: '8px 0' }} />
              <div>发送完成：成功 {emailResult.success} / 失败 {emailResult.failed}（共 {emailResult.total}）</div>
              {emailResult.errors.length > 0 && (
                <List
                  size="small"
                  header="失败明细"
                  dataSource={emailResult.errors}
                  renderItem={(item) => <List.Item>{item.to || `KOL #${item.campaignKolId}`}：{item.error}</List.Item>}
                />
              )}
            </>
          )}
        </Space>
      </Modal>

      <Modal
        title="AI 草稿起草进度"
        open={draftRunOpen}
        onCancel={closeDraftRunModal}
        maskClosable={false}
        width={560}
        footer={draftRunTerminal ? [
          <Button key="close" onClick={closeDraftRunModal}>关闭</Button>,
          <Button key="review" type="primary" onClick={() => { window.location.assign('/emails'); }}>去审批台查看</Button>
        ] : [
          <Button key="close" onClick={closeDraftRunModal}>后台运行并关闭</Button>
        ]}
      >
        {!draftRun && !draftRunError ? <Spin /> : (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {draftRunError && <Alert type="warning" showIcon message={draftRunError} />}
            {draftRun && (
              <>
                <div>
                  状态：<Tag color={draftRunTerminal ? (draftRun.status === 'success' ? 'green' : draftRun.status === 'failed' ? 'red' : 'orange') : 'blue'}>
                    {RUN_STATUS_LABEL[draftRun.status] || draftRun.status}
                  </Tag>
                </div>
                <Progress
                  percent={draftRunTotal ? Math.round((draftRunCompleted / draftRunTotal) * 100) : 0}
                  status={draftRun.status === 'failed' ? 'exception' : draftRunTerminal ? undefined : 'active'}
                />
                <div>已完成 {draftRunCompleted}/{draftRunTotal} ｜ 成功 {draftRunSucceeded} 封 ｜ 失败 {draftRunFailedCount} 封</div>
                {draftRunTerminal && (
                  <Alert
                    type={draftRun.status === 'success' ? 'success' : draftRun.status === 'failed' ? 'error' : 'warning'}
                    showIcon
                    message={draftRun.status === 'success'
                      ? `起草完成：成功 ${draftRunSucceeded} 封`
                      : `起草结束：成功 ${draftRunSucceeded} 封、失败 ${draftRunFailedCount} 封${draftRun.last_error ? `（${draftRun.last_error}）` : ''}`}
                  />
                )}
                {draftRunTerminal && draftRunFailedItems.length > 0 && (
                  <List
                    size="small"
                    header="失败明细"
                    dataSource={draftRunFailedItems}
                    renderItem={(item) => (
                      <List.Item>{kolNameByCustomerId(item.customer_id)}：{item.error || '起草失败'}</List.Item>
                    )}
                  />
                )}
              </>
            )}
          </Space>
        )}
      </Modal>

      <Modal title={isCandidatePool ? '编辑项目候选' : '编辑 KOL 合作'} open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={saveEdit} confirmLoading={savingEdit} width={760}>
        <Form form={form} layout="vertical">
          <Space align="start" style={{ width: '100%' }}>
            <Form.Item label="合作平台" name="cooperation_platforms">
              <Select mode="multiple" allowClear options={platformOptions} style={{ width: 260 }} placeholder="可多选" />
            </Form.Item>
            <Form.Item label="合作方式" name="cooperation_type" initialValue="product_exchange">
              <Select options={cooperationTypeOptions} style={{ width: 190 }} />
            </Form.Item>
          </Space>
          <Form.Item label="沟通产品/SKU" name="product_id">
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择产品"
              options={editProducts}
              allowClear
            />
          </Form.Item>
          <Space align="start" style={{ width: '100%' }}>
            <Form.Item label="KOL合作费" name="final_fee">
              <InputNumber min={0} precision={2} disabled={cooperationType === 'product_exchange'} style={{ width: 200 }} placeholder="0.00" />
            </Form.Item>
            <Form.Item label="币种" name="currency">
              <Select options={currencyOptions} disabled={cooperationType === 'product_exchange'} style={{ width: 190 }} placeholder="选择币种" />
            </Form.Item>
          </Space>
          <Space align="start" style={{ width: '100%' }}>
            {isCandidatePool ? (
              <Form.Item label="外联状态" name="outreach_status" extra="邮件是否待回复会由系统根据最新收发邮件单独维护">
                <Select options={OUTREACH_STATUS_OPTIONS} style={{ width: 170 }} />
              </Form.Item>
            ) : (
              <Form.Item label="项目状态" name="project_status">
                <Select options={PROJECT_STATUS_OPTIONS} style={{ width: 170 }} />
              </Form.Item>
            )}
            <Form.Item label="优先级" name="priority_level">
              <Select options={priorityOptions} style={{ width: 190 }} />
            </Form.Item>
            <Form.Item label="跟进人" name="owner">
              <Input style={{ width: 170 }} />
            </Form.Item>
          </Space>
          {isCandidatePool ? (
            <Form.Item label="项目备注" name="project_notes">
              <TextArea rows={3} />
            </Form.Item>
          ) : (
            <Form.Item label="收货地址" name="shipping_address">
              <TextArea rows={2} />
            </Form.Item>
          )}
          <Form.Item label="交付内容" name="deliverables">
            <TextArea rows={3} placeholder="例如：展示产品安装、核心卖点和折扣码" />
          </Form.Item>
          <Space align="start" style={{ width: '100%' }} wrap>
            {!isCandidatePool && (
              <>
                <Form.Item label="内容形式" name="content_format">
                  <Input style={{ width: 220 }} placeholder="例如：2×Reels + 3×Stories" />
                </Form.Item>
                <Form.Item label="预计上线时间" name="expected_publish_at">
                  <Input type="date" style={{ width: 180 }} />
                </Form.Item>
              </>
            )}
            {isCandidatePool && (
              <Form.Item label="预算审批状态" name="budget_approval_status">
                <Select allowClear style={{ width: 170 }} options={[
                  { value: 'pending', label: '待审批' },
                  { value: 'approved', label: '已通过' },
                  { value: 'rejected', label: '未通过' }
                ]} />
              </Form.Item>
            )}
          </Space>
          <Space align="start" style={{ width: '100%' }} wrap>
            <Form.Item label="总预计成本" name="estimated_total_cost_usd">
              <InputNumber min={0} precision={2} style={{ width: 180 }} />
            </Form.Item>
            <Form.Item label="近30天中位曝光" name="median_views_30d_snapshot" extra="保存入项时的数据快照">
              <InputNumber min={0} precision={0} style={{ width: 180 }} />
            </Form.Item>
            <Form.Item label="预计合作曝光" name="expected_views">
              <InputNumber min={0} precision={0} style={{ width: 180 }} />
            </Form.Item>
            <Form.Item label="预估CPM" name="estimated_cpm">
              <InputNumber min={0} precision={2} disabled style={{ width: 150 }} />
            </Form.Item>
          </Space>
          {!isCandidatePool && (
            <>
              <Space align="start" style={{ width: '100%' }} wrap>
                <Form.Item label="发货日期" name="shipping_date">
                  <Input type="date" style={{ width: 180 }} />
                </Form.Item>
                <Form.Item label="物流单号" name="tracking_number">
                  <Input style={{ width: 260 }} />
                </Form.Item>
              </Space>
              <Form.Item label="合作发布视频" name="published_video_urls" extra="每行一条链接；系统会自动识别平台并同步到视频数据，保存时不会自动抓取。">
                <TextArea rows={5} placeholder={'https://www.youtube.com/watch?v=...\nhttps://www.instagram.com/reel/...'} />
              </Form.Item>
              <Form.Item label="项目备注" name="project_notes">
                <TextArea rows={3} />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </div>
  );
};

export default CampaignKols;
