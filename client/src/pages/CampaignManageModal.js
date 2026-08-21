import React, { useCallback, useEffect, useState } from 'react';
import { Button, Form, Input, message, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd';
import { EditOutlined, InboxOutlined } from '@ant-design/icons';
import axios from 'axios';
import { getEmailSettings } from './emailApi';

const { TextArea } = Input;

const activePrimaryProduct = (products = []) => (
  products.find((item) => item.status !== 'archived' && item.role === 'hero')
  || products.find((item) => item.status !== 'archived')
  || null
);

const CampaignManageModal = ({ open, onCancel, onChanged }) => {
  const [form] = Form.useForm();
  const [campaigns, setCampaigns] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [mailboxes, setMailboxes] = useState([]);
  const [scope, setScope] = useState('active');
  const [archivingId, setArchivingId] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [campaignResponse, productResponse] = await Promise.all([
        axios.get('/api/campaigns', { params: { scope } }),
        axios.get('/api/products')
      ]);
      setCampaigns(campaignResponse.data.data || []);
      setProducts((productResponse.data.data || []).filter((item) => item.status !== 'archived'));
    } catch (error) {
      message.error(error.response?.data?.error || '获取项目资料失败');
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    if (open) loadData();
  }, [open, loadData]);

  useEffect(() => {
    if (!open) return;
    getEmailSettings().then((rows) => setMailboxes((rows || []).filter((m) => m.enabled))).catch(() => {});
  }, [open]);

  const openEditor = async (campaign) => {
    setLoading(true);
    try {
      const response = await axios.get(`/api/campaigns/${campaign.id}/detail`);
      const detail = response.data.data || {};
      const primary = activePrimaryProduct(detail.products);
      setEditing({ campaign: detail.campaign || campaign, primary });
      form.setFieldsValue({
        name: (detail.campaign || campaign).name,
        brand: (detail.campaign || campaign).brand || primary?.product?.brand || '',
        period: (detail.campaign || campaign).period || '',
        mailbox_id: (detail.campaign || campaign).mailbox_id ?? undefined,
        product_id: primary?.product?.id,
        campaign_brief: primary?.campaign_brief || ''
      });
    } catch (error) {
      message.error(error.response?.data?.error || '获取项目详情失败');
    } finally {
      setLoading(false);
    }
  };

  const saveProject = async () => {
    const values = await form.validateFields();
    const selectedProduct = products.find((item) => item.id === values.product_id);
    if (!selectedProduct) {
      message.error('所选产品不存在或已归档');
      return;
    }

    setSaving(true);
    try {
      await axios.put(`/api/campaigns/${editing.campaign.id}`, {
        name: values.name.trim(),
        brand: values.brand?.trim() || '',
        product: selectedProduct.name,
        period: values.period?.trim() || '',
        mailbox_id: values.mailbox_id ?? null
      });

      const currentPrimary = editing.primary;
      if (currentPrimary?.product?.id === selectedProduct.id) {
        await axios.put(
          `/api/campaigns/${editing.campaign.id}/products/${currentPrimary.id}`,
          { campaign_brief: values.campaign_brief?.trim() || '' }
        );
      } else {
        await axios.post(`/api/campaigns/${editing.campaign.id}/products`, {
          product_id: selectedProduct.id,
          role: 'hero',
          priority: 0,
          campaign_brief: values.campaign_brief?.trim() || '',
          status: 'active'
        });
        if (currentPrimary) {
          await axios.post(
            `/api/campaigns/${editing.campaign.id}/products/${currentPrimary.id}/archive`
          );
        }
      }

      message.success('项目信息已更新');
      setEditing(null);
      form.resetFields();
      await loadData();
      await onChanged?.();
    } catch (error) {
      message.error(error.response?.data?.error || '更新项目失败');
    } finally {
      setSaving(false);
    }
  };

  const archiveProject = async (campaign) => {
    setArchivingId(campaign.id);
    try {
      await axios.post(`/api/campaigns/${campaign.id}/archive`);
      message.success('项目已归档，历史数据已保留');
      await loadData();
      await onChanged?.();
    } catch (error) {
      message.error(error.response?.data?.error || '归档项目失败');
    } finally {
      setArchivingId(null);
    }
  };

  const columns = [
    { title: '项目名称', dataIndex: 'name', key: 'name' },
    { title: '品牌', dataIndex: 'brand', key: 'brand', render: (value) => value || '-' },
    { title: '产品', dataIndex: 'product', key: 'product', render: (value) => value || '-' },
    { title: '周期', dataIndex: 'period', key: 'period', render: (value) => value || '-' },
    {
      title: '状态', dataIndex: 'status', key: 'status',
      render: (value, record) => (
        <Tag color={value === 'archived' || record.campaign_type === 'historical_archive' ? 'default' : 'green'}>
          {value === 'archived' || record.campaign_type === 'historical_archive' ? '已归档' : '进行中'}
        </Tag>
      )
    },
    {
      title: '操作',
      key: 'action',
      width: 180,
      render: (_, record) => {
        const archived = record.status === 'archived' || record.campaign_type === 'historical_archive';
        return archived ? (
          <Button type="link" onClick={() => openEditor(record)}>查看</Button>
        ) : (
          <Space size={0}>
            <Button type="link" icon={<EditOutlined />} onClick={() => openEditor(record)}>编辑</Button>
            <Popconfirm
              title="确定归档该项目？"
              description="项目将移出进行中列表，达人、邮件、视频等历史数据会保留。"
              okText="归档"
              cancelText="取消"
              onConfirm={() => archiveProject(record)}
            >
              <Button type="link" danger icon={<InboxOutlined />} loading={archivingId === record.id}>归档</Button>
            </Popconfirm>
          </Space>
        );
      }
    }
  ];

  return (
    <>
      <Modal title="管理项目" open={open} onCancel={onCancel} footer={null} width={900}>
        <Select
          value={scope}
          onChange={setScope}
          style={{ width: 160, marginBottom: 16 }}
          options={[
            { value: 'active', label: '进行中的项目' },
            { value: 'historical', label: '已归档项目' }
          ]}
        />
        <Table
          rowKey="id"
          columns={columns}
          dataSource={campaigns}
          loading={loading}
          pagination={{ defaultPageSize: 10, showSizeChanger: true }}
        />
      </Modal>
      <Modal
        title={`${editing?.campaign?.status === 'archived' || editing?.campaign?.campaign_type === 'historical_archive' ? '查看' : '编辑'}项目${editing ? `：${editing.campaign.name}` : ''}`}
        open={Boolean(editing)}
        onCancel={() => setEditing(null)}
        onOk={editing?.campaign?.status === 'archived' || editing?.campaign?.campaign_type === 'historical_archive' ? () => setEditing(null) : saveProject}
        confirmLoading={saving}
        okText={editing?.campaign?.status === 'archived' || editing?.campaign?.campaign_type === 'historical_archive' ? '关闭' : '保存'}
        cancelButtonProps={{ style: editing?.campaign?.status === 'archived' || editing?.campaign?.campaign_type === 'historical_archive' ? { display: 'none' } : undefined }}
      >
        <Form form={form} layout="vertical" disabled={editing?.campaign?.status === 'archived' || editing?.campaign?.campaign_type === 'historical_archive'}>
          <Form.Item label="项目名称" name="name" rules={[{ required: true, whitespace: true, message: '请输入项目名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="品牌" name="brand">
            <Input placeholder="请输入项目品牌" />
          </Form.Item>
          <Form.Item label="主推产品/SKU" name="product_id" rules={[{ required: true, message: '请选择主推产品' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              onChange={(productId) => {
                if (form.getFieldValue('brand')?.trim()) return;
                const product = products.find((item) => item.id === productId);
                if (product?.brand) form.setFieldValue('brand', product.brand);
              }}
              options={products.map((item) => ({
                value: item.id,
                label: `${item.sku || item.name} | ${item.name}`
              }))}
            />
          </Form.Item>
          <Form.Item label="项目周期" name="period">
            <Input placeholder="例如：2026 Q3 或 2026-08-01 至 2026-09-30" />
          </Form.Item>
          <Form.Item label="发件邮箱" name="mailbox_id" tooltip="不选则使用默认邮箱">
            <Select
              allowClear
              placeholder="默认邮箱"
              options={mailboxes.map((m) => ({ value: m.id, label: `${m.label || m.username}（${m.username}）` }))}
            />
          </Form.Item>
          <Form.Item label="项目 Brief" name="campaign_brief">
            <TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
};

export default CampaignManageModal;
