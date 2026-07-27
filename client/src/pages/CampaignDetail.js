import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Descriptions, Empty, List, Result, Row, Space, Spin, Statistic, Table, Tabs, Tag } from 'antd';
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { getMainStatus } from './campaignKolStatus';
import { getEmailRecords } from './emailApi';

// 后端并行开发，契约固定但字段命名以 snake_case 为准；这里对个别字段做兜底取值。
const pick = (obj, keys) => {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

// 卖点/场景可能是数组、JSON 字符串或纯文本，统一转成可读文本。
const toText = (value) => {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) return value.filter(Boolean).join('、');
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter(Boolean).join('、');
    } catch (error) { /* 非 JSON 时按原文展示 */ }
  }
  return String(value);
};

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

// 按 summary 推导一句话"当前阶段"，优先级：异常 > 待审草稿 > 待确认回复 > 合作推进。
const deriveStage = (summary) => {
  if (!summary) return '-';
  const num = (v) => Number(v ?? 0) || 0;
  if (num(summary.exceptions) > 0) return `有 ${num(summary.exceptions)} 条异常待处理`;
  if (num(summary.drafts_pending) > 0) return `${num(summary.drafts_pending)} 封邮件草稿待审核`;
  if (num(summary.replies_pending) > 0) return `${num(summary.replies_pending)} 条达人回复待确认`;
  if (num(summary.kols_total) === 0) return '项目刚创建，尚未纳入达人';
  if (num(summary.replied) > 0) return `${num(summary.replied)} 位达人已回复，合作推进中`;
  if (num(summary.contacted) > 0) return `已联系 ${num(summary.contacted)} 位达人，等待回复`;
  return `${num(summary.kols_total)} 位达人待联系`;
};

const riskText = (risk) => (
  typeof risk === 'string' ? risk : (risk?.message || risk?.title || risk?.description || JSON.stringify(risk))
);

const riskLevelTag = (risk) => {
  const level = typeof risk === 'object' && risk ? (risk.level || risk.severity) : null;
  if (!level) return null;
  const colors = { high: 'red', medium: 'orange', low: 'blue' };
  const labels = { high: '高', medium: '中', low: '低' };
  return <Tag color={colors[level] || 'default'}>{labels[level] || level}</Tag>;
};

const normalizeProduct = (product) => ({
  id: pick(product, ['id', 'product_id']),
  name: pick(product, ['product_name', 'productName', 'name']),
  sku: pick(product, ['product_sku', 'productSku', 'sku']),
  category: pick(product, ['product_category', 'productCategory', 'category']),
  price: pick(product, ['product_price', 'price']),
  sellingPoints: toText(pick(product, ['product_selling_points', 'productSellingPoints', 'selling_points'])),
  scenarios: toText(pick(product, ['product_scenarios', 'scenarios', 'usage_scenarios']))
});

const CampaignDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);
  const [kols, setKols] = useState([]);
  const [emailRecords, setEmailRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');

  const fetchAll = useCallback(async () => {
    setLoading(true);
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
      } else {
        setError(err.response?.data?.error || '项目详情加载失败，请稍后重试');
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

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
        extra={<Link to="/campaigns"><Button type="primary">返回项目与产品</Button></Link>}
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
  const risks = Array.isArray(detail?.risks) ? detail.risks : [];
  const nextStep = detail?.next_step || '';
  const products = (Array.isArray(detail?.products) ? detail.products : []).map(normalizeProduct);
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
      {nextStep && (
        <Alert
          type="info"
          showIcon
          message="下一步建议"
          description={<span style={{ fontSize: 15, fontWeight: 500 }}>{nextStep}</span>}
        />
      )}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="项目概况" size="small">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="项目目标">{strategy?.campaign_goal || '-'}</Descriptions.Item>
              <Descriptions.Item label="目标市场">{strategy?.target_market || '-'}</Descriptions.Item>
              <Descriptions.Item label="策略状态"><Tag color={strategyStatus.color}>{strategyStatus.label}</Tag></Descriptions.Item>
              <Descriptions.Item label="当前阶段">{deriveStage(summary)}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="关键数据" size="small">
            <Row gutter={[16, 16]}>
              <Col span={8}><Statistic title="项目候选" value={summary.kols_candidate ?? 0} /></Col>
              <Col span={8}><Statistic title="KOL合作" value={summary.kols_confirmed ?? 0} /></Col>
              <Col span={8}><Statistic title="已联系" value={summary.contacted ?? 0} /></Col>
              <Col span={8}><Statistic title="已回复" value={summary.replied ?? 0} /></Col>
              <Col span={8}><Statistic title="待审草稿" value={summary.drafts_pending ?? 0} /></Col>
              <Col span={8}><Statistic title="待确认回复" value={summary.replies_pending ?? 0} /></Col>
              <Col span={8}><Statistic title="异常" value={summary.exceptions ?? 0} valueStyle={Number(summary.exceptions) > 0 ? { color: '#cf1322' } : undefined} /></Col>
            </Row>
          </Card>
        </Col>
      </Row>
      <Card title="推广产品" size="small">
        <Table
          size="small"
          rowKey={(r) => r.id || r.name}
          columns={overviewProductColumns}
          dataSource={products}
          pagination={false}
          locale={{ emptyText: <Empty description="暂无推广产品" /> }}
        />
      </Card>
      <Card title="关键风险" size="small">
        {risks.length ? (
          <List
            size="small"
            dataSource={risks}
            renderItem={(risk) => (
              <List.Item>
                <Space>{riskLevelTag(risk)}<span>{riskText(risk)}</span></Space>
              </List.Item>
            )}
          />
        ) : <Empty description="暂无关键风险" />}
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
        onRow={() => ({ onClick: () => navigate('/campaign-kols'), style: { cursor: 'pointer' } })}
      />
    </Card>
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
                  <Descriptions.Item label="价格">{product.price || '-'}</Descriptions.Item>
                  <Descriptions.Item label="卖点">{product.sellingPoints || '-'}</Descriptions.Item>
                  <Descriptions.Item label="场景">{product.scenarios || '-'}</Descriptions.Item>
                </Descriptions>
              </Card>
            ))}
          </Space>
        ) : <Empty description="暂无产品资料" />}
      </Card>
      <Card title="邮件记录" size="small">
        <Table
          size="small"
          rowKey="id"
          columns={emailColumns}
          dataSource={emailRecords}
          pagination={{ defaultPageSize: 10 }}
          locale={{ emptyText: <Empty description="暂无邮件记录" /> }}
        />
      </Card>
      <Card title="合同 / 发票 / 项目复盘" size="small">
        <Empty description="暂无数据（数据模型规划中，后续版本提供）" />
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
          <p className="page-subtitle">项目详情：概览、合作进度与项目资料。</p>
        </div>
        <Button icon={<ReloadOutlined />} onClick={fetchAll} loading={loading}>刷新</Button>
      </div>
      {error && detail && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={`部分数据刷新失败：${error}`} />}
      <Card className="content-card">
        <Tabs
          defaultActiveKey="overview"
          items={[
            { key: 'overview', label: '概览', children: overviewTab },
            { key: 'progress', label: '合作进度', children: progressTab },
            { key: 'materials', label: '项目资料', children: materialsTab }
          ]}
        />
      </Card>
    </div>
  );
};

export default CampaignDetail;
