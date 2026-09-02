import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Col,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag
} from 'antd';
import {
  BarChartOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined
} from '@ant-design/icons';
import axios from 'axios';

const { TextArea } = Input;

const platformOptions = [
  { value: 'youtube', label: 'YouTube' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'tiktok', label: 'TikTok' }
];

const crawlStatusOptions = [
  { value: 'pending', label: '未抓取' },
  { value: 'crawling', label: '抓取中' },
  { value: 'success', label: '已抓取' },
  { value: 'failed', label: '抓取失败' }
];

const analysisStatusOptions = [
  { value: 'not_analyzed', label: '未分析' },
  { value: 'analyzing', label: '分析中' },
  { value: 'success', label: '分析成功' },
  { value: 'analysis_failed', label: '分析失败' }
];

const statusColor = (status, type) => {
  if (status === 'success') return 'green';
  if (status === 'failed' || status === 'analysis_failed') return 'red';
  if (status === 'crawling' || status === 'analyzing') return 'blue';
  if (type === 'analysis' && status === 'not_analyzed') return 'default';
  return 'orange';
};

const statusText = (status, type) => {
  const map = {
    pending: '未抓取',
    crawling: '抓取中',
    failed: '失败',
    success: type === 'analysis' ? '分析成功' : '已抓取',
    not_analyzed: '未分析',
    analyzing: '分析中',
    analysis_failed: '分析失败'
  };
  return map[status] || status || '-';
};

const sceneColor = (scene) => {
  if (scene === 'finder_evidence') return 'purple';
  if (scene === 'collaboration_review') return 'green';
  return 'default';
};

const VideoAnalysis = () => {
  const [videos, setVideos] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [collaborationKols, setCollaborationKols] = useState([]);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [filters, setFilters] = useState({});
  const [loading, setLoading] = useState(false);
  const [crawlLoading, setCrawlLoading] = useState(false);
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [activeJob, setActiveJob] = useState(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingVideo, setEditingVideo] = useState(null);
  const [detailVideo, setDetailVideo] = useState(null);
  const [form] = Form.useForm();
  const selectedCampaignId = Form.useWatch('campaign_id', form);

  useEffect(() => {
    fetchCampaigns();
    fetchVideos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats = useMemo(() => {
    const crawled = videos.filter((item) => item.crawl_status === 'success').length;
    const aiSuccess = videos.filter((item) => item.analysis_status === 'success').length;
    const failed = videos.filter((item) => ['failed'].includes(item.crawl_status) || ['analysis_failed'].includes(item.analysis_status)).length;
    return { total: videos.length, crawled, aiSuccess, failed };
  }, [videos]);

  const campaignOptions = campaigns.map((item) => ({
    value: item.id,
    label: item.name,
    campaign: item
  }));

  const fetchCampaigns = async () => {
    try {
      const res = await axios.get('/api/campaigns');
      setCampaigns(res.data.data || []);
    } catch (error) {
      message.error('获取产品/活动列表失败');
    }
  };

  const fetchVideos = async (nextFilters = filters) => {
    setLoading(true);
    try {
      const params = { collaboration_only: 1 };
      Object.entries(nextFilters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') params[key] = value;
      });
      const res = await axios.get('/api/videos', { params });
      setVideos(res.data.data || []);
    } catch (error) {
      message.error('获取视频列表失败');
    } finally {
      setLoading(false);
    }
  };

  const updateFilter = (key, value) => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    fetchVideos(next);
  };

  const clearFilters = () => {
    setFilters({});
    fetchVideos({});
  };

  const openCreateModal = () => {
    setEditingVideo(null);
    setCollaborationKols([]);
    form.resetFields();
    setModalVisible(true);
  };

  const fetchCollaborationKols = async (campaignId) => {
    if (!campaignId) {
      setCollaborationKols([]);
      return;
    }
    try {
      const res = await axios.get('/api/campaign-kols', {
        params: { campaign_id: campaignId, pipeline_stage: 'confirmed', page_size: 100 }
      });
      setCollaborationKols(res.data.data || []);
    } catch (error) {
      setCollaborationKols([]);
      message.error('获取合作达人列表失败');
    }
  };

  const openEditModal = (record) => {
    setEditingVideo(record);
    form.resetFields();
    form.setFieldsValue({
      source_url: record.source_url,
      campaign_id: record.campaign_id,
      kol_name: record.kol_name,
      cooperation_price: record.cooperation_price,
      notes: record.notes
    });
    setModalVisible(true);
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    if (editingVideo) {
      await axios.put(`/api/videos/${editingVideo.id}`, values);
      message.success('视频信息已更新');
    } else {
      await axios.post('/api/videos', values);
      message.success('视频链接已新增');
    }
    setModalVisible(false);
    fetchVideos();
  };

  const setBatchLoading = (type, value) => {
    if (type === 'crawl') setCrawlLoading(value);
    else setAnalyzeLoading(value);
  };

  const pollJob = (jobId, type) => {
    const timer = setInterval(async () => {
      try {
        const res = await axios.get(`/api/videos/jobs/${jobId}`);
        const job = res.data.data.job;
        const items = res.data.data.items || [];
        const success = items.filter((item) => item.status === 'success').length;
        const failed = items.filter((item) => item.status === 'failed').length;
        const processed = success + failed;
        const total = Number(job?.total_count || items.length || 0);
        setActiveJob({
          id: jobId,
          type,
          status: job?.status,
          total,
          processed,
          success,
          failed
        });
        if (['success', 'partial_failed', 'failed'].includes(job?.status)) {
          clearInterval(timer);
          setBatchLoading(type, false);
          await fetchVideos();
          if (job.status === 'success') {
            message.success('任务完成');
          } else {
            message.warning(`任务结束：成功 ${job.success_count} 条，失败 ${job.failed_count} 条`);
          }
        }
      } catch (error) {
        clearInterval(timer);
        setBatchLoading(type, false);
        setActiveJob((current) => current ? { ...current, status: 'query_failed' } : null);
        message.error('查询任务状态失败');
      }
    }, 2000);
  };

  const runBatch = async (type, ids = selectedRowKeys) => {
    setBatchLoading(type, true);
    try {
      const endpoint = type === 'crawl' ? '/api/videos/crawl' : '/api/videos/analyze';
      const res = await axios.post(endpoint, { videoIds: ids });
      const jobId = res.data.data.job_id;
      setActiveJob({
        id: jobId,
        type,
        status: 'pending',
        total: Number(res.data.data.total || ids.length),
        processed: 0,
        success: 0,
        failed: 0
      });
      message.success(type === 'crawl' ? `已创建抓取任务 #${jobId}` : `已创建 AI 分析任务 #${jobId}`);
      pollJob(jobId, type);
    } catch (error) {
      setBatchLoading(type, false);
      setActiveJob(null);
      message.error(error.response?.data?.error || '创建任务失败');
    }
  };

  const handleDelete = async (ids) => {
    await axios.delete('/api/videos/batch', { data: { videoIds: ids } });
    message.success(`已删除 ${ids.length} 条视频`);
    setSelectedRowKeys([]);
    fetchVideos();
  };

  const handleExport = () => {
    const params = new URLSearchParams();
    if (selectedRowKeys.length) {
      params.set('ids', selectedRowKeys.join(','));
    } else {
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') params.set(key, value);
      });
      params.set('collaboration_only', '1');
    }
    const query = params.toString();
    window.location.href = query ? `/api/videos/export?${query}` : '/api/videos/export';
  };

  const columns = [
    {
      title: '平台',
      dataIndex: 'platform',
      key: 'platform',
      width: 120,
      render: (value) => value ? <Tag color={value === 'youtube' ? 'green' : value === 'instagram' ? 'blue' : 'magenta'}>{value}</Tag> : '-'
    },
    {
      title: 'KOL / 视频',
      key: 'video',
      width: 420,
      render: (_, record) => (
        <Space direction="vertical" size={2} align="start" style={{ minWidth: 0 }}>
          <strong style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{record.title || '待抓取标题'}</strong>
          <span style={{ color: '#344054' }}>{record.linked_kol_name || record.kol_name || record.author_name || '未填写 KOL'}</span>
          <span style={{ color: '#667085' }}>{record.campaign_name || '未关联项目'}</span>
        </Space>
      )
    },
    {
      title: '状态',
      key: 'status',
      width: 150,
      render: (_, record) => <Space direction="vertical" size={2}>
        <Tag color={statusColor(record.crawl_status, 'crawl')}>{statusText(record.crawl_status, 'crawl')}</Tag>
        <Tag color={statusColor(record.analysis_status, 'analysis')}>{statusText(record.analysis_status, 'analysis')}</Tag>
      </Space>
    },
    { title: '最近抓取', dataIndex: 'last_crawled_at', key: 'last_crawled_at', width: 160, render: (value) => value ? new Date(value).toLocaleString() : '-' },
    {
      title: '数据表现',
      key: 'performance',
      width: 180,
      render: (_, record) => <Space direction="vertical" size={0}>
        <span>曝光：{record.primary_exposure_count ?? '-'}</span>
        <span>播放：{record.play_count ?? '-'}</span>
        <span>点赞：{record.like_count ?? '-'}</span>
        <span>评论：{record.comment_count ?? '-'}</span>
      </Space>
    },
    {
      title: 'AI 报告',
      key: 'ai',
      width: 220,
      ellipsis: true,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Tag color={sceneColor(record.ai_scene)}>{record.ai_scene_label || '未分析'}</Tag>
          <span>{record.ai_score !== null && record.ai_score !== undefined ? `评分 ${record.ai_score}` : '未分析'}</span>
          <span style={{ color: '#667085' }}>{record.ai_summary || '未分析'}</span>
        </Space>
      )
    },
    {
      title: '操作',
      key: 'action',
      width: 280,
      fixed: 'right',
      render: (_, record) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => setDetailVideo(record)}>详情</Button>
          <Button size="small" icon={<SyncOutlined />} onClick={() => runBatch('crawl', [record.id])}>抓取</Button>
          <Button size="small" icon={<BarChartOutlined />} onClick={() => runBatch('analyze', [record.id])}>分析</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEditModal(record)}>编辑</Button>
          <Popconfirm title="确定删除这条视频？" onConfirm={() => handleDelete([record.id])}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">内容分析</h1>
        <p className="page-subtitle">仅分析已合作达人发布的视频，复盘真实合作效果并沉淀内容经验。</p>
      </div>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><Card><Statistic title="视频总数" value={stats.total} /></Card></Col>
        <Col span={6}><Card><Statistic title="已抓取" value={stats.crawled} /></Card></Col>
        <Col span={6}><Card><Statistic title="AI 成功" value={stats.aiSuccess} /></Card></Col>
        <Col span={6}><Card><Statistic title="失败/待补" value={stats.failed} /></Card></Col>
      </Row>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>新建链接</Button>
          <Button icon={<SyncOutlined />} loading={crawlLoading} disabled={!selectedRowKeys.length || crawlLoading} onClick={() => runBatch('crawl')}>批量抓取 ({selectedRowKeys.length})</Button>
          <Button icon={<BarChartOutlined />} loading={analyzeLoading} disabled={!selectedRowKeys.length || analyzeLoading} onClick={() => runBatch('analyze')}>批量分析 ({selectedRowKeys.length})</Button>
          <Popconfirm title="确定删除选中的视频？" disabled={!selectedRowKeys.length} onConfirm={() => handleDelete(selectedRowKeys)}>
            <Button danger icon={<DeleteOutlined />} disabled={!selectedRowKeys.length}>批量删除 ({selectedRowKeys.length})</Button>
          </Popconfirm>
          <Button icon={<DownloadOutlined />} disabled={!videos.length} onClick={handleExport}>
            导出 XLSX{selectedRowKeys.length ? ` (${selectedRowKeys.length})` : ''}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => fetchVideos()}>刷新</Button>
        </Space>
      </Card>

      {activeJob && (
        <Card className="content-card" style={{ marginBottom: 16 }}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <strong>
              {activeJob.type === 'crawl' ? '批量抓取' : '批量分析'}任务 #{activeJob.id}
              {['success', 'partial_failed', 'failed'].includes(activeJob.status) ? ' 已结束' : ' 处理中'}
            </strong>
            <Progress
              percent={activeJob.total ? Math.round((activeJob.processed / activeJob.total) * 100) : 0}
              status={activeJob.status === 'failed' || activeJob.status === 'query_failed' ? 'exception' : activeJob.status === 'success' ? 'success' : 'active'}
            />
            <span style={{ color: activeJob.failed ? '#cf1322' : '#039855', fontSize: 16 }}>
              已处理 {activeJob.processed} / {activeJob.total}
              （成功 {activeJob.success} / 失败 {activeJob.failed} / 总数 {activeJob.total}）
            </span>
          </Space>
        </Card>
      )}

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Row gutter={12}>
          <Col span={5}>
            <Select
              allowClear
              placeholder="产品/活动"
              value={filters.campaign_id}
              onChange={(value) => updateFilter('campaign_id', value)}
              options={campaignOptions}
              style={{ width: '100%' }}
            />
          </Col>
          <Col span={4}>
            <Select allowClear placeholder="平台" value={filters.platform} onChange={(value) => updateFilter('platform', value)} options={platformOptions} style={{ width: '100%' }} />
          </Col>
          <Col span={4}>
            <Select allowClear placeholder="抓取状态" value={filters.crawl_status} onChange={(value) => updateFilter('crawl_status', value)} options={crawlStatusOptions} style={{ width: '100%' }} />
          </Col>
          <Col span={4}>
            <Select allowClear placeholder="AI 状态" value={filters.analysis_status} onChange={(value) => updateFilter('analysis_status', value)} options={analysisStatusOptions} style={{ width: '100%' }} />
          </Col>
          <Col span={5}>
            <Input.Search allowClear prefix={<SearchOutlined />} placeholder="搜索标题、KOL、作者、链接" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} onSearch={(value) => updateFilter('search', value)} />
          </Col>
          <Col span={2}>
            <Button block onClick={clearFilters}>清空</Button>
          </Col>
        </Row>
      </Card>

      <Card className="content-card">
        <Table
          columns={columns}
          dataSource={videos}
          rowKey="id"
          loading={loading}
          rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }}
          scroll={{ x: 1600 }}
          pagination={{ defaultPageSize: 10, showSizeChanger: true }}
        />
      </Card>

      <Modal
        title={editingVideo ? '编辑链接' : '新建链接'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={handleSubmit}
        width={720}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="视频链接" name="source_url" rules={[{ required: true, message: '请输入视频链接' }]}>
            <Input disabled={Boolean(editingVideo)} placeholder="https://www.youtube.com/watch?v=..." />
          </Form.Item>
          <Form.Item label="所属项目" name="campaign_id" rules={[{ required: true, message: '请选择所属项目' }]}>
            <Select
              showSearch
              options={campaignOptions}
              optionFilterProp="label"
              onChange={(value) => {
                form.setFieldValue('campaign_kol_id', undefined);
                fetchCollaborationKols(value);
              }}
            />
          </Form.Item>
          {!editingVideo && (
            <Form.Item label="合作达人" name="campaign_kol_id" rules={[{ required: true, message: '请选择合作达人' }]}>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="请先选择项目"
                disabled={!selectedCampaignId}
                options={collaborationKols.map((item) => ({
                  value: item.id,
                  label: item.kol_name || item.kol_name_snapshot || `合作达人 #${item.id}`
                }))}
                notFoundContent="该项目暂无已确认合作达人"
              />
            </Form.Item>
          )}
          <Form.Item label="备注" name="notes">
            <TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="视频详情"
        open={Boolean(detailVideo)}
        onCancel={() => setDetailVideo(null)}
        footer={null}
        width={760}
      >
        {detailVideo ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div><strong>产品/活动：</strong>{detailVideo.campaign_name || '-'}</div>
            <div><strong>平台：</strong>{detailVideo.platform || '-'}</div>
            <div><strong>KOL：</strong>{detailVideo.linked_kol_name || detailVideo.kol_name || detailVideo.author_name || '-'}</div>
            <div><strong>标题：</strong>{detailVideo.title || '-'}</div>
            <div><strong>发布时间：</strong>{detailVideo.published_at ? new Date(detailVideo.published_at).toLocaleString() : '-'}</div>
            <div><strong>链接：</strong><a href={detailVideo.source_url} target="_blank" rel="noreferrer">{detailVideo.source_url}</a></div>
            <div><strong>内容类型：</strong>{detailVideo.content_type || '-'}</div>
            <div><strong>主要曝光数：</strong>{detailVideo.primary_exposure_count ?? '-'}</div>
            <div><strong>点赞数：</strong>{detailVideo.like_count ?? '-'}</div>
            <div><strong>评论数：</strong>{detailVideo.comment_count ?? '-'}</div>
            <div><strong>曝光口径：</strong>{detailVideo.exposure_metric_type || '-'}</div>
            <div><strong>数据完整性：</strong>{detailVideo.data_quality_note || '-'}</div>
            <div><strong>合作方式：</strong>{detailVideo.cooperation_type === 'product_exchange' ? '产品置换' : detailVideo.cooperation_type === 'paid_product' ? '付费＋产品' : detailVideo.cooperation_type === 'other' ? '其他' : '-'}</div>
            <div><strong>合作费用：</strong>{detailVideo.cooperation_type === 'product_exchange' ? '现金 0' : detailVideo.collaboration_fee ? `${detailVideo.collaboration_fee} ${detailVideo.collaboration_currency || ''}` : detailVideo.cooperation_price || '-'}</div>
            <div><strong>跟进人：</strong>{detailVideo.collaboration_owner || '-'}</div>
            <div><strong>项目备注：</strong>{detailVideo.collaboration_notes || detailVideo.notes || '-'}</div>
            <div><strong>分析场景：</strong>{detailVideo.ai_scene_label || '未分析'}</div>
            <div><strong>错误：</strong>{detailVideo.error_message || '-'}</div>
            <div><strong>AI 摘要：</strong>{detailVideo.ai_summary || '-'}</div>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
};

export default VideoAnalysis;
