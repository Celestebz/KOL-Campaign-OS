import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppstoreOutlined,
  BarsOutlined,
  ClockCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SettingOutlined,
  TeamOutlined
} from '@ant-design/icons';
import {
  Badge, Button, Card, Col, Empty, Input, message, Row, Segmented, Select, Space, Spin,
  Statistic, Table, Tag, Tooltip, Typography
} from 'antd';
import { Link } from 'react-router-dom';
import axios from 'axios';
import {
  CAMPAIGN_STAGES,
  normalizeCampaignProgress,
  progressSort
} from './campaignProgress';
import CampaignCreateModal from './CampaignCreateModal';
import CampaignManageModal from './CampaignManageModal';
import { subscribeCampaignProgressChanged } from './campaignProgressSync';
import './Campaigns.css';

const VIEW_STORAGE_KEY = 'campaign-management-view';

function formatUpdatedAt(value) {
  if (!value) return '暂无更新';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无更新';
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function parseDeadline(value) {
  if (!value) return null;
  const match = String(value).match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/);
  if (!match) return null;
  const date = new Date(match[0].replaceAll('/', '-'));
  return Number.isNaN(date.getTime()) ? null : date;
}

function deadlineMeta(value) {
  const date = parseDeadline(value);
  if (!date) return { label: value || '未设置截止日', urgent: false, overdue: false };
  const days = Math.ceil((date.getTime() - Date.now()) / 86400000);
  if (days < 0) return { label: `已逾期 ${Math.abs(days)} 天`, urgent: true, overdue: true };
  if (days === 0) return { label: '今天截止', urgent: true, overdue: false };
  return { label: `${date.toLocaleDateString('zh-CN')} · 剩余 ${days} 天`, urgent: days <= 14, overdue: false };
}

function stageMetrics(row) {
  if (row.stage === 'preparation') return [['关联产品', row.detail.products?.length || 0], ['项目达人', row.totalKols]];
  if (row.stage === 'finding') return [['项目达人', row.totalKols], ['确认中', row.candidatesPendingReview]];
  if (row.stage === 'outreach') return [['已联系', row.contacted], ['已回复', row.replied]];
  if (row.stage === 'fulfillment') return [['已合作', row.confirmedKols], ['项目达人', row.totalKols]];
  const published = Number(row.detail.summary?.by_project_status?.published || 0);
  const pending = Number(row.detail.summary?.by_project_status?.pending_publish || 0);
  return [['已上线', published], ['待上线', pending]];
}

function ProjectCard({ row }) {
  const deadline = deadlineMeta(row.deadline);
  const metrics = stageMetrics(row);
  return (
    <Link to={`/campaigns/${row.id}`} className="project-board-card-link">
      <Card
        size="small"
        hoverable
        className="project-board-card"
      >
        <div className="project-card-heading">
          <div>
            <Typography.Text strong>{row.name}</Typography.Text>
            <div className="project-card-product">
              {row.primaryProductSku || row.primaryProductName || '暂未关联主推产品'}
            </div>
          </div>
          <Badge status="processing" />
        </div>

        <Space size={6} wrap className="project-card-stage">
          <Tag>{row.substage}</Tag>
          {row.finderRunning > 0 && <Tag icon={<RobotOutlined />} color="processing">AI执行中</Tag>}
        </Space>

        <Typography.Text type="secondary" className="project-card-deadline">
          <ClockCircleOutlined /> {deadline.label}
        </Typography.Text>

        <div className="project-card-progress">
          <div className="project-card-progress-label">
            <span>已合作 <strong>{row.confirmedKols}</strong></span>
            <span>项目达人 <strong>{row.totalKols}</strong></span>
          </div>
        </div>

        <div className="project-card-metrics">
          {metrics.map(([label, value]) => (
            <div key={label}><strong>{value}</strong><span>{label}</span></div>
          ))}
        </div>

        <div className="project-card-next">
          <span>下一步</span>
          <Typography.Paragraph ellipsis={{ rows: 2 }}>{row.nextStep}</Typography.Paragraph>
        </div>

        <div className="project-card-footer">
          <span>{CAMPAIGN_STAGES.find((item) => item.key === row.stage)?.label}</span>
          <span>{formatUpdatedAt(row.updated_at)} 更新</span>
        </div>
      </Card>
    </Link>
  );
}

function BoardView({ campaigns, loading }) {
  if (loading) return <div className="project-loading"><Spin size="large" /></div>;
  return (
    <div className="project-board">
      {CAMPAIGN_STAGES.map((stage) => {
        const rows = campaigns.filter((item) => item.stage === stage.key).sort(progressSort);
        const helper = `${rows.length} 个项目`;
        return (
          <section key={stage.key} className="project-board-column">
            <header>
              <div><strong>{stage.label}</strong><Badge count={rows.length} showZero color="#1677ff" /></div>
              <span>{helper}</span>
            </header>
            <div className="project-board-column-content">
              {rows.length ? rows.map((row) => <ProjectCard key={row.id} row={row} />) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无项目" />
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ListView({ campaigns, loading }) {
  const columns = [
    {
      title: '项目', dataIndex: 'name', key: 'name', width: 210,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Link to={`/campaigns/${row.id}`}><Typography.Text strong>{row.name}</Typography.Text></Link>
          <Typography.Text type="secondary">{row.primaryProductSku || row.primaryProductName || '未关联主推产品'}</Typography.Text>
        </Space>
      )
    },
    {
      title: '当前阶段', dataIndex: 'stage', key: 'stage', width: 150,
      filters: CAMPAIGN_STAGES.map((stage) => ({ text: stage.label, value: stage.key })),
      onFilter: (value, row) => row.stage === value,
      render: (_, row) => <Space direction="vertical" size={2}><Tag>{CAMPAIGN_STAGES.find((item) => item.key === row.stage)?.label}</Tag><span>{row.substage}</span></Space>
    },
    {
      title: '达人进度', key: 'kolProgress', width: 150,
      sorter: (a, b) => a.confirmedKols - b.confirmedKols,
      render: (_, row) => <div className="project-list-progress"><strong>{row.confirmedKols}</strong> 已合作<br /><Typography.Text type="secondary">{row.totalKols} 位项目达人</Typography.Text></div>
    },
    { title: '截止日期', dataIndex: 'deadline', key: 'deadline', width: 160, render: (value) => <Typography.Text>{deadlineMeta(value).label}</Typography.Text> },
    { title: '下一步', dataIndex: 'nextStep', key: 'nextStep', ellipsis: true, render: (value) => <Tooltip title={value}>{value}</Tooltip> },
    { title: '最近更新', dataIndex: 'updated_at', key: 'updated_at', width: 130, sorter: (a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')), render: formatUpdatedAt }
  ];
  return (
    <Card className="content-card project-list-card">
      <Table columns={columns} dataSource={campaigns} rowKey="id" loading={loading} scroll={{ x: 900 }} pagination={{ defaultPageSize: 20, showSizeChanger: true }} />
    </Card>
  );
}

function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchText, setSearchText] = useState('');
  const [stageFilter, setStageFilter] = useState('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [view, setView] = useState(() => window.localStorage.getItem(VIEW_STORAGE_KEY) || 'board');

  const fetchCampaigns = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const listResponse = await axios.get('/api/campaigns');
      const baseRows = listResponse.data.data || [];
      const details = await Promise.allSettled(baseRows.map((row) => axios.get(`/api/campaigns/${row.id}/detail`)));
      const normalized = baseRows.map((row, index) => {
        const result = details[index];
        if (result.status === 'fulfilled') return normalizeCampaignProgress(result.value.data.data || {});
        return normalizeCampaignProgress({ campaign: row, summary: {}, risks: ['项目进度加载失败'], next_step: '请刷新后重试' });
      });
      setCampaigns(normalized.sort(progressSort));
    } catch (error) {
      if (!silent) {
        message.error(error.response?.data?.error || '获取项目进度失败');
        setCampaigns([]);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const refreshCampaigns = useCallback(async (campaignIds) => {
    const ids = [...new Set((campaignIds || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length) return fetchCampaigns({ silent: true });
    const results = await Promise.allSettled(ids.map((id) => axios.get(`/api/campaigns/${id}/detail`)));
    setCampaigns((current) => {
      const updates = new Map();
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') updates.set(ids[index], normalizeCampaignProgress(result.value.data.data || {}));
      });
      return current.map((item) => updates.get(Number(item.id)) || item).sort(progressSort);
    });
  }, [fetchCampaigns]);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

  useEffect(() => {
    const unsubscribe = subscribeCampaignProgressChanged(({ campaignIds }) => refreshCampaigns(campaignIds));
    const refreshOnFocus = () => fetchCampaigns({ silent: true });
    window.addEventListener('focus', refreshOnFocus);
    const timer = window.setInterval(() => fetchCampaigns({ silent: true }), 30 * 1000);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', refreshOnFocus);
      window.clearInterval(timer);
    };
  }, [fetchCampaigns, refreshCampaigns]);

  const changeView = (value) => {
    setView(value);
    window.localStorage.setItem(VIEW_STORAGE_KEY, value);
  };

  const filteredCampaigns = useMemo(() => campaigns.filter((item) => {
    const term = searchText.trim().toLowerCase();
    if (term && ![item.name, item.primaryProductName, item.primaryProductSku].some((value) => String(value || '').toLowerCase().includes(term))) return false;
    if (stageFilter !== 'all' && item.stage !== stageFilter) return false;
    return true;
  }), [campaigns, searchText, stageFilter]);

  const dueSoon = campaigns.filter((item) => {
    const date = parseDeadline(item.deadline);
    if (!date) return false;
    const days = Math.ceil((date.getTime() - Date.now()) / 86400000);
    return days >= 0 && days <= 14;
  }).length;
  const aiRunningProjects = campaigns.filter((item) => item.finderRunning > 0).length;
  const confirmedTotal = campaigns.reduce((sum, item) => sum + item.confirmedKols, 0);

  return (
    <div className="campaign-management-page">
      <div className="page-header project-page-header">
        <div>
          <h1 className="page-title">项目管理</h1>
          <p className="page-subtitle">集中查看项目进度，并进入对应业务页面处理待办事项。</p>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => fetchCampaigns()} loading={loading}>刷新进度</Button>
          <Button icon={<SettingOutlined />} onClick={() => setManageOpen(true)}>管理项目</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建项目</Button>
        </Space>
      </div>

      <Row gutter={[16, 16]} className="project-summary-row">
        <Col xs={12} lg={6}><Card><Statistic title="进行中项目" value={campaigns.length} prefix={<AppstoreOutlined />} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="未来14天到期" value={dueSoon} prefix={<ClockCircleOutlined />} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="AI 推进中" value={aiRunningProjects} prefix={<RobotOutlined />} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="已合作达人" value={confirmedTotal} prefix={<TeamOutlined />} /></Card></Col>
      </Row>

      <Card className="content-card project-toolbar-card">
        <div className="project-view-toolbar">
          <Segmented
            value={view}
            onChange={changeView}
            options={[
              { value: 'board', label: '看板', icon: <AppstoreOutlined /> },
              { value: 'list', label: '列表', icon: <BarsOutlined /> }
            ]}
          />
          <Space size={[8, 8]} wrap>
            <Input.Search allowClear placeholder="搜索项目、产品或 SKU" value={searchText} onChange={(event) => setSearchText(event.target.value)} style={{ width: 250 }} />
            <Select value={stageFilter} onChange={setStageFilter} style={{ width: 140 }} options={[{ value: 'all', label: '全部阶段' }, ...CAMPAIGN_STAGES.map((item) => ({ value: item.key, label: item.label }))]} />
          </Space>
        </div>
      </Card>

      {filteredCampaigns.length === 0 && !loading ? (
        <Card className="content-card"><Empty description="没有符合当前筛选条件的项目" /></Card>
      ) : view === 'board' ? (
        <BoardView campaigns={filteredCampaigns} loading={loading} />
      ) : (
        <ListView campaigns={filteredCampaigns} loading={loading} />
      )}
      <CampaignCreateModal
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onCreated={async () => {
          setCreateOpen(false);
          await fetchCampaigns();
        }}
      />
      <CampaignManageModal
        open={manageOpen}
        onCancel={() => setManageOpen(false)}
        onChanged={fetchCampaigns}
      />
    </div>
  );
}

export default Campaigns;
