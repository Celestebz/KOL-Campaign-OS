import React, { useState } from 'react';
import { Alert, Button, Card, Form, Input, Space, Typography } from 'antd';

function Login({ needsBootstrap, onSuccess }) {
  const [mode, setMode] = useState(needsBootstrap ? 'bootstrap' : 'login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (values) => {
    setLoading(true);
    setError('');
    const endpoint = mode === 'bootstrap' ? 'bootstrap' : mode === 'register' ? 'register' : 'login';
    try {
      const res = await fetch(`/api/auth/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || '操作失败，请重试');
      onSuccess(data.user);
    } catch (err) {
      setError(err.message || '无法连接服务器，请稍后再试');
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (next) => {
    setMode(next);
    setError('');
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0f2f5' }}>
      <Card style={{ width: 400, boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }}>
        <Typography.Title level={3} style={{ textAlign: 'center', marginBottom: 8 }}>KOL Campaign OS</Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          {mode === 'bootstrap' ? '创建首个管理员账号' : mode === 'register' ? '使用团队邀请码注册' : '使用个人账号登录'}
        </Typography.Paragraph>
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
        <Form key={mode} layout="vertical" onFinish={submit}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }, { pattern: /^[A-Za-z0-9_]{3,50}$/, message: '请输入3-50位字母、数字或下划线' }]}>
            <Input autoFocus size="large" autoComplete="username" />
          </Form.Item>
          {mode !== 'login' && (
            <Form.Item name="displayName" label="昵称" rules={[{ required: true, message: '请输入昵称' }]}>
              <Input size="large" maxLength={100} />
            </Form.Item>
          )}
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }, { min: 8, message: '密码至少8个字符' }]}>
            <Input.Password size="large" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </Form.Item>
          {mode === 'register' && (
            <Form.Item name="inviteCode" label="邀请码" rules={[{ required: true, message: '请输入邀请码' }]}>
              <Input size="large" autoComplete="off" />
            </Form.Item>
          )}
          <Button type="primary" htmlType="submit" block size="large" loading={loading}>
            {mode === 'bootstrap' ? '创建管理员并进入系统' : mode === 'register' ? '注册并进入系统' : '登录'}
          </Button>
        </Form>
        {!needsBootstrap && (
          <Space style={{ width: '100%', justifyContent: 'center', marginTop: 16 }}>
            {mode === 'login' ? <Button type="link" onClick={() => switchMode('register')}>使用邀请码注册</Button> : <Button type="link" onClick={() => switchMode('login')}>返回登录</Button>}
          </Space>
        )}
      </Card>
    </div>
  );
}

export default Login;
