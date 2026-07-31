import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Card, Col, Collapse, Drawer, Empty, Input, message, Modal,
  Popconfirm, Popover, Row, Space, Spin, Tag, Typography
} from 'antd';
import { PictureOutlined, ReloadOutlined, RobotOutlined, SendOutlined } from '@ant-design/icons';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import dayjs from 'dayjs';
import {
  approveDraft, draftReply, draftThreadReply, getDraft, getThread,
  refreshThreadContext, regenerateDraft, rejectDraft, saveDraft
} from './emailApi';

const { TextArea } = Input;

// Quill 工具栏只保留基础排版：加粗/斜体/下划线/列表/链接/清除格式
const QUILL_MODULES = {
  toolbar: [['bold', 'italic', 'underline'], [{ list: 'ordered' }, { list: 'bullet' }], ['link'], ['clean']]
};

// body_text（纯文本）→ Quill 初始 HTML：按空行分段，段内换行转 <br>
function plainTextToHtml(text) {
  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (!paragraphs.length) return '<p><br></p>';
  return paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

// Quill HTML → body_text（纯文本）：先把块级标签转换行再剥标签，保持与后端 body_text 契约一致
function htmlToPlainText(html) {
  const container = document.createElement('div');
  container.innerHTML = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n');
  return String(container.textContent || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 外部图片默认不加载：渲染 body_html 前把 <img> 替换为占位，点击"加载图片"后才渲染原始 HTML
const IMG_PLACEHOLDER = '<span style="color:#bfbfbf;font-size:12px;">[图片已隐藏]</span>';
function hideImages(html) {
  return String(html || '').replace(/<img\b[^>]*>/gi, IMG_PLACEHOLDER);
}

// context_message_ids 后端存 JSON 字符串数组，这里宽松解析
function parseContextMessageIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

const formatTime = (value) => (value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-');

// 单封邮件卡片：方向 Tag + 收发件人 + 时间 + 主题 + 正文（HTML 优先，外部图片默认隐藏）
function TimelineCard({ item, expanded, onToggle, imagesOn, onToggleImages, isReplyTarget }) {
  const inbound = item.direction === 'inbound';
  const reply = item.reply || null;
  const bodyHtml = reply?.body_html || '';
  const hasImages = /<img\b/i.test(bodyHtml);
  const quoted = reply?.quoted_body_text || '';
  const parseFailed = reply?.parse_status === 'failed';
  const previewText = String(item.cleanBody || '').replace(/\s+/g, ' ').trim();

  return (
    <Card
      size="small"
      style={{ marginBottom: 8, borderColor: isReplyTarget ? '#1677ff' : undefined, wordBreak: 'break-word', overflowWrap: 'anywhere' }}
      title={
        <Space wrap size={[6, 4]} style={{ cursor: 'pointer' }} onClick={onToggle}>
          <Tag color={inbound ? 'blue' : 'green'}>{inbound ? 'KOL 来信' : '我方发出'}</Tag>
          <span style={{ wordBreak: 'break-all' }}>{inbound ? (item.from || '-') : `发给 ${item.to || '-'}`}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{formatTime(item.at)}</Typography.Text>
          {isReplyTarget && <Tag color="processing">回复目标</Tag>}
        </Space>
      }
    >
      {item.subject ? (
        <div style={{ fontWeight: 600, marginBottom: 6, wordBreak: 'break-all', cursor: 'pointer' }} onClick={onToggle}>
          {item.subject}
        </div>
      ) : null}
      {parseFailed && (
        <Alert
          type="warning" showIcon style={{ marginBottom: 8 }}
          message="该邮件解析异常，以下内容可能不完整"
          description={reply?.parse_error ? String(reply.parse_error).slice(0, 200) : null}
        />
      )}
      {!expanded ? (
        <div style={{ color: '#8c8c8c', cursor: 'pointer' }} onClick={onToggle}>
          {previewText ? `${previewText.slice(0, 120)}${previewText.length > 120 ? '…' : ''}` : '（无正文，点击展开）'}
        </div>
      ) : (
        <>
          {bodyHtml ? (
            <div
              className="email-thread-html-body"
              style={{ overflowWrap: 'anywhere' }}
              dangerouslySetInnerHTML={{ __html: imagesOn ? bodyHtml : hideImages(bodyHtml) }}
            />
          ) : (
            <div style={{ whiteSpace: 'pre-wrap' }}>{item.cleanBody || '（无正文）'}</div>
          )}
          {hasImages && (
            <Button
              type="link" size="small" icon={<PictureOutlined />} style={{ paddingLeft: 0 }}
              onClick={() => onToggleImages(!imagesOn)}
            >
              {imagesOn ? '隐藏图片' : '加载图片'}
            </Button>
          )}
          {quoted ? (
            <Collapse
              ghost
              items={[{
                key: 'quoted',
                label: '查看引用历史',
                children: <div style={{ whiteSpace: 'pre-wrap', color: '#8c8c8c', fontSize: 12 }}>{quoted}</div>
              }]}
            />
          ) : null}
        </>
      )}
    </Card>
  );
}

// 邮件会话工作台：左侧历史时间线 + 右侧草稿编辑；旧数据（无 thread_id）回退为单封展示 + 旧起草流程
function EmailThreadDrawer({ open, threadId, reply, onClose, onChanged }) {
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState(null); // { thread, campaign, customer, timeline, pending_draft }
  const [draft, setDraft] = useState(null);
  const [editSubject, setEditSubject] = useState('');
  const [editHtml, setEditHtml] = useState('');
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [imageIds, setImageIds] = useState(new Set());
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenFeedback, setRegenFeedback] = useState('');
  const [regenLoading, setRegenLoading] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [contextRefreshing, setContextRefreshing] = useState(false);

  // 旧数据回退：reply.thread_id 为 null 时不调 threads API，直接用列表行构造单条时间线
  const legacyTimeline = useMemo(() => {
    if (!reply) return [];
    return [{
      direction: 'inbound',
      messageId: reply.message_id || `reply-${reply.id}`,
      replyId: reply.id,
      from: reply.from_address || null,
      to: null,
      at: reply.received_at,
      subject: reply.subject || '',
      cleanBody: reply.clean_body_text || reply.body_text || '',
      parseStatus: reply.parse_status || null,
      reply
    }];
  }, [reply]);

  const timeline = useMemo(() => (detail ? (detail.timeline || []) : legacyTimeline), [detail, legacyTimeline]);

  const initEditor = useCallback((d) => {
    setEditSubject(d?.subject || '');
    setEditHtml(plainTextToHtml(d?.body_text || ''));
  }, []);

  // 默认展开：最新一封来信 + 最近一封我方邮件；更早的折叠
  const defaultExpandedIds = useCallback((items) => {
    const ids = new Set();
    const latestInbound = [...items].reverse().find((m) => m.direction === 'inbound');
    const latestOutbound = [...items].reverse().find((m) => m.direction === 'outbound');
    if (latestInbound) ids.add(latestInbound.messageId);
    if (latestOutbound) ids.add(latestOutbound.messageId);
    return ids;
  }, []);

  const applyThreadData = useCallback((data, { resetEditor = true } = {}) => {
    setDetail(data);
    const d = data.pending_draft || null;
    setDraft(d);
    if (resetEditor) {
      initEditor(d);
      setExpandedIds(defaultExpandedIds(data.timeline || []));
    }
  }, [initEditor, defaultExpandedIds]);

  const loadThread = useCallback(async (options) => {
    if (!threadId) return;
    setLoading(true);
    try {
      const data = await getThread(threadId);
      applyThreadData(data, options);
    } catch (error) {
      message.error(error.response?.data?.error || '加载会话失败');
    } finally {
      setLoading(false);
    }
  }, [threadId, applyThreadData]);

  // 外层列表每 10 秒静默刷新会产生新的 reply 行对象；用 initKey 保证同一条会话只初始化一次，
  // 避免轮询触发 effect 重跑而清空正在编辑的草稿。
  const initKeyRef = useRef(null);

  useEffect(() => {
    if (!open) {
      initKeyRef.current = null;
      return;
    }
    const initKey = threadId ? `thread:${threadId}` : `reply:${reply?.id || ''}`;
    if (initKeyRef.current === initKey) return;
    initKeyRef.current = initKey;
    setRegenOpen(false);
    setRegenFeedback('');
    setRejectOpen(false);
    setRejectReason('');
    setImageIds(new Set());
    if (threadId) {
      loadThread();
    } else {
      // 旧数据：单条时间线直接展开，草稿区走旧 draftReply 流程
      setDetail(null);
      setDraft(null);
      initEditor(null);
      setExpandedIds(new Set(legacyTimeline.map((item) => item.messageId)));
    }
  }, [open, threadId, reply, loadThread, legacyTimeline, initEditor]);

  const latestInbound = useMemo(
    () => [...timeline].reverse().find((m) => m.direction === 'inbound') || null,
    [timeline]
  );

  // 回复目标：草稿记录的 reply_to_message_id（需能在时间线中找到），否则最新一封来信
  const replyTargetId = useMemo(() => {
    const fromDraft = draft?.reply_to_message_id;
    if (fromDraft && timeline.some((m) => m.messageId === fromDraft)) return fromDraft;
    return latestInbound?.messageId || null;
  }, [draft, timeline, latestInbound]);

  const recipient = detail?.customer?.email || draft?.recipient_email || latestInbound?.from || '';
  const contextIds = useMemo(() => parseContextMessageIds(draft?.context_message_ids), [draft]);

  const notifyChanged = () => { if (onChanged) onChanged(); };

  // 无草稿时起草：thread 模式走会话接口；旧数据回退旧 draftReply 后加载草稿详情进入编辑态
  const handleStartDraft = async () => {
    setActionLoading(true);
    try {
      if (threadId) {
        const res = await draftThreadReply(threadId, {});
        if (res?.message === '已有草稿，复用现有') message.info(res.message);
        else message.success(res?.message || '回复草稿已生成');
        await loadThread();
      } else {
        const res = await draftReply(reply.id);
        const draftId = res?.data?.draftId;
        if (draftId) {
          const d = await getDraft(draftId);
          setDraft(d);
          initEditor(d);
          message.success('已生成回复草稿');
        } else {
          message.success(res?.message || '已生成回复草稿，请到审批台审阅');
        }
      }
      notifyChanged();
    } catch (error) {
      message.error(error.response?.data?.error || '生成回复草稿失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    try {
      const bodyText = htmlToPlainText(editHtml);
      await saveDraft(draft.id, { subject: editSubject, body_text: bodyText });
      setDraft({ ...draft, subject: editSubject, body_text: bodyText });
      message.success('已保存修改（已留版本）');
      notifyChanged();
    } catch (error) {
      message.error(error.response?.data?.error || '保存失败');
    }
  };

  // 重新生成：后端对已有待审草稿会 dedupe 跳过，因此统一走旧 regenerateDraft 原地重生成
  const handleRegenerate = async () => {
    if (!draft) return;
    setRegenLoading(true);
    try {
      const updated = await regenerateDraft(draft.id, regenFeedback || undefined);
      message.success('已重新生成');
      setRegenOpen(false);
      setRegenFeedback('');
      if (updated) {
        setDraft(updated);
        initEditor(updated);
      } else if (threadId) {
        await loadThread();
      }
      notifyChanged();
    } catch (error) {
      message.error(error.response?.data?.error || '重新生成失败');
    } finally {
      setRegenLoading(false);
    }
  };

  const handleApprove = async () => {
    if (!draft) return;
    setActionLoading(true);
    try {
      const result = await approveDraft(draft.id);
      message.success('邮件已发送，外联状态已同步');
      if (result?.threading_missing) {
        message.warning('已发送，但原邮件缺少线程标识，对方邮箱可能无法自动归入同一会话');
      }
      notifyChanged();
      onClose();
    } catch (error) {
      message.error(error.response?.data?.error || (error.code === 'ECONNABORTED'
        ? '发送请求超时，请先检查邮箱发件箱，切勿重复点击发送'
        : `发送失败：${error.message || '未知错误'}`));
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    if (!draft) return;
    try {
      await rejectDraft(draft.id, rejectReason);
      message.success('已驳回');
      setRejectOpen(false);
      setRejectReason('');
      setDraft(null);
      if (threadId) await loadThread();
      notifyChanged();
    } catch (error) {
      message.error(error.response?.data?.error || '操作失败');
    }
  };

  const handleRefreshContext = async () => {
    if (!threadId) return;
    setContextRefreshing(true);
    try {
      const res = await refreshThreadContext(threadId);
      message.success(res?.message || '会话摘要已刷新');
      // 只刷新 detail，不重置编辑器，避免覆盖未保存的草稿编辑
      const data = await getThread(threadId);
      applyThreadData(data, { resetEditor: false });
    } catch (error) {
      message.error(error.response?.data?.error || '刷新会话摘要失败');
    } finally {
      setContextRefreshing(false);
    }
  };

  const toggleExpanded = (id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleImages = (id, on) => {
    setImageIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  // 发送前引用预览：纯前端示意，实际发送由后端附带最近一封来信的引用块
  const quotePreview = useMemo(() => {
    if (!latestInbound) return null;
    const body = String(latestInbound.cleanBody || '').slice(0, 500);
    const quoted = body.split('\n').map((line) => `> ${line}`).join('\n');
    const truncated = String(latestInbound.cleanBody || '').length > 500 ? '\n> …' : '';
    return `On ${formatTime(latestInbound.at)}, ${latestInbound.from || '对方'} wrote:\n${quoted}${truncated}`;
  }, [latestInbound]);

  const drawerWidth = typeof window === 'undefined'
    ? 1200
    : Math.min(Math.round(window.innerWidth * 0.92), 1200);

  const customerName = detail?.customer?.name || reply?.kol_name || '';

  return (
    <Drawer
      width={drawerWidth}
      open={open}
      onClose={onClose}
      title={
        <Space wrap size={[8, 4]}>
          <span>{customerName ? `${customerName} 的邮件会话` : '邮件会话'}</span>
          {detail?.campaign?.name && <Tag>{detail.campaign.name}</Tag>}
          {detail?.customer?.email && (
            <Typography.Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
              {detail.customer.email}
            </Typography.Text>
          )}
          {!threadId && <Tag color="orange">旧数据·未关联会话</Tag>}
        </Space>
      }
    >
      <Spin spinning={loading}>
        <Row gutter={16}>
          <Col xs={24} lg={13}>
            <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }} wrap>
              <Typography.Title level={5} style={{ margin: 0 }}>往来邮件（{timeline.length}）</Typography.Title>
              <Space size={4} wrap>
                <Button size="small" type="link" onClick={() => setExpandedIds(new Set(timeline.map((m) => m.messageId)))}>全部展开</Button>
                <Button size="small" type="link" onClick={() => setExpandedIds(new Set())}>全部折叠</Button>
                {threadId && (
                  <Button size="small" type="link" icon={<ReloadOutlined />} loading={contextRefreshing} onClick={handleRefreshContext}>
                    更新会话摘要
                  </Button>
                )}
              </Space>
            </Space>
            {detail?.thread?.context_summary && (
              <Alert
                type="info" showIcon style={{ marginBottom: 8 }}
                message="会话摘要"
                description={<div style={{ whiteSpace: 'pre-wrap' }}>{detail.thread.context_summary}</div>}
              />
            )}
            {!timeline.length && !loading ? (
              <Empty description="暂无往来邮件" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginTop: 40 }} />
            ) : (
              timeline.map((item) => (
                <TimelineCard
                  key={item.messageId}
                  item={item}
                  expanded={expandedIds.has(item.messageId)}
                  onToggle={() => toggleExpanded(item.messageId)}
                  imagesOn={imageIds.has(item.messageId)}
                  onToggleImages={(on) => toggleImages(item.messageId, on)}
                  isReplyTarget={item.messageId === replyTargetId}
                />
              ))
            )}
          </Col>

          <Col xs={24} lg={11}>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              <RobotOutlined /> 回复草稿
            </Typography.Title>
            {!draft ? (
              <Card size="small">
                <Empty
                  description={threadId ? '当前会话没有待审草稿' : '该来信暂无回复草稿'}
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                />
                <div style={{ textAlign: 'center', marginTop: 8 }}>
                  <Button
                    type="primary" icon={<RobotOutlined />} loading={actionLoading}
                    disabled={!threadId && !reply}
                    onClick={handleStartDraft}
                  >
                    AI 起草回复
                  </Button>
                </div>
              </Card>
            ) : (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Alert
                  type="warning" showIcon icon={<RobotOutlined />}
                  message="AI 生成，尚未发送"
                  description="请先核对收件人、主题和正文。点击“批准并发送”即代表批准，邮件会立即对外发送。"
                />
                <Input
                  addonBefore="收件人"
                  value={recipient}
                  readOnly
                  placeholder="未配置收件人邮箱"
                  style={{ wordBreak: 'break-all' }}
                />
                <Input
                  addonBefore="主题"
                  value={editSubject}
                  onChange={(e) => setEditSubject(e.target.value)}
                />
                <ReactQuill
                  theme="snow"
                  value={editHtml}
                  onChange={setEditHtml}
                  modules={QUILL_MODULES}
                />
                {contextIds.length > 0 && (
                  <Popover
                    title="AI 参考的历史邮件"
                    content={(
                      <div style={{ maxWidth: 360, wordBreak: 'break-all' }}>
                        {contextIds.map((id) => <div key={id} style={{ fontSize: 12 }}>{id}</div>)}
                      </div>
                    )}
                  >
                    <Button type="link" size="small" style={{ paddingLeft: 0 }}>
                      AI 参考了 {contextIds.length} 封历史邮件
                    </Button>
                  </Popover>
                )}
                {draft.context_summary_snapshot ? (
                  <Collapse
                    ghost
                    items={[{
                      key: 'snapshot',
                      label: '查看起草时的会话摘要快照',
                      children: (
                        <div style={{ whiteSpace: 'pre-wrap', color: '#8c8c8c', fontSize: 12 }}>
                          {draft.context_summary_snapshot}
                        </div>
                      )
                    }]}
                  />
                ) : null}
                {quotePreview && (
                  <Collapse
                    ghost
                    items={[{
                      key: 'quote',
                      label: '发送时将附带引用',
                      children: (
                        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, color: '#8c8c8c', fontSize: 12, wordBreak: 'break-all' }}>
                          {quotePreview}
                        </pre>
                      )
                    }]}
                  />
                )}
                {regenOpen && (
                  <TextArea
                    rows={3}
                    value={regenFeedback}
                    onChange={(e) => setRegenFeedback(e.target.value)}
                    placeholder="可填写反馈，AI 会据此调整（旧版本会保留在版本历史中）"
                  />
                )}
                <Space wrap>
                  <Button onClick={handleSave}>保存草稿</Button>
                  {!regenOpen ? (
                    <Button onClick={() => setRegenOpen(true)}>重新生成</Button>
                  ) : (
                    <>
                      <Button loading={regenLoading} onClick={handleRegenerate}>确认重新生成</Button>
                      <Button type="text" onClick={() => { setRegenOpen(false); setRegenFeedback(''); }}>取消</Button>
                    </>
                  )}
                  <Popconfirm
                    title="确认立即发送这封邮件？"
                    description="点击确认后，邮件将立即对外发送，且无法撤回。"
                    okText="确认发送"
                    cancelText="取消"
                    onConfirm={handleApprove}
                  >
                    <Button type="primary" icon={<SendOutlined />} loading={actionLoading} disabled={!recipient}>
                      批准并发送
                    </Button>
                  </Popconfirm>
                  <Button danger onClick={() => setRejectOpen(true)}>驳回</Button>
                </Space>
              </Space>
            )}
          </Col>
        </Row>
      </Spin>

      <Modal
        title="驳回草稿"
        open={rejectOpen}
        onOk={handleReject}
        onCancel={() => setRejectOpen(false)}
        okText="驳回"
        okButtonProps={{ danger: true }}
      >
        <p>请填写驳回原因：</p>
        <TextArea rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
      </Modal>
    </Drawer>
  );
}

export default EmailThreadDrawer;
