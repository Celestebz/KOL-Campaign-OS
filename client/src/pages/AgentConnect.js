import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Input, List, Popconfirm, Space, Spin, Typography } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';

const messages = { expired_device: '连接请求已过期，请让 Agent 重新发起登录。', device_not_pending: '此请求已处理或过期，请让 Agent 重新发起登录。' };
async function api(path, options) {
  const response = await fetch('/api/auth/agent' + path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(messages[body.error] || '操作失败，请刷新后重试。');
  return body;
}
function RoutedConnection() {
  const location = useLocation();
  const navigate = useNavigate();
  return <Connections code={new URLSearchParams(location.search).get('code') || ''} navigate={navigate} />;
}
export default function AgentConnect({ embedded = false }) {
  return embedded ? <Connections embedded /> : <RoutedConnection />;
}
function Connections({ embedded = false, code = '', navigate }) {
  const [input, setInput] = useState('');
  const [device, setDevice] = useState(null);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const reload = async () => setConnections((await api('/connections')).data || []);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setResult(''); setDevice(null);
    Promise.all([api('/connections'), code ? api('/device/' + encodeURIComponent(code)) : Promise.resolve(null)])
      .then(([list, details]) => { if (active) { setConnections(list.data || []); setDevice(details); } })
      .catch((err) => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [code]);
  const decide = async (approve) => {
    setBusy(true); setError('');
    try {
      await api('/device/' + encodeURIComponent(code) + '/decision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve }) });
      setResult(approve ? '已允许连接，请返回 Agent 继续。授权会自动保存，无需复制任何密钥。' : '已拒绝此次连接。');
      setDevice(null);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const revoke = async (id) => {
    setBusy(true); setError('');
    try { await api('/connections/' + id, { method: 'DELETE' }); await reload(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const content = <>
    <Typography.Title level={embedded ? 4 : 3}>Skill 连接</Typography.Title>
    <Typography.Paragraph>安装 Skill 后，让 Agent 发起登录，在此确认一次即可。以后自动连接，无需配置 Token 或环境变量。</Typography.Paragraph>
    {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
    {result && <Alert type="success" showIcon message={result} style={{ marginBottom: 16 }} />}
    {loading ? <Spin /> : <>
      {device && device.status === 'pending' && <Card title="确认连接到你的账号" style={{ marginBottom: 24 }}>
        <Typography.Paragraph>发起设备：{device.label}</Typography.Paragraph>
        <Typography.Paragraph>连接码：<Typography.Text strong code>{code}</Typography.Text></Typography.Paragraph>
        <Alert type="warning" showIcon message="仅在你刚刚发起 Skill 登录，且此处连接码与 Agent 显示一致时允许连接。" style={{ marginBottom: 16 }} />
        <Typography.Paragraph>允许读取你账号下的邮件会话和同步状态、查询共享达人资料，并使用现有找人、候选预览和待审邮件草稿接口。邮件审批和发送仍需人工操作。</Typography.Paragraph>
        <Space><Button type="primary" loading={busy} onClick={() => decide(true)}>允许连接</Button><Button disabled={busy} onClick={() => decide(false)}>拒绝</Button></Space>
      </Card>}
      {device && device.status !== 'pending' && <Alert message="此连接请求已经处理，请返回 Agent 查看结果。" style={{ marginBottom: 16 }} />}
      {!embedded && !code && <Space style={{ marginBottom: 24 }}>
        <Input aria-label="连接码" placeholder="输入 Agent 显示的连接码" value={input} maxLength={9} onChange={(event) => setInput(event.target.value.toUpperCase())} />
        <Button disabled={!/^[A-Z2-9]{4}-?[A-Z2-9]{4}$/.test(input)} onClick={() => navigate('/agent/connect?code=' + encodeURIComponent(input))}>查看请求</Button>
      </Space>}
      <Space style={{ width: '100%', justifyContent: 'space-between' }}><Typography.Title level={5}>已连接的 Agent</Typography.Title><Button disabled={busy} onClick={() => reload().catch((err) => setError(err.message))}>刷新</Button></Space>
      <List dataSource={connections} locale={{ emptyText: '尚无已连接的 Agent' }} renderItem={(item) => <List.Item actions={[
        <Popconfirm key="revoke" title="撤销后，该 Agent 需重新登录才能访问。" onConfirm={() => revoke(item.id)}><Button danger disabled={busy}>撤销连接</Button></Popconfirm>
      ]}><List.Item.Meta title={item.label} description={'授权有效期至 ' + new Date(item.refresh_expires_at).toLocaleString()} /></List.Item>} />
    </>}
  </>;
  return embedded ? content : <Card style={{ maxWidth: 840, margin: '24px auto' }}>{content}</Card>;
}
