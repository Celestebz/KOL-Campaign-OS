import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Descriptions, Drawer, Empty, Form, Input, message, Popconfirm, Select, Space, Statistic, Table, Tag
} from 'antd';
import { EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import axios from 'axios';
import {
  normalizeCampaign,
  normalizeCampaignProduct,
  campaignProductRoleLabels,
  campaignProductStatusLabels,
  campaignProductStatusColors
} from './productCampaignContract';

const { TextArea } = Input;

const roleOptions = [
  { value: 'hero', label: '主推' },
  { value: 'secondary', label: '辅推' },
  { value: 'test', label: '测试' }
];

const statusOptions = [
  { value: 'planned', label: '计划中' },
  { value: 'active', label: '进行中' },
  { value: 'paused', label: '已暂停' },
  { value: 'completed', label: '已完成' },
  { value: 'archived', label: '已归档' }
];

const Campaigns = () => {
  const [campaigns, setCampaigns] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerCampaign, setDrawerCampaign] = useState(null);
  const [campaignProducts, setCampaignProducts] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [editingCampaignProduct, setEditingCampaignProduct] = useState(null);
  const [createMode, setCreateMode] = useState('existing');
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [newProductName, setNewProductName] = useState('');
  const [newProductBrand, setNewProductBrand] = useState('');
  const [searchText, setSearchText] = useState('');
  const [form] = Form.useForm();

  useEffect(() => {
    fetchCampaigns();
    fetchProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchCampaigns = async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/campaigns');
      setCampaigns((res.data.data || []).map(normalizeCampaign));
    } catch (error) {
      message.error(error.response?.data?.error || '获取项目列表失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchProducts = async () => {
    try {
      const res = await axios.get('/api/products');
      setProducts(res.data.data || []);
    } catch (error) {
      message.error('获取产品列表失败');
    }
  };

  const fetchCampaignProducts = async (campaignId) => {
    setDetailLoading(true);
    try {
      const res = await axios.get(`/api/campaigns/${campaignId}/products`);
      setCampaignProducts((res.data.data || []).map(normalizeCampaignProduct));
    } catch (error) {
      setCampaignProducts([]);
    } finally {
      setDetailLoading(false);
    }
  };

  const openDrawer = async (record) => {
    const normalized = normalizeCampaign(record);
    setDrawerCampaign(normalized);
    setDrawerOpen(true);
    await fetchCampaignProducts(normalized.id);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setDrawerCampaign(null);
    setCampaignProducts([]);
  };

  const openProductModal = (record = null) => {
    setEditingCampaignProduct(record);
    form.resetFields();
    setCreateMode('existing');
    setSelectedProductId(null);
    setNewProductName('');
    setNewProductBrand('');
    if (record) {
      form.setFieldsValue({
        role: record.role,
        priority: record.priority,
        campaign_brief: record.campaign_brief || '',
        status: record.status
      });
    }
    setProductModalOpen(true);
  };

  const handleAttachProduct = async () => {
    if (!drawerCampaign) return;
    let productId = selectedProductId;
    try {
      if (createMode === 'new') {
        if (!newProductName.trim()) {
          message.warning('请输入新产品名称');
          return;
        }
        const res = await axios.post('/api/products', { brand: newProductBrand.trim(), name: newProductName.trim() });
        productId = res.data.data.id;
        await fetchProducts();
      }
      if (!productId) {
        message.warning('请选择产品');
        return;
      }
      await axios.post(`/api/campaigns/${drawerCampaign.id}/products`, {
        product_id: productId,
        role: 'hero',
        status: 'active'
      });
      message.success('产品已添加到项目');
      setProductModalOpen(false);
      await fetchCampaignProducts(drawerCampaign.id);
      await fetchCampaigns();
    } catch (error) {
      message.error(error.response?.data?.error || '添加产品失败');
    }
  };

  const handleUpdateCampaignProduct = async () => {
    if (!drawerCampaign || !editingCampaignProduct) return;
    const values = await form.validateFields();
    try {
      await axios.put(`/api/campaigns/${drawerCampaign.id}/products/${editingCampaignProduct.id}`, values);
      message.success('项目产品已更新');
      setProductModalOpen(false);
      await fetchCampaignProducts(drawerCampaign.id);
      await fetchCampaigns();
    } catch (error) {
      message.error(error.response?.data?.error || '更新失败');
    }
  };

  const handleArchiveCampaignProduct = async (record) => {
    if (!drawerCampaign) return;
    try {
      await axios.post(`/api/campaigns/${drawerCampaign.id}/products/${record.id}/archive`);
      message.success('项目产品已归档');
      await fetchCampaignProducts(drawerCampaign.id);
      await fetchCampaigns();
    } catch (error) {
      message.error(error.response?.data?.error || '归档失败');
    }
  };

  const handleCreateCampaign = async () => {
    const name = searchText.trim();
    if (!name) {
      message.warning('请输入项目名称');
      return;
    }
    try {
      await axios.post('/api/campaigns', { name, product: name });
      message.success('项目已创建');
      setSearchText('');
      await fetchCampaigns();
    } catch (error) {
      message.error(error.response?.data?.error || '创建项目失败');
    }
  };

  const availableProducts = useMemo(() => {
    const attachedIds = new Set(campaignProducts.map((item) => item.product_id));
    return products.filter((item) => item.status !== 'archived' && !attachedIds.has(item.id));
  }, [products, campaignProducts]);

  const filteredCampaigns = campaigns.filter((item) => {
    if (!searchText) return true;
    const term = searchText.toLowerCase();
    return String(item.name || '').toLowerCase().includes(term) || String(item.brand || '').toLowerCase().includes(term);
  });

  const columns = [
    {
      title: '项目名称',
      dataIndex: 'name',
      key: 'name',
      render: (v, r) => (
        <Button type="link" style={{ padding: 0, height: 'auto', whiteSpace: 'normal', textAlign: 'left' }} onClick={() => openDrawer(r)}>
          {v || '-'}
        </Button>
      )
    },
    { title: '品牌', dataIndex: 'brand', key: 'brand', render: (v) => v || '-' },
    {
      title: '关联产品',
      key: 'products',
      render: (_, r) => `${r.associatedProductCount} 个（活跃 ${r.activeProductCount} 个）`
    },
    { title: '备注产品', dataIndex: 'product', key: 'product', render: (v) => v || '-' }
  ];

  const productColumns = [
    { title: '产品', dataIndex: 'productName', key: 'productName' },
    { title: '品牌', dataIndex: 'productBrand', key: 'productBrand', render: (v) => v || '-' },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      render: (v) => campaignProductRoleLabels[v] || v || '-'
    },
    { title: '优先级', dataIndex: 'priority', key: 'priority' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v) => <Tag color={campaignProductStatusColors[v] || 'default'}>{campaignProductStatusLabels[v] || v}</Tag>
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Space>
          <Button type="link" icon={<EditOutlined />} onClick={() => openProductModal(record)}>编辑</Button>
          <Popconfirm title="确定归档该项目产品？" onConfirm={() => handleArchiveCampaignProduct(record)} disabled={record.status === 'archived'}>
            <Button type="link" danger disabled={record.status === 'archived'}>归档</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">项目与产品</h1>
        <p className="page-subtitle">管理 Campaign 及其关联的产品上下文。</p>
      </div>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Space size="large" wrap style={{ marginBottom: 16 }}>
          <Statistic title="总项目" value={campaigns.length} />
          <Statistic title="总关联产品" value={campaigns.reduce((sum, item) => sum + item.associatedProductCount, 0)} />
          <Statistic title="活跃关联产品" value={campaigns.reduce((sum, item) => sum + item.activeProductCount, 0)} />
        </Space>
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="搜索项目名称、品牌"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onSearch={handleCreateCampaign}
            enterButton="新建项目"
            style={{ width: 380 }}
          />
          <Button icon={<ReloadOutlined />} onClick={fetchCampaigns}>刷新</Button>
        </Space>
      </Card>

      <Card className="content-card">
        <Table columns={columns} dataSource={filteredCampaigns} rowKey="id" loading={loading} pagination={{ defaultPageSize: 20, showSizeChanger: true }} />
      </Card>

      <Drawer title={drawerCampaign?.name || '项目详情'} width={720} open={drawerOpen} onClose={closeDrawer}>
        {drawerCampaign && (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Descriptions bordered column={2} size="small">
              <Descriptions.Item label="品牌">{drawerCampaign.brand || '-'}</Descriptions.Item>
              <Descriptions.Item label="关联产品">{drawerCampaign.associatedProductCount} 个</Descriptions.Item>
              <Descriptions.Item label="活跃产品">{drawerCampaign.activeProductCount} 个</Descriptions.Item>
              <Descriptions.Item label="备注产品">{drawerCampaign.product || '-'}</Descriptions.Item>
            </Descriptions>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0 }}>项目产品</h3>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => openProductModal()}>添加产品</Button>
              </div>
              {detailLoading ? <Alert type="info" message="加载中..." /> : (
                <Table size="small" rowKey="id" pagination={false} dataSource={campaignProducts} columns={productColumns} locale={{ emptyText: <Empty description="暂无关联产品" /> }} />
              )}
            </div>
          </Space>
        )}
      </Drawer>

      {productModalOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', width: 560, maxHeight: '90vh', overflow: 'auto', borderRadius: 8, padding: 24 }}>
            <h2>{editingCampaignProduct ? '编辑项目产品' : '添加产品到项目'}</h2>
            {!editingCampaignProduct && (
              <>
                <Space style={{ marginBottom: 16 }}>
                  <Button type={createMode === 'existing' ? 'primary' : 'default'} onClick={() => setCreateMode('existing')}>选择现有产品</Button>
                  <Button type={createMode === 'new' ? 'primary' : 'default'} onClick={() => setCreateMode('new')}>创建并添加</Button>
                </Space>
                {createMode === 'existing' ? (
                  <Select
                    showSearch
                    optionFilterProp="label"
                    placeholder="选择产品"
                    value={selectedProductId}
                    onChange={setSelectedProductId}
                    style={{ width: '100%', marginBottom: 16 }}
                    options={availableProducts.map((item) => ({ value: item.id, label: `${item.brand || ''} ${item.name}`.trim() }))}
                  />
                ) : (
                  <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}>
                    <Input placeholder="品牌" value={newProductBrand} onChange={(e) => setNewProductBrand(e.target.value)} />
                    <Input placeholder="产品名称" value={newProductName} onChange={(e) => setNewProductName(e.target.value)} />
                  </Space>
                )}
              </>
            )}
            <Form form={form} layout="vertical">
              <Form.Item label="角色" name="role" rules={[{ required: true }]} initialValue="hero">
                <Select options={roleOptions} />
              </Form.Item>
              <Form.Item label="优先级" name="priority" rules={[{ required: true }]} initialValue={0}>
                <Input type="number" min={0} />
              </Form.Item>
              <Form.Item label="状态" name="status" rules={[{ required: true }]} initialValue="active">
                <Select options={statusOptions} />
              </Form.Item>
              <Form.Item label="项目 Brief" name="campaign_brief">
                <TextArea rows={4} placeholder="输入该项目中产品的定位和 Brief" />
              </Form.Item>
            </Form>
            <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
              <Button onClick={() => setProductModalOpen(false)}>取消</Button>
              <Button type="primary" onClick={editingCampaignProduct ? handleUpdateCampaignProduct : handleAttachProduct}>
                {editingCampaignProduct ? '保存' : '添加'}
              </Button>
            </Space>
          </div>
        </div>
      )}
    </div>
  );
};

export default Campaigns;
