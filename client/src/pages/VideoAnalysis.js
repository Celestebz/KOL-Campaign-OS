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
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Upload
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
  SyncOutlined,
  UploadOutlined
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

const VideoAnalysis = () => {
  const [videos, setVideos] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [filters, setFilters] = useState({});
  const [loading, setLoading] = useState(false);
  const [jobLoading, setJobLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [campaignManageVisible, setCampaignManageVisible] = useState(false);
  const [editingVideo, setEditingVideo] = useState(null);
  const [detailVideo, setDetailVideo] = useState(null);
  const [form] = Form.useForm();

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

  const handleDeleteCampaign = async (campaign, event) => {
    event?.preventDefault();
    event?.stopPropagation();
    try {
      await axios.delete(`/api/campaigns/${campaign.id}`);
      message.success('产品/活动已删除');
      if (filters.campaign_id === campaign.id) {
        const nextFilters = { ...filters, campaign_id: undefined };
        setFilters(nextFilters);
        fetchVideos(nextFilters);
      }
      if (form.getFieldValue('campaign_id') === campaign.id) {
        form.setFieldValue('campaign_id', 1);
      }
      fetchCampaigns();
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
          fetchCampaigns();
          fetchVideos();
          if (form.getFieldValue('campaign_id') === campaign.id) {
            form.setFieldValue('campaign_id', res.data.data.id);
          }
        } catch (error) {
          message.error(error.response?.data?.error || '重命名产品/活动失败');
          return Promise.reject();
        }
      }
    });
  };

  const renderCampaignOption = (option) => {
    const campaign = option.campaign;
    if (!campaign) return option.label;
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span>{campaign.name}</span>
        <Space size={2}>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => handleRenameCampaign(campaign, event)}
          />
          {campaign.id !== 1 ? (
            <Popconfirm
              title="删除这个产品/活动？"
              description="仅未被视频使用的产品/活动可以删除。"
              onConfirm={(event) => handleDeleteCampaign(campaign, event)}
              onCancel={(event) => {
                event?.preventDefault();
                event?.stopPropagation();
              }}
            >
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
              />
            </Popconfirm>
          ) : null}
        </Space>
      </div>
    );
  };

  const campaignManageColumns = [
    { title: '产品/活动', dataIndex: 'name', key: 'name' },
    {
      title: '操作',
      key: 'action',
      width: 180,
      render: (_, campaign) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={(event) => handleRenameCampaign(campaign, event)}>重命名</Button>
          <Popconfirm
            title="删除这个产品/活动？"
            description={campaign.id === 1 ? 'Default Campaign 不能删除。' : '仅未被视频使用的产品/活动可以删除。'}
            disabled={campaign.id === 1}
            onConfirm={(event) => handleDeleteCampaign(campaign, event)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} disabled={campaign.id === 1}>删除</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  const fetchVideos = async (nextFilters = filters) => {
    setLoading(true);
    try {
      const params = {};
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
    form.resetFields();
    form.setFieldsValue({ campaign_id: 1 });
    setModalVisible(true);
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

  const handleImport = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    setLoading(true);
    try {
      const res = await axios.post('/api/videos/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      const errors = res.data.data?.errors || [];
      message.success(res.data.message || '导入完成');
      if (errors.length) {
        Modal.warning({
          title: '部分行导入失败',
          width: 720,
          content: (
            <div style={{ maxHeight: 260, overflow: 'auto' }}>
              {errors.map((item) => <div key={item}>{item}</div>)}
            </div>
          )
        });
      }
      fetchCampaigns();
      fetchVideos();
    } catch (error) {
      message.error(error.response?.data?.error || '导入失败');
    } finally {
      setLoading(false);
    }
    return false;
  };

  const pollJob = (jobId) => {
    const timer = setInterval(async () => {
      try {
        const res = await axios.get(`/api/videos/jobs/${jobId}`);
        const job = res.data.data.job;
        if (['success', 'partial_failed', 'failed'].includes(job?.status)) {
          clearInterval(timer);
          setJobLoading(false);
          await fetchVideos();
          if (job.status === 'success') {
            message.success('任务完成');
          } else {
            message.warning(`任务结束：成功 ${job.success_count} 条，失败 ${job.failed_count} 条`);
          }
        }
      } catch (error) {
        clearInterval(timer);
        setJobLoading(false);
        message.error('查询任务状态失败');
      }
    }, 2000);
  };

  const runBatch = async (type, ids = selectedRowKeys) => {
    setJobLoading(true);
    try {
      const endpoint = type === 'crawl' ? '/api/videos/crawl' : '/api/videos/analyze';
      const res = await axios.post(endpoint, { videoIds: ids });
      const jobId = res.data.data.job_id;
      message.success(type === 'crawl' ? `已创建抓取任务 #${jobId}` : `已创建 AI 分析任务 #${jobId}`);
      pollJob(jobId);
    } catch (error) {
      setJobLoading(false);
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
    { title: '产品/活动', dataIndex: 'campaign_name', key: 'campaign_name', width: 160, render: (value) => value || '-' },
    {
      title: 'KOL / 视频',
      key: 'video',
      ellipsis: true,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <strong>{record.title || record.source_url}</strong>
          <span style={{ color: '#667085' }}>{record.kol_name || record.author_name || '-'}</span>
        </Space>
      )
    },
    {
      title: '抓取状态',
      dataIndex: 'crawl_status',
      key: 'crawl_status',
      width: 120,
      render: (value) => <Tag color={statusColor(value, 'crawl')}>{statusText(value, 'crawl')}</Tag>
    },
    {
      title: 'AI 状态',
      dataIndex: 'analysis_status',
      key: 'analysis_status',
      width: 130,
      render: (value) => <Tag color={statusColor(value, 'analysis')}>{statusText(value, 'analysis')}</Tag>
    },
    { title: '最近抓取', dataIndex: 'last_crawled_at', key: 'last_crawled_at', width: 160, render: (value) => value ? new Date(value).toLocaleString() : '-' },
    { title: '内容类型', dataIndex: 'content_type', key: 'content_type', width: 100, render: (value) => value || '-' },
    { title: '主要曝光数', dataIndex: 'primary_exposure_count', key: 'primary_exposure_count', width: 120, render: (value) => value ?? '-' },
    { title: '曝光口径', dataIndex: 'exposure_metric_type', key: 'exposure_metric_type', width: 180, ellipsis: true, render: (value) => value || '-' },
    { title: '播放', dataIndex: 'play_count', key: 'play_count', width: 90, render: (value) => value ?? '-' },
    { title: '点赞', dataIndex: 'like_count', key: 'like_count', width: 90, render: (value) => value ?? '-' },
    { title: '评论', dataIndex: 'comment_count', key: 'comment_count', width: 90, render: (value) => value ?? '-' },
    { title: '合作价格', dataIndex: 'cooperation_price', key: 'cooperation_price', width: 120, render: (value) => value || '-' },
    {
      title: 'AI 报告',
      key: 'ai',
      width: 220,
      ellipsis: true,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <span>{record.ai_score !== null && record.ai_score !== undefined ? `评分 ${record.ai_score}` : '-'}</span>
          <span style={{ color: '#667085' }}>{record.ai_summary || '-'}</span>
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
        <h1 className="page-title">视频数据</h1>
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
          <Upload accept=".xlsx,.xls,.csv" showUploadList={false} beforeUpload={handleImport}>
            <Button icon={<UploadOutlined />}>上传 Excel/CSV</Button>
          </Upload>
          <Button icon={<SyncOutlined />} loading={jobLoading} disabled={!selectedRowKeys.length} onClick={() => runBatch('crawl')}>批量抓取 ({selectedRowKeys.length})</Button>
          <Button icon={<BarChartOutlined />} loading={jobLoading} disabled={!selectedRowKeys.length} onClick={() => runBatch('analyze')}>批量分析 ({selectedRowKeys.length})</Button>
          <Popconfirm title="确定删除选中的视频？" disabled={!selectedRowKeys.length} onConfirm={() => handleDelete(selectedRowKeys)}>
            <Button danger icon={<DeleteOutlined />} disabled={!selectedRowKeys.length}>批量删除 ({selectedRowKeys.length})</Button>
          </Popconfirm>
          <Button icon={<DownloadOutlined />} disabled={!videos.length} onClick={handleExport}>
            导出 XLSX{selectedRowKeys.length ? ` (${selectedRowKeys.length})` : ''}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => fetchVideos()}>刷新</Button>
        </Space>
      </Card>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Row gutter={12}>
          <Col span={5}>
            <Select
              allowClear
              placeholder="产品/活动"
              value={filters.campaign_id}
              onChange={(value) => updateFilter('campaign_id', value)}
              options={campaignOptions}
              optionRender={renderCampaignOption}
              dropdownRender={(menu) => (
                <>
                  {menu}
                  <div style={{ padding: 8, borderTop: '1px solid #f0f0f0' }}>
                    <Button block icon={<EditOutlined />} onClick={() => setCampaignManageVisible(true)}>
                      管理产品/活动
                    </Button>
                  </div>
                </>
              )}
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
          pagination={{ pageSize: 20, showSizeChanger: true }}
        />
      </Card>

      <Modal
        title="管理产品/活动"
        open={campaignManageVisible}
        onCancel={() => setCampaignManageVisible(false)}
        footer={null}
        width={680}
      >
        <Table
          columns={campaignManageColumns}
          dataSource={campaigns}
          rowKey="id"
          pagination={false}
          size="small"
        />
      </Modal>

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
          <Form.Item label="所属产品/活动" name="campaign_id" rules={[{ required: true, message: '请选择产品/活动' }]}>
            <Select
              showSearch
              options={campaignOptions}
              optionFilterProp="label"
              optionRender={renderCampaignOption}
              dropdownRender={(menu) => (
                <>
                  {menu}
                  <div style={{ padding: 8 }}>
                    <Input.Search
                      placeholder="输入新产品/活动名称后回车"
                      enterButton="新建"
                      onSearch={async (value) => {
                        if (!value) return;
                        const res = await axios.post('/api/campaigns', { name: value, product: value });
                        await fetchCampaigns();
                        form.setFieldValue('campaign_id', res.data.data.id);
                      }}
                    />
                    <Button block icon={<EditOutlined />} style={{ marginTop: 8 }} onClick={() => setCampaignManageVisible(true)}>
                      管理产品/活动
                    </Button>
                  </div>
                </>
              )}
            />
          </Form.Item>
          <Form.Item label="KOL 名称" name="kol_name">
            <Input />
          </Form.Item>
          <Form.Item label="合作价格" name="cooperation_price">
            <Input />
          </Form.Item>
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
            <div><strong>KOL：</strong>{detailVideo.kol_name || detailVideo.author_name || '-'}</div>
            <div><strong>标题：</strong>{detailVideo.title || '-'}</div>
            <div><strong>链接：</strong><a href={detailVideo.source_url} target="_blank" rel="noreferrer">{detailVideo.source_url}</a></div>
            <div><strong>内容类型：</strong>{detailVideo.content_type || '-'}</div>
            <div><strong>主要曝光数：</strong>{detailVideo.primary_exposure_count ?? '-'}</div>
            <div><strong>曝光口径：</strong>{detailVideo.exposure_metric_type || '-'}</div>
            <div><strong>数据完整性：</strong>{detailVideo.data_quality_note || '-'}</div>
            <div><strong>合作价格：</strong>{detailVideo.cooperation_price || '-'}</div>
            <div><strong>备注：</strong>{detailVideo.notes || '-'}</div>
            <div><strong>错误：</strong>{detailVideo.error_message || '-'}</div>
            <div><strong>AI 摘要：</strong>{detailVideo.ai_summary || '-'}</div>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
};

export default VideoAnalysis;
