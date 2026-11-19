import React, { useEffect, useRef, useState } from 'react';
import { Alert, Modal, Select, Space, Table, message } from 'antd';
import axios from 'axios';
import { suggestedTasks } from './taskLabels';

export default function TaskIntakeModal({ open, onClose, customers, campaigns, onSaved, outreach = false }) {
  const context = new URLSearchParams(window.location.search);
  const [campaignId, setCampaignId] = useState();
  const [tasks, setTasks] = useState([]);
  const [assignments, setAssignments] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => {
    if (!open) return;
    setCampaignId(Number(new URLSearchParams(window.location.search).get('campaign_id')) || undefined);
    setTasks([]); setAssignments({}); setError('');
  }, [open]);
  useEffect(() => {
    const current = ++request.current;
    setTasks([]); setAssignments({}); setError('');
    if (!open || !campaignId) return;
    setLoading(true);
    axios.get(`/api/campaigns/${campaignId}/tasks`).then((res) => {
      if (current !== request.current) return;
      const active = (res.data.data || []).filter((task) => task.status === 'active');
      setTasks(active);
      const requested = Number(new URLSearchParams(window.location.search).get('task_id'));
      setAssignments(Object.fromEntries(customers.map((customer) => [customer.id,
        requested && active.some((task) => task.id === requested) ? [requested] : suggestedTasks(customer, active)
      ])));
    }).catch((err) => { if (current === request.current) setError(err.response?.data?.error || '任务加载失败'); })
      .finally(() => { if (current === request.current) setLoading(false); });
    return () => { request.current += 1; };
  }, [open, campaignId, customers]);
  const save = async () => {
    const pairs = customers.flatMap((customer) => (assignments[customer.id] || []).map((taskId) => ({ customer_id: customer.id, task_id: taskId })));
    if (!pairs.length) return message.warning('请为至少一位达人选择任务');
    if (pairs.length > 200) return message.warning('每批最多200组达人任务，请分批提交');
    setSaving(true);
    try {
      const res = await axios.post(`/api/campaigns/${campaignId}/task-members`, { assignments: pairs });
      const rows = res.data.data || [];
      message.success(`新增 ${rows.filter((row) => row.created).length} 组达人任务，已有 ${rows.filter((row) => !row.created).length} 组保留原进度`);
      onSaved?.(campaignId, rows); onClose();
    } catch (err) { message.error(err.response?.data?.error || '加入失败，未提交本批次'); }
    finally { setSaving(false); }
  };
  return <Modal title={`按产品任务加入候选池（${customers.length}位达人）`} open={open} onCancel={onClose} styles={{ body: { maxHeight: '65vh', overflowY: 'auto' } }}
    onOk={save} confirmLoading={saving} okText={outreach ? '加入并预览开发信' : '加入所选任务'} width={800} okButtonProps={{ disabled: !campaignId || loading || !!error }}>
    <Space direction="vertical" style={{ width: '100%' }}>
      <Select aria-label="任务所属项目" placeholder="选择项目" value={campaignId} onChange={setCampaignId} style={{ width: '100%' }}
        options={campaigns.filter((c) => c.status === 'active' && c.campaign_type === 'active_project').map((c) => ({ value: c.id, label: c.name }))} />
      <Alert type="info" showIcon message={context.get('task_id') ? '已选择来源任务，请逐人核对适配情况。' : '根据产品推荐预选任务；组合任务需要全部产品匹配。可人工调整，加入后仍需审核。'} />
      {error && <Alert type="error" message={error} />}
      {campaignId && !loading && !tasks.length && !error && <Alert type="warning" message="该项目暂无启用的产品任务，请先到项目中创建。" />}
      <Table rowKey="id" size="small" pagination={false} loading={loading} dataSource={customers} columns={[
        { title: '达人', dataIndex: 'name', width: 180 },
        { title: '本次加入的任务', render: (_, customer) => <Select mode="multiple" aria-label={`${customer.name}的任务`} style={{ width: '100%' }}
          value={assignments[customer.id] || []} onChange={(values) => setAssignments((old) => ({ ...old, [customer.id]: values }))}
          options={tasks.map((task) => ({ value: task.id, label: `${task.name} · ${(task.products || []).map((p) => p.sku || p.name).join(' + ')}` }))} /> }
      ]} />
    </Space>
  </Modal>;
}
