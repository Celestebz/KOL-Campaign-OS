import React, { useEffect, useState } from 'react';
import { Button, Card, Form, Input, message, Modal, Popconfirm, Select, Space, Table, Tag, Upload } from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  UploadOutlined
} from '@ant-design/icons';
import axios from 'axios';

const { TextArea } = Input;

const Customers = () => {
  const [kols, setKols] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingKol, setEditingKol] = useState(null);
  const [searchText, setSearchText] = useState('');
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchKols();
    fetchGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchKols = async () => {
    setLoading(true);
    try {
      const params = {};
      if (searchText) params.search = searchText;
      if (selectedGroup) params.group_id = selectedGroup;
      const response = await axios.get('/api/customers', { params });
      setKols(response.data.data || []);
    } catch (error) {
      message.error('获取 KOL 列表失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchGroups = async () => {
    try {
      const response = await axios.get('/api/groups');
      setGroups(response.data.data || []);
    } catch (error) {
      message.error('获取分组失败');
    }
  };

  const handleAdd = () => {
    setEditingKol(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (record) => {
    setEditingKol(record);
    form.setFieldsValue(record);
    setModalVisible(true);
  };

  const handleDelete = async (id) => {
    await axios.delete(`/api/customers/${id}`);
    message.success('删除成功');
    fetchKols();
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    if (editingKol) {
      await axios.put(`/api/customers/${editingKol.id}`, values);
      message.success('更新成功');
    } else {
      await axios.post('/api/customers', values);
      message.success('创建成功');
    }
    setModalVisible(false);
    fetchKols();
  };

  const handleDownloadTemplate = () => {
    window.location.href = '/api/customers/template/download';
  };

  const handleImport = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    setImporting(true);

    try {
      const response = await axios.post('/api/customers/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      const result = response.data.data;
      message.success(response.data.message || '导入完成');
      if (result?.errors?.length) {
        Modal.warning({
          title: '部分行导入失败',
          width: 720,
          content: (
            <div style={{ maxHeight: 260, overflow: 'auto' }}>
              {result.errors.map((item) => <div key={item}>{item}</div>)}
            </div>
          )
        });
      }
      fetchKols();
      fetchGroups();
    } catch (error) {
      message.error(error.response?.data?.error || '导入失败');
    } finally {
      setImporting(false);
    }

    return false;
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
    { title: 'KOL', dataIndex: 'name', key: 'name', width: 180, fixed: 'left' },
    { title: '联系人', dataIndex: 'contact_name', key: 'contact_name', width: 140, render: (v) => v || '-' },
    { title: 'YouTube', key: 'youtube', width: 150, render: (_, r) => platformLink(r.youtube_url, r.youtube_followers) },
    { title: 'Instagram', key: 'instagram', width: 150, render: (_, r) => platformLink(r.instagram_url, r.instagram_followers) },
    { title: 'TikTok', key: 'tiktok', width: 150, render: (_, r) => platformLink(r.tiktok_url, r.tiktok_followers) },
    { title: 'Email', dataIndex: 'email', key: 'email', width: 220, render: (v) => v || '-' },
    { title: '电话', dataIndex: 'phone', key: 'phone', width: 140, render: (v) => v || '-' },
    { title: '国家地区', dataIndex: 'country_region', key: 'country_region', width: 120, render: (v) => v || '-' },
    { title: '视频价格', dataIndex: 'video_price', key: 'video_price', width: 120, render: (v) => v || '-' },
    { title: '价格（RMB）', dataIndex: 'price_rmb', key: 'price_rmb', width: 130, render: (v) => v || '-' },
    { title: '评分', dataIndex: 'rating', key: 'rating', width: 90, render: (v) => v || '-' },
    { title: '分组', dataIndex: 'group_name', key: 'group_name', width: 130, render: (v) => v ? <Tag>{v}</Tag> : '-' },
    { title: '备注', dataIndex: 'notes', key: 'notes', width: 220, ellipsis: true, render: (v) => v || '-' },
    {
      title: '操作',
      key: 'action',
      width: 150,
      fixed: 'right',
      render: (_, record) => (
        <Space>
          <Button type="link" icon={<EditOutlined />} onClick={() => handleEdit(record)}>编辑</Button>
          <Popconfirm title="确定删除这个 KOL？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">KOL 管理</h1>
      </div>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="搜索 KOL、联系人、邮箱、平台链接"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            onSearch={fetchKols}
            style={{ width: 300 }}
          />
          <Select
            allowClear
            placeholder="选择分组"
            value={selectedGroup}
            onChange={setSelectedGroup}
            style={{ width: 180 }}
            options={groups.map((item) => ({ value: item.id, label: item.name }))}
          />
          <Button icon={<ReloadOutlined />} onClick={fetchKols}>刷新</Button>
          <Button icon={<DownloadOutlined />} onClick={handleDownloadTemplate}>下载模板</Button>
          <Upload accept=".xlsx,.xls,.csv" showUploadList={false} beforeUpload={handleImport}>
            <Button icon={<UploadOutlined />} loading={importing}>批量导入</Button>
          </Upload>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增 KOL</Button>
        </Space>
      </Card>

      <Card className="content-card">
        <Table
          columns={columns}
          dataSource={kols}
          rowKey="id"
          loading={loading}
          scroll={{ x: 1900 }}
          pagination={{ pageSize: 20, showSizeChanger: true }}
        />
      </Card>

      <Modal
        title={editingKol ? '编辑 KOL' : '新增 KOL'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={handleSubmit}
        width={820}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="KOL" name="name" rules={[{ required: true, message: '请输入 KOL 名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="联系人" name="contact_name">
            <Input />
          </Form.Item>
          <Form.Item label="YouTube" name="youtube_url">
            <Input />
          </Form.Item>
          <Form.Item label="YouTube粉丝量" name="youtube_followers">
            <Input />
          </Form.Item>
          <Form.Item label="Instagram" name="instagram_url">
            <Input />
          </Form.Item>
          <Form.Item label="Instagram 粉丝量" name="instagram_followers">
            <Input />
          </Form.Item>
          <Form.Item label="TikTok" name="tiktok_url">
            <Input />
          </Form.Item>
          <Form.Item label="TikTok 粉丝量" name="tiktok_followers">
            <Input />
          </Form.Item>
          <Form.Item label="Email" name="email">
            <Input />
          </Form.Item>
          <Form.Item label="电话" name="phone">
            <Input />
          </Form.Item>
          <Form.Item label="国家地区" name="country_region">
            <Input />
          </Form.Item>
          <Form.Item label="视频价格" name="video_price">
            <Input />
          </Form.Item>
          <Form.Item label="汇率" name="exchange_rate">
            <Input />
          </Form.Item>
          <Form.Item label="价格（RMB）" name="price_rmb">
            <Input />
          </Form.Item>
          <Form.Item label="评分" name="rating">
            <Input />
          </Form.Item>
          <Form.Item label="分组" name="group_id">
            <Select allowClear options={groups.map((item) => ({ value: item.id, label: item.name }))} />
          </Form.Item>
          <Form.Item label="备注" name="notes">
            <TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Customers;
