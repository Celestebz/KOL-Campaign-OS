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
  { value: 'youtube_native_search', label: 'YouTube Native Search' },
  { value: 'google_web_to_youtube', label: 'Google/Web -> YouTube' },
  { value: 'youtube_to_instagram', label: 'YouTube -> Instagram' },
  { value: 'google_web_to_instagram', label: 'Google/Web -> Instagram' },
  { value: 'reddit_to_instagram', label: 'Reddit -> Instagram' },
  { value: 'seed_posts_to_profile', label: 'Seed Posts/Reels -> Profile' },
  { value: 'instagram_native_small_batch', label: 'Instagram Native Small Batch (fallback)' },
  { value: 'google_web_to_tiktok', label: 'Google/Web -> TikTok' },
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

const defaultSubagentRoutesForTargets = (targets = []) => {
  const routes = [];
  if (targets.includes('youtube')) routes.push('youtube_native_search', 'google_web_to_youtube', 'spider_web_expansion');
  if (targets.includes('instagram')) routes.push('youtube_to_instagram', 'google_web_to_instagram', 'reddit_to_instagram', 'seed_posts_to_profile', 'instagram_native_small_batch');
  if (targets.includes('tiktok')) routes.push('google_web_to_tiktok', 'seed_posts_to_profile', 'tiktok_native_small_batch');
  return [...new Set(routes.length ? routes : ['youtube_native_search'])];
};

const cycleOrder = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'];

const sortCycles = (cycles = []) => [...cycles].sort((a, b) => (
  cycleOrder.indexOf(a.cycle) - cycleOrder.indexOf(b.cycle)
));

const statusOptions = [
  { value: 'new', label: 'New' },
  { value: 'approved', label: 'Approved' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'ignored', label: 'Ignored' },
  { value: 'error', label: 'Error' }
];

const statusColor = {
  new: 'blue',
  approved: 'green',
  duplicate: 'purple',
  ignored: 'default',
  error: 'red'
};

const safeParseJson = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
};

const subtaskSummary = (subtask) => safeParseJson(subtask?.agent_result_summary) || {};

const routePlanRoutes = (subtask) => {
  const plan = subtaskSummary(subtask).route_plan || {};
  const routes = [...(plan.required_routes || []), ...(plan.optional_routes || [])];
  return routes.map((item) => ({
    route: item.route,
    required: Boolean(item.required)
  })).filter((item) => item.route);
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
  const [finderSubtasks, setFinderSubtasks] = useState([]);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [filters, setFilters] = useState({ status: 'new' });
  const [modalOpen, setModalOpen] = useState(false);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [promptModal, setPromptModal] = useState(null);
  const [importModal, setImportModal] = useState(null);
  const [importPayload, setImportPayload] = useState('');
  const [detail, setDetail] = useState(null);
  const [form] = Form.useForm();
  const [taskForm] = Form.useForm();
  const executionMode = Form.useWatch('execution_mode', taskForm);
  const selectedTaskCycles = Form.useWatch('cycles', taskForm) || [];

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
      setFinderSubtasks([]);
      return;
    }
    fetchSubtasks(finderTasks[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finderTasks[0]?.id]);

  useEffect(() => {
    if (!taskModalOpen) return;
    const targets = taskForm.getFieldValue('target_platforms') || [];
    if (!targets.length) return;
    taskForm.setFieldValue(
      'discovery_routes',
      executionMode === 'subagent_hybrid' ? defaultSubagentRoutesForTargets(targets) : defaultRoutesForTargets(targets)
    );
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
      message.error(error.response?.data?.error || '获取 Raw Candidates 失败');
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
      message.error(error.response?.data?.error || '获取 Finder Task 失败');
    }
  };

  const fetchSubtasks = async (finderTaskId = finderTasks[0]?.id) => {
    if (!finderTaskId) return;
    try {
      const res = await axios.get(`/api/finder-tasks/${finderTaskId}/subtasks`);
      setFinderSubtasks(res.data.data || []);
    } catch (error) {
      message.error(error.response?.data?.error || '获取 Subagent 任务失败');
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
      message.warning('请先选择一个 Ready Strategy');
      return;
    }
    const strategyCycles = sortCycles(selectedStrategy.search_strategy || []);
    const cycles = strategyCycles.length
      ? strategyCycles.filter((cycle) => String(cycle.keywords || '').trim()).map((cycle) => cycle.cycle)
      : ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'];
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
    taskForm.setFieldsValue({
      cycles,
      discovery_routes: [...new Set(discoveryRoutes.length ? discoveryRoutes : defaultRoutesForTargets(uniqueTargetPlatforms))],
      search_sources: [...new Set(searchSources.length ? searchSources : ['maton_agent', 'google_web', 'youtube_search'])],
      target_platforms: uniqueTargetPlatforms,
      seed_urls: '',
      execution_mode: 'system_provider',
      limit_per_platform: 10,
      allow_fallback: true
    });
    setTaskModalOpen(true);
  };

  const startFinderTask = async () => {
    if (!selectedStrategy) {
      message.warning('请先选择一个 Ready Strategy');
      return;
    }
    const values = await taskForm.validateFields();
    setTaskLoading(true);
    try {
      const res = await axios.post('/api/finder-tasks', {
        strategy_id: selectedStrategy.id,
        ...values
      });
      const task = res.data.data;
      if (values.execution_mode === 'subagent_hybrid') {
        const generated = await axios.post(`/api/finder-tasks/${task.id}/subtasks/generate`);
        setFinderSubtasks(generated.data.data || []);
        message.success(`已生成 ${generated.data.data?.length || 0} 个 Subagent 任务`);
      } else {
        message.success('7 轮搜索任务已启动');
      }
      setTaskModalOpen(false);
      fetchFinderTasks(selectedStrategy.id);
      fetchCandidates();
    } catch (error) {
      message.error(error.response?.data?.error || '启动 Finder 任务失败');
    } finally {
      setTaskLoading(false);
    }
  };

  const openPrompt = async (subtask) => {
    try {
      const res = await axios.get(`/api/finder-subtasks/${subtask.id}/prompt`);
      setPromptModal(res.data.data);
    } catch (error) {
      message.error(error.response?.data?.error || '获取 Prompt 失败');
    }
  };

  const copyPrompt = async () => {
    if (!promptModal?.agent_prompt) return;
    try {
      await navigator.clipboard.writeText(promptModal.agent_prompt);
      message.success('Prompt 已复制');
    } catch (error) {
      message.error('复制失败，请手动选择文本复制');
    }
  };

  const updateTaskRoutesForTargets = (targets = []) => {
    taskForm.setFieldValue(
      'discovery_routes',
      executionMode === 'subagent_hybrid' ? defaultSubagentRoutesForTargets(targets) : defaultRoutesForTargets(targets)
    );
  };

  const openImport = (subtask) => {
    const isCycleSubtask = subtask.discovery_route === 'cycle_multi_route';
    setImportModal(subtask);
    setImportPayload(JSON.stringify({
      finder_subtask_id: subtask.id,
      strategy_id: subtask.strategy_id,
      source_agent: isCycleSubtask ? `codex_subagent_${String(subtask.search_cycle || '').toLowerCase()}_cycle` : `codex_subagent_${subtask.discovery_route}`,
      ...(isCycleSubtask ? { route_coverage: [] } : {}),
      accepted_candidates: [],
      rejected_candidates: []
    }, null, 2));
  };

  const importSubtaskResult = async () => {
    if (!importModal) return;
    let payload;
    try {
      payload = JSON.parse(importPayload);
    } catch (error) {
      message.error('JSON 格式错误，请检查后再导入');
      return;
    }
    setTaskLoading(true);
    try {
      await axios.post(`/api/finder-subtasks/${importModal.id}/import`, payload);
      message.success('Subagent 结果已导入 Raw Candidates');
      setImportModal(null);
      setImportPayload('');
      fetchSubtasks(importModal.finder_task_id);
      fetchFinderTasks(selectedStrategy?.id);
      fetchCandidates();
    } catch (error) {
      message.error(error.response?.data?.error || '导入 Subagent 结果失败');
    } finally {
      setTaskLoading(false);
    }
  };

  const openCreate = () => {
    if (!selectedStrategy) {
      message.warning('请先选择一个 Ready Strategy');
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
      message.warning('请先选择一个 Ready Strategy');
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
      message.warning('请先选择一个 Ready Strategy');
      return;
    }
    await axios.post(`/api/raw-candidates/${record.id}/approve`, {
      strategy_id: strategyId,
      campaign_id: record.campaign_id || selectedStrategy?.campaign_id || filters.campaign_id || 1
    });
    message.success('已加入 KOL Master 和项目子表');
    fetchCandidates();
  };

  const batchApprove = async () => {
    if (!selectedStrategy) {
      message.warning('请先选择一个 Ready Strategy');
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
    message.success('已忽略选中候选');
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
    message.success('已忽略');
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
          <span style={{ color: '#666' }}>{r.ai_match_reason || r.matched_keywords || '-'}</span>
        </Space>
      )
    },
    { title: '项目', dataIndex: 'campaign_name', key: 'campaign_name', width: 150, render: (v) => v || '-' },
    {
      title: 'Strategy',
      key: 'strategy',
      width: 190,
      render: (_, r) => (
        <Space direction="vertical" size={2}>
          <span>{r.strategy_name || '未绑定 Strategy'}</span>
          {r.strategy_status ? <Tag color={r.strategy_status === 'ready' ? 'green' : 'default'}>{r.strategy_status}</Tag> : null}
        </Space>
      )
    },
    { title: '搜索轮次', dataIndex: 'search_cycle', key: 'search_cycle', width: 110, render: (v) => v || '-' },
    { title: 'Persona', dataIndex: 'matched_persona', key: 'matched_persona', width: 150, render: (v) => v || '-' },
    { title: 'Discovery Route', dataIndex: 'discovery_route', key: 'discovery_route', width: 170, render: (v) => v ? <Tag color="blue">{v}</Tag> : '-' },
    { title: 'Source Platform', dataIndex: 'source_platform', key: 'source_platform', width: 140, render: (v) => v || '-' },
    { title: 'Target Platform', dataIndex: 'target_platform', key: 'target_platform', width: 140, render: (v, r) => v || r.platform || '-' },
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
    { title: '状态', dataIndex: 'status', key: 'status', width: 110, render: (v) => <Tag color={statusColor[v] || 'default'}>{v || 'new'}</Tag> },
    {
      title: '操作',
      key: 'actions',
      width: 230,
      fixed: 'right',
      render: (_, record) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => setDetail(record)}>详情</Button>
          <Button size="small" type="primary" icon={<CheckOutlined />} disabled={['approved', 'duplicate'].includes(record.status) || (!record.strategy_id && !selectedStrategy)} onClick={() => approveOne(record)}>Approve</Button>
          <Button size="small" icon={<StopOutlined />} disabled={record.status === 'ignored'} onClick={() => ignoreOne(record)}>忽略</Button>
        </Space>
      )
    }
  ];

  const cycleOptions = sortCycles(selectedStrategy?.search_strategy?.length ? selectedStrategy.search_strategy : [
    { cycle: 'C1', name: 'Competitor Reviews' },
    { cycle: 'C2', name: 'Category Search' },
    { cycle: 'C3', name: 'Use-case Search' },
    { cycle: 'C4', name: 'Feature / Technical Search' },
    { cycle: 'C5', name: 'Community / Audience Search' },
    { cycle: 'C6', name: 'Platform Native Search' },
    { cycle: 'C7', name: 'Spider-web Expansion' }
  ]).map((cycle) => ({
    label: `${cycle.cycle} ${cycle.name}`,
    value: cycle.cycle
  }));

  const latestTask = finderTasks[0];
  const taskPercent = latestTask?.total_cycles
    ? Math.round(((latestTask.completed_cycles || 0) / latestTask.total_cycles) * 100)
    : 0;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">KOL Finder</h1>
        <p className="page-subtitle">Raw Candidates 用来承接 Finder 找到的候选，Approve 后进入 KOL Master 和当前项目子表。</p>
      </div>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select allowClear placeholder="选择 Ready Strategy" value={filters.strategy_id} onChange={updateStrategyFilter} options={strategyOptions} style={{ width: 300 }} />
          <Select allowClear placeholder="项目/产品" value={filters.campaign_id} onChange={(v) => updateFilter('campaign_id', v)} options={campaignOptions} style={{ width: 180 }} />
          <Select allowClear placeholder="平台" value={filters.platform} onChange={(v) => updateFilter('platform', v)} options={platformOptions} style={{ width: 140 }} />
          <Select allowClear placeholder="状态" value={filters.status} onChange={(v) => updateFilter('status', v)} options={statusOptions} style={{ width: 140 }} />
          <InputNumber placeholder="最低评分" min={0} max={100} value={filters.min_score} onChange={(v) => updateFilter('min_score', v)} style={{ width: 120 }} />
          <Input.Search allowClear placeholder="搜索 KOL、链接、关键词、国家" value={filters.search} onChange={(e) => updateFilter('search', e.target.value)} onSearch={fetchCandidates} style={{ width: 300 }} />
          <Button icon={<ReloadOutlined />} onClick={fetchCandidates}>刷新</Button>
          <Button type="primary" icon={<SearchOutlined />} disabled={!selectedStrategy} onClick={openTaskModal}>开始 7 轮搜索</Button>
          <Button type="primary" icon={<PlusOutlined />} disabled={!selectedStrategy} onClick={openCreate}>新增候选</Button>
        </Space>
      </Card>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            <strong>最近 Finder Task</strong>
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
              {finderSubtasks.length ? (
                <div style={{ marginTop: 8 }}>
                  <Table
                    size="small"
                    rowKey="id"
                    dataSource={finderSubtasks}
                    pagination={false}
                    columns={[
                      { title: 'Cycle', dataIndex: 'search_cycle', key: 'search_cycle', width: 90, render: (v) => <Tag color="blue">{v}</Tag> },
                      { title: '任务', dataIndex: 'name', key: 'name', width: 220 },
                      {
                        title: 'Route Plan',
                        key: 'route_plan',
                        render: (_, subtask) => {
                          const routes = routePlanRoutes(subtask);
                          if (!routes.length) return <Tag>{subtask.discovery_route}</Tag>;
                          return (
                            <Space wrap size={[4, 4]}>
                              {routes.slice(0, 6).map((item) => (
                                <Tag key={`${subtask.id}-${item.route}`} color={item.required ? 'geekblue' : 'default'}>
                                  {item.required ? '必跑 ' : '可选 '}{item.route}
                                </Tag>
                              ))}
                              {routes.length > 6 ? <Tag>+{routes.length - 6}</Tag> : null}
                            </Space>
                          );
                        }
                      },
                      { title: 'Target', dataIndex: 'target_platform', key: 'target_platform', width: 130 },
                      { title: 'Status', dataIndex: 'status', key: 'status', width: 110, render: (v) => <Tag color={v === 'completed' ? 'green' : v === 'failed' ? 'red' : v === 'running' ? 'blue' : 'default'}>{v}</Tag> },
                      { title: 'Accepted', dataIndex: 'accepted_count', key: 'accepted_count', width: 90, render: (v) => v || 0 },
                      { title: 'Rejected', dataIndex: 'rejected_count', key: 'rejected_count', width: 90, render: (v) => v || 0 },
                      {
                        title: '操作',
                        key: 'actions',
                        width: 180,
                        render: (_, subtask) => (
                          <Space>
                            <Button size="small" onClick={() => openPrompt(subtask)}>Prompt</Button>
                            <Button size="small" type="primary" onClick={() => openImport(subtask)}>导入</Button>
                          </Space>
                        )
                      }
                    ]}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <span style={{ color: '#666' }}>选择 Ready Strategy 后，可以启动自动 7 轮搜索。搜索源负责发现线索，目标 KOL 平台负责最终沉淀。</span>
          )}
        </Space>
      </Card>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Space wrap>
          <span>已选 {selectedRowKeys.length} 个候选</span>
          <Button icon={<CheckOutlined />} disabled={!selectedRowKeys.length || !selectedStrategy} onClick={batchApprove}>批量 Approve</Button>
          <Button icon={<StopOutlined />} disabled={!selectedRowKeys.length} onClick={batchIgnore}>批量忽略</Button>
          <Popconfirm title="确定删除选中的 Raw Candidate？" onConfirm={batchDelete}>
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

      <Modal title="新增 Raw Candidate" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleCreate} width={820}>
        <Form form={form} layout="vertical">
          <Form.Item label="Strategy" name="strategy_id">
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
            <Form.Item label="匹配 Persona" name="matched_persona">
              <Input placeholder="Primary Persona / Secondary..." style={{ width: 260 }} />
            </Form.Item>
          </Space>
          <Form.Item label="AI匹配理由 / 备注" name="ai_match_reason">
            <TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="创建 Finder 任务" open={taskModalOpen} onCancel={() => setTaskModalOpen(false)} onOk={startFinderTask} confirmLoading={taskLoading} okText={executionMode === 'subagent_hybrid' ? '生成 Cycle Subagent 任务' : '启动搜索'} width={760}>
        <Form form={taskForm} layout="vertical">
          <Form.Item label="Strategy">
            <Input value={selectedStrategy?.name || ''} disabled />
          </Form.Item>
          <Form.Item label="执行模式" name="execution_mode" rules={[{ required: true, message: '请选择执行模式' }]}>
            <Select options={[
              { value: 'system_provider', label: 'System Provider' },
              { value: 'subagent_hybrid', label: 'Subagent Hybrid' }
            ]} />
          </Form.Item>
          {executionMode === 'subagent_hybrid' ? (
            <div style={{ marginBottom: 16, color: '#666' }}>
              将按搜索意图生成 Cycle Subagent 任务，预计 {selectedTaskCycles.length || 0} 个。每个任务会包含必跑/可选 route plan，候选导入时仍需记录真实 discovery route。
            </div>
          ) : null}
          <Form.Item label="Discovery Routes" name="discovery_routes" rules={[{ required: true, message: 'Please select at least one Discovery Route' }]}>
            <Checkbox.Group options={discoveryRouteOptions} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 8 }} />
          </Form.Item>
          <Form.Item label="Seed URLs" name="seed_urls" tooltip="Paste Instagram post, reel, or profile URLs. One URL per line.">
            <TextArea rows={3} placeholder={"https://www.instagram.com/reel/...\nhttps://www.instagram.com/example/"} />
          </Form.Item>
          <Form.Item label="搜索轮次" name="cycles" rules={[{ required: true, message: '请选择至少一个搜索轮次' }]}>
            <Checkbox.Group options={cycleOptions} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 8 }} />
          </Form.Item>
          <Form.Item label="Advanced Search Sources" name="search_sources" tooltip="Advanced compatibility for old Finder executors. Instagram V2 does not use native profile search by default.">
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

      <Modal title="Subagent Prompt" open={Boolean(promptModal)} onCancel={() => setPromptModal(null)} footer={[
        <Button key="copy" type="primary" onClick={copyPrompt}>复制 Prompt</Button>,
        <Button key="close" onClick={() => setPromptModal(null)}>关闭</Button>
      ]} width={900}>
        <TextArea value={promptModal?.agent_prompt || ''} rows={22} readOnly />
      </Modal>

      <Modal title="导入 Subagent 结果" open={Boolean(importModal)} onCancel={() => setImportModal(null)} onOk={importSubtaskResult} confirmLoading={taskLoading} width={900}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <span style={{ color: '#666' }}>粘贴 subagent 返回的 JSON。导入后会写入 Raw Candidates，仍需人工 Approve。</span>
          <TextArea value={importPayload} onChange={(e) => setImportPayload(e.target.value)} rows={20} />
        </Space>
      </Modal>

      <Modal title="Raw Candidate 详情" open={Boolean(detail)} onCancel={() => setDetail(null)} footer={null} width={760}>
        {detail ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div><strong>KOL：</strong>{detail.kol_name}</div>
            <div><strong>项目：</strong>{detail.campaign_name || '-'}</div>
            <div><strong>Strategy：</strong>{detail.strategy_name || '未绑定 Strategy'}</div>
            <div><strong>搜索轮次：</strong>{detail.search_cycle || '-'}</div>
            <div><strong>匹配 Persona：</strong>{detail.matched_persona || '-'}</div>
            <div><strong>平台：</strong>{detail.platform || '-'}</div>
            <div><strong>来源视频：</strong>{detail.video_url ? <a href={detail.video_url} target="_blank" rel="noreferrer">{detail.video_title || detail.video_url}</a> : '-'}</div>
            <div><strong>来源：</strong>{detail.source || '-'}</div>
            <div><strong>Discovery Route: </strong>{detail.discovery_route || '-'}</div>
            <div><strong>Source Platform: </strong>{detail.source_platform || '-'}</div>
            <div><strong>Target Platform: </strong>{detail.target_platform || detail.platform || '-'}</div>
            <div>
              <strong>目标平台主页：</strong>
              {getTargetProfileUrl(detail) ? (
                <a href={getTargetProfileUrl(detail)} target="_blank" rel="noreferrer">
                  {detail.target_platform || detail.platform || 'Profile'} 主页
                </a>
              ) : '-'}
            </div>
            <div><strong>Source Agent: </strong>{detail.source_agent || '-'}</div>
            <div><strong>证据：</strong>{detail.evidence_url ? <a href={detail.evidence_url} target="_blank" rel="noreferrer">{detail.evidence_title || detail.evidence_url}</a> : '-'}</div>
            <div><strong>证据类型：</strong>{detail.evidence_type || '-'}</div>
            <div><strong>搜索 Query：</strong>{detail.source_query || '-'}</div>
            <div><strong>Finder Task：</strong>{detail.finder_task_name || detail.finder_task_id || '-'}</div>
            <div><strong>匹配关键词：</strong>{detail.matched_keywords || '-'}</div>
            <div><strong>评分拆解：</strong>{detail.scoring_breakdown || '-'}</div>
            <div><strong>AI匹配理由：</strong>{detail.ai_match_reason || '-'}</div>
            <div><strong>错误原因：</strong>{detail.error_message || '-'}</div>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
};

export default RawCandidates;
