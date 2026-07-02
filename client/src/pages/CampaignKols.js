import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Form, Input, message, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd';
import { DeleteOutlined, EditOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import axios from 'axios';

const { TextArea } = Input;

const statusOptions = [
  { value: 'candidate', label: '候选' },
  { value: 'to_contact', label: '待联系' },
  { value: 'contacted', label: '已联系' },
  { value: 'no_reply', label: '没回复' },
  { value: 'negotiating', label: '沟通中' },
  { value: 'confirmed', label: '已确定' },
  { value: 'published', label: '已发布' },
  { value: 'not_fit', label: '不合适' }
];

const statusColor = {
  candidate: 'blue',
  to_contact: 'cyan',
  contacted: 'geekblue',
  no_reply: 'default',
  negotiating: 'orange',
  confirmed: 'green',
  published: 'purple',
  not_fit: 'red'
};

const CampaignKols = () => {
  const [rows, setRows] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [filters, setFilters] = useState({});
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();

  const campaignOptions = useMemo(() => campaigns.map((item) => ({
    value: item.id,
    label: item.name
  })), [campaigns]);

  useEffect(() => {
    fetchCampaigns();
    fetchRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const openEdit = (record) => {
    setEditing(record);
    form.setFieldsValue(record);
  };

  const saveEdit = async () => {
    const values = await form.validateFields();
    await axios.put(`/api/campaign-kols/${editing.id}`, values);
    message.success('项目 KOL 已更新');
    setEditing(null);
    fetchRows();
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
      message.success(`同步完成：成功 ${data.success_count}，失败 ${data.failed_count}`);
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
      <Space direction="vertical" size={0}>
        {url ? <a href={url} target="_blank" rel="noreferrer">主页</a> : <span>-</span>}
        {followers ? <span style={{ color: '#666' }}>{followers}</span> : null}
      </Space>
    );
  };

  const columns = [
    { title: '项目/产品', dataIndex: 'campaign_name', key: 'campaign_name', width: 150, fixed: 'left' },
    {
      title: 'KOL',
      key: 'kol',
      width: 190,
      fixed: 'left',
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <strong>{r.kol_name || r.kol_name_snapshot}</strong>
          <span style={{ color: '#666' }}>{r.contact_name || r.contact_name_snapshot || '-'}</span>
        </Space>
      )
    },
    { title: 'YouTube', key: 'youtube', width: 130, render: (_, r) => platformLink(r.youtube_url || r.youtube_url_snapshot, r.youtube_followers || r.youtube_followers_snapshot) },
    { title: 'Instagram', key: 'instagram', width: 130, render: (_, r) => platformLink(r.instagram_url || r.instagram_url_snapshot, r.instagram_followers || r.instagram_followers_snapshot) },
    { title: 'TikTok', key: 'tiktok', width: 130, render: (_, r) => platformLink(r.tiktok_url || r.tiktok_url_snapshot, r.tiktok_followers || r.tiktok_followers_snapshot) },
    { title: 'Email', dataIndex: 'email_snapshot', key: 'email_snapshot', width: 200, render: (v, r) => v || r.email || '-' },
    { title: '国家地区', dataIndex: 'country_region_snapshot', key: 'country_region_snapshot', width: 120, render: (v, r) => v || r.country_region || '-' },
    { title: '项目报价', dataIndex: 'quoted_price', key: 'quoted_price', width: 110, render: (v) => v || '-' },
    { title: 'RMB', dataIndex: 'price_rmb', key: 'price_rmb', width: 100, render: (v) => v || '-' },
    { title: '状态', dataIndex: 'status', key: 'status', width: 110, render: (v) => <Tag color={statusColor[v] || 'default'}>{statusOptions.find((item) => item.value === v)?.label || v || '-'}</Tag> },
    { title: '跟进人', dataIndex: 'owner', key: 'owner', width: 100, render: (v) => v || '-' },
    {
      title: '发布链接',
      key: 'video_links',
      width: 150,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          {r.youtube_video_link ? <a href={r.youtube_video_link} target="_blank" rel="noreferrer">YouTube</a> : null}
          {r.instagram_video_link ? <a href={r.instagram_video_link} target="_blank" rel="noreferrer">Instagram</a> : null}
          {r.tiktok_video_link ? <a href={r.tiktok_video_link} target="_blank" rel="noreferrer">TikTok</a> : null}
          {!r.youtube_video_link && !r.instagram_video_link && !r.tiktok_video_link ? '-' : null}
        </Space>
      )
    },
    { title: '同步', dataIndex: 'sync_status', key: 'sync_status', width: 120, render: (v) => <Tag>{v || 'sync_pending'}</Tag> },
    { title: '备注', dataIndex: 'notes', key: 'notes', width: 220, ellipsis: true, render: (v) => v || '-' },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      fixed: 'right',
      render: (_, record) => (
        <Space>
          <Button type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
          <Popconfirm title="确定从项目中删除这个 KOL？" onConfirm={() => deleteOne(record.id)}>
            <Button type="link" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Campaign KOL</h1>
        <p className="page-subtitle">项目子表：继承 KOL Master 信息，但项目报价、状态、备注和发布链接可单独编辑。</p>
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
          <Button icon={<SyncOutlined />} loading={syncing} onClick={syncSelected}>{selectedRowKeys.length ? '同步选中到飞书' : '同步待同步到飞书'}</Button>
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
          pagination={{ pageSize: 20, showSizeChanger: true }}
        />
      </Card>

      <Modal title="编辑项目 KOL" open={Boolean(editing)} onCancel={() => setEditing(null)} onOk={saveEdit} width={760}>
        <Form form={form} layout="vertical">
          <Space align="start" style={{ width: '100%' }}>
            <Form.Item label="项目报价" name="quoted_price">
              <Input style={{ width: 170 }} />
            </Form.Item>
            <Form.Item label="汇率" name="exchange_rate">
              <Input style={{ width: 120 }} />
            </Form.Item>
            <Form.Item label="价格 RMB" name="price_rmb">
              <Input style={{ width: 150 }} />
            </Form.Item>
          </Space>
          <Space align="start" style={{ width: '100%' }}>
            <Form.Item label="状态" name="status">
              <Select options={statusOptions} style={{ width: 170 }} />
            </Form.Item>
            <Form.Item label="跟进人" name="owner">
              <Input style={{ width: 170 }} />
            </Form.Item>
          </Space>
          <Form.Item label="YouTube 视频链接" name="youtube_video_link">
            <Input />
          </Form.Item>
          <Form.Item label="Instagram 视频链接" name="instagram_video_link">
            <Input />
          </Form.Item>
          <Form.Item label="TikTok 视频链接" name="tiktok_video_link">
            <Input />
          </Form.Item>
          <Form.Item label="备注" name="notes">
            <TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default CampaignKols;
