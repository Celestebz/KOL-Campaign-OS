import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Collapse, Empty, message, Popconfirm, Row, Select, Space, Spin, Statistic, Table, Tabs, Tag, Typography } from 'antd';
import { ExceptionOutlined, MailOutlined, ProjectOutlined, RobotOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getWorkbench, submitCandidateDecisions } from './workbenchApi';
import { getItemType, sortItemsByRisk } from './constants';
import DecisionCard from './DecisionCard';
import ExceptionProblemCard from './ExceptionProblemCard';
import DecisionDrawer from './DecisionDrawer';
import RecentDecisions from './RecentDecisions';
import './Workbench.css';
import { notifyCampaignProgressChanged } from '../campaignProgressSync';

const POLL_INTERVAL = 30 * 1000;

function groupByCampaign(items) {
  const groups = new Map();
  items.forEach((item) => {
    const key = String(item.campaign_id);
    if (!groups.has(key)) groups.set(key, {
      key,
      campaignId: item.campaign_id,
      name: item.campaign_name || `项目 #${item.campaign_id}`,
      items: []
    });
    groups.get(key).items.push(item);
  });
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length);
}

function itemCounts(items) {
  return items.reduce((counts, item) => ({ ...counts, [item.type]: (counts[item.type] || 0) + 1 }), {});
}

function Workbench() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState(['approvals', 'exceptions', 'running', 'recent'].includes(requestedTab) ? requestedTab : 'approvals');
  const [campaignId, setCampaignId] = useState(searchParams.get('campaign_id') || 'all');
  const [data, setData] = useState({ summary: {}, items: [], exception_groups: [], recent_decisions: [], active_runs: [] });
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedCandidates, setSelectedCandidates] = useState([]);
  const [bulkLoading, setBulkLoading] = useState(false);

  const fetchWorkbench = useCallback(async () => {
    try { setData(await getWorkbench()); } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchWorkbench();
    const timer = setInterval(fetchWorkbench, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchWorkbench]);

  const approvals = useMemo(() => sortItemsByRisk(data.items).filter((item) =>
    item.type !== 'exception' && (campaignId === 'all' || String(item.campaign_id) === campaignId)
  ), [data.items, campaignId]);
  const exceptions = data.items.filter((item) => item.type === 'exception' && (campaignId === 'all' || String(item.campaign_id) === campaignId));
  const exceptionGroups = useMemo(() => data.exception_groups.map((group) => ({
    ...group,
    item_ids: group.item_ids.filter((id) => exceptions.some((item) => item.id === id))
  })).filter((group) => group.item_ids.length).map((group) => ({ ...group, affected_count: group.item_ids.length })), [data.exception_groups, exceptions]);
  const projectGroups = useMemo(() => groupByCampaign(approvals), [approvals]);
  const campaigns = useMemo(() => groupByCampaign(data.items.filter((item) => item.campaign_id)).map((group) => ({ value: group.key, label: group.name })), [data.items]);
  const replyCount = data.items.filter((item) => item.type === 'reply').length;
  const selected = selectedId ? data.items.find((item) => item.id === selectedId) || null : null;
  const activeRuns = data.active_runs.filter((item) => campaignId === 'all' || String(item.campaign_id) === campaignId);

  useEffect(() => { if (selectedId && !selected) setSelectedId(null); }, [selectedId, selected]);
  useEffect(() => { setSelectedCandidates((ids) => ids.filter((id) => approvals.some((item) => item.approval_item_id === id))); }, [approvals]);

  const changeTab = (key) => {
    setActiveTab(key);
    const next = new URLSearchParams(searchParams);
    if (key === 'approvals') next.delete('tab'); else next.set('tab', key);
    setSearchParams(next, { replace: true });
  };

  const changeCampaign = (value) => {
    setCampaignId(value);
    setSelectedCandidates([]);
    const next = new URLSearchParams(searchParams);
    if (value === 'all') next.delete('campaign_id'); else next.set('campaign_id', value);
    setSearchParams(next, { replace: true });
  };

  const bulkDecision = async (decision, candidatePool) => {
    const chosen = candidatePool.filter((item) => selectedCandidates.includes(item.approval_item_id));
    if (!chosen.length) return;
    setBulkLoading(true);
    try {
      const result = await submitCandidateDecisions(chosen, decision);
      if (result.failed) message.warning(`已处理 ${result.succeeded} 位，${result.failed} 位处理失败`);
      else message.success(`已${decision === 'approve' ? '通过' : '淘汰'} ${result.succeeded} 位候选达人`);
      if (result.succeeded > 0) notifyCampaignProgressChanged(chosen.map((item) => item.campaign_id));
      setSelectedCandidates([]);
      await fetchWorkbench();
    } catch (error) {
      message.error(error.response?.data?.error || '批量审核失败');
    } finally {
      setBulkLoading(false);
    }
  };

  const candidateColumns = [
    { title: '候选达人', dataIndex: 'title', render: (value) => value.replace(' · 候选达人待审核', '') },
    { title: '关键信息', dataIndex: 'facts', render: (facts) => (facts || []).slice(1, 3).join('；') || '-' },
    { title: '风险', render: (_, item) => item.risks?.length ? <Tag color="orange">{item.risks.length} 项待确认</Tag> : <Tag color="green">无已知风险</Tag> },
    { title: '', width: 90, render: (_, item) => <Button size="small" onClick={() => setSelectedId(item.id)}>查看判断</Button> }
  ];

  const projectPanel = (group) => {
    const counts = itemCounts(group.items);
    const candidates = group.items.filter((item) => item.type === 'candidate');
    const otherItems = group.items.filter((item) => item.type !== 'candidate');
    const selectedInGroup = selectedCandidates.filter((id) => candidates.some((item) => item.approval_item_id === id));
    const nextType = otherItems[0]?.type || (candidates.length ? 'candidate' : null);
    const nextLabel = nextType ? getItemType(nextType).label : '暂无待办';
    return {
      key: group.key,
      label: (
        <div className="workbench-project-label">
          <div><Typography.Text strong>{group.name}</Typography.Text><Typography.Text type="secondary">下一步：{nextLabel}</Typography.Text></div>
          <Space wrap>{Object.entries(counts).map(([type, count]) => <Tag key={type} color={getItemType(type).color}>{getItemType(type).label} {count}</Tag>)}</Space>
        </div>
      ),
      children: (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {otherItems.map((item) => <DecisionCard key={item.id} item={item} onOpen={(current) => setSelectedId(current.id)} />)}
          {candidates.length > 0 && (
            <Card size="small" title={`候选达人池（${candidates.length}）`} extra={
              <Space>
                <Typography.Text type="secondary">已选 {selectedInGroup.length} 位</Typography.Text>
                <Popconfirm title="确认批量通过选中的候选达人？" onConfirm={() => bulkDecision('approve', candidates)}><Button type="primary" size="small" loading={bulkLoading} disabled={!selectedInGroup.length}>批量通过</Button></Popconfirm>
                <Popconfirm title="确认批量淘汰选中的候选达人？" onConfirm={() => bulkDecision('reject', candidates)}><Button danger size="small" loading={bulkLoading} disabled={!selectedInGroup.length}>批量淘汰</Button></Popconfirm>
              </Space>
            }>
              <Table
                rowKey="approval_item_id"
                size="small"
                columns={candidateColumns}
                dataSource={candidates}
                rowSelection={{ selectedRowKeys: selectedCandidates, onChange: setSelectedCandidates, preserveSelectedRowKeys: true }}
                pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 位` }}
              />
            </Card>
          )}
        </Space>
      )
    };
  };

  const runColumns = [
    { title: '项目', dataIndex: 'campaign_name' }, { title: 'AI 正在执行', dataIndex: 'task_name' },
    { title: '进度', render: (_, row) => `${row.completed || 0}/${row.total || 0}` },
    { title: '当前节点', dataIndex: 'current_node' }, { title: '预计下一步', dataIndex: 'next_step' }
  ];

  const approvalContent = loading ? <div className="workbench-loading"><Spin /></div> : projectGroups.length ? (
    <Collapse className="workbench-projects" defaultActiveKey={projectGroups.slice(0, 1).map((group) => group.key)} items={projectGroups.map(projectPanel)} />
  ) : <Card><Empty description="当前没有需要你决定的事项" /></Card>;

  return (
    <div className="workbench-page">
      <Row gutter={16} className="workbench-summary">
        <Col xs={24} md={8}><Card><Statistic title="有待办的进行中项目" value={groupByCampaign(data.items.filter((item) => item.type !== 'exception')).length} prefix={<ProjectOutlined />} /></Card></Col>
        <Col xs={24} md={8}><Card><Statistic title="等待我方回复" value={replyCount} valueStyle={{ color: replyCount ? '#1677ff' : undefined }} prefix={<MailOutlined />} /></Card></Col>
        <Col xs={24} md={8}><Card><Statistic title="需要处理的系统问题" value={data.summary.exceptions || 0} suffix={data.summary.exception_records ? `（${data.summary.exception_records} 条记录）` : undefined} valueStyle={{ color: data.summary.exceptions ? '#d4380d' : undefined }} prefix={<ExceptionOutlined />} /></Card></Col>
      </Row>

      {data.summary.unmatched_replies > 0 && <Alert className="workbench-inbox-alert" type="warning" showIcon message={`${data.summary.unmatched_replies} 封新邮件尚未匹配到项目`} description="这些邮件已从审核队列分流，不会干扰项目决策。请先到邮件中心完成归属。" action={<Button onClick={() => navigate('/emails')}>去邮件中心</Button>} />}

      <Card className="workbench-toolbar"><Space wrap><Typography.Text strong>查看范围</Typography.Text><Select value={campaignId} style={{ width: 260 }} options={[{ value: 'all', label: '全部进行中项目' }, ...campaigns]} onChange={changeCampaign} /></Space></Card>

      <Tabs activeKey={activeTab} onChange={changeTab} items={[
        { key: 'approvals', label: `项目决策 ${approvals.length}`, children: approvalContent },
        { key: 'exceptions', label: `系统问题 ${exceptionGroups.length}`, children: exceptionGroups.length ? exceptionGroups.map((group) => <ExceptionProblemCard key={group.key} group={group} items={exceptions} onOpen={(current) => setSelectedId(current.id)} />) : <Card><Empty description="当前没有影响进行中项目的系统问题" /></Card> },
        { key: 'running', label: <span><RobotOutlined /> AI 执行中 {activeRuns.length}</span>, children: <Card><Table rowKey={(row) => `${row.source}:${row.id}`} columns={runColumns} dataSource={activeRuns} pagination={false} /></Card> },
        { key: 'recent', label: '最近已处理', children: <Card><RecentDecisions items={data.recent_decisions} /></Card> }
      ]} />

      <DecisionDrawer item={selected} open={Boolean(selectedId)} onClose={() => setSelectedId(null)} onRefresh={fetchWorkbench} />
    </div>
  );
}

export default Workbench;
