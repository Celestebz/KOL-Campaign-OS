import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Descriptions, Divider, Drawer, Empty, Form, Input, InputNumber, List, message, Modal, Popconfirm, Progress, Select, Space, Spin, Table, Tag } from 'antd';
import { DeleteOutlined, EditOutlined, MailOutlined, ReloadOutlined, RobotOutlined, SyncOutlined } from '@ant-design/icons';
import axios from 'axios';
import { describeSyncResult } from './campaignKolSyncResult';
import { getMainStatus, getSubStatusLabel, SUB_STATUS_LABELS } from './campaignKolStatus';
import { getEmailTemplates, previewEmail, sendEmails, generateDrafts, getAutomationRun } from './emailApi';

const { TextArea } = Input;

// 细分状态仍用于编辑表单/筛选；列表与详情展示收敛为主状态（见 campaignKolStatus.js）。
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

const RUN_TERMINAL_STATUSES = ['success', 'partial_failed', 'failed'];
const RUN_STATUS_LABEL = { running: '进行中', success: '已完成', partial_failed: '部分失败', failed: '失败' };
const RUN_POLL_INTERVAL_MS = 5000;

const CampaignKols = () => {
  const [rows, setRows] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
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
  const [editing, setEditing] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailRow, setDetailRow] = useState(null);
  const [masterDetail, setMasterDetail] = useState(null);
  const [history, setHistory] = useState([]);
  const [productAssignments, setProductAssignments] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [editingAssignment, setEditingAssignment] = useState(null);
  const [assignmentForm] = Form.useForm();
  const [form] = Form.useForm();
  const cooperationType = Form.useWatch('cooperation_type', form);

  const campaignOptions = useMemo(() => campaigns.map((item) => ({
    value: item.id,
    label: item.name
  })), [campaigns]);

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
      const res = await axios.get('/api/campaign-kols', { params: filters });
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
    values.cooperation_platforms = parsePlatforms(values.cooperation_platforms, [values.platform_account_platform].filter(Boolean));
    if (values.project_override && typeof values.project_override === 'object') {
      values.project_override = JSON.stringify(values.project_override, null, 2);
    }
    try {
      const response = await axios.get(`/api/campaign-kols/${record.id}/published-videos`);
      values.published_video_urls = (response.data.data || [])
        .map((video) => video.canonical_url || video.source_url)
        .join('\n');
    } catch (error) {
      values.published_video_urls = '';
      message.error('获取合作发布视频失败');
    }
    form.setFieldsValue(values);
  };

  useEffect(() => {
    fetchRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.campaign_id, filters.status, filters.sync_status]);

  const openDetail = async (record) => {
    setDetailOpen(true);
    setDetailRow(record);
    setMasterDetail(null);
    setHistory([]);
    setProductAssignments([]);
    setDetailError('');
    setDetailLoading(true);
    try {
      const [master, projectHistory, assignments] = await Promise.all([
        axios.get(`/api/customers/${record.customer_id}`),
        axios.get(`/api/customers/${record.customer_id}/project-history`),
        axios.get(`/api/campaign-kols/${record.id}/products`)
      ]);
      setMasterDetail(master.data.data);
      setHistory(projectHistory.data.data || []);
      setProductAssignments(assignments.data.data || []);
    } catch (error) {
      setDetailError('KOL 详情加载失败，请稍后重试');
    } finally {
      setDetailLoading(false);
    }
  };

  const saveEdit = async () => {
    const values = await form.validateFields();
    const publishedVideoUrls = values.published_video_urls || '';
    delete values.published_video_urls;
    if (values.cooperation_type === 'product_exchange') {
      values.final_fee = 0;
      values.currency = null;
    }
    await axios.patch(`/api/campaign-kols/${editing.id}`, values);
    await axios.put(`/api/campaign-kols/${editing.id}/published-videos`, {
      urls: publishedVideoUrls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean)
    });
    message.success('项目 KOL 已更新');
    setEditing(null);
    fetchRows();
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
      const res = await axios.post('/api/sync/feishu/push', {
        scope: selectedRowKeys.length ? 'campaign_kols' : 'all',
        ids: selectedRowKeys
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
    { title: '项目/产品', dataIndex: 'campaign_name', key: 'campaign_name', width: 150, fixed: 'left' },
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
          <span style={{ color: '#666', maxWidth: '100%', overflowWrap: 'anywhere' }}>{r.contact_name || r.contact_name_snapshot || '-'}</span>
        </Space>
      )
    },
    { title: 'YouTube', key: 'youtube', width: 130, render: (_, r) => platformLink(r.youtube_url || r.youtube_url_snapshot, r.youtube_followers || r.youtube_followers_snapshot) },
    { title: 'Instagram', key: 'instagram', width: 130, render: (_, r) => platformLink(r.instagram_url || r.instagram_url_snapshot, r.instagram_followers || r.instagram_followers_snapshot) },
    { title: 'TikTok', key: 'tiktok', width: 130, render: (_, r) => platformLink(r.tiktok_url || r.tiktok_url_snapshot, r.tiktok_followers || r.tiktok_followers_snapshot) },
    { title: 'Email', dataIndex: 'email_snapshot', key: 'email_snapshot', width: 200, render: (v, r) => v || r.email || '-' },
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
    { title: '外联状态', dataIndex: 'outreach_status', key: 'outreach_status', width: 110, render: (v) => {
      const labels = { not_contacted: '待联系', contacted: '已联系', replied: '已回复', interested: '有意向', rejected: '已拒绝' };
      const colors = { contacted: 'blue', replied: 'gold', interested: 'green', rejected: 'red' };
      return v ? <Tag color={colors[v] || 'default'}>{labels[v] || v}</Tag> : '-';
    } },
    { title: '合作平台', dataIndex: 'cooperation_platforms', key: 'cooperation_platforms', width: 180, render: (v, r) => {
      const values = parsePlatforms(v, [r.platform_account_platform].filter(Boolean));
      return values.length ? <Space wrap size={[4, 4]}>{values.map((value) => <Tag key={value}>{value}</Tag>)}</Space> : '-';
    } },
    { title: '合作SKU', dataIndex: 'product_sku', key: 'product_sku', width: 120, render: (v, r) => v || r.product_name || '-' },
    { title: '优先级', dataIndex: 'priority_level', key: 'priority_level', width: 150, render: (v) => priorityOptions.find((item) => item.value === v)?.label || v || '-' },
    { title: 'KOL合作费', dataIndex: 'final_fee', key: 'final_fee', width: 140, render: (v, r) => r.cooperation_type === 'product_exchange' ? '现金 0' : formatFee(v || r.price_rmb, r.currency || 'USD') },
    { title: '项目状态', dataIndex: 'project_status', key: 'project_status', width: 150, render: (v) => {
      const main = getMainStatus(v);
      const sub = getSubStatusLabel(v);
      return (
        <Space size={4}>
          <Tag color={main.color}>{main.label}</Tag>
          {sub && sub !== main.label && <span style={{ fontSize: 12, color: '#999' }}>{sub}</span>}
        </Space>
      );
    } },
    { title: '跟进人', dataIndex: 'owner', key: 'owner', width: 100, render: (v) => v || '-' },
    { title: '物流单号', dataIndex: 'tracking_number', key: 'tracking_number', width: 150, render: (v) => v || '-' },
    { title: '合作发布视频', dataIndex: 'published_video_count', key: 'published_video_count', width: 130, render: (v) => `${v || 0} 条` },
    { title: '同步', dataIndex: 'sync_status', key: 'sync_status', width: 120, render: (v) => <Tag>{v || 'sync_pending'}</Tag> },
    { title: '项目备注', dataIndex: 'project_notes', key: 'project_notes', width: 220, ellipsis: true, render: (v, r) => v || r.notes || '-' },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      fixed: 'right',
      render: (_, record) => (
        <Space direction="vertical" size={0} align="start">
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
        <h1 className="page-title">KOL 合作</h1>
        <p className="page-subtitle">按项目管理 KOL 的报价、跟进、交付与合作状态。</p>
      </div>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select allowClear placeholder="项目/产品" value={filters.campaign_id} onChange={(v) => updateFilter('campaign_id', v)} options={campaignOptions} style={{ width: 180 }} />
          <Select allowClear placeholder="状态" value={filters.status} onChange={(v) => updateFilter('status', v)} options={statusOptions} style={{ width: 150 }} />
          <Select allowClear placeholder="同步状态" value={filters.sync_status} onChange={(v) => updateFilter('sync_status', v)} options={[
            { value: 'sync_pending', label: 'sync_pending' },
            { value: 'synced', label: 'synced' },
            { value: 'sync_failed', label: 'sync_failed' }
          ]} style={{ width: 160 }} />
          <Input.Search allowClear placeholder="搜索 KOL、Email、国家、备注、视频链接" value={filters.search} onChange={(e) => updateFilter('search', e.target.value)} onSearch={fetchRows} style={{ width: 320 }} />
          <Button icon={<ReloadOutlined />} onClick={fetchRows}>刷新</Button>
          <Button icon={<SyncOutlined />} loading={syncing} onClick={syncSelected}>{selectedRowKeys.length ? '同步选中到飞书项目子表' : '同步待同步到飞书项目子表'}</Button>
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
          dataSource={rows}
          loading={loading}
          rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
          scroll={{ x: 2100 }}
          pagination={{ defaultPageSize: 20, showSizeChanger: true }}
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

      <Modal title="编辑 KOL 合作" open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={saveEdit} width={760}>
        <Form form={form} layout="vertical">
          <Space align="start" style={{ width: '100%' }}>
            <Form.Item label="合作平台" name="cooperation_platforms">
              <Select mode="multiple" allowClear options={platformOptions} style={{ width: 260 }} placeholder="可多选" />
            </Form.Item>
            <Form.Item label="合作方式" name="cooperation_type" initialValue="paid_product">
              <Select options={cooperationTypeOptions} style={{ width: 190 }} />
            </Form.Item>
            <Form.Item label="KOL合作费" name="final_fee">
              <InputNumber min={0} precision={2} disabled={cooperationType === 'product_exchange'} style={{ width: 200 }} placeholder="0.00" />
            </Form.Item>
            <Form.Item label="币种" name="currency">
              <Select options={currencyOptions} disabled={cooperationType === 'product_exchange'} style={{ width: 190 }} placeholder="选择币种" />
            </Form.Item>
          </Space>
          <Space align="start" style={{ width: '100%' }}>
            <Form.Item label="项目状态" name="project_status">
              <Select options={statusOptions} style={{ width: 170 }} />
            </Form.Item>
            <Form.Item label="优先级" name="priority_level">
              <Select options={priorityOptions} style={{ width: 190 }} />
            </Form.Item>
            <Form.Item label="跟进人" name="owner">
              <Input style={{ width: 170 }} />
            </Form.Item>
          </Space>
          <Form.Item label="收货地址" name="shipping_address">
            <TextArea rows={2} />
          </Form.Item>
          <Form.Item label="交付内容" name="deliverables">
            <TextArea rows={3} placeholder="例如：展示产品安装、核心卖点和折扣码" />
          </Form.Item>
          <Space align="start" style={{ width: '100%' }} wrap>
            <Form.Item label="内容形式" name="content_format">
              <Input style={{ width: 220 }} placeholder="例如：2×Reels + 3×Stories" />
            </Form.Item>
            <Form.Item label="预计上线时间" name="expected_publish_at">
              <Input type="date" style={{ width: 180 }} />
            </Form.Item>
            <Form.Item label="预算审批状态" name="budget_approval_status">
              <Select allowClear style={{ width: 170 }} options={[
                { value: 'pending', label: '待审批' },
                { value: 'approved', label: '已通过' },
                { value: 'rejected', label: '未通过' }
              ]} />
            </Form.Item>
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
        </Form>
      </Modal>
    </div>
  );
};

export default CampaignKols;
