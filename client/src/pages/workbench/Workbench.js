import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Col, Empty, Row, Select, Space, Spin, Statistic, Table, Tabs } from 'antd';
import { ExceptionOutlined, HourglassOutlined, RobotOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import { getWorkbench } from './workbenchApi';
import { sortItemsByRisk } from './constants';
import DecisionCard from './DecisionCard';
import ExceptionCard from './ExceptionCard';
import DecisionDrawer from './DecisionDrawer';
import RecentDecisions from './RecentDecisions';
import './Workbench.css';

const POLL_INTERVAL = 30 * 1000;

function Workbench() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const initialTab = ['approvals', 'exceptions', 'running', 'recent'].includes(requestedTab)
    ? requestedTab : (searchParams.get('type') === 'exception' ? 'exceptions' : 'approvals');
  const [activeTab, setActiveTab] = useState(initialTab);
  const [campaignId, setCampaignId] = useState(searchParams.get('campaign_id') || 'all');
  const [type, setType] = useState(searchParams.get('type') || 'all');
  const [risk, setRisk] = useState('all');
  const [data, setData] = useState({ summary: {}, items: [], recent_decisions: [], active_runs: [] });
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);

  const fetchWorkbench = useCallback(async () => {
    try { setData(await getWorkbench()); } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchWorkbench();
    const timer = setInterval(fetchWorkbench, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchWorkbench]);

  const campaigns = useMemo(() => {
    const values = [...data.items, ...data.active_runs]
      .filter((item) => item.campaign_id)
      .map((item) => [String(item.campaign_id), item.campaign_name || `项目 #${item.campaign_id}`]);
    return [...new Map(values).entries()].map(([value, label]) => ({ value, label }));
  }, [data]);

  const filteredItems = useMemo(() => sortItemsByRisk(data.items).filter((item) =>
    (campaignId === 'all' || String(item.campaign_id) === campaignId)
    && (type === 'all' || item.type === type)
    && (risk === 'all' || item.risk_level === risk)
  ), [data.items, campaignId, type, risk]);
  const approvals = filteredItems.filter((item) => item.type !== 'exception');
  const exceptions = filteredItems.filter((item) => item.type === 'exception');
  const activeRuns = data.active_runs.filter((item) => campaignId === 'all' || String(item.campaign_id) === campaignId);
  const selected = selectedId ? data.items.find((item) => item.id === selectedId) || null : null;

  useEffect(() => { if (selectedId && !selected) setSelectedId(null); }, [selectedId, selected]);

  const changeTab = (key) => {
    setActiveTab(key);
    const next = new URLSearchParams(searchParams);
    if (key === 'exceptions') next.set('tab', 'exceptions'); else next.delete('tab');
    setSearchParams(next, { replace: true });
  };

  const changeCampaign = (value) => {
    setCampaignId(value);
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete('campaign_id'); else next.set('campaign_id', value);
    setSearchParams(next, { replace: true });
  };

  const changeType = (value) => {
    setType(value);
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete('type'); else next.set('type', value);
    setSearchParams(next, { replace: true });
  };

  const queue = (items, emptyText, exception = false) => loading
    ? <div className="workbench-loading"><Spin /></div>
    : items.length === 0
      ? <Card><Empty description={emptyText} /></Card>
      : items.map((item) => exception
        ? <ExceptionCard key={item.id} item={item} onOpen={(current) => setSelectedId(current.id)} />
        : <DecisionCard key={item.id} item={item} onOpen={(current) => setSelectedId(current.id)} />);

  const runColumns = [
    { title: '项目', dataIndex: 'campaign_name', render: (value, row) => value || `项目 #${row.campaign_id || '-'}` },
    { title: 'AI 正在执行', dataIndex: 'task_name' },
    { title: '进度', render: (_, row) => `${row.completed || 0}/${row.total || 0}` },
    { title: '当前节点', dataIndex: 'current_node', render: (value) => value || '执行中' },
    { title: '开始时间', dataIndex: 'started_at', render: (value) => value ? new Date(value).toLocaleString('zh-CN') : '-' },
    { title: '预计下一步', dataIndex: 'next_step' }
  ];

  return (
    <div className="workbench-page">
      <Row gutter={16} className="workbench-summary">
        <Col xs={24} md={8}><Card><Statistic title="待我审核" value={data.summary.pending || 0} prefix={<HourglassOutlined />} /></Card></Col>
        <Col xs={24} md={8}><Card><Statistic title="异常待处理" value={data.summary.exceptions || 0} valueStyle={{ color: '#d4380d' }} prefix={<ExceptionOutlined />} /></Card></Col>
        <Col xs={24} md={8}><Card><Statistic title="AI 执行中" value={data.summary.active_runs || 0} valueStyle={{ color: '#1677ff' }} prefix={<RobotOutlined />} /></Card></Col>
      </Row>

      <Card className="workbench-toolbar">
        <Space wrap>
          <Select value={campaignId} style={{ width: 220 }} options={[{ value: 'all', label: '全部项目' }, ...campaigns]} onChange={changeCampaign} />
          <Select value={type} style={{ width: 160 }} options={[{ value: 'all', label: '全部审核类型' }, ...Object.entries({ strategy: '项目需求与达人策略', candidate: '候选达人', outreach: '对外沟通', reply: '达人回复', budget: '预算与履约', exception: '异常处理' }).map(([value, label]) => ({ value, label }))]} onChange={changeType} />
          <Select value={risk} style={{ width: 130 }} options={[{ value: 'all', label: '全部风险' }, { value: 'high', label: '高风险' }, { value: 'low', label: '低风险' }, { value: 'none', label: '无风险' }]} onChange={setRisk} />
        </Space>
      </Card>

      <Tabs activeKey={activeTab} onChange={changeTab} items={[
        { key: 'approvals', label: `待我审核 ${approvals.length}`, children: queue(approvals, 'AI 正在后台工作，暂无需要你审核的事项') },
        { key: 'exceptions', label: `异常处理 ${exceptions.length}`, children: queue(exceptions, '当前没有需要人工处理的异常', true) },
        { key: 'running', label: `AI 执行中 ${activeRuns.length}`, children: <Card><Table rowKey={(row) => `${row.source}:${row.id}`} columns={runColumns} dataSource={activeRuns} pagination={false} locale={{ emptyText: '当前没有正在执行的 AI 任务' }} /></Card> },
        { key: 'recent', label: '最近已处理', children: <Card><RecentDecisions items={data.recent_decisions} /></Card> }
      ]} />

      <DecisionDrawer item={selected} open={Boolean(selectedId)} onClose={() => setSelectedId(null)} onRefresh={fetchWorkbench} />
    </div>
  );
}

export default Workbench;
