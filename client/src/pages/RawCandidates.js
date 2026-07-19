import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Form, Input, InputNumber, message, Modal, Popconfirm, Progress, Select, Space, Table, Tag } from 'antd';
import { CheckOutlined, DeleteOutlined, EyeOutlined, ReloadOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import axios from 'axios';
import { buildFinderTaskRequest, evidenceSignalLabels, normalizeEvidenceSignals } from './finderTaskContract';

const { TextArea } = Input;

const platformOptions = [
  { value: 'youtube', label: 'YouTube' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'tiktok', label: 'TikTok' }
];

const statusOptions = [
  { value: 'pending', label: '待审核' },
  { value: 'manual_review', label: '人工审核' },
  { value: 'new', label: '待审核（旧）' },
  { value: 'approved', label: '已通过' },
  { value: 'duplicate', label: '重复' },
  { value: 'risk_review', label: '历史风险' },
  { value: 'ignored', label: '已忽略' },
  { value: 'error', label: '错误' }
];

const statusColor = {
  pending: 'blue',
  manual_review: 'orange',
  new: 'blue',
  approved: 'green',
  duplicate: 'purple',
  risk_review: 'orange',
  ignored: 'default',
  error: 'red'
};

const cooperationRiskOptions = [
  { value: 'historical_refusal', label: '历史拒绝合作' },
  { value: 'communication_risk', label: '沟通风险' },
  { value: 'price_mismatch', label: '报价不合适' },
  { value: 'brand_safety', label: '品牌安全风险' },
  { value: 'delivery_issue', label: '履约问题' },
  { value: 'other', label: '其他' }
];

const cooperationRiskLabel = (value) => (
  cooperationRiskOptions.find((item) => item.value === value)?.label || value || '-'
);

const statusLabel = (value) => (
  statusOptions.find((item) => item.value === value)?.label || value || 'new'
);

const evidenceStatusLabel = (value) => ({
  new: '推荐入池',
  manual_review: '待人工审核',
  risk_review: '风险复核',
  ignored: '已忽略'
}[value] || '未评分');

const riskLevelLabel = (value) => ({
  high: '高',
  medium: '中',
  low: '低'
}[value] || '-');

const identityStatusLabel = (value) => ({
  new_kol: '新 KOL',
  known_kol_new_product_fit: '已有 KOL · 新产品匹配',
  existing_product_fit_updated: '已有 KOL · 产品匹配更新',
  unresolved: '待识别'
}[value] || value || '-');

const safeParseJson = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
};

const normalizeHandle = (value) => String(value || '').trim().replace(/^@/, '').replace(/^\/+|\/+$/g, '');

const platformProfileFromHandle = (platform, handle) => {
  const cleanHandle = normalizeHandle(handle);
  if (!cleanHandle) return '';
  if (platform === 'instagram') return `https://www.instagram.com/${cleanHandle}/`;
  if (platform === 'tiktok') return `https://www.tiktok.com/@${cleanHandle}`;
  return '';
};

const findPlatformUrl = (value, platform) => {
  if (!value) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text.startsWith('http')) return '';
    if (platform === 'instagram' && text.includes('instagram.com')) return text;
    if (platform === 'youtube' && (text.includes('youtube.com') || text.includes('youtu.be'))) return text;
    if (platform === 'tiktok' && text.includes('tiktok.com')) return text;
    return '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPlatformUrl(item, platform);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    const priorityKeys = platform === 'instagram'
      ? ['instagram_url', 'instagramUrl', 'instagram', 'profile_url', 'profileUrl', 'profile']
      : platform === 'youtube'
        ? ['youtube_url', 'youtubeUrl', 'channel_url', 'channelUrl', 'profile_url', 'profileUrl', 'profile']
        : ['tiktok_url', 'tiktokUrl', 'profile_url', 'profileUrl', 'profile'];
    for (const key of priorityKeys) {
      const found = findPlatformUrl(value[key], platform);
      if (found) return found;
    }
    const handle = value.username || value.handle || value.unique_id;
    const fromHandle = platformProfileFromHandle(platform, handle);
    if (fromHandle) return fromHandle;
    for (const item of Object.values(value)) {
      const found = findPlatformUrl(item, platform);
      if (found) return found;
    }
  }
  return '';
};

const getTargetProfileUrl = (record = {}) => {
  const platform = String(record.target_platform || record.platform || '').toLowerCase();
  const direct = findPlatformUrl(record.profile_url, platform);
  if (direct) return direct;
  const raw = safeParseJson(record.raw_data);
  return findPlatformUrl(raw, platform);
};

const normalizeUrlForCompare = (value) => String(value || '').trim().replace(/\/$/, '');

const renderClue = (record = {}) => {
  const clues = [];
  if (record.video_url) {
    clues.push({
      url: record.video_url,
      title: record.video_title || record.evidence_title || '代表视频'
    });
  }

  if (
    record.evidence_url &&
    normalizeUrlForCompare(record.evidence_url) !== normalizeUrlForCompare(record.video_url)
  ) {
    clues.push({
      url: record.evidence_url,
      title: record.evidence_title || record.evidence_type || '证据'
    });
  }

  if (!clues.length) return '-';

  return (
    <Space direction="vertical" size={2}>
      {clues.map((item, index) => (
        <a key={`${item.url}-${index}`} href={item.url} target="_blank" rel="noreferrer">{item.title}</a>
      ))}
    </Space>
  );
};

const RawCandidates = () => {
  const [candidates, setCandidates] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [campaignProducts, setCampaignProducts] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [finderTasks, setFinderTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [taskLoading, setTaskLoading] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [filters, setFilters] = useState({ status: 'pending' });
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [videoEvidence, setVideoEvidence] = useState([]);
  const [videoEvidenceLoading, setVideoEvidenceLoading] = useState(false);
  const [detail, setDetail] = useState(null);
  const [globalRiskRecord, setGlobalRiskRecord] = useState(null);
  const [riskForm] = Form.useForm();
  const [taskForm] = Form.useForm();

  const campaignOptions = useMemo(() => campaigns.map((item) => ({
    value: item.id,
    label: item.name
  })), [campaigns]);

  const strategyOptions = useMemo(() => strategies.map((item) => ({
    value: item.id,
    label: `${item.name} · ${item.campaign_name || 'Campaign'}`,
    strategy: item
  })), [strategies]);

  const selectedStrategy = useMemo(() => (
    strategies.find((item) => item.id === filters.strategy_id)
  ), [strategies, filters.strategy_id]);

  const displayedFinderTask = useMemo(() => {
    const candidateTaskIds = new Set(candidates.map((item) => item.finder_task_id).filter(Boolean));
    return finderTasks.find((task) => candidateTaskIds.has(task.id)) || finderTasks[0];
  }, [candidates, finderTasks]);

  useEffect(() => {
    fetchCampaigns();
    fetchStrategies();
    fetchCandidates();
    fetchFinderTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!filters.strategy_id) return;
    fetchFinderTasks(filters.strategy_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.strategy_id]);

  useEffect(() => {
    fetchCampaignProducts(filters.campaign_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.campaign_id]);

  useEffect(() => {
    const hasRunning = finderTasks.some((task) => ['draft', 'running'].includes(task.status));
    if (!hasRunning) return undefined;
    const timer = setInterval(() => {
      fetchFinderTasks(filters.strategy_id);
      fetchCandidates();
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finderTasks, filters.strategy_id]);

  useEffect(() => {
    if (!displayedFinderTask?.id) {
      setVideoEvidence([]);
      return;
    }
    fetchVideoEvidence(displayedFinderTask.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedFinderTask?.id]);

  const fetchCampaigns = async () => {
    try {
      const res = await axios.get('/api/campaigns');
      setCampaigns(res.data.data || []);
    } catch (error) {
      setCampaigns([]);
      message.error(error.response?.data?.error || '获取产品/活动失败，请确认后端服务已启动');
    }
  };

  const fetchCampaignProducts = async (campaignId) => {
    if (!campaignId) {
      setCampaignProducts([]);
      return;
    }
    try {
      const res = await axios.get(`/api/campaigns/${campaignId}/products`);
      setCampaignProducts(res.data.data || []);
    } catch (error) {
      setCampaignProducts([]);
    }
  };

  const fetchStrategies = async () => {
    try {
      const res = await axios.get('/api/kol-strategies', { params: { status: 'ready' } });
      setStrategies(res.data.data || []);
    } catch (error) {
      setStrategies([]);
      message.error(error.response?.data?.error || '获取策略失败，请确认后端服务已启动');
    }
  };

  const fetchCandidates = async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/raw-candidates', { params: filters });
      setCandidates(res.data.data || []);
    } catch (error) {
      message.error(error.response?.data?.error || '获取候选池失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchFinderTasks = async (strategyId = filters.strategy_id) => {
    try {
      const params = strategyId
        ? { strategy_id: strategyId }
        : filters.campaign_id
          ? { campaign_id: filters.campaign_id }
          : {};
      const res = await axios.get('/api/finder-tasks', { params });
      setFinderTasks(res.data.data || []);
    } catch (error) {
      message.error(error.response?.data?.error || '获取寻找任务失败');
    }
  };

  const fetchVideoEvidence = async (finderTaskId = finderTasks[0]?.id) => {
    if (!finderTaskId) return;
    setVideoEvidenceLoading(true);
    try {
      const res = await axios.get(`/api/finder-tasks/${finderTaskId}/video-evidence`);
      setVideoEvidence(res.data.data || []);
    } catch (error) {
      setVideoEvidence([]);
    } finally {
      setVideoEvidenceLoading(false);
    }
  };

  const analyzeVideoEvidence = async () => {
    if (!latestTask?.id) return;
    setVideoEvidenceLoading(true);
    try {
      await axios.post(`/api/finder-tasks/${latestTask.id}/evidence-analysis`);
      message.success('Video evidence scoring finished');
      fetchVideoEvidence(latestTask.id);
    } catch (error) {
      message.error(error.response?.data?.error || 'Video evidence scoring failed');
    } finally {
      setVideoEvidenceLoading(false);
    }
  };

  const generateCandidatesFromEvidence = async () => {
    if (!latestTask?.id) return;
    setVideoEvidenceLoading(true);
    try {
      const res = await axios.post(`/api/finder-tasks/${latestTask.id}/generate-candidates-from-evidence`);
      message.success(`Generated ${res.data.data?.inserted_count || 0} Raw Candidates from video evidence`);
      fetchVideoEvidence(latestTask.id);
      fetchCandidates();
    } catch (error) {
      message.error(error.response?.data?.error || 'Generate candidates failed');
    } finally {
      setVideoEvidenceLoading(false);
    }
  };

  const updateFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value || undefined }));
  };

  const updateStrategyFilter = (strategyId) => {
    const strategy = strategies.find((item) => item.id === strategyId);
    setFilters((prev) => ({
      ...prev,
      strategy_id: strategyId || undefined,
      campaign_id: strategy?.campaign_id || prev.campaign_id
    }));
    setSelectedRowKeys([]);
  };

  const openTaskModal = () => {
    if (!selectedStrategy) {
      message.warning('请先选择一个已发布策略');
      return;
    }
    if (!selectedStrategy.campaign_product_id) {
      message.warning('所选策略未绑定项目产品，请先编辑策略并选择产品');
      return;
    }
    const targetPlatform = selectedStrategy.primary_platform
      || selectedStrategy.finder_handoff?.required_platforms?.[0]
      || selectedStrategy.secondary_platforms?.[0]
      || 'youtube';
    taskForm.setFieldsValue({ target_platform: targetPlatform, limit: 10 });
    setTaskModalOpen(true);
  };

  const startFinderTask = async () => {
    if (!selectedStrategy) {
      message.warning('请先选择一个已发布策略');
      return;
    }
    const values = await taskForm.validateFields();
    setTaskLoading(true);
    try {
      await axios.post('/api/finder-tasks', buildFinderTaskRequest({
        strategyId: selectedStrategy.id,
        targetPlatform: values.target_platform,
        limit: values.limit
      }));
      message.success('视频证据寻找任务已启动');
      setTaskModalOpen(false);
      fetchFinderTasks(selectedStrategy.id);
      fetchCandidates();
    } catch (error) {
      message.error(error.response?.data?.error || '启动寻找任务失败');
    } finally {
      setTaskLoading(false);
    }
  };

  const approveOne = async (record) => {
    const strategyId = record.strategy_id || selectedStrategy?.id;
    if (!strategyId) {
      message.warning('请先选择一个已发布策略');
      return;
    }
    try {
      await axios.post(`/api/raw-candidates/${record.id}/approve`, {
        strategy_id: strategyId,
        campaign_id: record.campaign_id || selectedStrategy?.campaign_id || filters.campaign_id || 1,
        campaign_product_id: record.fit_campaign_product_id || selectedStrategy?.campaign_product_id || undefined
      });
      message.success('已加入 KOL 管理和当前项目子表');
      fetchCandidates();
    } catch (error) {
      message.error(error.response?.data?.error || '通过候选失败');
      fetchCandidates();
    }
  };

  const batchApprove = async () => {
    if (!selectedStrategy) {
      message.warning('请先选择一个已发布策略');
      return;
    }
    const res = await axios.post('/api/raw-candidates/batch-approve', {
      ids: selectedRowKeys,
      strategy_id: selectedStrategy.id,
      campaign_id: selectedStrategy.campaign_id
    });
    const data = res.data.data;
    message.success(`批量完成：成功 ${data.success_count}，失败 ${data.failed_count}`);
    setSelectedRowKeys([]);
    fetchCandidates();
  };

  const batchIgnore = async () => {
    await axios.post('/api/raw-candidates/batch-ignore', { ids: selectedRowKeys });
    message.success('已忽略本项目候选');
    setSelectedRowKeys([]);
    fetchCandidates();
  };

  const batchDelete = async () => {
    await axios.delete('/api/raw-candidates/batch', { data: { ids: selectedRowKeys } });
    message.success('已删除选中候选');
    setSelectedRowKeys([]);
    fetchCandidates();
  };

  const ignoreOne = async (record) => {
    await axios.post(`/api/raw-candidates/${record.id}/ignore`);
    message.success('已忽略本项目');
    fetchCandidates();
  };

  const openGlobalRiskModal = (record) => {
    setGlobalRiskRecord(record);
    riskForm.resetFields();
    riskForm.setFieldsValue({
      category: record.global_cooperation_risk_category || record.rejection_category || 'historical_refusal',
      reason: record.global_cooperation_risk_reason || record.rejection_reason || ''
    });
  };

  const submitGlobalRisk = async () => {
    if (!globalRiskRecord) return;
    const values = await riskForm.validateFields();
    await axios.post(`/api/raw-candidates/${globalRiskRecord.id}/mark-do-not-contact`, values);
    message.success('已标记为全局不建议合作');
    setGlobalRiskRecord(null);
    fetchCandidates();
  };

  const columns = [
    {
      title: 'KOL',
      key: 'kol',
      width: 260,
      fixed: 'left',
      render: (_, r) => (
        <Space direction="vertical" size={2}>
          <strong>{r.kol_name}</strong>
          {r.global_cooperation_status === 'do_not_contact' || r.status === 'risk_review' ? (
            <Space wrap size={[4, 4]}>
              <Tag color="red">全局不建议合作</Tag>
              <Tag color="orange">{cooperationRiskLabel(r.global_cooperation_risk_category || r.rejection_category)}</Tag>
            </Space>
          ) : null}
          {r.status === 'ignored' && (r.rejection_scope || 'project') === 'project' ? <Tag>本项目已忽略</Tag> : null}
        </Space>
      )
    },
    { title: '项目', dataIndex: 'campaign_name', key: 'campaign_name', width: 150, render: (v) => v || '-' },
    {
      title: '项目产品',
      key: 'product',
      width: 180,
      render: (_, r) => (
        <Space direction="vertical" size={2}>
          <span>{r.product_name || '-'}</span>
          {r.product_brand ? <Tag>{r.product_brand}</Tag> : null}
          {r.fit_score ? <Tag color="blue">产品匹配 {r.fit_score}</Tag> : null}
        </Space>
      )
    },
    {
      title: '身份识别',
      key: 'identity',
      width: 180,
      render: (_, r) => (
        <Space direction="vertical" size={2}>
          {r.fit_identity_status ? <Tag color={r.fit_identity_status === 'new_kol' ? 'green' : 'orange'}>{identityStatusLabel(r.fit_identity_status)}</Tag> : null}
          {r.matched_customer_id ? <Tag>已存在 KOL Master</Tag> : null}
        </Space>
      )
    },
    {
      title: '策略',
      key: 'strategy',
      width: 190,
      render: (_, r) => (
        <Space direction="vertical" size={2}>
          <span>{r.strategy_name || '未绑定策略'}</span>
          {r.strategy_status ? <Tag color={r.strategy_status === 'ready' ? 'green' : 'default'}>{r.strategy_status}</Tag> : null}
        </Space>
      )
    },
    { title: 'KOL画像', dataIndex: 'matched_persona', key: 'matched_persona', width: 150, render: (v) => v || '未生成' },
    { title: '发现路径', dataIndex: 'discovery_route', key: 'discovery_route', width: 170, render: (v) => v ? <Tag color="blue">{v}</Tag> : '-' },
    { title: '来源平台', dataIndex: 'source_platform', key: 'source_platform', width: 140, render: (v) => v || '-' },
    { title: '目标平台', dataIndex: 'target_platform', key: 'target_platform', width: 140, render: (v, r) => v || r.platform || '-' },
    { title: '来源', dataIndex: 'source', key: 'source', width: 130, render: (v) => v ? <Tag>{v}</Tag> : '-' },
    { title: '平台', dataIndex: 'platform', key: 'platform', width: 110, render: (v) => v ? <Tag>{v}</Tag> : '-' },
    {
      title: '主页',
      key: 'links',
      width: 180,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          {r.profile_url ? <a href={r.profile_url} target="_blank" rel="noreferrer">主页</a> : <span>-</span>}
        </Space>
      )
    },
    { title: '线索', key: 'clue', width: 260, render: (_, r) => renderClue(r) },
    { title: '粉丝', dataIndex: 'followers', key: 'followers', width: 100, render: (v) => v || '-' },
    { title: '均播', dataIndex: 'avg_views', key: 'avg_views', width: 100, render: (v) => v || '-' },
    { title: '国家地区', dataIndex: 'country_region', key: 'country_region', width: 120, render: (v) => v || '-' },
    { title: 'Email', dataIndex: 'email', key: 'email', width: 190, render: (v) => v || '-' },
    { title: 'AI评分', dataIndex: 'ai_score', key: 'ai_score', width: 90, render: (v) => v ?? '-' },
    { title: '匹配关键词', dataIndex: 'matched_keywords', key: 'matched_keywords', width: 180, ellipsis: true, render: (v) => v || '-' },
    {
      title: '合作风险',
      key: 'cooperation_risk',
      width: 150,
      render: (_, r) => (
        r.global_cooperation_status === 'do_not_contact' || r.status === 'risk_review'
          ? <Tag color="red">全局不建议合作</Tag>
          : r.status === 'ignored'
            ? <Tag>本项目不合适</Tag>
            : '-'
      )
    },
    { title: '状态', dataIndex: 'status', key: 'status', width: 120, render: (v) => <Tag color={statusColor[v] || 'default'}>{statusLabel(v)}</Tag> },
    {
      title: '操作',
      key: 'actions',
      width: 340,
      fixed: 'right',
      render: (_, record) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => setDetail(record)}>详情</Button>
          <Button size="small" type="primary" icon={<CheckOutlined />} disabled={['approved', 'duplicate'].includes(record.status) || (!record.strategy_id && !selectedStrategy)} onClick={() => approveOne(record)}>通过</Button>
          <Button size="small" icon={<StopOutlined />} disabled={record.status === 'ignored'} onClick={() => ignoreOne(record)}>忽略本项目</Button>
          <Button size="small" danger onClick={() => openGlobalRiskModal(record)}>标记不合作</Button>
        </Space>
      )
    }
  ];

  const latestTask = displayedFinderTask;
  const analyzedEvidenceCount = videoEvidence.filter((item) => item.finder_analysis_status === 'success').length;
  const taskPercent = videoEvidence.length
    ? Math.round((analyzedEvidenceCount / videoEvidence.length) * 100)
    : latestTask?.status === 'success' ? 100 : 0;
  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">KOL 寻找</h1>
        <p className="page-subtitle">这里承接搜索找到的候选 KOL，人工通过后进入 KOL 管理和当前项目子表。</p>
      </div>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select allowClear placeholder="选择已发布策略" value={filters.strategy_id} onChange={updateStrategyFilter} options={strategyOptions} style={{ width: 300 }} />
          <Select allowClear placeholder="项目/产品" value={filters.campaign_id} onChange={(v) => updateFilter('campaign_id', v)} options={campaignOptions} style={{ width: 180 }} />
          <Select allowClear placeholder="项目产品" value={filters.campaign_product_id} onChange={(v) => updateFilter('campaign_product_id', v)} options={campaignProducts.map((item) => ({ value: item.id, label: `${item.product?.name || item.product_name || ''} (${item.role || 'hero'})`.trim() }))} style={{ width: 200 }} />
          <Select allowClear placeholder="平台" value={filters.platform} onChange={(v) => updateFilter('platform', v)} options={platformOptions} style={{ width: 140 }} />
          <Select allowClear placeholder="身份识别" value={filters.identity_status} onChange={(v) => updateFilter('identity_status', v)} options={[
            { value: 'new_kol', label: '新 KOL' },
            { value: 'known_kol_new_product_fit', label: '已有 KOL · 新产品匹配' },
            { value: 'existing_product_fit_updated', label: '已有 KOL · 产品匹配更新' }
          ]} style={{ width: 200 }} />
          <Select allowClear placeholder="状态" value={filters.status} onChange={(v) => updateFilter('status', v)} options={statusOptions} style={{ width: 140 }} />
          <InputNumber placeholder="最低评分" min={0} max={100} value={filters.min_score} onChange={(v) => updateFilter('min_score', v)} style={{ width: 120 }} />
          <Input.Search allowClear placeholder="搜索 KOL、链接、关键词、国家" value={filters.search} onChange={(e) => updateFilter('search', e.target.value)} onSearch={fetchCandidates} style={{ width: 300 }} />
          <Button icon={<ReloadOutlined />} onClick={fetchCandidates}>刷新</Button>
          <Button type="primary" icon={<SearchOutlined />} disabled={!selectedStrategy} onClick={openTaskModal}>创建 Finder 任务</Button>
        </Space>
      </Card>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            <strong>最近寻找任务</strong>
            {latestTask ? <Tag color={latestTask.status === 'success' ? 'green' : latestTask.status === 'failed' ? 'red' : latestTask.status === 'partial_failed' ? 'orange' : 'blue'}>{latestTask.status}</Tag> : <Tag>暂无任务</Tag>}
            {latestTask ? <span>候选 {latestTask.success_count || 0} / 失败 {latestTask.failed_count || 0}</span> : null}
            <Button size="small" icon={<ReloadOutlined />} onClick={() => fetchFinderTasks()}>刷新任务</Button>
          </Space>
          {latestTask ? (
            <>
              <Progress percent={taskPercent} size="small" />
              <span style={{ color: '#666' }}>
                {latestTask.error_message || latestTask.name}
              </span>
              {latestTask.provider_attempts?.length ? (
                <Space wrap size={[4, 4]}>
                  {latestTask.provider_attempts.slice(0, 6).map((attempt, index) => (
                    <Tag key={`${attempt.search_source || attempt.provider}-${attempt.target_platform || attempt.platform}-${index}`} color={attempt.ok ? 'green' : 'red'}>
                      {attempt.search_source || attempt.provider} → {attempt.target_platform || attempt.platform}: {attempt.ok ? 'ok' : attempt.error}
                    </Tag>
                  ))}
                </Space>
              ) : null}
              <div style={{ marginTop: 8 }}>
                  <Space wrap style={{ marginBottom: 8 }}>
                    <Tag color="blue">阶段1 视频证据：{videoEvidence.length}</Tag>
                    <Tag color="purple">阶段2 已评分：{videoEvidence.filter((item) => item.finder_analysis_status === 'success').length}</Tag>
                    <Tag color="green">阶段3 候选 KOL</Tag>
                    <Button size="small" onClick={() => fetchVideoEvidence(latestTask.id)} loading={videoEvidenceLoading}>刷新证据</Button>
                    <Button size="small" type="primary" onClick={analyzeVideoEvidence} loading={videoEvidenceLoading} disabled={!videoEvidence.length}>证据评分</Button>
                    <Button size="small" onClick={generateCandidatesFromEvidence} loading={videoEvidenceLoading} disabled={!videoEvidence.some((item) => item.enter_raw_candidates === 'true' && item.recommended_status !== 'ignored')}>生成候选 KOL</Button>
                  </Space>
                  <Table
                    size="small"
                    rowKey="id"
                    dataSource={videoEvidence}
                    loading={videoEvidenceLoading}
                    pagination={{ pageSize: 5 }}
                    columns={[
                      { title: '平台', dataIndex: 'target_platform', key: 'target_platform', width: 100, render: (v) => <Tag>{v}</Tag> },
                      { title: '视频', dataIndex: 'title', key: 'title', width: 260, render: (v, record) => <a href={record.video_url} target="_blank" rel="noreferrer">{v || record.video_url}</a> },
                      { title: '作者', dataIndex: 'author_name', key: 'author_name', width: 160 },
                      { title: '搜索词', dataIndex: 'source_query', key: 'source_query', width: 180 },                      {
                        title: '线索',
                        dataIndex: 'evidence_signals',
                        key: 'evidence_signals',
                        width: 220,
                        render: (value) => {
                          const signals = normalizeEvidenceSignals(value);
                          return signals.length ? (
                            <Space wrap size={[4, 4]}>
                              {signals.map((item) => (
                                <Tag key={item.signal} color="cyan" title={item.reason}>
                                  {evidenceSignalLabels[item.signal] || item.signal}
                                </Tag>
                              ))}
                            </Space>
                          ) : '-';
                        }
                      },                      { title: '优先级', dataIndex: 'candidate_priority_score', key: 'candidate_priority_score', width: 90, render: (v) => v ?? '-' },
                      { title: '最高信号', dataIndex: 'content_relevance_score', key: 'content_relevance_score', width: 100, render: (v) => v ?? '-' },
                      { title: '证据强度', dataIndex: 'evidence_strength_score', key: 'evidence_strength_score', width: 90, render: (v) => v ?? '-' },
                      { title: '创作者匹配', dataIndex: 'creator_fit_score', key: 'creator_fit_score', width: 100, render: (v) => v ?? '-' },
                      { title: '推荐状态', dataIndex: 'recommended_status', key: 'recommended_status', width: 140, render: (v) => <Tag color={v === 'new' ? 'green' : v === 'manual_review' ? 'orange' : v === 'risk_review' ? 'red' : 'default'}>{evidenceStatusLabel(v)}</Tag> },
                      { title: '风险', dataIndex: 'risk_level', key: 'risk_level', width: 100, render: (v) => <Tag color={v === 'high' ? 'red' : v === 'medium' ? 'orange' : 'green'}>{riskLevelLabel(v)}</Tag> }
                    ]}
                    scroll={{ x: 1500 }}
                  />
              </div>
            </>
          ) : (
            <span style={{ color: '#666' }}>选择已发布策略后，选择一个目标平台即可开始寻找视频证据。</span>
          )}
        </Space>
      </Card>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Space wrap>
          <span>已选 {selectedRowKeys.length} 个候选</span>
          <Button icon={<CheckOutlined />} disabled={!selectedRowKeys.length || !selectedStrategy} onClick={batchApprove}>批量通过</Button>
          <Button icon={<StopOutlined />} disabled={!selectedRowKeys.length} onClick={batchIgnore}>批量忽略本项目</Button>
          <Popconfirm title="确定删除选中的候选？" onConfirm={batchDelete}>
            <Button danger icon={<DeleteOutlined />} disabled={!selectedRowKeys.length}>批量删除</Button>
          </Popconfirm>
        </Space>
      </Card>

      <Card className="content-card">
        <Table
          rowKey="id"
          columns={columns}
          dataSource={candidates}
          loading={loading}
          rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
          scroll={{ x: 2900 }}
          pagination={{ pageSize: 20, showSizeChanger: true }}
        />
      </Card>

      <Modal title="创建视频证据寻找任务" open={taskModalOpen} onCancel={() => setTaskModalOpen(false)} onOk={startFinderTask} confirmLoading={taskLoading} okText="开始找视频" width={520}>
        <Form form={taskForm} layout="vertical">
          <Form.Item label="项目">
            <Input value={selectedStrategy?.campaign_name || campaigns.find((c) => c.id === selectedStrategy?.campaign_id)?.name || ''} disabled />
          </Form.Item>
          <Form.Item label="项目产品">
            <Input value={selectedStrategy?.product_name || ''} disabled />
          </Form.Item>
          <Form.Item label="策略">
            <Input value={selectedStrategy?.name || ''} disabled />
          </Form.Item>
          <Form.Item label="目标平台" name="target_platform" rules={[{ required: true, message: '请选择一个目标平台' }]}>
            <Select options={platformOptions} />
          </Form.Item>
          <Form.Item label="视频数量上限" name="limit" rules={[{ required: true, message: '请输入视频数量上限' }]}>
            <InputNumber min={1} max={50} style={{ width: '100%' }} />
          </Form.Item>
          <span style={{ color: '#666' }}>系统会直接在目标平台寻找视频，再由 AI 判断每条视频命中的一个或多个线索。</span>
        </Form>
      </Modal>

      <Modal title="候选详情" open={Boolean(detail)} onCancel={() => setDetail(null)} footer={null} width={760}>
        {detail ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div><strong>KOL：</strong>{detail.kol_name}</div>
            <div><strong>项目：</strong>{detail.campaign_name || '-'}</div>
            <div><strong>项目产品：</strong>{detail.product_name || '-'}</div>
            <div><strong>身份识别：</strong>{identityStatusLabel(detail.fit_identity_status)}</div>
            <div><strong>产品匹配分：</strong>{detail.fit_score ?? '-'}</div>
            <div><strong>策略：</strong>{detail.strategy_name || '未绑定策略'}</div>
            <div><strong>匹配 KOL画像：</strong>{detail.matched_persona || '未生成'}</div>
            <div><strong>平台：</strong>{detail.platform || '-'}</div>
            <div><strong>来源视频：</strong>{detail.video_url ? <a href={detail.video_url} target="_blank" rel="noreferrer">{detail.video_title || detail.video_url}</a> : '-'}</div>
            <div><strong>来源：</strong>{detail.source || '-'}</div>
            <div><strong>发现路径：</strong>{detail.discovery_route || '-'}</div>
            <div><strong>来源平台：</strong>{detail.source_platform || '-'}</div>
            <div><strong>目标平台：</strong>{detail.target_platform || detail.platform || '-'}</div>
            <div>
              <strong>目标平台主页：</strong>
              {getTargetProfileUrl(detail) ? (
                <a href={getTargetProfileUrl(detail)} target="_blank" rel="noreferrer">
                  {detail.target_platform || detail.platform || 'Profile'} 主页
                </a>
              ) : '-'}
            </div>
            <div><strong>来源 Agent：</strong>{detail.source_agent || '-'}</div>
            <div><strong>证据：</strong>{detail.evidence_url ? <a href={detail.evidence_url} target="_blank" rel="noreferrer">{detail.evidence_title || detail.evidence_url}</a> : '-'}</div>
            <div><strong>证据类型：</strong>{detail.evidence_type || '-'}</div>
            <div><strong>搜索 Query：</strong>{detail.source_query || '-'}</div>
            <div><strong>寻找任务：</strong>{detail.finder_task_name || detail.finder_task_id || '-'}</div>
            <div><strong>项目级拒绝：</strong>{detail.rejection_scope === 'project' || detail.status === 'ignored' ? `${cooperationRiskLabel(detail.rejection_category)} ${detail.rejection_reason || ''}` : '-'}</div>
            <div><strong>全局合作状态：</strong>{detail.global_cooperation_status === 'do_not_contact' ? `全局不建议合作 / ${cooperationRiskLabel(detail.global_cooperation_risk_category)} / ${detail.global_cooperation_risk_reason || '-'}` : '-'}</div>
            <div><strong>匹配关键词：</strong>{detail.matched_keywords || '-'}</div>
            <div><strong>评分拆解：</strong>{detail.scoring_breakdown || '-'}</div>
            <div><strong>AI匹配理由：</strong>{detail.ai_match_reason || '-'}</div>
            <div><strong>错误原因：</strong>{detail.error_message || '-'}</div>
          </Space>
        ) : null}
      </Modal>

      <Modal title="标记为全局不建议合作" open={Boolean(globalRiskRecord)} onCancel={() => setGlobalRiskRecord(null)} onOk={submitGlobalRisk} width={560}>
        <Form form={riskForm} layout="vertical">
          <Form.Item label="KOL">
            <Input value={globalRiskRecord?.kol_name || ''} disabled />
          </Form.Item>
          <Form.Item label="不建议合作类型" name="category" rules={[{ required: true, message: '请选择类型' }]}>
            <Select options={cooperationRiskOptions} />
          </Form.Item>
          <Form.Item label="原因" name="reason" rules={[{ required: true, message: '请填写原因' }]}>
            <TextArea rows={4} placeholder="例如：历史明确拒绝合作、沟通风险、报价长期不匹配、品牌安全风险等" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default RawCandidates;
