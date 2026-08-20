import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, DatePicker, Form, Input, InputNumber, message, Popconfirm, Table, Tag, Typography } from 'antd';

function UserManagement() {
  const [users, setUsers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [usersRes, invitesRes] = await Promise.all([fetch('/api/auth/admin/users'), fetch('/api/auth/admin/invites')]);
      const usersData = await usersRes.json();
      const invitesData = await invitesRes.json();
      if (!usersRes.ok) throw new Error(usersData.error);
      if (!invitesRes.ok) throw new Error(invitesData.error);
      setUsers(usersData.data || []);
      setInvites(invitesData.data || []);
      setError('');
    } catch (err) { setError(err.message || '加载失败'); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createInvite = async (values) => {
    const res = await fetch('/api/auth/admin/invites', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...values, expiresAt: values.expiresAt?.toISOString() })
    });
    const data = await res.json();
    if (!res.ok) return message.error(data.error || '生成失败');
    message.success(`邀请码已生成：${data.data.code}`);
    load();
  };

  const changeStatus = async (user, status) => {
    const res = await fetch(`/api/auth/admin/users/${user.id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    const data = await res.json();
    if (!res.ok) return message.error(data.error || '操作失败');
    load();
  };

  const revoke = async (id) => {
    const res = await fetch(`/api/auth/admin/invites/${id}/revoke`, { method: 'POST' });
    if (!res.ok) return message.error('作废失败');
    load();
  };

  return (
    <div style={{ padding: '24px 0' }}>
      <Typography.Title level={2}>用户与邀请</Typography.Title>
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
      <Card title="团队成员" style={{ marginBottom: 16 }}>
        <Table rowKey="id" dataSource={users} pagination={false} columns={[
          { title: '用户名', dataIndex: 'username' },
          { title: '昵称', dataIndex: 'display_name' },
          { title: '角色', dataIndex: 'role', render: (v) => <Tag color={v === 'admin' ? 'gold' : 'blue'}>{v}</Tag> },
          { title: '状态', dataIndex: 'status', render: (v) => <Tag color={v === 'active' ? 'green' : 'default'}>{v}</Tag> },
          { title: '最近登录', dataIndex: 'last_login_at', render: (v) => v ? new Date(v).toLocaleString() : '—' },
          { title: '操作', render: (_, user) => user.role === 'admin' ? '—' : <Popconfirm title={`确定${user.status === 'active' ? '停用' : '启用'}该账号？`} onConfirm={() => changeStatus(user, user.status === 'active' ? 'disabled' : 'active')}><Button size="small">{user.status === 'active' ? '停用' : '启用'}</Button></Popconfirm> }
        ]} />
      </Card>
      <Card title="生成邀请码" style={{ marginBottom: 16 }}>
        <Form layout="inline" onFinish={createInvite} initialValues={{ maxUses: 1 }}>
          <Form.Item name="note" label="备注"><Input placeholder="给谁使用" /></Form.Item>
          <Form.Item name="maxUses" label="次数"><InputNumber min={1} max={100} /></Form.Item>
          <Form.Item name="expiresAt" label="有效期"><DatePicker showTime /></Form.Item>
          <Button type="primary" htmlType="submit">生成</Button>
        </Form>
      </Card>
      <Card title="邀请码">
        <Table rowKey="id" dataSource={invites} columns={[
          { title: '邀请码', dataIndex: 'code', render: (v) => <Typography.Text copyable>{v}</Typography.Text> },
          { title: '备注', dataIndex: 'note' },
          { title: '使用', render: (_, row) => `${row.used_count}/${row.max_uses}` },
          { title: '有效期', dataIndex: 'expires_at', render: (v) => v ? new Date(v).toLocaleString() : '永久' },
          { title: '状态', render: (_, row) => row.revoked_at ? <Tag>已作废</Tag> : <Tag color="green">有效</Tag> },
          { title: '操作', render: (_, row) => row.revoked_at ? '—' : <Popconfirm title="确定作废该邀请码？" onConfirm={() => revoke(row.id)}><Button size="small" danger>作废</Button></Popconfirm> }
        ]} />
      </Card>
    </div>
  );
}

export default UserManagement;
