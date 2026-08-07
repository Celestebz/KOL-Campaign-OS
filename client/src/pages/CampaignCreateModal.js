import React, { useEffect, useState } from 'react';
import { Form, Input, message, Modal, Select } from 'antd';
import axios from 'axios';
import { getEmailSettings } from './emailApi';

const { TextArea } = Input;

const CampaignCreateModal = ({ open, onCancel, onCreated, createAndContinue = false }) => {
  const [form] = Form.useForm();
  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mailboxes, setMailboxes] = useState([]);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setLoadingProducts(true);
    axios.get('/api/products')
      .then((response) => {
        setProducts((response.data.data || []).filter((item) => item.status !== 'archived'));
      })
      .catch((error) => {
        setProducts([]);
        message.error(error.response?.data?.error || '获取产品列表失败');
      })
      .finally(() => setLoadingProducts(false));
  }, [form, open]);

  useEffect(() => {
    if (!open) return;
    getEmailSettings().then((rows) => setMailboxes((rows || []).filter((m) => m.enabled))).catch(() => {});
  }, [open]);

  const handleSubmit = async () => {
    const values = await form.validateFields();
    const product = products.find((item) => item.id === values.product_id);
    if (!product) {
      message.error('所选产品不存在或已归档');
      return;
    }

    setSubmitting(true);
    try {
      const campaignResponse = await axios.post('/api/campaigns', {
        name: values.name.trim(),
        brand: product.brand || '',
        product: product.name,
        period: values.period?.trim() || '',
        mailbox_id: values.mailbox_id || null
      });
      const campaign = campaignResponse.data.data;

      try {
        await axios.post(`/api/campaigns/${campaign.id}/products`, {
          product_id: product.id,
          role: 'hero',
          priority: 0,
          campaign_brief: values.campaign_brief?.trim() || '',
          status: 'active'
        });
      } catch (error) {
        const detail = error.response?.data?.error || '';
        if (!detail.includes('already attached')) throw error;
      }

      message.success('项目已创建并关联产品');
      form.resetFields();
      await onCreated?.(campaign);
    } catch (error) {
      message.error(error.response?.data?.error || '创建项目失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="新建项目"
      open={open}
      onCancel={onCancel}
      onOk={handleSubmit}
      confirmLoading={submitting}
      okText={createAndContinue ? '创建并加入候选池' : '创建项目'}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Form.Item
          label="项目名称"
          name="name"
          rules={[{ required: true, whitespace: true, message: '请输入项目名称' }]}
        >
          <Input autoFocus placeholder="例如：TMB-1404 达人推广项目" />
        </Form.Item>
        <Form.Item
          label="推广产品/SKU"
          name="product_id"
          rules={[{ required: true, message: '请选择推广产品' }]}
        >
          <Select
            showSearch
            loading={loadingProducts}
            placeholder="请选择产品"
            optionFilterProp="label"
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
          <TextArea rows={4} placeholder="填写本项目的目标、内容要求或补充说明" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default CampaignCreateModal;
