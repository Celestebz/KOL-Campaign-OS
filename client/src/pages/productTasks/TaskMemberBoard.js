import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Timeline, message } from 'antd';
import axios from 'axios';
import { COOPERATION, INTENT, OUTREACH, REVIEW, dateText, isCooperating, options } from './taskLabels';
import TaskOutreachModal from './TaskOutreachModal';

const FIELD_LABELS = { review_status: '审核状态', cooperation_status: '合作进度', intent: '产品意向', next_follow_up_at: '下次跟进时间', agreed_publish_at: '承诺发布日期', received_at: '实际收货日期', draft_due_at: '初稿期限', published_at: '实际发布日期', video_url: '作品链接', quoted_fee: '本任务报价', notes: '备注' };
const dateFields = ['agreed_publish_at', 'received_at', 'draft_due_at', 'published_at'];
function eventText(event) {
  if (event.event_type !== 'updated') return event.summary;
  try { return Object.entries(JSON.parse(event.summary).after).map(([key, value]) => `${FIELD_LABELS[key] || key}：${REVIEW[value] || COOPERATION[value] || INTENT[value] || value || '清空'}`).join('；'); }
  catch (_) { return '更新任务进度'; }
}
export default function TaskMemberBoard({ campaignId, view }) {
  const [members, setMembers] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [taskFilter, setTaskFilter] = useState();
  const [outreach, setOutreach] = useState();
  const [followUpOnly, setFollowUpOnly] = useState(false);
  const [selected, setSelected] = useState([]);
  const [editing, setEditing] = useState(null);
  const [history, setHistory] = useState(null);
  const [contactText, setContactText] = useState('');
  const [mailOpen, setMailOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form] = Form.useForm();
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [a, b] = await Promise.all([axios.get(`/api/campaigns/${campaignId}/task-members`), axios.get(`/api/campaigns/${campaignId}/tasks`)]);
      const nextMembers = a.data.data || [];
      setMembers(nextMembers); setTasks(b.data.data || []);
      setSelected((old) => old.filter((key) => nextMembers.some((m) => m.id === key)));
    } catch (err) { setError(err.response?.data?.error || '任务达人加载失败'); }
    finally { setLoading(false); }
  }, [campaignId]);
  useEffect(() => { load(); }, [load]);
  const rows = members.filter((m) => (view === 'cooperation' ? isCooperating(m) : !isCooperating(m))
    && (!taskFilter || m.task_id === taskFilter) && (!outreach || m.outreach_status === outreach) && (!followUpOnly || m.follow_up_due));
  const openEdit = (row) => {
    form.resetFields(); const values = { ...row };
    dateFields.forEach((key) => { values[key] = row[key]?.slice(0, 10); });
    if (row.next_follow_up_at) { const date = new Date(row.next_follow_up_at); values.next_follow_up_at = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
    form.setFieldsValue(values); setEditing(row);
  };
  const save = async () => {
    const values = await form.validateFields();
    const payload = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value || null]));
    if (payload.next_follow_up_at) payload.next_follow_up_at = new Date(payload.next_follow_up_at).toISOString();
    setSaving(true);
    try { await axios.put(`/api/campaigns/${campaignId}/tasks/${editing.task_id}/members/${editing.id}`, payload); message.success('该任务进度已保存'); setEditing(null); await load(); }
    catch (err) { message.error(err.response?.data?.error || '保存失败'); }
    finally { setSaving(false); }
  };
  const showHistory = async (row) => {
    setHistory({ member: row, loading: true }); setContactText('');
    try { const res = await axios.get(`/api/campaigns/${campaignId}/tasks/${row.task_id}/members/${row.id}/timeline`); setHistory({ member: row, ...res.data.data }); }
    catch (err) { setHistory({ member: row, error: err.response?.data?.error || '记录加载失败' }); }
  };
  const contact = async () => {
    setSaving(true);
    try { const row = history.member; await axios.post(`/api/campaigns/${campaignId}/tasks/${row.task_id}/members/${row.id}/contact`, { summary: contactText }); await showHistory(row); await load(); }
    catch (err) { message.error(err.response?.data?.error || '补录失败'); }
    finally { setSaving(false); }
  };
  const changeFilter = (setter) => (value) => { setter(value); setSelected([]); };
  return <Space direction="vertical" style={{ width: '100%' }}>
    <Space wrap>
      <Select allowClear aria-label="筛选产品任务" placeholder="产品任务" style={{ width: 230 }} value={taskFilter} onChange={changeFilter(setTaskFilter)} options={tasks.map((t) => ({ value: t.id, label: t.name }))} />
      <Select allowClear placeholder="本次触达状态" style={{ width: 150 }} value={outreach} onChange={changeFilter(setOutreach)} options={options(OUTREACH)} />
      <Checkbox checked={followUpOnly} onChange={(e) => changeFilter(setFollowUpOnly)(e.target.checked)}>仅看待跟进</Checkbox>
      <Button onClick={load}>刷新</Button>
      <Button type="primary" disabled={!selected.length} onClick={() => setMailOpen(true)}>开发信（已选{selected.length}组任务）</Button>
    </Space>
    <Alert type="info" showIcon message={`当前 ${new Set(rows.map((r) => r.customer_id)).size} 位达人、${rows.length} 组任务。同一达人可以分别推进不同产品。`} />
    {error && <Alert type="error" message={error} />}
    <Table rowKey="id" loading={loading} dataSource={rows} scroll={{ x: 1450 }} rowSelection={{ selectedRowKeys: selected, onChange: setSelected }} columns={[
      { title: '达人', dataIndex: 'kol_name', fixed: 'left', width: 160 }, { title: '产品任务', dataIndex: 'task_name', width: 230 },
      { title: '审核', dataIndex: 'review_status', render: (v) => REVIEW[v] || v },
      { title: '本次触达', dataIndex: 'outreach_status', render: (v) => OUTREACH[v] || v },
      { title: '产品意向', dataIndex: 'intent', render: (v) => INTENT[v] || v },
      { title: '合作进度', dataIndex: 'cooperation_status', render: (v) => COOPERATION[v] || v },
      { title: '下次跟进', render: (_, row) => <Space>{row.next_follow_up_at ? new Date(row.next_follow_up_at).toLocaleString('zh-CN') : '-'}{row.follow_up_due && <Tag color="orange">待跟进</Tag>}</Space> },
      { title: '要求 / 承诺发布', render: (_, row) => `${dateText(row.publish_due_at)} / ${dateText(row.agreed_publish_at)}` },
      { title: '操作', fixed: 'right', width: 140, render: (_, row) => <Space direction="vertical"><Button size="small" onClick={() => openEdit(row)}>审核与进度</Button><Button size="small" onClick={() => showHistory(row)}>触达记录</Button></Space> }
    ]} />
    <Modal title={editing ? `${editing.kol_name} · ${editing.task_name}` : ''} open={!!editing} onCancel={() => setEditing(null)} onOk={save} confirmLoading={saving} width={700}>
      <Form layout="vertical" form={form}>
        <Space align="start" wrap>
          <Form.Item label={FIELD_LABELS.review_status} name="review_status"><Select style={{ width: 160 }} options={options(REVIEW)} /></Form.Item>
          <Form.Item label={FIELD_LABELS.intent} name="intent"><Select style={{ width: 160 }} options={options(INTENT)} /></Form.Item>
          <Form.Item label={FIELD_LABELS.cooperation_status} name="cooperation_status"><Select style={{ width: 160 }} options={options(COOPERATION)} /></Form.Item>
          <Form.Item label={FIELD_LABELS.next_follow_up_at} name="next_follow_up_at"><Input type="datetime-local" /></Form.Item>
          {dateFields.map((key) => <Form.Item key={key} label={FIELD_LABELS[key]} name={key}><Input type="date" /></Form.Item>)}
          <Form.Item label={FIELD_LABELS.quoted_fee} name="quoted_fee"><Input /></Form.Item>
        </Space>
        <Form.Item label={FIELD_LABELS.video_url} name="video_url"><Input /></Form.Item>
        <Form.Item label={FIELD_LABELS.notes} name="notes"><Input.TextArea rows={4} /></Form.Item>
      </Form>
    </Modal>
    <Drawer title={history ? `${history.member.kol_name} · 触达与合作记录` : ''} open={!!history} onClose={() => setHistory(null)} width={750}>
      {history?.loading && <div>加载中…</div>}{history?.error && <Alert type="error" message={history.error} />}
      {history && !history.loading && <>
        <Alert type="info" message="这里只展示明确关联到本任务的记录；旧项目级邮件继续在原项目记录或邮件中心查看。" />
        <Timeline style={{ marginTop: 20 }} items={[
          ...(history.events || []).map((e) => ({ at: e.occurred_at, color: 'gray', children: <div>{new Date(e.occurred_at).toLocaleString('zh-CN')} · {eventText(e)}</div> })),
          ...(history.bounces || []).map((b) => ({ at: b.received_at, color: 'red', children: <div>{new Date(b.received_at).toLocaleString('zh-CN')} · 退信（{b.bounce_type}）{b.reason}</div> })),
          ...(history.mail || []).map((m) => ({ at: m.created_at, color: m.status === 'success' ? 'green' : 'red', children: <div>{new Date(m.created_at).toLocaleString('zh-CN')} · 发信{m.status === 'success' ? '成功' : '失败'}<h4>{m.subject}</h4><div style={{ whiteSpace: 'pre-wrap' }}>{m.body_text}</div></div> })),
          ...(history.replies || []).map((m) => ({ at: m.received_at, color: 'blue', children: <div>{new Date(m.received_at).toLocaleString('zh-CN')} · 达人回复<h4>{m.subject}</h4><div style={{ whiteSpace: 'pre-wrap' }}>{m.body_text}</div></div> }))
        ].sort((a, b) => new Date(b.at) - new Date(a.at))} />
        <Input.TextArea aria-label="人工联系摘要" rows={3} placeholder="补录电话、微信等已完成联系，记录渠道和内容" value={contactText} onChange={(e) => setContactText(e.target.value)} />
        <Button style={{ marginTop: 10 }} loading={saving} disabled={!contactText.trim()} onClick={contact}>补录有效触达</Button>
      </>}
    </Drawer>
    <TaskOutreachModal open={mailOpen} onClose={() => setMailOpen(false)} campaignId={campaignId} memberIds={selected} onSent={load} />
  </Space>;
}
