import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Collapse, Form, Input, InputNumber, message, Modal, Popconfirm, Row, Select, Space, Table, Tag, Upload } from 'antd';
import { CopyOutlined, DeleteOutlined, EditOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, RobotOutlined, SaveOutlined, UploadOutlined } from '@ant-design/icons';
import axios from 'axios';

const { TextArea } = Input;
const { Panel } = Collapse;

const platformOptions = [
  { value: 'youtube', label: 'YouTube' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'tiktok', label: 'TikTok' }
];

const goalOptions = [
  { value: 'awareness', label: '品牌曝光' },
  { value: 'review', label: '产品测评' },
  { value: 'affiliate_conversion', label: '联盟转化' },
  { value: 'ugc_ads_asset', label: 'UGC / 广告素材' },
  { value: 'expert_credibility', label: '专家背书' }
];

const statusColor = {
  draft: 'orange',
  ready: 'green',
  archived: 'default'
};

const statusLabel = {
  draft: '草稿',
  ready: '已发布',
  archived: '已归档'
};

const emptyJson = (fallback) => JSON.stringify(fallback, null, 2);

const defaultProductContext = {
  product_line: '',
  key_selling_points: [],
  must_show_functions: [],
  target_users: [],
  buying_triggers: [],
  objections: [],
  price_positioning: '',
  competitors: [],
  alternatives: [],
  scenarios: []
};

const defaultPersona = {
  primary_persona: '',
  secondary_personas: [],
  exclusion_personas: [],
  positive_audience_signals: [],
  negative_signals: [],
  best_content_formats: []
};

const defaultSearch = [
  { cycle: 'C1', name: 'Competitor Reviews', priority: 1, keywords: '', platforms: '', target_count: '', exclusions: '', purpose: '' },
  { cycle: 'C2', name: 'Category Search', priority: 2, keywords: '', platforms: '', target_count: '', exclusions: '', purpose: '' },
  { cycle: 'C3', name: 'Use-case Search', priority: 3, keywords: '', platforms: '', target_count: '', exclusions: '', purpose: '' },
  { cycle: 'C4', name: 'Feature / Technical Search', priority: 4, keywords: '', platforms: '', target_count: '', exclusions: '', purpose: '' },
  { cycle: 'C5', name: 'Community / Audience Search', priority: 5, keywords: '', platforms: '', target_count: '', exclusions: '', purpose: '' },
  { cycle: 'C6', name: 'Platform Native Search', priority: 6, keywords: '', platforms: '', target_count: '', exclusions: '', purpose: '' },
  { cycle: 'C7', name: 'Spider-web Expansion', priority: 7, keywords: '', platforms: '', target_count: '', exclusions: '', purpose: '' }
];

const defaultScoring = {
  content_relevance: 25,
  audience_market_fit: 20,
  content_quality: 15,
  engagement_quality: 15,
  commercial_collaboration_fit: 10,
  conversion_potential: 15,
  risk_deduction_max: 10,
  approval_threshold: 75,
  hero_threshold: 85,
  mid_tier_threshold: 75,
  micro_threshold: 65
};

const defaultHandoff = {
  required_platforms: [],
  required_keywords: [],
  competitor_keywords: [],
  exclusion_keywords: [],
  minimum_followers: '',
  maximum_followers: '',
  minimum_avg_views: '',
  required_evidence: [],
  approve_threshold: 75,
  tier_rules: {
    hero: 'final_score >= 85 and strong strategic fit',
    mid_tier: 'final_score 75-84 or strong niche fit',
    micro: 'final_score 65-74 with clear use-case/community value'
  }
};

function stringifySection(value, fallback) {
  if (Array.isArray(value)) {
    return JSON.stringify(value.length ? value : fallback, null, 2);
  }
  return JSON.stringify(value && Object.keys(value).length ? value : fallback, null, 2);
}

function parseSection(value, label) {
  try {
    return value ? JSON.parse(value) : {};
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON`);
  }
}

const KolStrategy = () => {
  const [strategies, setStrategies] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [materialAnalyzing, setMaterialAnalyzing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [campaignManageVisible, setCampaignManageVisible] = useState(false);
  const [editing, setEditing] = useState(null);
  const [filters, setFilters] = useState({});
  const [newCampaignName, setNewCampaignName] = useState('');
  const [briefText, setBriefText] = useState('');
  const [materialFiles, setMaterialFiles] = useState([]);
  const [form] = Form.useForm();

  const campaignOptions = useMemo(() => campaigns.map((item) => ({
    value: item.id,
    label: item.name,
    campaign: item
  })), [campaigns]);

  useEffect(() => {
    fetchCampaigns();
    fetchStrategies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchCampaigns = async () => {
    const res = await axios.get('/api/campaigns');
    setCampaigns(res.data.data || []);
  };

  const createCampaign = async (name, selectAfterCreate = false) => {
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      message.error('请输入产品/活动名称');
      return;
    }
    try {
      const res = await axios.post('/api/campaigns', { name: cleanName, product: cleanName });
      message.success(res.data.message || '产品/活动已创建');
      setNewCampaignName('');
      await fetchCampaigns();
      if (selectAfterCreate) {
        form.setFieldValue('campaign_id', res.data.data.id);
        updateCampaignFields(res.data.data.id);
      }
    } catch (error) {
      message.error(error.response?.data?.error || '创建产品/活动失败');
    }
  };

  const handleDeleteCampaign = async (campaign, event) => {
    event?.preventDefault();
    event?.stopPropagation();
    try {
      await axios.delete(`/api/campaigns/${campaign.id}`);
      message.success('产品/活动已删除');
      if (filters.campaign_id === campaign.id) {
        setFilters((prev) => ({ ...prev, campaign_id: undefined }));
      }
      if (form.getFieldValue('campaign_id') === campaign.id) {
        form.setFieldValue('campaign_id', 1);
      }
      await fetchCampaigns();
      fetchStrategies();
    } catch (error) {
      message.error(error.response?.data?.error || '删除产品/活动失败');
    }
  };

  const handleRenameCampaign = (campaign, event) => {
    event?.preventDefault();
    event?.stopPropagation();
    let nextName = campaign.name;

    Modal.confirm({
      title: '重命名产品/活动',
      content: (
        <Input
          defaultValue={campaign.name}
          autoFocus
          onChange={(inputEvent) => {
            nextName = inputEvent.target.value;
          }}
          onPressEnter={() => {
            document.querySelector('.ant-modal-confirm-btns .ant-btn-primary')?.click();
          }}
        />
      ),
      okText: '保存',
      cancelText: '取消',
      async onOk() {
        const cleanName = String(nextName || '').trim();
        if (!cleanName) {
          message.error('请输入产品/活动名称');
          return Promise.reject();
        }
        try {
          const res = await axios.put(`/api/campaigns/${campaign.id}`, { name: cleanName, product: cleanName });
          message.success('产品/活动已重命名');
          await fetchCampaigns();
          fetchStrategies();
          if (form.getFieldValue('campaign_id') === campaign.id) {
            form.setFieldValue('campaign_id', res.data.data.id);
            updateCampaignFields(res.data.data.id);
          }
        } catch (error) {
          message.error(error.response?.data?.error || '重命名产品/活动失败');
          return Promise.reject();
        }
      }
    });
  };

  const fetchStrategies = async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/kol-strategies', { params: filters });
      setStrategies(res.data.data || []);
    } catch (error) {
      message.error(error.response?.data?.error || '获取策略失败');
    } finally {
      setLoading(false);
    }
  };

  const applyStrategyToForm = (strategy) => {
    const handoff = strategy.finder_handoff && Object.keys(strategy.finder_handoff).length
      ? strategy.finder_handoff
      : defaultHandoff;
    form.setFieldsValue({
      ...strategy,
      secondary_platforms: strategy.secondary_platforms || [],
      product_context_text: stringifySection(strategy.product_context, defaultProductContext),
      persona_config_text: stringifySection(strategy.persona_config, defaultPersona),
      search_strategy_text: stringifySection(strategy.search_strategy, defaultSearch),
      scoring_weights_text: stringifySection(strategy.scoring_weights, defaultScoring),
      finder_handoff_text: stringifySection(handoff, defaultHandoff),
      minimum_followers: handoff.minimum_followers ? Number(handoff.minimum_followers) : null,
      maximum_followers: handoff.maximum_followers ? Number(handoff.maximum_followers) : null,
      minimum_avg_views: handoff.minimum_avg_views ? Number(handoff.minimum_avg_views) : null
    });
    setBriefText('');
    setMaterialFiles([]);
  };

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    const campaign = campaigns[0] || {};
    form.setFieldsValue({
      campaign_id: campaign.id || 1,
      name: `${campaign.name || '项目'} KOL 策略`,
      brand: campaign.brand || '',
      product: campaign.product || campaign.name || '',
      status: 'draft',
      secondary_platforms: [],
      product_context_text: emptyJson(defaultProductContext),
      persona_config_text: emptyJson(defaultPersona),
      search_strategy_text: emptyJson(defaultSearch),
      scoring_weights_text: emptyJson(defaultScoring),
      finder_handoff_text: emptyJson(defaultHandoff),
      minimum_followers: null,
      maximum_followers: null,
      minimum_avg_views: null
    });
    setBriefText('');
    setMaterialFiles([]);
    setModalOpen(true);
  };

  const openEdit = (record) => {
    setEditing(record);
    applyStrategyToForm(record);
    setModalOpen(true);
  };

  const buildPayload = async () => {
    const values = await form.validateFields();
    const finderHandoff = parseSection(values.finder_handoff_text, '寻找任务交接');
    finderHandoff.minimum_followers = values.minimum_followers ? String(values.minimum_followers) : '';
    finderHandoff.maximum_followers = values.maximum_followers ? String(values.maximum_followers) : '';
    finderHandoff.minimum_avg_views = values.minimum_avg_views ? String(values.minimum_avg_views) : '';
    return {
      ...values,
      product_context: parseSection(values.product_context_text, 'Product Breakdown'),
      persona_config: parseSection(values.persona_config_text, 'KOL画像'),
      search_strategy: parseSection(values.search_strategy_text, '7轮搜索策略'),
      scoring_weights: parseSection(values.scoring_weights_text, 'Scoring Weights'),
      finder_handoff: finderHandoff
    };
  };

  const saveStrategy = async () => {
    setSaving(true);
    try {
      const payload = await buildPayload();
      const res = editing
        ? await axios.put(`/api/kol-strategies/${editing.id}`, payload)
        : await axios.post('/api/kol-strategies', payload);
      message.success('策略已保存');
      setEditing(res.data.data);
      applyStrategyToForm(res.data.data);
      fetchStrategies();
      return res.data.data;
    } catch (error) {
      message.error(error.response?.data?.error || error.message || '保存失败');
      throw error;
    } finally {
      setSaving(false);
    }
  };

  const handleAnalyzeMaterials = async () => {
    if (!briefText.trim() && !materialFiles.length) {
      message.warning('请先粘贴 Brief 或上传 PDF / DOCX / TXT');
      return;
    }
    setMaterialAnalyzing(true);
    try {
      const saved = await saveStrategy();
      const formData = new FormData();
      formData.append('brief_text', briefText);
      materialFiles.forEach((file) => {
        formData.append('files', file.originFileObj || file);
      });
      const res = await axios.post(`/api/kol-strategies/${saved.id}/analyze-materials`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      const next = res.data.data;
      setEditing(next);
      applyStrategyToForm(next);
      fetchStrategies();
      if (res.data.meta?.truncated) {
        message.warning(`材料较长，已截断到 ${res.data.meta.used_chars} 字符后生成草稿`);
      } else {
        message.success('AI 已分析材料并生成策略草稿');
      }
    } catch (error) {
      message.error(error.response?.data?.error || error.message || 'AI 分析材料失败');
    } finally {
      setMaterialAnalyzing(false);
    }
  };

  const generateDraft = async () => {
    if (!editing?.id) {
      message.warning('请先保存策略草稿，再生成 AI 草稿');
      return;
    }
    setGenerating(true);
    try {
      const saved = await saveStrategy();
      const res = await axios.post(`/api/kol-strategies/${saved.id}/generate-draft`);
      message.success('AI 草稿已生成，请人工检查后发布给 KOL 寻找');
      setEditing(res.data.data);
      applyStrategyToForm(res.data.data);
      fetchStrategies();
    } catch (error) {
      message.error(error.response?.data?.error || 'AI 生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const markReady = async (record = editing) => {
    if (!record?.id) return;
    try {
      const res = await axios.post(`/api/kol-strategies/${record.id}/mark-ready`);
      message.success('策略已发布给 KOL 寻找');
      if (editing?.id === record.id) {
        setEditing(res.data.data);
        applyStrategyToForm(res.data.data);
      }
      fetchStrategies();
    } catch (error) {
      message.error(error.response?.data?.error || '发布给 KOL 寻找失败');
    }
  };

  const duplicateStrategy = async (record) => {
    const res = await axios.post(`/api/kol-strategies/${record.id}/duplicate`);
    message.success('已复制为新草稿');
    fetchStrategies();
    openEdit(res.data.data);
  };

  const archiveStrategy = async (record) => {
    await axios.post(`/api/kol-strategies/${record.id}/archive`);
    message.success('已归档');
    fetchStrategies();
  };

  const updateCampaignFields = (campaignId) => {
    const campaign = campaignOptions.find((item) => item.value === campaignId)?.campaign;
    if (!campaign) return;
    form.setFieldsValue({
      brand: campaign.brand || '',
      product: campaign.product || campaign.name || ''
    });
  };

  const columns = [
    { title: '策略', dataIndex: 'name', key: 'name', width: 220, fixed: 'left' },
    { title: '项目/产品', dataIndex: 'campaign_name', key: 'campaign_name', width: 150, render: (v) => v || '-' },
    { title: '品牌', dataIndex: 'brand', key: 'brand', width: 120, render: (v) => v || '-' },
    { title: '品类', dataIndex: 'category', key: 'category', width: 140, render: (v) => v || '-' },
    { title: '市场/语言', key: 'market', width: 160, render: (_, r) => [r.target_market, r.language].filter(Boolean).join(' / ') || '-' },
    { title: '主平台', dataIndex: 'primary_platform', key: 'primary_platform', width: 110, render: (v) => v ? <Tag>{v}</Tag> : '-' },
    { title: '目标', dataIndex: 'campaign_goal', key: 'campaign_goal', width: 160, render: (v) => v || '-' },
    { title: '状态', dataIndex: 'status', key: 'status', width: 100, render: (v) => <Tag color={statusColor[v] || 'default'}>{statusLabel[v] || statusLabel.draft}</Tag> },
    {
      title: '操作',
      key: 'actions',
      width: 260,
      fixed: 'right',
      render: (_, record) => (
        <Space>
          <Button type="link" onClick={() => openEdit(record)}>编辑</Button>
          <Button type="link" icon={<PlayCircleOutlined />} disabled={record.status === 'ready'} onClick={() => markReady(record)}>发布给 KOL 寻找</Button>
          <Button type="link" icon={<CopyOutlined />} onClick={() => duplicateStrategy(record)}>复制</Button>
          <Popconfirm title="归档后 KOL 寻找不会再使用该策略，确定归档？" onConfirm={() => archiveStrategy(record)}>
            <Button type="link" danger>归档</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  const campaignManageColumns = [
    { title: '产品/活动', dataIndex: 'name', key: 'name' },
    { title: '品牌', dataIndex: 'brand', key: 'brand', render: (v) => v || '-' },
    { title: '产品', dataIndex: 'product', key: 'product', render: (v) => v || '-' },
    {
      title: '操作',
      key: 'action',
      width: 180,
      render: (_, campaign) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={(event) => handleRenameCampaign(campaign, event)}>重命名</Button>
          <Popconfirm
            title="删除这个产品/活动？"
            description={campaign.id === 1 ? 'Default Campaign 不能删除。' : '仅未被视频、策略、候选池或项目 KOL 使用的产品/活动可以删除。'}
            disabled={campaign.id === 1}
            onConfirm={(event) => handleDeleteCampaign(campaign, event)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} disabled={campaign.id === 1}>删除</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">KOL 策略</h1>
        <p className="page-subtitle">先拆解产品、目标用户和 KOL画像，再发布给 KOL 寻找使用。</p>
      </div>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select allowClear placeholder="项目/产品" value={filters.campaign_id} onChange={(v) => setFilters((prev) => ({ ...prev, campaign_id: v || undefined }))} options={campaignOptions} style={{ width: 180 }} />
          <Select allowClear placeholder="状态" value={filters.status} onChange={(v) => setFilters((prev) => ({ ...prev, status: v || undefined }))} options={[
            { value: 'draft', label: '草稿' },
            { value: 'ready', label: '已发布' },
            { value: 'archived', label: '已归档' }
          ]} style={{ width: 140 }} />
          <Input.Search allowClear placeholder="搜索策略、品牌、产品、品类" value={filters.search} onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value || undefined }))} onSearch={fetchStrategies} style={{ width: 300 }} />
          <Button icon={<ReloadOutlined />} onClick={fetchStrategies}>刷新</Button>
          <Button icon={<EditOutlined />} onClick={() => setCampaignManageVisible(true)}>管理产品/活动</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增策略</Button>
        </Space>
      </Card>

      <Card className="content-card">
        <Table columns={columns} dataSource={strategies} rowKey="id" loading={loading} scroll={{ x: 1500 }} pagination={{ pageSize: 10 }} />
      </Card>

      <Modal
        title={editing ? 'KOL 策略 Agent 工作台' : '新增 KOL 策略'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        width={1180}
        footer={[
          <Button key="cancel" onClick={() => setModalOpen(false)}>关闭</Button>,
          <Button key="ai" icon={<RobotOutlined />} loading={generating} disabled={!editing?.id} onClick={generateDraft}>无材料生成草稿</Button>,
          <Button key="ready" icon={<PlayCircleOutlined />} disabled={!editing?.id || editing?.status === 'ready'} onClick={() => markReady()}>发布给 KOL 寻找</Button>,
          <Button key="save" type="primary" icon={<SaveOutlined />} loading={saving} onClick={saveStrategy}>保存草稿</Button>
        ]}
      >
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message="策略发布给 KOL 寻找后，可启动 System Provider 搜索，或生成 Subagent Hybrid 任务与 Prompt。" />
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label="策略名称" name="name" rules={[{ required: true, message: '请输入策略名称' }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="项目/产品" name="campaign_id" rules={[{ required: true, message: '请选择项目/产品' }]}>
                <Select
                  showSearch
                  options={campaignOptions}
                  optionFilterProp="label"
                  onChange={updateCampaignFields}
                  dropdownRender={(menu) => (
                    <>
                      {menu}
                      <div style={{ padding: 8, borderTop: '1px solid #f0f0f0' }}>
                        <Input.Search
                          placeholder="输入新产品/活动名称后回车"
                          enterButton="新建"
                          value={newCampaignName}
                          onChange={(event) => setNewCampaignName(event.target.value)}
                          onSearch={(value) => createCampaign(value, true)}
                        />
                        <Button block icon={<EditOutlined />} style={{ marginTop: 8 }} onClick={() => setCampaignManageVisible(true)}>
                          管理产品/活动
                        </Button>
                      </div>
                    </>
                  )}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="合作目标" name="campaign_goal">
                <Select options={goalOptions} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={6}><Form.Item label="品牌" name="brand"><Input /></Form.Item></Col>
            <Col span={6}><Form.Item label="产品" name="product"><Input /></Form.Item></Col>
            <Col span={6}><Form.Item label="品类" name="category"><Input /></Form.Item></Col>
            <Col span={6}><Form.Item label="目标市场" name="target_market"><Input placeholder="US / EU / Global" /></Form.Item></Col>
          </Row>
          <Row gutter={16}>
            <Col span={6}><Form.Item label="语言" name="language"><Input placeholder="English / Spanish..." /></Form.Item></Col>
            <Col span={6}><Form.Item label="主平台" name="primary_platform"><Select allowClear options={platformOptions} /></Form.Item></Col>
            <Col span={12}><Form.Item label="次平台" name="secondary_platforms"><Select mode="multiple" allowClear options={platformOptions} /></Form.Item></Col>
          </Row>

          <Card size="small" title="寻找准入规则" style={{ marginBottom: 16 }}>
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item label="最低粉丝数" name="minimum_followers">
                  <InputNumber min={0} precision={0} placeholder="e.g. 1000" style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="最高粉丝数" name="maximum_followers">
                  <InputNumber min={0} precision={0} placeholder="optional, e.g. 200000" style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="最低平均播放" name="minimum_avg_views">
                  <InputNumber min={0} precision={0} placeholder="optional, e.g. 3000" style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
            <Alert
              type="info"
              showIcon
              message="KOL 寻找会过滤明显不符合规则的候选；粉丝数或播放量未知时，候选会留在候选池等待人工判断。"
            />
          </Card>

          <Row gutter={16}>
            <Col span={14}>
              <Card size="small" title="材料区">
                <TextArea
                  rows={10}
                  value={briefText}
                  onChange={(event) => setBriefText(event.target.value)}
                  placeholder="粘贴产品 Brief、卖点、目标市场、竞品、价格定位、用户画像、合作目标等材料..."
                />
                <Upload
                  accept=".txt,.pdf,.docx"
                  multiple
                  maxCount={5}
                  fileList={materialFiles}
                  beforeUpload={(file) => {
                    if (materialFiles.length >= 5) {
                      message.warning('单次最多上传 5 个文件');
                      return Upload.LIST_IGNORE;
                    }
                    setMaterialFiles((prev) => [...prev, file]);
                    return false;
                  }}
                  onRemove={(file) => {
                    setMaterialFiles((prev) => prev.filter((item) => item.uid !== file.uid));
                  }}
                  style={{ marginTop: 12 }}
                >
                  <Button icon={<UploadOutlined />} style={{ marginTop: 12 }}>上传 PDF / DOCX / TXT</Button>
                </Upload>
                <Space style={{ marginTop: 12 }}>
                  <Button type="primary" icon={<RobotOutlined />} loading={materialAnalyzing} onClick={handleAnalyzeMaterials}>
                    AI 分析材料并生成策略
                  </Button>
                  <Button disabled>AI 自动调研资料（预留）</Button>
                </Space>
              </Card>
            </Col>
            <Col span={10}>
              <Card size="small" title="AI 材料摘要 / 发布状态">
                <Space direction="vertical" style={{ width: '100%' }}>
                  <div>
                    <strong>状态：</strong>
                    <Tag color={statusColor[editing?.status] || 'default'}>{editing?.status || 'draft'}</Tag>
                  </div>
                  <div>
                    <strong>材料来源：</strong>{editing?.source_material_type || '未分析材料'}
                  </div>
                  <div>
                    <strong>Research Agent：</strong>{editing?.research_status || 'not_started'}（预留）
                  </div>
                  {editing?.source_material_meta?.truncated ? (
                    <Alert type="warning" showIcon message={`材料已截断：原 ${editing.source_material_meta.original_chars} 字符，使用 ${editing.source_material_meta.used_chars} 字符。`} />
                  ) : null}
                  <TextArea
                    rows={9}
                    value={editing?.source_material_summary || ''}
                    readOnly
                    placeholder="AI 分析材料后，这里会显示产品理解摘要。"
                  />
                </Space>
              </Card>
            </Col>
          </Row>

          <Collapse defaultActiveKey={['editor']} style={{ marginTop: 16 }}>
            <Panel header="结构化策略编辑器" key="editor">
              <Card size="small" title="产品拆解" style={{ marginBottom: 12 }}>
                <Form.Item name="product_context_text">
                  <TextArea rows={8} />
                </Form.Item>
              </Card>
              <Card size="small" title="KOL画像" style={{ marginBottom: 12 }}>
                <Form.Item name="persona_config_text">
                  <TextArea rows={8} />
                </Form.Item>
              </Card>
              <Card size="small" title="7轮搜索策略" style={{ marginBottom: 12 }}>
                <Form.Item name="search_strategy_text">
                  <TextArea rows={10} />
                </Form.Item>
              </Card>
              <Card size="small" title="评分权重" style={{ marginBottom: 12 }}>
                <Form.Item name="scoring_weights_text">
                  <TextArea rows={8} />
                </Form.Item>
              </Card>
              <Card size="small" title="寻找任务交接">
                <Form.Item name="finder_handoff_text">
                  <TextArea rows={8} />
                </Form.Item>
              </Card>
            </Panel>
          </Collapse>
        </Form>
      </Modal>

      <Modal
        title="管理产品/活动"
        open={campaignManageVisible}
        onCancel={() => setCampaignManageVisible(false)}
        footer={null}
        width={760}
      >
        <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
          <Input
            placeholder="输入新产品/活动名称"
            value={newCampaignName}
            onChange={(event) => setNewCampaignName(event.target.value)}
            onPressEnter={() => createCampaign(newCampaignName)}
          />
          <Button type="primary" onClick={() => createCampaign(newCampaignName)}>新建</Button>
        </Space.Compact>
        <Table
          columns={campaignManageColumns}
          dataSource={campaigns}
          rowKey="id"
          pagination={false}
          size="small"
        />
      </Modal>
    </div>
  );
};

export default KolStrategy;
