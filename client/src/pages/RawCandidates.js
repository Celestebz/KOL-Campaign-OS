import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Checkbox, Form, Input, InputNumber, message, Modal, Popconfirm, Progress, Select, Space, Switch, Table, Tag } from 'antd';
import { CheckOutlined, DeleteOutlined, EyeOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import axios from 'axios';

const { TextArea } = Input;

const platformOptions = [
  { value: 'youtube', label: 'YouTube' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'tiktok', label: 'TikTok' }
];

const searchSourceOptions = [
  { value: 'maton_agent', label: 'Maton Agent' },
  { value: 'google_web', label: 'Google Web' },
  { value: 'youtube_search', label: 'YouTube Search' },
  { value: 'instagram_search', label: 'Instagram Search' },
  { value: 'tiktok_search', label: 'TikTok Search' }
];

const discoveryRouteOptions = [
  { value: 'target_platform_first', label: 'Target Platform First' },
  { value: 'youtube_native_search', label: 'YouTube Native Search' },
  { value: 'google_web_to_youtube', label: 'Google/Web -> YouTube' },
  { value: 'youtube_to_instagram', label: 'YouTube -> Instagram' },
  { value: 'google_web_to_instagram', label: 'Google/Web -> Instagram' },
  { value: 'reddit_to_instagram', label: 'Reddit -> Instagram' },
  { value: 'seed_posts_to_profile', label: 'Seed Posts/Reels -> Profile' },
  { value: 'instagram_native_small_batch', label: 'Instagram Native Small Batch (fallback)' },
  { value: 'google_web_to_tiktok', label: 'Google/Web -> TikTok' },
  { value: 'youtube_to_tiktok', label: 'YouTube -> TikTok' },
  { value: 'instagram_to_tiktok', label: 'Instagram -> TikTok' },
  { value: 'reddit_to_tiktok', label: 'Reddit -> TikTok' },
  { value: 'tiktok_native_small_batch', label: 'TikTok Native Small Batch (fallback)' },
  { value: 'spider_web_expansion', label: 'Spider-web Expansion' }
];

const defaultRoutesForTargets = (targets = []) => {
  const routes = [];
  if (targets.includes('youtube')) routes.push('youtube_native_search', 'google_web_to_youtube', 'spider_web_expansion');
  if (targets.includes('instagram')) routes.push('youtube_to_instagram', 'google_web_to_instagram', 'seed_posts_to_profile');
  if (targets.includes('tiktok')) routes.push('google_web_to_tiktok', 'seed_posts_to_profile');
  return [...new Set(routes.length ? routes : ['youtube_native_search'])];
};

const cycleOrder = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'];

const searchIntensityOptions = [
  { value: 'quick', label: '快速验证' },
  { value: 'standard', label: '标准搜索（推荐）' },
  { value: 'full', label: '全量搜索' }
];

const searchIntensityCycles = {
  youtube: {
    quick: ['C1', 'C2', 'C4'],
    standard: ['C1', 'C2', 'C3', 'C4'],
    full: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']
  },
  instagram: {
    quick: ['C2', 'C3', 'C5'],
    standard: ['C1', 'C2', 'C3', 'C5'],
    full: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']
  },
  tiktok: {
    quick: ['C2', 'C3', 'C5'],
    standard: ['C2', 'C3', 'C5', 'C6'],
    full: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']
  }
};

const recommendedCyclesForTargets = (targets = [], intensity = 'standard') => {
  const normalizedTargets = [...new Set((targets.length ? targets : ['youtube']).filter((target) => searchIntensityCycles[target]))];
  const ids = normalizedTargets.flatMap((target) => searchIntensityCycles[target]?.[intensity] || searchIntensityCycles[target]?.standard || []);
  return cycleOrder.filter((cycle) => ids.includes(cycle) && cycle !== 'C7');
};

const sortCycles = (cycles = []) => [...cycles].sort((a, b) => (
  cycleOrder.indexOf(a.cycle) - cycleOrder.indexOf(b.cycle)
));

const statusOptions = [
  { value: 'new', label: '待审核' },
  { value: 'approved', label: '已通过' },
  { value: 'duplicate', label: '重复' },
  { value: 'risk_review', label: '历史风险' },
  { value: 'ignored', label: '已忽略' },
  { value: 'error', label: '错误' }
];

const statusColor = {
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

const RawCandidates = () => {
  const [candidates, setCandidates] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [finderTasks, setFinderTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [taskLoading, setTaskLoading] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [filters, setFilters] = useState({ status: 'new' });
  const [modalOpen, setModalOpen] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [videoEvidence, setVideoEvidence] = useState([]);
  const [videoEvidenceLoading, setVideoEvidenceLoading] = useState(false);
  const [detail, setDetail] = useState(null);
  const [globalRiskRecord, setGlobalRiskRecord] = useState(null);
  const [form] = Form.useForm();
  const [riskForm] = Form.useForm();
  const [taskForm] = Form.useForm();
  const executionMode = Form.useWatch('execution_mode', taskForm);
  const searchIntensity = Form.useWatch('search_intensity', taskForm) || 'standard';
  const selectedTargetPlatforms = Form.useWatch('target_platforms', taskForm) || [];
  const recommendedTaskCycles = recommendedCyclesForTargets(selectedTargetPlatforms, searchIntensity);

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
    if (!finderTasks[0]?.id) {
      setVideoEvidence([]);
      return;
    }
    fetchVideoEvidence(finderTasks[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finderTasks[0]?.id]);

  useEffect(() => {
    if (!taskModalOpen) return;
    taskForm.setFieldValue('cycles', recommendedTaskCycles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskModalOpen, searchIntensity, selectedTargetPlatforms.join(',')]);

  useEffect(() => {
    if (!taskModalOpen || !selectedTargetPlatforms.length) return;
    taskForm.setFieldValue(
      'discovery_routes',
      executionMode === 'video_evidence_finder' ? ['target_platform_first'] : defaultRoutesForTargets(selectedTargetPlatforms)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskModalOpen, executionMode]);

  useEffect(() => {
    if (!taskModalOpen) return;
    const targets = taskForm.getFieldValue('target_platforms') || [];
    if (!targets.length) return;
    taskForm.setFieldValue(
      'discovery_routes',
      executionMode === 'video_evidence_finder' ? ['target_platform_first'] : defaultRoutesForTargets(targets)
    );
    if (executionMode === 'video_evidence_finder') taskForm.setFieldValue('cycles', ['C2', 'C3', 'C6']);
  }, [executionMode, taskModalOpen, taskForm]);

  const fetchCampaigns = async () => {
    const res = await axios.get('/api/campaigns');
    setCampaigns(res.data.data || []);
  };

  const fetchStrategies = async () => {
    const res = await axios.get('/api/kol-strategies', { params: { status: 'ready' } });
    setStrategies(res.data.data || []);
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
      const params = strategyId ? { strategy_id: strategyId } : {};
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
    const strategyCycles = sortCycles(selectedStrategy.search_strategy || []);
    const targetPlatforms = [
      selectedStrategy.primary_platform,
      ...(selectedStrategy.secondary_platforms || []),
      ...(selectedStrategy.finder_handoff?.required_platforms || [])
    ].filter(Boolean);
    const searchSources = strategyCycles.flatMap((cycle) => (
      Array.isArray(cycle.search_sources) ? cycle.search_sources : String(cycle.search_sources || '').split(/[,，;]/)
    )).map((value) => String(value || '').trim()).filter(Boolean);
    const discoveryRoutes = strategyCycles.flatMap((cycle) => (
      Array.isArray(cycle.discovery_routes) ? cycle.discovery_routes : String(cycle.discovery_routes || '').split(/[,，;]/)
    )).map((value) => String(value || '').trim()).filter(Boolean);
    const uniqueTargetPlatforms = [...new Set(targetPlatforms.length ? targetPlatforms : ['youtube'])];
    const searchIntensityValue = 'standard';
    taskForm.setFieldsValue({
      search_intensity: searchIntensityValue,
      cycles: recommendedCyclesForTargets(uniqueTargetPlatforms, searchIntensityValue),
      discovery_routes: [...new Set(discoveryRoutes.length ? discoveryRoutes : defaultRoutesForTargets(uniqueTargetPlatforms))],
      search_sources: [...new Set(searchSources.length ? searchSources : ['maton_agent', 'google_web', 'youtube_search'])],
      target_platforms: uniqueTargetPlatforms,
      seed_urls: '',
      execution_mode: 'video_evidence_finder',
      limit_per_platform: 10,
      allow_fallback: true
    });
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
      const recommendedCycles = recommendedCyclesForTargets(values.target_platforms || [], values.search_intensity || 'standard');
      const selectedCycles = [...(values.cycles || [])].sort().join(',');
      const expectedCycles = [...recommendedCycles].sort().join(',');
      await axios.post('/api/finder-tasks', {
        strategy_id: selectedStrategy.id,
        ...values,
        cycles_source: selectedCycles === expectedCycles ? 'intensity' : 'manual'
      });
      message.success('Finder 搜索任务已启动');
      setTaskModalOpen(false);
      fetchFinderTasks(selectedStrategy.id);
      fetchCandidates();
    } catch (error) {
      message.error(error.response?.data?.error || '启动寻找任务失败');
    } finally {
      setTaskLoading(false);
    }
  };

  const updateTaskRoutesForTargets = (targets = []) => {
    taskForm.setFieldValue(
      'discovery_routes',
      executionMode === 'video_evidence_finder' ? ['target_platform_first'] : defaultRoutesForTargets(targets)
    );
    taskForm.setFieldValue('cycles', executionMode === 'video_evidence_finder' ? ['C2', 'C3', 'C6'] : recommendedCyclesForTargets(targets, taskForm.getFieldValue('search_intensity') || 'standard'));
  };

  const openCreate = () => {
    if (!selectedStrategy) {
      message.warning('请先选择一个已发布策略');
      return;
    }
    form.resetFields();
    form.setFieldsValue({
      strategy_id: selectedStrategy.id,
      campaign_id: selectedStrategy.campaign_id,
      platform: selectedStrategy.primary_platform || 'youtube',
      status: 'new',
      source: 'manual'
    });
    setModalOpen(true);
  };

  const handleCreate = async () => {
    if (!selectedStrategy) {
      message.warning('请先选择一个已发布策略');
      return;
    }
    const values = await form.validateFields();
    await axios.post('/api/raw-candidates', {
      ...values,
      strategy_id: selectedStrategy.id,
      campaign_id: selectedStrategy.campaign_id
    });
    message.success('候选已保存');
    setModalOpen(false);
    fetchCandidates();
  };

  const approveOne = async (record) => {
    const strategyId = record.strategy_id || selectedStrategy?.id;
    if (!strategyId) {
      message.warning('请先选择一个已发布策略');
      return;
    }
    await axios.post(`/api/raw-candidates/${record.id}/approve`, {
      strategy_id: strategyId,
      campaign_id: record.campaign_id || selectedStrategy?.campaign_id || filters.campaign_id || 1
    });
    message.success('已加入 KOL 管理和当前项目子表');
    fetchCandidates();
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
          <span style={{ color: '#666' }}>{r.ai_match_reason || r.matched_keywords || '-'}</span>
        </Space>
      )
    },
    { title: '项目', dataIndex: 'campaign_name', key: 'campaign_name', width: 150, render: (v) => v || '-' },
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
    { title: '搜索轮次', dataIndex: 'search_cycle', key: 'search_cycle', width: 110, render: (v) => v || '-' },
    { title: 'KOL画像', dataIndex: 'matched_persona', key: 'matched_persona', width: 150, render: (v) => v || '-' },
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
    {
      title: '代表视频',
      key: 'video',
      width: 170,
      render: (_, r) => r.video_url ? <a href={r.video_url} target="_blank" rel="noreferrer">{r.video_title || '代表视频'}</a> : '-'
    },
    {
      title: '证据',
      key: 'evidence',
      width: 170,
      render: (_, r) => r.evidence_url ? <a href={r.evidence_url} target="_blank" rel="noreferrer">{r.evidence_title || r.evidence_type || '证据'}</a> : '-'
    },
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
    { title: '状态', dataIndex: 'status', key: 'status', width: 120, render: (v) => <Tag color={statusColor[v] || 'default'}>{v || 'new'}</Tag> },
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

  const cycleOptions = sortCycles(selectedStrategy?.search_strategy?.length ? selectedStrategy.search_strategy : [
    { cycle: 'C1', name: '竞品评测' },
    { cycle: 'C2', name: '品类搜索' },
    { cycle: 'C3', name: '使用场景搜索' },
    { cycle: 'C4', name: '功能/技术搜索' },
    { cycle: 'C5', name: '社区/受众搜索' },
    { cycle: 'C6', name: '平台内搜索' },
    { cycle: 'C7', name: '线索扩展' }
  ]).map((cycle) => ({
    label: `${cycle.cycle} ${cycle.name}`,
    value: cycle.cycle
  }));

  const latestTask = finderTasks[0];
  const expansionSummary = (latestTask?.raw_response_summary || []).find((item) => item.expansion_cycle === 'C7' && item.expansion_status === 'deferred');
  const taskPercent = latestTask?.total_cycles
    ? Math.round(((latestTask.completed_cycles || 0) / latestTask.total_cycles) * 100)
    : 0;

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
          <Select allowClear placeholder="平台" value={filters.platform} onChange={(v) => updateFilter('platform', v)} options={platformOptions} style={{ width: 140 }} />
          <Select allowClear placeholder="状态" value={filters.status} onChange={(v) => updateFilter('status', v)} options={statusOptions} style={{ width: 140 }} />
          <InputNumber placeholder="最低评分" min={0} max={100} value={filters.min_score} onChange={(v) => updateFilter('min_score', v)} style={{ width: 120 }} />
          <Input.Search allowClear placeholder="搜索 KOL、链接、关键词、国家" value={filters.search} onChange={(e) => updateFilter('search', e.target.value)} onSearch={fetchCandidates} style={{ width: 300 }} />
          <Button icon={<ReloadOutlined />} onClick={fetchCandidates}>刷新</Button>
          <Button type="primary" icon={<SearchOutlined />} disabled={!selectedStrategy} onClick={openTaskModal}>创建 Finder 任务</Button>
          <Button type="primary" icon={<PlusOutlined />} disabled={!selectedStrategy} onClick={openCreate}>新增候选</Button>
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
                {latestTask.current_cycle ? `当前轮次：${latestTask.current_cycle}；` : ''}
                {latestTask.error_message || latestTask.name}
              </span>
              {latestTask.provider_attempts?.length ? (
                <Space wrap size={[4, 4]}>
                  {latestTask.provider_attempts.slice(0, 6).map((attempt, index) => (
                    <Tag key={`${attempt.cycle}-${attempt.search_source}-${attempt.target_platform}-${index}`} color={attempt.ok ? 'green' : 'red'}>
                      {attempt.cycle} / {attempt.search_source || attempt.provider} → {attempt.target_platform || attempt.platform}: {attempt.ok ? 'ok' : attempt.error}
                    </Tag>
                  ))}
                </Space>
              ) : null}
              {expansionSummary ? (
                <Space wrap>
                  <Tag color="default">C7 线索扩展：等待种子候选</Tag>
                  <span style={{ color: '#666' }}>{expansionSummary.expansion_reason || 'waiting_for_seeds'}</span>
                </Space>
              ) : null}
              {safeParseJson(latestTask?.raw_request)?.execution_mode === 'video_evidence_finder' || videoEvidence.length ? (
                <div style={{ marginTop: 8 }}>
                  <Space wrap style={{ marginBottom: 8 }}>
                    <Tag color="blue">Stage 1 Video Evidence: {videoEvidence.length}</Tag>
                    <Tag color="purple">Stage 2 Scored: {videoEvidence.filter((item) => item.finder_analysis_status === 'success').length}</Tag>
                    <Tag color="green">Stage 3 Raw Candidates</Tag>
                    <Button size="small" onClick={() => fetchVideoEvidence(latestTask.id)} loading={videoEvidenceLoading}>Refresh Evidence</Button>
                    <Button size="small" type="primary" onClick={analyzeVideoEvidence} loading={videoEvidenceLoading} disabled={!videoEvidence.length}>Score Evidence</Button>
                    <Button size="small" onClick={generateCandidatesFromEvidence} loading={videoEvidenceLoading} disabled={!videoEvidence.some((item) => item.enter_raw_candidates === 'true' && item.recommended_status !== 'ignored')}>Generate Raw Candidates</Button>
                  </Space>
                  <Table
                    size="small"
                    rowKey="id"
                    dataSource={videoEvidence}
                    loading={videoEvidenceLoading}
                    pagination={{ pageSize: 5 }}
                    columns={[
                      { title: 'Platform', dataIndex: 'target_platform', key: 'target_platform', width: 100, render: (v) => <Tag>{v}</Tag> },
                      { title: 'Video', dataIndex: 'title', key: 'title', width: 260, render: (v, record) => <a href={record.video_url} target="_blank" rel="noreferrer">{v || record.video_url}</a> },
                      { title: 'Author', dataIndex: 'author_name', key: 'author_name', width: 160 },
                      { title: 'Source Query', dataIndex: 'source_query', key: 'source_query', width: 180 },
                      { title: 'Signal', dataIndex: 'source_signal', key: 'source_signal', width: 120, render: (v) => <Tag color="cyan">{v}</Tag> },
                      { title: 'Priority', dataIndex: 'candidate_priority_score', key: 'candidate_priority_score', width: 90, render: (v) => v ?? '-' },
                      { title: 'Best Signal', dataIndex: 'content_relevance_score', key: 'content_relevance_score', width: 100, render: (v) => v ?? '-' },
                      { title: 'Evidence', dataIndex: 'evidence_strength_score', key: 'evidence_strength_score', width: 90, render: (v) => v ?? '-' },
                      { title: 'Creator', dataIndex: 'creator_fit_score', key: 'creator_fit_score', width: 90, render: (v) => v ?? '-' },
                      { title: 'Status', dataIndex: 'recommended_status', key: 'recommended_status', width: 140, render: (v) => <Tag color={v === 'new' ? 'green' : v === 'manual_review' ? 'orange' : v === 'risk_review' ? 'red' : 'default'}>{v || 'not scored'}</Tag> },
                      { title: 'Risk', dataIndex: 'risk_level', key: 'risk_level', width: 100, render: (v) => <Tag color={v === 'high' ? 'red' : v === 'medium' ? 'orange' : 'green'}>{v || '-'}</Tag> }
                    ]}
                    scroll={{ x: 1500 }}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <span style={{ color: '#666' }}>选择已发布策略后，可以按搜索强度创建 Finder 任务。C7 线索扩展会在有种子候选后再生成。</span>
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

      <Modal title="新增候选" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleCreate} width={820}>
        <Form form={form} layout="vertical">
          <Form.Item label="策略" name="strategy_id">
            <Select disabled options={strategyOptions} />
          </Form.Item>
          <Form.Item label="KOL 名称" name="kol_name" rules={[{ required: true, message: '请输入 KOL 名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="项目/产品" name="campaign_id">
            <Select disabled options={campaignOptions} />
          </Form.Item>
          <Form.Item label="平台" name="platform">
            <Select options={platformOptions} />
          </Form.Item>
          <Form.Item label="主页链接" name="profile_url">
            <Input />
          </Form.Item>
          <Form.Item label="来源视频链接（可选）" name="video_url">
            <Input />
          </Form.Item>
          <Form.Item label="来源视频标题（可选）" name="video_title">
            <Input />
          </Form.Item>
          <Space style={{ width: '100%' }} align="start">
            <Form.Item label="联系人" name="contact_name">
              <Input style={{ width: 180 }} />
            </Form.Item>
            <Form.Item label="Email" name="email">
              <Input style={{ width: 220 }} />
            </Form.Item>
            <Form.Item label="国家地区" name="country_region">
              <Input style={{ width: 160 }} />
            </Form.Item>
          </Space>
          <Space style={{ width: '100%' }} align="start">
            <Form.Item label="粉丝量" name="followers">
              <Input style={{ width: 160 }} />
            </Form.Item>
            <Form.Item label="平均播放" name="avg_views">
              <Input style={{ width: 160 }} />
            </Form.Item>
            <Form.Item label="AI评分" name="ai_score">
              <InputNumber min={0} max={100} style={{ width: 120 }} />
            </Form.Item>
          </Space>
          <Form.Item label="匹配关键词" name="matched_keywords">
            <Input />
          </Form.Item>
          <Space style={{ width: '100%' }} align="start">
            <Form.Item label="搜索轮次" name="search_cycle">
              <Input placeholder="C1 / C2 / Competitor Reviews..." style={{ width: 220 }} />
            </Form.Item>
            <Form.Item label="匹配 KOL画像" name="matched_persona">
              <Input placeholder="主画像 / 次画像..." style={{ width: 260 }} />
            </Form.Item>
          </Space>
          <Form.Item label="AI匹配理由 / 备注" name="ai_match_reason">
            <TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="创建寻找任务" open={taskModalOpen} onCancel={() => setTaskModalOpen(false)} onOk={startFinderTask} confirmLoading={taskLoading} okText="启动搜索" width={760}>
        <Form form={taskForm} layout="vertical">
          <Form.Item label="策略">
            <Input value={selectedStrategy?.name || ''} disabled />
          </Form.Item>
          <Form.Item label="执行模式" name="execution_mode" rules={[{ required: true, message: '请选择执行模式' }]}>
            <Select options={[
              { value: 'video_evidence_finder', label: 'Video Evidence Finder' },
              { value: 'system_provider', label: 'System Provider' }
            ]} />
          </Form.Item>
          <Form.Item label="搜索强度" name="search_intensity" rules={[{ required: true, message: '请选择搜索强度' }]}>
            <Select options={searchIntensityOptions} />
          </Form.Item>
          <div style={{ marginBottom: 16, color: '#666' }}>
            推荐轮次：{recommendedTaskCycles.length ? recommendedTaskCycles.join(' / ') : '请先选择目标平台'}。C7 线索扩展会在有种子候选后作为二阶段任务生成。
          </div>
          <Form.Item label="发现路径" name="discovery_routes" rules={[{ required: true, message: '请选择至少一个发现路径' }]}>
            <Checkbox.Group options={discoveryRouteOptions} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 8 }} />
          </Form.Item>
          <Form.Item label="种子链接" name="seed_urls" tooltip="粘贴 Instagram post、reel 或 profile 链接，每行一个。">
            <TextArea rows={3} placeholder={"https://www.instagram.com/reel/...\nhttps://www.instagram.com/example/"} />
          </Form.Item>
          <Form.Item label="高级：手动搜索轮次" name="cycles" rules={[{ required: true, message: '请选择至少一个搜索轮次' }]} tooltip="默认按搜索强度推荐。手动选择会随任务一起提交；无种子时 C7 会延后。">
            <Checkbox.Group options={cycleOptions} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 8 }} />
          </Form.Item>
          <Form.Item label="高级搜索源" name="search_sources" tooltip="兼容旧版寻找执行器的高级设置。Instagram V2 默认不使用站内主页搜索。">
            <Checkbox.Group options={searchSourceOptions} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 8 }} />
          </Form.Item>
          <Form.Item label="目标 KOL 平台" name="target_platforms" rules={[{ required: true, message: '请选择至少一个目标平台' }]}>
            <Checkbox.Group options={platformOptions} onChange={updateTaskRoutesForTargets} />
          </Form.Item>
          <Form.Item label="每轮每平台上限" name="limit_per_platform" rules={[{ required: true, message: '请输入上限' }]}>
            <InputNumber min={1} max={50} style={{ width: 180 }} />
          </Form.Item>
          <Form.Item label="主搜索源失败时尝试备用搜索源" name="allow_fallback" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="候选详情" open={Boolean(detail)} onCancel={() => setDetail(null)} footer={null} width={760}>
        {detail ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div><strong>KOL：</strong>{detail.kol_name}</div>
            <div><strong>项目：</strong>{detail.campaign_name || '-'}</div>
            <div><strong>策略：</strong>{detail.strategy_name || '未绑定策略'}</div>
            <div><strong>搜索轮次：</strong>{detail.search_cycle || '-'}</div>
            <div><strong>匹配 KOL画像：</strong>{detail.matched_persona || '-'}</div>
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
