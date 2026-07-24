import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Empty, Form, Input, InputNumber, List,
  message, Modal, Popconfirm, Row, Select, Space, Statistic, Switch, Table, Tabs, Tag, Tooltip
} from 'antd';
import {
  DeleteOutlined, EditOutlined, MailOutlined, PlusOutlined, ReloadOutlined,
  RobotOutlined, SendOutlined, WarningOutlined
} from '@ant-design/icons';
import {
  USE_MOCK,
  getEmailSettings, saveEmailSettings, testEmailSettings,
  getEmailTemplates, getEmailVariables, createEmailTemplate, updateEmailTemplate, deleteEmailTemplate,
  getDrafts, saveDraft, regenerateDraft, approveDraft, rejectDraft, sendDraft,
  getEmailRecords,
  getEmailReplies, confirmReply, ignoreReply, retryReplySummary, draftReply
} from './emailApi';

const { TextArea } = Input;

const INTENT_LABELS = {
  interested: { text: '有意向', color: 'green' },
  question: { text: '询问中', color: 'gold' },
  rejected: { text: '已拒绝', color: 'red' },
  other: { text: '其他', color: 'default' }
};

const AI_STATUS_LABELS = {
  pending: { text: '总结中', color: 'blue' },
  success: { text: '已总结', color: 'green' },
  failed: { text: '总结失败', color: 'red' }
};

const DRAFT_STATUS_LABELS = {
  pending_review: { text: '待审阅', color: 'gold' },
  approved: { text: '已批准', color: 'green' },
  rejected: { text: '已驳回', color: 'red' },
  sent: { text: '已发送', color: 'blue' },
  send_failed: { text: '发送失败', color: 'red' }
};

const DRAFT_KIND_LABELS = {
  first_touch: '首触',
  follow_up: '跟进',
  reply: '回复'
};

const RISK_LABELS = {
  none: { text: '无风险', color: 'default' },
  low: { text: '低风险', color: 'gold' },
  high: { text: '高风险', color: 'red' }
};

// ---- 审批台 ----

function ApprovalTab() {
  const [drafts, setDrafts] = useState([]);
  const [counts, setCounts] = useState({ pending_review: 0, high_risk: 0, approved: 0 });
  const [filters, setFilters] = useState({});
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenFeedback, setRegenFeedback] = useState('');
  const [regenLoading, setRegenLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  const fetchDrafts = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getDrafts(filters);
      setDrafts(data.drafts || []);
      setCounts(data.counts || { pending_review: 0, high_risk: 0, approved: 0 });
      if (selected) {
        const still = (data.drafts || []).find((d) => d.id === selected.id);
        if (still) selectDraft(still);
        else setSelected(null);
      }
    } catch (error) {
      message.error('获取草稿列表失败');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  useEffect(() => { fetchDrafts(); }, [fetchDrafts]);

  const selectDraft = (draft) => {
    setSelected(draft);
    setEditSubject(draft.subject || '');
    setEditBody(draft.body_text || '');
  };

  const handleSave = async () => {
    try {
      await saveDraft(selected.id, { subject: editSubject, body_text: editBody });
      message.success('已保存修改（已留版本）');
      fetchDrafts();
    } catch (error) {
      message.error(error.response?.data?.error || '保存失败');
    }
  };

  const handleRegenerate = async () => {
    setRegenLoading(true);
    try {
      const updated = await regenerateDraft(selected.id, regenFeedback || undefined);
      message.success('已重新生成');
      setRegenOpen(false);
      setRegenFeedback('');
      await fetchDrafts();
      if (updated) selectDraft(updated);
    } catch (error) {
      message.error('重新生成失败');
    } finally {
      setRegenLoading(false);
    }
  };

  const handleApprove = async () => {
    setActionLoading(true);
    try {
      await approveDraft(selected.id);
      message.success('已批准，可以发送');
      fetchDrafts();
    } catch (error) {
      message.error('操作失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    try {
      await rejectDraft(selected.id, rejectReason);
      message.success('已驳回');
      setRejectOpen(false);
      setRejectReason('');
      fetchDrafts();
    } catch (error) {
      message.error('操作失败');
    }
  };

  const handleSend = async () => {
    setActionLoading(true);
    try {
      await sendDraft(selected.id);
      message.success('发送成功，状态已回写');
      fetchDrafts();
    } catch (error) {
      message.error(error.response?.data?.error || '发送失败');
    } finally {
      setActionLoading(false);
    }
  };

  const evidence = selected?.evidence;

  return (
    <>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}><Card><Statistic title="待审阅" value={counts.pending_review} /></Card></Col>
        <Col span={8}><Card><Statistic title="高风险" value={counts.high_risk} valueStyle={{ color: '#cf1322' }} prefix={<WarningOutlined />} /></Card></Col>
        <Col span={8}><Card><Statistic title="已批准待发送" value={counts.approved} valueStyle={{ color: '#3f8600' }} /></Card></Col>
      </Row>

      <Space style={{ marginBottom: 12 }} wrap>
        <Select allowClear placeholder="类型" style={{ width: 120 }}
          value={filters.kind} onChange={(v) => setFilters({ ...filters, kind: v })}
          options={Object.entries(DRAFT_KIND_LABELS).map(([value, label]) => ({ value, label }))} />
        <Select allowClear placeholder="风险" style={{ width: 120 }}
          value={filters.risk_level} onChange={(v) => setFilters({ ...filters, risk_level: v })}
          options={[{ value: 'high', label: '高风险' }, { value: 'low', label: '低风险' }, { value: 'none', label: '无风险' }]} />
        <Select allowClear placeholder="状态" style={{ width: 130 }}
          value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })}
          options={Object.entries(DRAFT_STATUS_LABELS).map(([value, o]) => ({ value, label: o.text }))} />
        <Button icon={<ReloadOutlined />} onClick={fetchDrafts}>刷新</Button>
      </Space>

      <Row gutter={16}>
        <Col span={7}>
          <List
            loading={loading}
            dataSource={drafts}
            locale={{ emptyText: '暂无草稿' }}
            renderItem={(draft) => {
              const risk = RISK_LABELS[draft.risk_level] || RISK_LABELS.none;
              const status = DRAFT_STATUS_LABELS[draft.status] || {};
              return (
                <List.Item
                  onClick={() => selectDraft(draft)}
                  style={{
                    cursor: 'pointer', padding: '10px 12px', display: 'block',
                    background: selected?.id === draft.id ? '#e6f4ff' : undefined,
                    borderLeft: selected?.id === draft.id ? '3px solid #1677ff' : '3px solid transparent'
                  }}
                >
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Space wrap size={[4, 4]}>
                      <strong>{draft.kol_name}</strong>
                      <Tag>{DRAFT_KIND_LABELS[draft.kind] || draft.kind}</Tag>
                      <Tag color={risk.color}>{risk.text}</Tag>
                      <Tag color={status.color}>{status.text}</Tag>
                    </Space>
                    <span style={{ color: '#888', fontSize: 12 }}>{draft.generated_at ? new Date(draft.generated_at).toLocaleString('zh-CN') : ''}</span>
                  </Space>
                </List.Item>
              );
            }}
          />
        </Col>

        <Col span={17}>
          {!selected ? <Empty description="从左侧选择一封草稿" style={{ marginTop: 80 }} /> : (
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              {selected.status === 'pending_review' && (
                <Alert type="warning" showIcon icon={<RobotOutlined />}
                  message="AI 生成，未经人工批准" description="请核对证据面板后再批准；批准后才会进入可发送状态。" />
              )}
              <Input addonBefore="主题" value={editSubject}
                disabled={selected.status !== 'pending_review'}
                onChange={(e) => setEditSubject(e.target.value)} />
              <TextArea rows={8} value={editBody}
                disabled={selected.status !== 'pending_review'}
                onChange={(e) => setEditBody(e.target.value)} />
              <Space wrap>
                {selected.status === 'pending_review' && (
                  <>
                    <Button onClick={handleSave}>保存修改</Button>
                    <Button onClick={() => setRegenOpen(true)}>重新生成</Button>
                    <Button type="primary" loading={actionLoading} onClick={handleApprove}>批准</Button>
                    <Button danger onClick={() => setRejectOpen(true)}>驳回</Button>
                  </>
                )}
                {selected.status === 'approved' && (
                  <Button type="primary" icon={<SendOutlined />} loading={actionLoading} onClick={handleSend}>
                    发送
                  </Button>
                )}
              </Space>

              <Card size="small" title="证据面板">
                {!evidence ? <Empty description="无证据数据" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : (
                  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    <Descriptions size="small" column={4}>
                      <Descriptions.Item label="粉丝">{evidence.metrics?.followers || '-'}</Descriptions.Item>
                      <Descriptions.Item label="近30天均播">{evidence.metrics?.avg_views_30d?.toLocaleString() || '-'}</Descriptions.Item>
                      <Descriptions.Item label="近30天中位播">{evidence.metrics?.median_views_30d?.toLocaleString() || '-'}</Descriptions.Item>
                      <Descriptions.Item label="快照日期">{evidence.snapshot_date || '-'}</Descriptions.Item>
                    </Descriptions>
                    <Table
                      size="small" rowKey="youtube_video_id" pagination={false}
                      dataSource={evidence.videos || []}
                      columns={[
                        { title: '引用视频', dataIndex: 'title', ellipsis: true },
                        { title: '播放', dataIndex: 'views', width: 110, render: (v) => v?.toLocaleString() },
                        { title: '发布日期', dataIndex: 'published_at', width: 110 }
                      ]}
                    />
                    <div><strong>匹配理由：</strong>{evidence.match_reason || '-'}</div>
                    {selected.risk_reasons?.length > 0 && (
                      <Alert type={selected.risk_level === 'high' ? 'error' : 'warning'} showIcon
                        message="风险标记"
                        description={
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {selected.risk_reasons.map((r) => <li key={r.code}><b>{r.code}</b>：{r.message}</li>)}
                          </ul>
                        } />
                    )}
                  </Space>
                )}
              </Card>
            </Space>
          )}
        </Col>
      </Row>

      <Modal title="重新生成草稿" open={regenOpen} onOk={handleRegenerate} confirmLoading={regenLoading}
        onCancel={() => setRegenOpen(false)} okText="重新生成">
        <p>可填写反馈，AI 会据此调整（旧版本会保留在版本历史中）：</p>
        <TextArea rows={3} value={regenFeedback} onChange={(e) => setRegenFeedback(e.target.value)}
          placeholder="例如：去掉金额表述，语气再随意一点" />
      </Modal>

      <Modal title="驳回草稿" open={rejectOpen} onOk={handleReject}
        onCancel={() => setRejectOpen(false)} okText="驳回" okButtonProps={{ danger: true }}>
        <p>请填写驳回原因：</p>
        <TextArea rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
      </Modal>
    </>
  );
}

// ---- 发送记录 ----

function RecordsTab() {
  const [data, setData] = useState({ records: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState();

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getEmailRecords(status));
    } catch (error) {
      message.error('获取发送记录失败');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { fetchRecords(); }, [fetchRecords]);

  const columns = [
    { title: 'KOL', dataIndex: 'kol_name', width: 140 },
    { title: '收件人', dataIndex: 'to_address', width: 200, render: (v) => v || '-' },
    { title: '主题', dataIndex: 'subject', ellipsis: true },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (v, record) => (
        <Tooltip title={record.error || ''}>
          <Tag color={v === 'success' ? 'green' : 'red'}>{v === 'success' ? '成功' : '失败'}</Tag>
        </Tooltip>
      )
    },
    { title: '发送时间', dataIndex: 'created_at', width: 160,
      render: (v) => (v ? new Date(v).toLocaleString('zh-CN') : '-') }
  ];

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Select allowClear placeholder="全部状态" style={{ width: 140 }} value={status} onChange={setStatus}
          options={[{ value: 'success', label: '成功' }, { value: 'failed', label: '失败' }]} />
        <Button icon={<ReloadOutlined />} onClick={fetchRecords}>刷新</Button>
      </Space>
      <Table rowKey="id" loading={loading} columns={columns} dataSource={data.records} />
    </>
  );
}

// ---- 回复待确认 ----

function RepliesTab() {
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [editedSummary, setEditedSummary] = useState('');

  const fetchReplies = useCallback(async () => {
    setLoading(true);
    try {
      setReplies(await getEmailReplies('pending'));
    } catch (error) {
      message.error('获取回复列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchReplies(); }, [fetchReplies]);

  const openConfirm = (record) => {
    setConfirming(record);
    setEditedSummary(record.ai_summary || '');
  };

  const handleConfirm = async () => {
    try {
      await confirmReply(confirming.id, editedSummary);
      message.success('已确认，状态将同步到飞书');
      setConfirming(null);
      fetchReplies();
    } catch (error) {
      message.error(error.response?.data?.error || '确认失败');
    }
  };

  const handleIgnore = async (record) => {
    try {
      await ignoreReply(record.id);
      message.success('已忽略');
      fetchReplies();
    } catch (error) {
      message.error('操作失败');
    }
  };

  const handleRetry = async (record) => {
    try {
      await retryReplySummary(record.id);
      message.success('已重新总结');
      fetchReplies();
    } catch (error) {
      message.error('重试失败');
    }
  };

  const handleDraftReply = async (record) => {
    try {
      await draftReply(record.id);
      message.success('已生成回复草稿，请到审批台审阅');
    } catch (error) {
      message.error('生成回复草稿失败');
    }
  };

  const columns = [
    { title: 'KOL', dataIndex: 'kol_name', width: 140 },
    { title: '项目', dataIndex: 'campaign_name', width: 160 },
    { title: '回复时间', dataIndex: 'received_at', width: 160,
      render: (v) => (v ? new Date(v).toLocaleString('zh-CN') : '-') },
    { title: '主题', dataIndex: 'subject', width: 180, ellipsis: true },
    {
      title: 'AI 摘要', dataIndex: 'ai_summary', ellipsis: true,
      render: (v, record) => {
        const ai = AI_STATUS_LABELS[record.ai_status] || {};
        if (record.ai_status === 'failed') {
          return <Space><Tag color={ai.color}>{ai.text}</Tag><Button type="link" size="small" onClick={() => handleRetry(record)}>重试</Button></Space>;
        }
        return v || <Tag color={ai.color}>{ai.text}</Tag>;
      }
    },
    {
      title: '意向', dataIndex: 'ai_intent', width: 90,
      render: (v) => {
        const intent = INTENT_LABELS[v];
        return intent ? <Tag color={intent.color}>{intent.text}</Tag> : '-';
      }
    },
    {
      title: '操作', width: 260, render: (_, record) => (
        <Space size={0}>
          <Button type="link" size="small" onClick={() => openConfirm(record)}>确认</Button>
          <Button type="link" size="small" icon={<MailOutlined />} onClick={() => handleDraftReply(record)}>回复草稿</Button>
          <Popconfirm title="忽略这条回复？" onConfirm={() => handleIgnore(record)}>
            <Button type="link" size="small" danger>忽略</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <>
      <Button icon={<ReloadOutlined />} onClick={fetchReplies} style={{ marginBottom: 12 }}>刷新</Button>
      <Table
        rowKey="id" loading={loading} columns={columns} dataSource={replies}
        expandable={{
          expandedRowRender: (record) => (
            <div style={{ whiteSpace: 'pre-wrap' }}>{record.body_text || '（无正文）'}</div>
          )
        }}
      />
      <Modal
        title={`确认回复 - ${confirming?.kol_name || ''}`}
        open={Boolean(confirming)} onOk={handleConfirm} onCancel={() => setConfirming(null)}
        okText="确认并更新状态" width={640}
      >
        <p>确认后将按意向更新外联状态，并把摘要写入跟进记录、同步飞书。可修改摘要：</p>
        <TextArea rows={4} value={editedSummary} onChange={(e) => setEditedSummary(e.target.value)} />
      </Modal>
    </>
  );
}

// ---- 模板与口径 ----

const TEMPLATE_KIND_LABELS = {
  style_guide: { text: '写作规范', color: 'purple' },
  fixed: { text: '固定模板', color: 'default' }
};

function TemplatesTab() {
  const [templates, setTemplates] = useState([]);
  const [variables, setVariables] = useState({});
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();
  const templateKind = Form.useWatch('kind', form);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const [tpls, vars] = await Promise.all([getEmailTemplates(), getEmailVariables()]);
      setTemplates(tpls);
      setVariables(vars);
    } catch (error) {
      message.error('获取模板失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const openEdit = (record) => {
    setEditing(record || null);
    form.setFieldsValue(record || { name: '', kind: 'style_guide', subject: '', body_html: '' });
    setModalOpen(true);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    try {
      if (editing) {
        await updateEmailTemplate(editing.id, values);
        message.success('模板已更新');
      } else {
        await createEmailTemplate(values);
        message.success('模板已创建');
      }
      setModalOpen(false);
      fetchTemplates();
    } catch (error) {
      message.error(error.response?.data?.error || '保存失败');
    }
  };

  const handleDelete = async (record) => {
    try {
      await deleteEmailTemplate(record.id);
      message.success('已删除');
      fetchTemplates();
    } catch (error) {
      message.error('删除失败');
    }
  };

  const columns = [
    { title: '名称', dataIndex: 'name', width: 240 },
    { title: '类型', dataIndex: 'kind', width: 110,
      render: (v) => {
        const kind = TEMPLATE_KIND_LABELS[v] || {};
        return <Tag color={kind.color}>{kind.text || v}</Tag>;
      } },
    { title: '主题/内容', dataIndex: 'subject', ellipsis: true,
      render: (v, record) => v || <span style={{ color: '#888' }}>{(record.body_html || '').slice(0, 60)}...</span> },
    {
      title: '操作', width: 150, render: (_, record) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
          <Popconfirm title="删除该模板？" onConfirm={() => handleDelete(record)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit(null)} style={{ marginBottom: 12 }}>
        新建模板
      </Button>
      <Table rowKey="id" loading={loading} columns={columns} dataSource={templates} />
      <Modal
        title={editing ? '编辑模板' : '新建模板'}
        open={modalOpen} onOk={handleSave} onCancel={() => setModalOpen(false)}
        width={720} okText="保存"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="模板名称" rules={[{ required: true, message: '必填' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="kind" label="类型" rules={[{ required: true }]}
            extra="写作规范：指导 AI 起草的口径与风格约束；固定模板：变量填充，用于无需个性化的场景">
            <Select options={[
              { value: 'style_guide', label: '写作规范（AI 起草用）' },
              { value: 'fixed', label: '固定模板（变量填充）' }
            ]} />
          </Form.Item>
          {templateKind !== 'style_guide' && (
            <Form.Item name="subject" label="邮件主题">
              <Input placeholder="支持变量，如：Re: {{campaign_name}}" />
            </Form.Item>
          )}
          <Form.Item name="body_html" label={templateKind === 'style_guide' ? '写作规范内容' : '邮件正文 (HTML)'}
            rules={[{ required: true, message: '必填' }]}>
            <TextArea rows={10} />
          </Form.Item>
          {templateKind !== 'style_guide' && (
            <div style={{ color: '#888' }}>
              可用变量：
              {Object.entries(variables).map(([key, label]) => (
                <Tag key={key}>{`{{${key}}} ${label}`}</Tag>
              ))}
            </div>
          )}
        </Form>
      </Modal>
    </>
  );
}

// ---- 邮箱配置 ----

function SettingsTab() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      const data = await getEmailSettings();
      if (data) form.setFieldsValue(data);
    } catch (error) {
      message.error('获取邮箱设置失败');
    }
  }, [form]);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const handleSave = async () => {
    const values = await form.validateFields();
    setLoading(true);
    try {
      await saveEmailSettings(values);
      message.success('邮箱设置已保存');
    } catch (error) {
      message.error(error.response?.data?.error || '保存失败');
    } finally {
      setLoading(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const msg = await testEmailSettings();
      message.success(msg || 'SMTP 连接成功');
    } catch (error) {
      message.error(error.response?.data?.error || '连接失败');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card title="企业邮箱配置" style={{ maxWidth: 760 }}>
      <Form form={form} layout="vertical">
        <Form.Item name="smtp_host" label="SMTP 服务器" rules={[{ required: true, message: '必填' }]}>
          <Input placeholder="如 smtp.qiye.aliyun.com" />
        </Form.Item>
        <Space size="large">
          <Form.Item name="smtp_port" label="SMTP 端口" initialValue={465}>
            <InputNumber min={1} max={65535} />
          </Form.Item>
          <Form.Item name="smtp_secure" label="SMTP SSL" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Space>
        <Form.Item name="imap_host" label="IMAP 服务器（用于回复追踪）">
          <Input placeholder="如 imap.qiye.aliyun.com" />
        </Form.Item>
        <Space size="large">
          <Form.Item name="imap_port" label="IMAP 端口" initialValue={993}>
            <InputNumber min={1} max={65535} />
          </Form.Item>
          <Form.Item name="imap_secure" label="IMAP TLS" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
          <Form.Item name="poll_interval_minutes" label="轮询间隔（分钟，0 关闭）" initialValue={5}>
            <InputNumber min={0} max={120} />
          </Form.Item>
        </Space>
        <Form.Item name="username" label="邮箱账号" rules={[{ required: true, message: '必填' }]}>
          <Input placeholder="you@company.com" />
        </Form.Item>
        <Form.Item name="password" label="授权码 / 三方客户端安全密码">
          <Input.Password placeholder="阿里邮箱建议填三方客户端安全密码" />
        </Form.Item>
        <Form.Item name="sender_name" label="发件人显示名">
          <Input placeholder="如 MOOER Marketing" />
        </Form.Item>
        <Form.Item name="default_cc" label="默认抄送">
          <TextArea rows={2} placeholder="多个地址用逗号/分号/换行分隔" />
        </Form.Item>
        <Space>
          <Button type="primary" loading={loading} onClick={handleSave}>保存</Button>
          <Button loading={testing} onClick={handleTest}>测试 SMTP 连接</Button>
        </Space>
      </Form>
    </Card>
  );
}

function Emails() {
  return (
    <Card title="邮件中心">
      {USE_MOCK && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message="当前为 UI 预览模式，展示的是内置假数据，操作不会真实发送或保存。" />
      )}
      <Tabs
        defaultActiveKey="approval"
        items={[
          { key: 'approval', label: '审批台', children: <ApprovalTab /> },
          { key: 'records', label: '发送记录', children: <RecordsTab /> },
          { key: 'replies', label: '回复待确认', children: <RepliesTab /> },
          { key: 'templates', label: '模板与口径', children: <TemplatesTab /> },
          { key: 'settings', label: '邮箱配置', children: <SettingsTab /> }
        ]}
      />
    </Card>
  );
}

export default Emails;
