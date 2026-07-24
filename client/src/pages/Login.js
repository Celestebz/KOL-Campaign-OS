import React, { useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';

function Login({ onSuccess }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async ({ password }) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        onSuccess();
      } else {
        setError(data.error || '口令错误，请重试');
      }
    } catch (err) {
      setError('无法连接服务器，请稍后再试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f0f2f5'
      }}
    >
      <Card style={{ width: 360, boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }}>
        <Typography.Title level={3} style={{ textAlign: 'center', marginBottom: 8 }}>
          KOL Campaign OS
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          请输入团队访问口令
        </Typography.Paragraph>
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
        <Form onFinish={handleSubmit}>
          <Form.Item name="password" rules={[{ required: true, message: '请输入访问口令' }]}>
            <Input.Password placeholder="访问口令" autoFocus size="large" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={loading}>
            进入工作台
          </Button>
        </Form>
      </Card>
    </div>
  );
}

export default Login;
