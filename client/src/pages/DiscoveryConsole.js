import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Form, Input, InputNumber, message, Modal, Popconfirm, Row, Select, Space, Tag, Typography } from 'antd';
import { CopyOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import axios from 'axios';

const { Text, Paragraph, Title } = Typography;
const labels = { queued: '等待 Agent 接手', running: 'Agent 执行中', blocked: '需要处理', completed: '本轮已结束', cancelled: '已停止' };
const stages = { waiting: '等待接手', searching: '搜索达人', verifying: '核验条件', analyzing: '分析证据', writing: '写入候选', done: '本轮结束' };
const colors = { queued: 'default', running: 'blue', blocked: 'orange', completed: 'green', cancelled: 'default' };
const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

export function handoffText(request, origin) {
  return `请重新读取新版 kol-campaign-os-agent Skill，执行找人需求 #${request.id}。\nOS 地址：${origin}\n先读取 GET /api/agent/discovery-requests/${request.id}，按 Skill 的控制台需求流程领取并执行。\n使用需求中的 context 和 requirements，不选 Strategy、不修改旧策略、不写脚本调用 createFinderTask。\n项目：${request.campaign_name || request.campaign_id}；产品：${request.product_name || request.campaign_product_id}；平台：${request.target_platform}；目标：${request.target_count} 人。\n要求：${request.requirements}\n持续回报进度，把核验合格的人选写入 Raw 候选，停止于人工审核，不批准、不发送邮件。\n若尚未安装新版 Skill，请从 OS 项目 skills/kol-campaign-os-agent 安装；读取 references/discovery-console.md。访问凭据在本机安全配置，不要粘贴到聊天中。`;
}

export default function DiscoveryConsole() {
  const [form] = Form.useForm();
  const [campaigns, setCampaigns] = useState([]);
  const [products, setProducts] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [handoff, setHandoff] = useState(null);
  const [acting, setActing] = useState(null);
  const requestKey = useRef(newKey());
  const lastSubmission = useRef('');
  const alive = useRef(true);
  const polling = useRef(false);
  const load = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const response = await axios.get('/api/discovery-requests');
      if (alive.current) { setRequests(response.data.data || []); setLoadError(''); }
    } catch (e) {
      if (alive.current) setLoadError(e.response?.data?.error || '读取任务失败，请检查连接后刷新');
    } finally { polling.current = false; }
  }, []);
  useEffect(() => {
    alive.current = true;
    setLoading(true);
    Promise.all([load(), axios.get('/api/campaigns')
      .then((response) => { if (alive.current) setCampaigns(response.data.data || []); })
      .catch(() => { if (alive.current) message.error('读取项目失败，请刷新'); })])
      .finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; };
  }, [load]);
  const campaignId = Form.useWatch('campaign_id', form);
  useEffect(() => {
    if (!campaignId) { setProducts([]); return undefined; }
    let cancelled = false;
    setProducts([]);
    form.setFieldsValue({ campaign_product_id: undefined });
    axios.get(`/api/campaigns/${campaignId}/products`).then((response) => {
      if (!cancelled) setProducts((response.data.data || []).filter((p) => p.status === 'active'));
    }).catch(() => { if (!cancelled) message.error('读取项目产品失败，请刷新'); });
    return () => { cancelled = true; };
  }, [campaignId, form]);
  useEffect(() => {
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);
  const create = async (values) => {
    const signature = JSON.stringify(values);
    if (lastSubmission.current && lastSubmission.current !== signature) requestKey.current = newKey();
    lastSubmission.current = signature;
    setCreating(true);
    try {
      const response = await axios.post('/api/discovery-requests', { ...values, request_key: requestKey.current });
      setHandoff(response.data.data);
      requestKey.current = newKey();
      lastSubmission.current = '';
      await load();
      message.success('需求已保存，请把指令交给外部 Agent');
    } catch (e) { message.error(e.response?.data?.error || '提交失败，可以重试'); }
    finally { setCreating(false); }
  };
  const control = async (request, action) => {
    setActing(request.id);
    try {
      const response = await axios.post(`/api/discovery-requests/${request.id}/${action}`);
      if (action === 'retry') setHandoff(response.data.data);
      await load();
    } catch (e) { message.error(e.response?.data?.error || '操作失败，请刷新重试'); }
    finally { setActing(null); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(handoffText(handoff, window.location.origin)); message.success('已复制，请粘贴给外部 Agent'); }
    catch { message.warning('浏览器无法自动复制，请在下方文本框中选择并复制'); }
  };
  return <div style={{ paddingBottom: 32 }}>
    <Title level={3}>找达人控制台</Title>
    <Paragraph type="secondary">填写要求，交给外部 Agent 执行 Skill；在原始候选中审核结果。</Paragraph>
    <Row gutter={[24, 24]}>
      <Col xs={24} lg={9}>
        <Card title="这次想找什么达人？" loading={loading}>
          <Form form={form} layout="vertical" initialValues={{ target_count: 10 }} onFinish={create}>
            <Form.Item label="项目" name="campaign_id" rules={[{ required: true, message: '请选择项目' }]}>
              <Select showSearch optionFilterProp="label" placeholder="选择项目" options={campaigns.map((c) => ({ value: c.id, label: c.name }))} />
            </Form.Item>
            <Form.Item label="产品" name="campaign_product_id" rules={[{ required: true, message: '请选择产品' }]}>
              <Select showSearch optionFilterProp="label" placeholder={campaignId ? '选择项目产品' : '请先选择项目'} disabled={!campaignId}
                options={products.map((p) => ({ value: p.id, label: p.product?.name || p.product_name || p.name }))} />
            </Form.Item>
            <Form.Item label="平台" name="target_platform" rules={[{ required: true, message: '请选择一个平台' }]}>
              <Select placeholder="选择平台" options={['youtube', 'instagram', 'tiktok'].map((p) => ({ value: p, label: { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok' }[p] }))} />
            </Form.Item>
            <Form.Item label="本轮目标人数" name="target_count" rules={[{ required: true }]} extra="每轮 1–50 人；实际结果取决于符合条件的达人数量。">
              <InputNumber min={1} max={50} precision={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="找人要求" name="requirements" rules={[{ required: true, whitespace: true, message: '请填写找人要求' }]}>
              <Input.TextArea rows={6} maxLength={5000} showCount placeholder="例如：美国 TikTok 家居达人，最近 10 条视频播放中位数至少 2,000，排除品牌商家和已有达人。请写清国家、内容方向、指标口径及排除条件。" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block icon={<SearchOutlined />} loading={creating}>生成 Agent 任务指令</Button>
          </Form>
          <Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>保存后需把指令交给 Agent，网页不会自动唤醒它。<Link to="/settings">连接设置</Link></Paragraph>
        </Card>
      </Col>
      <Col xs={24} lg={15}>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
          <Text strong>最近的找人需求</Text><Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
        {loadError && <Alert type="error" message={loadError} showIcon style={{ marginBottom: 16 }} />}
        {!requests.length && !loading && !loadError && <Empty description="还没有找人需求" />}
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {requests.map((request) => <Card key={request.id} title={`#${request.id} · ${request.campaign_name || '项目'} / ${request.product_name || '产品'}`}
            extra={<Tag color={colors[request.status]}>{labels[request.status] || request.status}</Tag>}>
            <Space wrap><Tag>{request.target_platform}</Tag><Text>目标 {request.target_count} 人</Text><Text strong>Raw 候选 {request.candidate_count} 人</Text></Space>
            <Paragraph style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>{request.requirements}</Paragraph>
            <Paragraph type="secondary">{stages[request.stage] || request.stage} · {request.progress_note || '复制任务指令给 Agent 后开始执行'}</Paragraph>
            {request.heartbeat_at && <Paragraph type="secondary">最近回报：{new Date(request.heartbeat_at).toLocaleString()}{request.status === 'running' && Date.now() - new Date(request.heartbeat_at).getTime() > 10 * 60 * 1000 ? ' · 较久未回报，请检查 Agent 状态' : ''}</Paragraph>}
            <Space wrap>
              {['queued', 'running', 'blocked'].includes(request.status) && <Button onClick={() => setHandoff(request)}>复制任务指令</Button>}
              {request.finder_task_id && <Link to={`/finder?finder_task_id=${request.finder_task_id}`}>审核本次 Raw 候选</Link>}
              {['queued', 'running', 'blocked'].includes(request.status) && <Popconfirm title="停止后续执行？" description="已在处理的单次请求可能仍会完成。" onConfirm={() => control(request, 'cancel')}><Button loading={acting === request.id}>停止</Button></Popconfirm>}
              {['blocked', 'cancelled'].includes(request.status) && <Button loading={acting === request.id} onClick={() => control(request, 'retry')}>交给 Agent 继续</Button>}
            </Space>
          </Card>)}
        </Space>
      </Col>
    </Row>
    <Modal title="把任务交给外部 Agent" open={Boolean(handoff)} onCancel={() => setHandoff(null)} footer={<Button type="primary" icon={<CopyOutlined />} onClick={copy}>复制指令</Button>}>
      <Paragraph>Agent 需要安装新版 kol-campaign-os-agent Skill，并在本机配置此 OS 用户的 External Agent API 凭据。指令不包含密钥。</Paragraph>
      <Input.TextArea aria-label="Agent 任务指令" readOnly rows={12} value={handoff ? handoffText(handoff, window.location.origin) : ''} />
    </Modal>
  </div>;
}
