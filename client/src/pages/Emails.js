import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Empty, Form, Input, InputNumber, List,
  message, Modal, Popconfirm, Radio, Row, Select, Space, Statistic, Switch, Table, Tabs, Tag, Tooltip
} from 'antd';
import {
  CopyOutlined, DeleteOutlined, EditOutlined, MailOutlined, PlusOutlined, ReloadOutlined,
  RobotOutlined, SendOutlined
} from '@ant-design/icons';
import axios from 'axios';
import {
  getEmailSettings, saveEmailSettings, testEmailSettings, testImapSettings, syncEmailNow, getEmailSyncStatus,
  getEmailTemplates, getEmailVariables, createEmailTemplate, updateEmailTemplate, deleteEmailTemplate,
  getDrafts, saveDraft, regenerateDraft, approveDraft, rejectDraft, sendDraft, confirmManualSent, confirmNotSent,
  getEmailRecords,
  getReplyTodos, getUnmatchedReplies, bindReply, confirmReply, ignoreReply, markReplyManuallyHandled, retryReplySummary, draftReply,
  getApprovalDashboardSummary
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
  sending: { text: '发送中', color: 'processing' },
  rejected: { text: '已驳回', color: 'red' },
  sent: { text: '已发送', color: 'blue' },
  send_failed: { text: '发送失败', color: 'red' },
  send_unknown: { text: '发送结果待确认', color: 'orange' }
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

// 顶部指标卡渲染辅助：数字为 null 时显示 —；分母 0 时回复率也显示 —。
const EMPTY_DASHBOARD_SUMMARY = {
  todayContactedKols: null,
  weekContactedKols: null,
  previousWeekContactedKols: null,
  weekDifference: null,
  replyRate30d: null,
  repliedKols30d: null,
  deliveredKols30d: null,
  denominatorType: 'sent_success'
};

// 数字 / 百分比渲染：null/undefined 一律显示 —；分母为 0 时回复率显示 —。
function formatMetric(value, { percent = false } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (percent) return `${value}%`;
  return String(value);
}

// 副标题中分子 / 分母文字：分母为 0 时显示 —（避免出现 "0人回复 / 0人发送成功"）。
function formatRatioCounts({ replied, delivered }) {
  const repliedText = (replied === null || replied === undefined) ? '—' : `${replied}`;
  const deliveredText = (delivered === null || delivered === undefined || delivered === 0) ? '—' : `${delivered}`;
  return `${repliedText}人回复 / ${deliveredText}人发送成功`;
}

// "较上周 +9" / "较上周 -6" / "与上周持平"。三者优先级：持平 > 上升 > 下降。
function formatWeekDifference(difference) {
  if (difference === null || difference === undefined || Number.isNaN(difference)) return null;
  if (difference === 0) return '与上周持平';
  if (difference > 0) return `较上周 +${difference}`;
  return `较上周 ${difference}`;
}

function ApprovalTab() {
  const [drafts, setDrafts] = useState([]);
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
  const [dashboard, setDashboard] = useState(EMPTY_DASHBOARD_SUMMARY);
  const [dashboardLoading, setDashboardLoading] = useState(true);

  const fetchDrafts = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getDrafts(filters);
      setDrafts(data.drafts || []);
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

  // 顶部指标独立拉取：失败不影响审批列表；骨架屏期间显示占位。
  const fetchDashboard = useCallback(async () => {
    setDashboardLoading(true);
    try {
      const summary = await getApprovalDashboardSummary();
      setDashboard(summary);
    } catch (error) {
      // 静默降级：单卡失败时显示 —，不打断审批台
      setDashboard(EMPTY_DASHBOARD_SUMMARY);
    } finally {
      setDashboardLoading(false);
    }
  }, []);

  useEffect(() => { fetchDrafts(); }, [fetchDrafts]);
  useEffect(() => { fetchDashboard(); }, [fetchDashboard]);

  // 审批动作完成后顺带刷新指标，保持"今日/本周"数字与最新外联状态同步。
  const refreshAll = useCallback(() => {
    fetchDrafts();
    fetchDashboard();
  }, [fetchDrafts, fetchDashboard]);

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
      message.success('邮件已发送，外联状态已同步');
      refreshAll();
    } catch (error) {
      message.error(error.response?.data?.error || (error.code === 'ECONNABORTED'
        ? '发送请求超时，请先检查邮箱发件箱，切勿重复点击发送'
        : `发送失败：${error.message || '未知错误'}`));
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
      refreshAll();
    } catch (error) {
      message.error(error.response?.data?.error || '发送失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleConfirmManualSent = async () => {
    setActionLoading(true);
    try {
      await confirmManualSent(selected.id);
      message.success('已标记为手动发送，外联状态已同步');
      refreshAll();
    } catch (error) {
      message.error(error.response?.data?.error || '标记失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleConfirmNotSent = async () => {
    setActionLoading(true);
    try {
      await confirmNotSent(selected.id);
      message.success('已恢复为待审阅');
      fetchDrafts();
    } catch (error) {
      message.error(error.response?.data?.error || '恢复失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCopyRecipient = async () => {
    if (!selected?.recipient_email) return;
    try {
      await navigator.clipboard.writeText(selected.recipient_email);
      message.success('收件人邮箱已复制');
    } catch (error) {
      message.error('复制失败，请手动选择邮箱地址');
    }
  };

  const evidence = selected?.evidence;

  const weekDeltaText = formatWeekDifference(dashboard.weekDifference);
  const replyRateText = formatMetric(dashboard.replyRate30d, { percent: true });

  return (
    <>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card>
            <Statistic
              title="今日联络 KOL"
              value={dashboardLoading ? '—' : formatMetric(dashboard.todayContactedKols)}
              loading={dashboardLoading}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="本周联络 KOL"
              value={dashboardLoading ? '—' : formatMetric(dashboard.weekContactedKols)}
              loading={dashboardLoading}
            />
            {!dashboardLoading && weekDeltaText && (
              <div style={{ color: dashboard.weekDifference > 0 ? '#3f8600' : (dashboard.weekDifference < 0 ? '#cf1322' : '#8c8c8c'), marginTop: 4 }}>
                {weekDeltaText}
              </div>
            )}
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="30天回复率"
              value={dashboardLoading ? '—' : replyRateText}
              loading={dashboardLoading}
            />
            {!dashboardLoading && (
              <div style={{ color: '#8c8c8c', marginTop: 4, fontSize: 12 }}>
                {formatRatioCounts({ replied: dashboard.repliedKols30d, delivered: dashboard.deliveredKols30d })}
              </div>
            )}
          </Card>
        </Col>
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
                  message="AI 生成，尚未发送" description="请先核对收件人、主题和正文。点击“发送”即代表批准，邮件会立即对外发送。" />
              )}
              {selected.status === 'sending' && (
                <Alert type="warning" showIcon message="邮件正在发送或上次发送未正常结束"
                  description="为避免重复投递，请先检查邮箱发件箱；确认未发出后再联系管理员处理。" />
              )}
              {selected.status === 'send_unknown' && (
                <Alert type="warning" showIcon message="发送结果待确认"
                  description="SMTP 未返回明确结果。请先检查邮箱发件箱，系统不会自动重发。" />
              )}
              {!selected.recipient_email && (
                <Alert type="error" showIcon message="未配置收件人邮箱"
                  description="请先在 KOL 管理中补充邮箱地址，系统发送已禁用。" />
              )}
              <Input
                addonBefore="收件人"
                value={selected.recipient_email || ''}
                readOnly
                placeholder="未配置收件人邮箱"
                addonAfter={(
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    disabled={!selected.recipient_email}
                    onClick={handleCopyRecipient}
                  >
                    复制
                  </Button>
                )}
              />
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
                    <Popconfirm
                      title="确认立即发送这封邮件？"
                      description="点击确认后，邮件将立即对外发送，且无法撤回。"
                      okText="确认发送"
                      cancelText="取消"
                      onConfirm={handleApprove}
                    >
                      <Button type="primary" icon={<SendOutlined />} loading={actionLoading}
                        disabled={!selected.recipient_email}>发送</Button>
                    </Popconfirm>
                    <Button danger onClick={() => setRejectOpen(true)}>驳回</Button>
                  </>
                )}
                {selected.status === 'approved' && (
                  <Button type="primary" icon={<SendOutlined />} loading={actionLoading}
                    disabled={!selected.recipient_email} onClick={handleSend}>
                    发送
                  </Button>
                )}
                {selected.status === 'send_failed' && (
                  <Popconfirm
                    title="确认重新发送这封邮件？"
                    description="仅在确认上一轮没有发送成功后重试，以免重复投递。"
                    okText="确认重发"
                    cancelText="取消"
                    onConfirm={handleSend}
                  >
                    <Button type="primary" icon={<SendOutlined />} loading={actionLoading}
                      disabled={!selected.recipient_email}>重新发送</Button>
                  </Popconfirm>
                )}
                {['sending', 'send_unknown'].includes(selected.status) && (
                  <>
                    <Popconfirm
                      title="确认已通过网页邮箱发送？"
                      description="确认后系统将标记为已发送，并同步外联状态。"
                      okText="确认已发送"
                      cancelText="取消"
                      onConfirm={handleConfirmManualSent}
                    >
                      <Button type="primary" loading={actionLoading}>确认已手动发送</Button>
                    </Popconfirm>
                    <Popconfirm
                      title="确认这封邮件没有发出？"
                      description="确认后草稿将恢复为待审阅，可重新编辑或发送。"
                      okText="确认未发送"
                      cancelText="取消"
                      onConfirm={handleConfirmNotSent}
                    >
                      <Button loading={actionLoading}>确认未发送</Button>
                    </Popconfirm>
                  </>
                )}
              </Space>

              <Card size="small" title="证据面板">
                {!evidence ? <Empty description="无证据数据" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : (
                  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    <Descriptions size="small" column={4}>
                      <Descriptions.Item label="粉丝">{evidence.metrics?.followers || '-'}</Descriptions.Item>
                      <Descriptions.Item label="近30天均播">{evidence.metrics?.avg_views_30d?.toLocaleString() || '-'}</Descriptions.Item>
                      <Descriptions.Item label="近30天中位播">{evidence.metrics?.median_views_30d?.toLocaleString() || '-'}</Descriptions.Item>
                      <Descriptions.Item label={evidence.platform && evidence.platform !== 'youtube' ? '最新视频日期' : '快照日期'}>{evidence.snapshot_date || '-'}</Descriptions.Item>
                    </Descriptions>
                    <Table
                      size="small" rowKey={(v) => v.video_id || v.youtube_video_id} pagination={false}
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
  const [viewMode, setViewMode] = useState('pending'); // pending=待确认；unmatched=未识别回复
  const [binding, setBinding] = useState(null);
  const [bindCustomerId, setBindCustomerId] = useState(null);
  const [bindOptions, setBindOptions] = useState([]);
  const [bindSearching, setBindSearching] = useState(false);
  const [bindSaving, setBindSaving] = useState(false);
  const prevCountRef = useRef(null);

  const fetchReplies = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const rows = viewMode === 'unmatched' ? await getUnmatchedReplies() : await getReplyTodos();
      if (viewMode === 'pending' && prevCountRef.current !== null && rows.length > prevCountRef.current) {
        message.info(`收到 ${rows.length - prevCountRef.current} 条新回复`);
      }
      prevCountRef.current = rows.length;
      setReplies(rows);
    } catch (error) {
      if (!silent) message.error('获取回复列表失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [viewMode]);

  useEffect(() => { fetchReplies(); }, [fetchReplies]);

  // 邮件中心打开时每 10 秒静默刷新（准实时收信的页面侧配套，第一轮不上 SSE）
  useEffect(() => {
    const timer = setInterval(() => fetchReplies({ silent: true }), 10000);
    return () => clearInterval(timer);
  }, [fetchReplies]);

  const changeView = (event) => {
    prevCountRef.current = null;
    setViewMode(event.target.value);
  };

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

  const handleManuallyReplied = async (record) => {
    try {
      await markReplyManuallyHandled(record.id);
      message.success('已记录为人工回复，邮件待办已完成');
      fetchReplies();
    } catch (error) {
      message.error(error.response?.data?.error || '操作失败');
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

  const searchKols = useCallback(async (keyword) => {
    setBindSearching(true);
    try {
      const res = await axios.get('/api/customers', { params: keyword ? { search: keyword } : {} });
      setBindOptions((res.data.data || []).slice(0, 50).map((kol) => ({
        value: kol.id,
        label: `${kol.name || '未命名'}${kol.email ? `（${kol.email}）` : ''}`
      })));
    } catch (error) {
      message.error('搜索 KOL 失败');
    } finally {
      setBindSearching(false);
    }
  }, []);

  const openBind = (record) => {
    setBinding(record);
    setBindCustomerId(null);
    searchKols('');
  };

  const handleBind = async () => {
    if (!bindCustomerId) {
      message.warning('请选择要绑定的 KOL');
      return;
    }
    setBindSaving(true);
    try {
      await bindReply(binding.id, bindCustomerId);
      message.success('已绑定 KOL，AI 摘要生成中');
      setBinding(null);
      fetchReplies();
    } catch (error) {
      message.error(error.response?.data?.error || '绑定失败');
    } finally {
      setBindSaving(false);
    }
  };

  const pendingColumns = [
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
          return <Space><Tooltip title={record.ai_error || '暂无详细错误'}><Tag color={ai.color}>{ai.text}</Tag></Tooltip><Button type="link" size="small" onClick={() => handleRetry(record)}>重试</Button></Space>;
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
      title: '操作', width: 360, render: (_, record) => (
        <Space size={0}>
          {record.confirm_status === 'pending'
            ? <Button type="link" size="small" onClick={() => openConfirm(record)}>确认意向</Button>
            : <Tag color="green">意向已确认</Tag>}
          <Button type="link" size="small" icon={<MailOutlined />} onClick={() => handleDraftReply(record)}>回复草稿</Button>
          <Popconfirm
            title="确认已经通过外部邮箱回复该达人？"
            description="系统只记录完成状态，不会发送邮件。"
            okText="确认已回复"
            cancelText="取消"
            onConfirm={() => handleManuallyReplied(record)}
          >
            <Button type="link" size="small">已人工回复</Button>
          </Popconfirm>
          <Popconfirm title="忽略这条回复？" onConfirm={() => handleIgnore(record)}>
            <Button type="link" size="small" danger>忽略</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  const unmatchedColumns = [
    { title: '发件人', dataIndex: 'from_address', width: 220, render: (v) => v || '-' },
    { title: '收到时间', dataIndex: 'received_at', width: 160,
      render: (v) => (v ? new Date(v).toLocaleString('zh-CN') : '-') },
    { title: '主题', dataIndex: 'subject', width: 220, ellipsis: true },
    {
      title: '操作', width: 180, render: (_, record) => (
        <Space size={0}>
          <Button type="link" size="small" onClick={() => openBind(record)}>绑定 KOL</Button>
          <Popconfirm title="忽略这条回复？" onConfirm={() => handleIgnore(record)}>
            <Button type="link" size="small" danger>忽略</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="邮件待办"
        description="这里集中显示当前轮到我方处理的 KOL 来信；确认意向不会清除待办。通过系统发送回复，或标记“已人工回复”后，待办才会完成。"
      />
      <Space style={{ marginBottom: 12 }} wrap>
        <Radio.Group
          value={viewMode}
          onChange={changeView}
          options={[
            { value: 'pending', label: '待回复' },
            { value: 'unmatched', label: '未识别回复' }
          ]}
          optionType="button"
        />
        <Button icon={<ReloadOutlined />} onClick={() => fetchReplies()}>刷新</Button>
      </Space>
      <Table
        rowKey="id" loading={loading} columns={viewMode === 'unmatched' ? unmatchedColumns : pendingColumns} dataSource={replies}
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
      <Modal
        title={`绑定 KOL - ${binding?.from_address || ''}`}
        open={Boolean(binding)} onOk={handleBind} onCancel={() => setBinding(null)}
        okText="绑定" confirmLoading={bindSaving} width={520}
      >
        <p>把这条回复归属到一个 KOL，项目默认取该 KOL 最近的项目关系，绑定后自动生成 AI 摘要：</p>
        <Select
          showSearch
          filterOption={false}
          onSearch={searchKols}
          loading={bindSearching}
          value={bindCustomerId}
          onChange={setBindCustomerId}
          options={bindOptions}
          placeholder="输入名称或邮箱搜索 KOL"
          style={{ width: '100%' }}
        />
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

const SYNC_STATUS_LABELS = {
  connected: { text: '已连接', color: 'green' },
  connecting: { text: '连接中', color: 'gold' },
  reconnecting: { text: '重连中', color: 'orange' },
  failed: { text: '连接失败', color: 'red' },
  off: { text: '已关闭', color: 'default' }
};

const SYNC_MODE_LABELS = { idle: '实时监听（推荐）', poll: '定时轮询', off: '关闭回复同步' };

const formatSyncTime = (value) => (value ? new Date(value).toLocaleString('zh-CN') : '-');

function SettingsTab() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingImap, setTestingImap] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);
  const syncMode = Form.useWatch('sync_mode', form);

  const fetchSettings = useCallback(async () => {
    try {
      const data = await getEmailSettings();
      if (data) form.setFieldsValue(data);
    } catch (error) {
      message.error('获取邮箱设置失败');
    }
  }, [form]);

  const fetchSyncStatus = useCallback(async () => {
    try {
      setSyncStatus(await getEmailSyncStatus());
    } catch (error) {
      // 状态接口失败不影响配置页
    }
  }, []);

  useEffect(() => { fetchSettings(); fetchSyncStatus(); }, [fetchSettings, fetchSyncStatus]);

  // 收信状态每 15 秒刷新一次
  useEffect(() => {
    const timer = setInterval(fetchSyncStatus, 15000);
    return () => clearInterval(timer);
  }, [fetchSyncStatus]);

  const handleSave = async () => {
    const values = await form.validateFields();
    setLoading(true);
    try {
      await saveEmailSettings(values);
      message.success('邮箱设置已保存，收信监听已重启');
      setTimeout(fetchSyncStatus, 1500);
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

  const handleTestImap = async () => {
    setTestingImap(true);
    try {
      const msg = await testImapSettings();
      message.success(msg || 'IMAP 连接成功');
    } catch (error) {
      message.error(error.response?.data?.error || 'IMAP 连接失败');
    } finally {
      setTestingImap(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const msg = await syncEmailNow();
      message.success(msg || '同步完成');
      fetchSyncStatus();
    } catch (error) {
      message.error(error.response?.data?.error || '同步失败');
    } finally {
      setSyncing(false);
    }
  };

  const statusLabel = SYNC_STATUS_LABELS[syncStatus?.status] || { text: syncStatus?.status || '-', color: 'default' };

  return (
    <div style={{ maxWidth: 760 }}>
      <Card title="企业邮箱配置">
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
          <Space size="large" wrap>
            <Form.Item name="imap_port" label="IMAP 端口" initialValue={993}>
              <InputNumber min={1} max={65535} />
            </Form.Item>
            <Form.Item name="imap_secure" label="IMAP TLS" valuePropName="checked" initialValue={true}>
              <Switch />
            </Form.Item>
            <Form.Item name="sync_mode" label="收信模式" initialValue="idle">
              <Select style={{ width: 180 }} options={[
                { value: 'idle', label: '实时监听（推荐）' },
                { value: 'poll', label: '定时轮询' },
                { value: 'off', label: '关闭回复同步' }
              ]} />
            </Form.Item>
            {(syncMode || 'idle') === 'poll' && (
              <Form.Item name="poll_interval_minutes" label="轮询间隔（分钟）" initialValue={5}>
                <InputNumber min={1} max={120} />
              </Form.Item>
            )}
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
          <Space wrap>
            <Button type="primary" loading={loading} onClick={handleSave}>保存</Button>
            <Button loading={testing} onClick={handleTest}>测试 SMTP 连接</Button>
            <Button loading={testingImap} onClick={handleTestImap}>测试 IMAP</Button>
            <Button loading={syncing} onClick={handleSyncNow}>立即同步一次</Button>
          </Space>
        </Form>
      </Card>
      <Card title="收信状态" size="small" style={{ marginTop: 16 }}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="收信模式">{SYNC_MODE_LABELS[syncStatus?.mode] || syncStatus?.mode || '-'}</Descriptions.Item>
          <Descriptions.Item label="连接状态">
            <Tag color={statusLabel.color}>{statusLabel.text}</Tag>
            {syncStatus?.reconnect_attempts > 0 && <span>（第 {syncStatus.reconnect_attempts} 次重连）</span>}
          </Descriptions.Item>
          <Descriptions.Item label="最后收到邮件">{formatSyncTime(syncStatus?.last_mail_at)}</Descriptions.Item>
          <Descriptions.Item label="最后补偿同步">{formatSyncTime(syncStatus?.last_full_sync_at)}</Descriptions.Item>
          {syncStatus?.last_error && (
            <Descriptions.Item label="最近错误">
              <span style={{ color: '#cf1322' }}>{syncStatus.last_error}</span>
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>
    </div>
  );
}

function Emails() {
  return (
    <Card title="邮件中心">
      <Tabs
        defaultActiveKey="approval"
        items={[
          { key: 'approval', label: '审批台', children: <ApprovalTab /> },
          { key: 'records', label: '发送记录', children: <RecordsTab /> },
          { key: 'replies', label: '邮件待办', children: <RepliesTab /> },
          { key: 'templates', label: '模板与口径', children: <TemplatesTab /> },
          { key: 'settings', label: '邮箱配置', children: <SettingsTab /> }
        ]}
      />
    </Card>
  );
}

export default Emails;
