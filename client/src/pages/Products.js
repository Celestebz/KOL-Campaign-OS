import React, { useEffect, useState } from 'react';
import {
  Alert, Button, Card, Descriptions, Drawer, Form, Input, message, Popconfirm, Space, Statistic, Table, Tag
} from 'antd';
import { EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import axios from 'axios';
import { normalizeCampaignProduct, productStatusLabel } from './productCampaignContract';

const { TextArea } = Input;

const editableProductFields = ['brand', 'name', 'sku', 'category', 'product_url', 'description', 'selling_points'];

const Products = () => {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [searchText, setSearchText] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerProduct, setDrawerProduct] = useState(null);
  const [campaignHistory, setCampaignHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchProducts = async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/products');
      setProducts(res.data.data || []);
    } catch (error) {
      message.error(error.response?.data?.error || '获取产品列表失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchCampaignHistory = async (productId) => {
    setHistoryLoading(true);
    try {
      const res = await axios.get(`/api/products/${productId}/campaigns`);
      setCampaignHistory((res.data.data || []).map(normalizeCampaignProduct));
    } catch (error) {
      setCampaignHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const openDrawer = async (record) => {
    setDrawerProduct(record);
    setDrawerOpen(true);
    await fetchCampaignHistory(record.id);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setDrawerProduct(null);
    setCampaignHistory([]);
  };

  const openModal = (record = null) => {
    setEditing(record);
    form.resetFields();
    if (record) {
      const values = {};
      for (const field of editableProductFields) {
        values[field] = record[field] ?? '';
      }
      form.setFieldsValue(values);
    }
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    const payload = {};
    for (const field of editableProductFields) {
      payload[field] = values[field] === '' ? null : values[field];
    }
    try {
      if (editing) {
        await axios.put(`/api/products/${editing.id}`, payload);
        message.success('产品已更新');
      } else {
        await axios.post('/api/products', payload);
        message.success('产品已创建');
      }
      setModalOpen(false);
      await fetchProducts();
    } catch (error) {
      message.error(error.response?.data?.error || '保存失败');
    }
  };

  const handleArchive = async (record) => {
    try {
      await axios.post(`/api/products/${record.id}/archive`);
      message.success('产品已归档');
      await fetchProducts();
      if (drawerOpen && drawerProduct?.id === record.id) {
        setDrawerProduct((prev) => (prev ? { ...prev, status: 'archived' } : prev));
      }
    } catch (error) {
      message.error(error.response?.data?.error || '归档失败');
    }
  };

  const filteredProducts = products.filter((item) => {
    if (!searchText) return true;
    const term = searchText.toLowerCase();
    return [item.name, item.brand, item.sku, item.category].some((v) => String(v || '').toLowerCase().includes(term));
  });

  const columns = [
    {
      title: '产品名称',
      dataIndex: 'name',
      key: 'name',
      render: (v, r) => (
        <Button type="link" style={{ padding: 0, height: 'auto', whiteSpace: 'normal', textAlign: 'left' }} onClick={() => openDrawer(r)}>
          {v || '-'}
        </Button>
      )
    },
    { title: '品牌', dataIndex: 'brand', key: 'brand', render: (v) => v || '-' },
    { title: 'SKU', dataIndex: 'sku', key: 'sku', render: (v) => v || '-' },
    { title: '品类', dataIndex: 'category', key: 'category', render: (v) => v || '-' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v) => <Tag color={v === 'archived' ? 'default' : 'green'}>{productStatusLabel(v)}</Tag>
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Space>
          <Button type="link" icon={<EditOutlined />} onClick={() => openModal(record)}>编辑</Button>
          <Popconfirm title="确定归档该产品？" onConfirm={() => handleArchive(record)} disabled={record.status === 'archived'}>
            <Button type="link" danger disabled={record.status === 'archived'}>归档</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">产品目录</h1>
        <p className="page-subtitle">管理可复用的全局产品资产。</p>
      </div>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Space size="large" wrap style={{ marginBottom: 16 }}>
          <Statistic title="总产品" value={products.length} />
          <Statistic title="正常" value={products.filter((item) => item.status !== 'archived').length} />
          <Statistic title="已归档" value={products.filter((item) => item.status === 'archived').length} />
        </Space>
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="搜索产品名称、品牌、SKU、品类"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 320 }}
          />
          <Button icon={<ReloadOutlined />} onClick={fetchProducts}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal()}>新增产品</Button>
        </Space>
      </Card>

      <Card className="content-card">
        <Table columns={columns} dataSource={filteredProducts} rowKey="id" loading={loading} pagination={{ defaultPageSize: 20, showSizeChanger: true }} />
      </Card>

      <Drawer title={drawerProduct?.name || '产品详情'} width={640} open={drawerOpen} onClose={closeDrawer}>
        {drawerProduct && (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Descriptions bordered column={2} size="small">
              <Descriptions.Item label="品牌">{drawerProduct.brand || '-'}</Descriptions.Item>
              <Descriptions.Item label="状态">{productStatusLabel(drawerProduct.status)}</Descriptions.Item>
              <Descriptions.Item label="SKU">{drawerProduct.sku || '-'}</Descriptions.Item>
              <Descriptions.Item label="品类">{drawerProduct.category || '-'}</Descriptions.Item>
              <Descriptions.Item label="产品链接" span={2}>
                {drawerProduct.product_url ? <a href={drawerProduct.product_url} target="_blank" rel="noreferrer">{drawerProduct.product_url}</a> : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="卖点" span={2}>{drawerProduct.selling_points || '-'}</Descriptions.Item>
              <Descriptions.Item label="描述" span={2}>{drawerProduct.description || '-'}</Descriptions.Item>
            </Descriptions>
            <div>
              <h3>项目历史</h3>
              {historyLoading ? <Alert type="info" message="加载中..." /> : campaignHistory.length ? (
                <Table size="small" rowKey="id" pagination={false} dataSource={campaignHistory} columns={[
                  { title: '项目', dataIndex: 'campaign_name' },
                  { title: '角色', dataIndex: 'role' },
                  { title: '状态', dataIndex: 'status' },
                  { title: 'Brief', dataIndex: 'campaign_brief', ellipsis: true }
                ]} />
              ) : <Alert type="info" message="暂无项目历史" />}
            </div>
          </Space>
        )}
      </Drawer>

      <Form.Provider>
        {modalOpen && (
          <Form form={form} layout="vertical" initialValues={{ brand: '', name: '', sku: '', category: '', product_url: '', description: '', selling_points: '' }}>
            <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ background: '#fff', width: 640, maxHeight: '90vh', overflow: 'auto', borderRadius: 8, padding: 24 }}>
                <h2>{editing ? '编辑产品' : '新增产品'}</h2>
                <Form.Item label="品牌" name="brand" rules={[{ required: false }]}>
                  <Input placeholder="品牌名称" />
                </Form.Item>
                <Form.Item label="产品名称" name="name" rules={[{ required: true, message: '请输入产品名称' }]}>
                  <Input placeholder="产品名称" />
                </Form.Item>
                <Form.Item label="SKU" name="sku">
                  <Input placeholder="SKU" />
                </Form.Item>
                <Form.Item label="品类" name="category">
                  <Input placeholder="品类" />
                </Form.Item>
                <Form.Item label="产品链接" name="product_url">
                  <Input placeholder="https://..." />
                </Form.Item>
                <Form.Item label="卖点" name="selling_points">
                  <TextArea rows={3} placeholder="每行一个卖点" />
                </Form.Item>
                <Form.Item label="描述" name="description">
                  <TextArea rows={4} placeholder="产品描述" />
                </Form.Item>
                <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
                  <Button onClick={() => setModalOpen(false)}>取消</Button>
                  <Button type="primary" onClick={handleSubmit}>保存</Button>
                </Space>
              </div>
            </div>
          </Form>
        )}
      </Form.Provider>
    </div>
  );
};

export default Products;
