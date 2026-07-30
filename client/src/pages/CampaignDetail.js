import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Descriptions, Empty, Result, Row, Space, Spin, Statistic, Table, Tabs, Tag } from 'antd';
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { getMainStatus } from './campaignKolStatus';
import { getEmailRecords } from './emailApi';
import { subscribeCampaignProgressChanged } from './campaignProgressSync';
import { deriveCampaignStage, deriveProgressText } from './campaignProgress';
import { normalizeCampaignProductMaterial } from './campaignProductMaterial';

const STRATEGY_STATUS = {
  draft: { label: '草稿', color: 'orange' },
  ready: { label: '已发布', color: 'green' },
  archived: { label: '已归档', color: 'default' }
};

const CAMPAIGN_STATUS_LABELS = {
  planned: '计划中',
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  archived: '已归档'
};

const OUTREACH_STATUS = {
  not_contacted: { label: '待联系', color: 'default' },
  contacted: { label: '已联系', color: 'blue' },
  waiting_reply: { label: '待回复', color: 'gold' },
  replied: { label: '待回复', color: 'gold' },
  negotiating: { label: '沟通中', color: 'orange' },
  interested: { label: '有意向', color: 'green' },
  confirmed: { label: '已确认', color: 'cyan' },
  rejected: { label: '已终止', color: 'red' },
  terminated: { label: '已终止', color: 'red' }
};

const CONTENT_STATUS_LABELS = {
  pending: '待处理',
  draft: '草稿',
  review: '审核中',
  published: '已发布'
};

const CURRENCY_SYMBOLS = { GBP: '£', USD: '$', EUR: '€', CNY: '¥' };

const formatFee = (value, currency) => {
  if (value === undefined || value === null || value === '') return '-';
  const symbol = CURRENCY_SYMBOLS[currency];
  return symbol ? `${symbol}${value}` : `${value}${currency ? ` ${currency}` : ''}`;
};

const formatTime = (value) => (value ? new Date(value).toLocaleString('zh-CN') : '-');

const formatProductPrice = (product) => {
  if (product.price === undefined || product.price === null || product.price === '') return '-';
  return `${product.currency ? `${product.currency} ` : ''}${product.price}`;
};

const CampaignDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);
  const [kols, setKols] = useState([]);
  const [emailRecords, setEmailRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');

  const fetchAll = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError('');
    setNotFound(false);
    try {
      const [detailRes, kolsRes, recordsData] = await Promise.all([
        axios.get(`/api/campaigns/${id}/detail`),
        axios.get('/api/campaign-kols', { params: { campaign_id: id } }),
        getEmailRecords(null, { campaign_id: id }).catch(() => null)
      ]);
      setDetail(detailRes.data.data || null);
      setKols(kolsRes.data.data || []);
      setEmailRecords(recordsData?.records || (Array.isArray(recordsData) ? recordsData : []));
    } catch (err) {
      if (err.response?.status === 404) {
        setNotFound(true);
      } else if (!silent) {
        setError(err.response?.data?.error || '项目详情加载失败，请稍后重试');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    const currentId = Number(id);
    const unsubscribe = subscribeCampaignProgressChanged(({ campaignIds }) => {
      if (!campaignIds?.length || campaignIds.some((campaignId) => Number(campaignId) === currentId)) {
        fetchAll({ silent: true });
      }
    });
    const refreshOnFocus = () => fetchAll({ silent: true });
    window.addEventListener('focus', refreshOnFocus);
    const timer = window.setInterval(() => fetchAll({ silent: true }), 30 * 1000);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', refreshOnFocus);
      window.clearInterval(timer);
    };
  }, [fetchAll, id]);

  if (loading && !detail) {
    return (
      <div style={{ minHeight: 320, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (notFound) {
    return (
      <Result
        status="404"
        title="项目不存在"
        subTitle="未找到该项目，可能已被删除。"
        extra={<Link to="/campaigns"><Button type="primary">返回项目管理</Button></Link>}
      />
    );
  }

  if (error && !detail) {
    return (
      <div style={{ marginTop: 24 }}>
        <Alert
          type="error"
          showIcon
          message={error}
          action={<Button icon={<ReloadOutlined />} onClick={fetchAll}>重试</Button>}
        />
      </div>
    );
  }

  const campaign = detail?.campaign || {};
  const strategy = detail?.strategy || null;
  const summary = detail?.summary || {};
  const progressDetail = detail || {};
  const progressStage = deriveCampaignStage(progressDetail);
  const progressText = deriveProgressText(progressDetail, progressStage);
  const products = (Array.isArray(detail?.products) ? detail.products : []).map(normalizeCampaignProductMaterial);
  const strategyStatus = STRATEGY_STATUS[strategy?.status] || { label: strategy?.status || '暂无策略', color: 'default' };

  const overviewProductColumns = [
    { title: '产品名称', dataIndex: 'name', render: (v) => v || '-' },
    { title: 'SKU', dataIndex: 'sku', width: 140, render: (v) => v || '-' },
    { title: '品类', dataIndex: 'category', width: 140, render: (v) => v || '-' },
    { title: '卖点', dataIndex: 'sellingPoints', render: (v) => v || '-' }
  ];

  const kolColumns = [
    {
      title: '达人',
      key: 'kol',
      width: 180,
      render: (_, r) => r.kol_name || r.kol_name_snapshot || '-'
    },
    {
      title: '平台',
      key: 'platform',
      width: 110,
      render: (_, r) => r.platform_account_platform || '-'
    },
    {
      title: '阶段',
      dataIndex: 'pipeline_stage',
      key: 'pipeline_stage',
      width: 110,
      render: (v) => (v === 'confirmed'
        ? <Tag color="green">KOL合作</Tag>
        : <Tag color="blue">项目候选</Tag>)
    },
    {
      title: '主状态',
      dataIndex: 'project_status',
      key: 'project_status',
      width: 120,
      render: (v) => {
        const main = getMainStatus(v);
        return <Tag color={main.color}>{main.label}</Tag>;
      }
    },
    {
      title: '外联状态',
      dataIndex: 'outreach_status',
      key: 'outreach_status',
      width: 110,
      render: (v) => {
        if (!v) return '-';
        const item = OUTREACH_STATUS[v] || { label: v, color: 'default' };
        return <Tag color={item.color}>{item.label}</Tag>;
      }
    },
    {
      title: '报价',
      key: 'fee',
      width: 130,
      render: (_, r) => formatFee(r.final_fee ?? r.quoted_fee, r.currency)
    },
    {
      title: '样品',
      key: 'sample',
      width: 200,
      render: (_, r) => {
        const date = r.shipping_date ? String(r.shipping_date).slice(0, 10) : '';
        if (!date && !r.tracking_number) return '-';
        return (
          <Space direction="vertical" size={0}>
            {date ? <span>发货：{date}</span> : null}
            {r.tracking_number ? <span style={{ color: '#666' }}>{r.tracking_number}</span> : null}
          </Space>
        );
      }
    },
    {
      title: '内容状态',
      dataIndex: 'content_status',
      key: 'content_status',
      width: 110,
      render: (v) => (v ? (CONTENT_STATUS_LABELS[v] || v) : '-')
    },
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: 160,
      render: formatTime
    }
  ];

  const emailColumns = [
    { title: '收件人', dataIndex: 'to_address', width: 220, render: (v) => v || '-' },
    { title: '主题', dataIndex: 'subject', ellipsis: true, render: (v) => v || '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v) => <Tag color={v === 'success' ? 'green' : 'red'}>{v === 'success' ? '成功' : (v === 'failed' ? '失败' : (v || '-'))}</Tag>
    },
    { title: '时间', dataIndex: 'created_at', width: 160, render: formatTime }
  ];

  const overviewTab = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {progressText && (
        <Alert
          type="info"
          showIcon
          message="当前推进"
          description={<span style={{ fontSize: 15, fontWeight: 500 }}>{progressText}</span>}
        />
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="项目概况" size="small">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="项目目标">{strategy?.campaign_goal || '-'}</Descriptions.Item>
              <Descriptions.Item label="目标市场">{strategy?.target_market || '-'}</Descriptions.Item>
              <Descriptions.Item label="达人策略状态"><Tag color={strategyStatus.color}>{strategyStatus.label}</Tag></Descriptions.Item>
              <Descriptions.Item label="当前阶段">{progressText}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="关键数据" size="small">
            <Row gutter={[16, 16]}>
              <Col span={8}><Statistic title="项目达人" value={summary.kols_total ?? 0} /></Col>
              <Col span={8}><Statistic title="项目候选" value={summary.kols_candidate ?? 0} /></Col>
              <Col span={8}><Statistic title="KOL合作" value={summary.kols_confirmed ?? 0} /></Col>
              <Col span={8}><Statistic title="已联系" value={summary.contacted ?? 0} /></Col>
              <Col span={8}><Statistic title="已回复" value={summary.replied ?? 0} /></Col>
              <Col span={8}><Statistic title="已上线" value={summary.by_project_status?.published ?? 0} /></Col>
            </Row>
          </Card>
        </Col>
      </Row>
      <Card
        title="推广产品"
        size="small"
        extra={<Link to={`/finder?campaign_id=${campaign.id}`}><Button type="link">进入该项目的 KOL 寻找</Button></Link>}
      >
        <Table
          size="small"
          rowKey={(r) => r.id || r.name}
          columns={overviewProductColumns}
          dataSource={products}
          pagination={false}
          locale={{ emptyText: <Empty description="暂无推广产品" /> }}
        />
      </Card>
    </Space>
  );

  const progressTab = (
    <Card size="small" title={`项目达人（${kols.length}）`}>
      <Table
        size="small"
        rowKey="id"
        columns={kolColumns}
        dataSource={kols}
        loading={loading}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        locale={{ emptyText: <Empty description="该项目暂无达人" /> }}
        onRow={() => ({ onClick: () => navigate(`/campaign-kols?campaign_id=${campaign.id}`), style: { cursor: 'pointer' } })}
      />
    </Card>
  );

  const communicationTab = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="沟通与履约在专业页面处理"
        description="项目详情保留进度与事实；完整邮件、报价、物流和内容节点请进入对应业务页面。"
        action={(
          <Space wrap>
            <Link to={`/emails?campaign_id=${campaign.id}`}><Button>邮件中心</Button></Link>
            <Link to={`/campaign-kols?campaign_id=${campaign.id}`}><Button type="primary">KOL 合作</Button></Link>
          </Space>
        )}
      />
      <Card title="最近邮件记录" size="small">
        <Table
          size="small"
          rowKey="id"
          columns={emailColumns}
          dataSource={emailRecords}
          pagination={{ defaultPageSize: 10 }}
          locale={{ emptyText: <Empty description="暂无邮件记录" /> }}
        />
      </Card>
    </Space>
  );

  const materialsTab = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card title="产品资料" size="small">
        {products.length ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {products.map((product) => (
              <Card key={product.id || product.name} type="inner" title={product.name || '未命名产品'} size="small">
                <Descriptions column={2} size="small">
                  <Descriptions.Item label="SKU">{product.sku || '-'}</Descriptions.Item>
                  <Descriptions.Item label="品类">{product.category || '-'}</Descriptions.Item>
                  <Descriptions.Item label="价格">{formatProductPrice(product)}</Descriptions.Item>
                  <Descriptions.Item label="卖点">{product.sellingPoints || '-'}</Descriptions.Item>
                  <Descriptions.Item label="产品描述" span={2}>{product.description || '-'}</Descriptions.Item>
                  <Descriptions.Item label="项目产品简报" span={2}>{product.campaignBrief || '-'}</Descriptions.Item>
                  <Descriptions.Item label="产品链接" span={2}>
                    {product.productUrl ? <a href={product.productUrl} target="_blank" rel="noreferrer">查看产品页面</a> : '-'}
                  </Descriptions.Item>
                </Descriptions>
              </Card>
            ))}
          </Space>
        ) : <Empty description="暂无产品资料" />}
      </Card>
    </Space>
  );

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <Space size="middle">
            <Link to="/campaigns"><Button icon={<ArrowLeftOutlined />}>返回</Button></Link>
            <h1 className="page-title" style={{ margin: 0 }}>{campaign.name || '项目详情'}</h1>
            {campaign.status && <Tag>{CAMPAIGN_STATUS_LABELS[campaign.status] || campaign.status}</Tag>}
          </Space>
          <p className="page-subtitle">查看项目进度、达人推进、沟通履约与项目资料。</p>
        </div>
        <Button icon={<ReloadOutlined />} onClick={fetchAll} loading={loading}>刷新</Button>
      </div>
      {error && detail && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={`部分数据刷新失败：${error}`} />}
      <Card className="content-card">
        <Tabs
          defaultActiveKey="overview"
          items={[
            { key: 'overview', label: '概览', children: overviewTab },
            { key: 'progress', label: '达人进展', children: progressTab },
            { key: 'communication', label: '沟通与履约', children: communicationTab },
            { key: 'materials', label: '项目资料', children: materialsTab }
          ]}
        />
      </Card>
    </div>
  );
};

export default CampaignDetail;
