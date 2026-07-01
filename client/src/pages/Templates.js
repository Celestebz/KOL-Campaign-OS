import React, { useEffect, useState } from 'react';
import { Button, Card, Form, Input, message, Modal, Popconfirm, Select, Space, Switch, Table, Tag } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import axios from 'axios';

const { TextArea } = Input;

const DEFAULT_SYSTEM_PROMPT = 'You are a senior KOL marketing analyst. Return valid JSON only. Do not include Markdown, explanations, or chain-of-thought. The system is brand-agnostic: never assume the target brand is MOOER or any fixed brand unless it is provided in the campaign context.';
const DEFAULT_USER_PROMPT = 'Analyze the video performance metrics and comments for KOL marketing value. Consider creator/category fit, audience feedback, purchase intent, brand or category mentions, collaboration risks, product feedback, cooperation advice, and content optimization suggestions. If a target brand or product is configured, evaluate fit against it; otherwise evaluate the video generically for its apparent category. Return all required fields.';

const Templates = () => {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    setLoading(true);
    try {
      const response = await axios.get('/api/prompt-templates');
      setTemplates(response.data.data || []);
    } catch (error) {
      message.error('获取 Prompt 模板失败');
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = () => {
    setEditingTemplate(null);
    form.resetFields();
    form.setFieldsValue({
      platform: 'all',
      is_default: false,
      system_prompt: DEFAULT_SYSTEM_PROMPT,
      user_prompt: DEFAULT_USER_PROMPT
    });
    setModalVisible(true);
  };

  const handleEdit = (record) => {
    setEditingTemplate(record);
    form.setFieldsValue({ ...record, is_default: Boolean(record.is_default) });
    setModalVisible(true);
  };

  const handleDelete = async (id) => {
    await axios.delete(`/api/prompt-templates/${id}`);
    message.success('删除成功');
    fetchTemplates();
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    if (editingTemplate) {
      await axios.put(`/api/prompt-templates/${editingTemplate.id}`, values);
      message.success('更新成功');
    } else {
      await axios.post('/api/prompt-templates', values);
      message.success('创建成功');
    }
    setModalVisible(false);
    fetchTemplates();
  };

  const columns = [
    { title: '模板名称', dataIndex: 'name', key: 'name' },
    { title: '平台', dataIndex: 'platform', key: 'platform', width: 120, render: (v) => <Tag>{v || 'all'}</Tag> },
    { title: '默认', dataIndex: 'is_default', key: 'is_default', width: 100, render: (v) => v ? <Tag color="green">默认</Tag> : '-' },
    { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', width: 180, render: (v) => v ? new Date(v).toLocaleString() : '-' },
    {
      title: '操作',
      key: 'action',
      width: 180,
      render: (_, record) => (
        <Space>
          <Button type="link" icon={<EditOutlined />} onClick={() => handleEdit(record)}>编辑</Button>
          <Popconfirm title="确定删除这个模板？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">AI Prompt 模板</h1>
      </div>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新建 Prompt 模板</Button>
      </Card>

      <Card className="content-card">
        <Table columns={columns} dataSource={templates} rowKey="id" loading={loading} />
      </Card>

      <Modal
        title={editingTemplate ? '编辑 Prompt 模板' : '新建 Prompt 模板'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={handleSubmit}
        width={860}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="模板名称" name="name" rules={[{ required: true, message: '请输入模板名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="平台" name="platform">
            <Select options={[
              { value: 'all', label: 'all' },
              { value: 'youtube', label: 'youtube' },
              { value: 'instagram', label: 'instagram' },
              { value: 'tiktok', label: 'tiktok' }
            ]} />
          </Form.Item>
          <Form.Item label="系统 Prompt" name="system_prompt">
            <TextArea rows={3} />
          </Form.Item>
          <Form.Item label="分析任务 Prompt" name="user_prompt" rules={[{ required: true, message: '请输入分析任务 Prompt' }]}>
            <TextArea rows={5} />
          </Form.Item>
          <Form.Item label="品牌关键词" name="brand_keywords">
            <TextArea rows={2} placeholder="逗号或换行分隔" />
          </Form.Item>
          <Form.Item label="购买意向关键词" name="purchase_keywords">
            <TextArea rows={2} placeholder="price, how much, link, 在哪买..." />
          </Form.Item>
          <Form.Item label="负面风险关键词" name="negative_keywords">
            <TextArea rows={2} placeholder="fake, bad, expensive, 质量差..." />
          </Form.Item>
          <Form.Item label="设为默认" name="is_default" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Templates;
