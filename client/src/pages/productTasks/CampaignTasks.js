import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Upload, message } from 'antd';
import axios from 'axios';
import { Link } from 'react-router-dom';
import { dateText } from './taskLabels';

export default function CampaignTasks({ campaignId }) {
  const [tasks, setTasks] = useState([]);
  const [products, setProducts] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importRows, setImportRows] = useState(null);
  const [importSelection, setImportSelection] = useState([]);
  const [importing, setImporting] = useState(false);
  const [form] = Form.useForm();
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [a, b] = await Promise.all([axios.get(`/api/campaigns/${campaignId}/tasks`), axios.get(`/api/campaigns/${campaignId}/products`)]);
      setTasks(a.data.data || []); setProducts(b.data.data || []);
    } catch (err) { setError(err.response?.data?.error || '产品任务加载失败'); }
    finally { setLoading(false); }
  }, [campaignId]);
  useEffect(() => { load(); }, [load]);
  const edit = (task = {}) => {
    form.resetFields();
    form.setFieldsValue({ task_type: 'recruitment', status: 'active', priority: 0, ...task,
      campaign_product_ids: task.products?.map((p) => p.campaign_product_id) || [] });
    setEditing(task);
  };
  const save = async () => {
    let values;
    try { values = await form.validateFields(); } catch (_) { return; }
    setSaving(true);
    try {
      const body = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === '' || value === undefined ? null : value]));
      if (editing.id) await axios.put(`/api/campaigns/${campaignId}/tasks/${editing.id}`, body);
      else await axios.post(`/api/campaigns/${campaignId}/tasks`, body);
      setEditing(null); message.success('产品任务已保存'); await load();
    } catch (err) { message.error(err.response?.data?.error || '保存失败'); }
    finally { setSaving(false); }
  };
  const previewImport = async (file) => {
    setImporting(true);
    try {
      const data = new FormData(); data.append('file', file);
      const res = await axios.post(`/api/campaigns/${campaignId}/tasks/import-preview`, data);
      const values = res.data.data || [];
      setImportRows(values); setImportSelection(values.filter((r) => !r.errors.length).map((r) => r.source_row));
    } catch (err) { message.error(err.response?.data?.error || '任务清单读取失败'); }
    finally { setImporting(false); }
    return false;
  };
  const confirmImport = async () => {
    setImporting(true);
    try {
      const res = await axios.post(`/api/campaigns/${campaignId}/tasks/import`, {
        rows: importRows.filter((r) => importSelection.includes(r.source_row)).map((r) => r.task)
      });
      message.success(`已新增 ${(res.data.data || []).filter((r) => r.created).length} 条任务；重复导入保留原进度`);
      setImportRows(null); await load();
    } catch (err) { message.error(err.response?.data?.error || '导入失败，未提交本批次'); }
    finally { setImporting(false); }
  };
  return <Space direction="vertical" style={{ width: '100%' }}>
    <Space><Button type="primary" onClick={() => edit()}>新增产品任务</Button>
      <Upload accept=".xlsx,.xls" showUploadList={false} beforeUpload={previewImport}><Button loading={importing}>导入任务清单</Button></Upload>
      <Button onClick={load}>刷新任务</Button></Space>
    <Alert type="info" showIcon message="每条任务独立设置产品、审核与发布时间。样品数量、候选人数和完成交付分别统计。" />
    {error && <Alert type="error" message={error} />}
    <Table rowKey="id" loading={loading} dataSource={tasks} scroll={{ x: 1500 }} columns={[
      { title: '任务 / 产品', width: 250, render: (_, row) => <Space direction="vertical"><strong>{row.name}</strong><Space wrap>{row.products?.map((p) => <Tag key={p.campaign_product_id}>{p.sku || p.name}</Tag>)}</Space>{row.task_type === 'delivery_follow_up' && <Tag>历史催交付</Tag>}</Space> },
      { title: '状态', dataIndex: 'status', render: (value) => ({ active: '进行中', paused: '暂停', completed: '完成', archived: '归档' })[value] || value },
      { title: '名单审批期限', dataIndex: 'approval_due_at', render: dateText },
      { title: '发布窗口', render: (_, row) => `${dateText(row.publish_from)} ～ ${dateText(row.publish_due_at)}` },
      { title: '送测数量', render: (_, row) => row.sample_min == null && row.sample_max == null ? '未确认' : `${row.sample_min ?? '?'}～${row.sample_max ?? '?'}` },
      { title: '名单 / 合格目标', render: (_, row) => `${row.counts?.candidates || 0} / ${row.candidate_target ?? '未确认'}` },
      { title: '审核通过', render: (_, row) => row.counts?.approved || 0 },
      { title: '已触达', render: (_, row) => row.counts?.contacted || 0 },
      { title: '确认合作', render: (_, row) => row.counts?.cooperating || 0 },
      { title: '已交付', render: (_, row) => row.counts?.delivered || 0 },
      { title: '负责人', dataIndex: 'owner' },
      { title: '排期提醒', render: (_, row) => {
        const today = new Date().toLocaleDateString('sv-SE');
        if (row.status !== 'active') return '-';
        if (row.publish_due_at && row.publish_due_at < today) return <Tag color="orange">发布期限已过，请核实</Tag>;
        if (!row.publish_due_at) return <Tag>发布期限待确认</Tag>;
        if (row.approval_due_at && row.approval_due_at < today) return <Tag>审批期限已过，请核实</Tag>;
        return '-';
      } },
      { title: '操作', fixed: 'right', width: 170, render: (_, row) => <Space direction="vertical"><Link to={`/customers?campaign_id=${campaignId}&task_id=${row.id}`}>从资源库选人</Link><Button size="small" onClick={() => edit(row)}>编辑任务</Button></Space> }
    ]} />
    <Modal title={editing?.id ? '编辑产品任务' : '新增产品任务'} open={!!editing} onCancel={() => setEditing(null)} onOk={save} confirmLoading={saving} width={700}>
      <Form layout="vertical" form={form}>
        <Form.Item name="name" label="任务名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={255} /></Form.Item>
        <Form.Item name="campaign_product_ids" label="推广产品（多选为一个组合）" rules={[{ required: true, type: 'array', min: 1 }]}>
          <Select mode="multiple" options={products.filter((p) => p.status === 'active').map((p) => ({ value: p.id, label: `${p.product?.sku || '-'} · ${p.product?.name || ''}` }))} />
        </Form.Item>
        <Space align="start" wrap>
          <Form.Item name="task_type" label="任务类型"><Select style={{ width: 150 }} options={[{ value: 'recruitment', label: '找人合作' }, { value: 'delivery_follow_up', label: '历史催交付' }]} /></Form.Item>
          <Form.Item name="status" label="任务状态"><Select style={{ width: 120 }} options={['active', 'paused', 'completed', 'archived'].map((v, i) => ({ value: v, label: ['进行中', '暂停', '完成', '归档'][i] }))} /></Form.Item>
          <Form.Item name="priority" label="优先级（越大越优先）"><InputNumber min={0} max={1000000} /></Form.Item>
          <Form.Item name="owner" label="负责人"><Input /></Form.Item>
          <Form.Item name="approval_due_at" label="名单审批期限"><Input type="date" /></Form.Item>
          <Form.Item name="publish_from" label="发布窗口开始"><Input type="date" /></Form.Item>
          <Form.Item name="publish_due_at" label="发布截止日期"><Input type="date" /></Form.Item>
          <Form.Item name="sample_min" label="送测数量下限"><InputNumber min={0} precision={0} /></Form.Item>
          <Form.Item name="sample_max" label="送测数量上限"><InputNumber min={0} precision={0} /></Form.Item>
          <Form.Item name="candidate_target" label="合格候选目标"><InputNumber min={0} precision={0} /></Form.Item>
        </Space>
        <Form.Item name="requirements" label="达人与交付要求"><Input.TextArea rows={4} /></Form.Item>
      </Form>
    </Modal>
    <Modal title="任务清单导入预览" open={!!importRows} width={1100} onCancel={() => setImportRows(null)}
      onOk={confirmImport} confirmLoading={importing} okText={`确认导入 ${importSelection.length} 条`} okButtonProps={{ disabled: !importSelection.length }}>
      <Alert type="info" showIcon message="上传只生成预览。请核对日期和产品组合；未知日期及合格候选目标留空。有错误的行需先补齐产品或修正文件。" />
      <Table rowKey="source_row" size="small" dataSource={importRows || []} scroll={{ x: 950 }} rowSelection={{ selectedRowKeys: importSelection, onChange: setImportSelection, getCheckboxProps: (row) => ({ disabled: !!row.errors.length }) }} columns={[
        { title: '原行', dataIndex: 'source_row', width: 60 },
        { title: '任务', render: (_, row) => row.task.name },
        { title: '产品', render: (_, row) => row.skus.join(' + ') },
        { title: '类型', render: (_, row) => row.task.task_type === 'delivery_follow_up' ? '历史催交付' : '找人合作' },
        { title: '审批 / 发布', render: (_, row) => `${dateText(row.task.approval_due_at)} / ${dateText(row.task.publish_due_at)}` },
        { title: '核对项', width: 320, render: (_, row) => <Space direction="vertical">{row.errors.map((text) => <span key={text} style={{ color: '#cf1322' }}>{text}</span>)}{row.warnings.map((text) => <span key={text}>{text}</span>)}</Space> }
      ]} />
    </Modal>
  </Space>;
}
