import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Descriptions, Drawer, Empty, Input, List, message, Modal, Result, Row, Select, Space, Spin, Statistic, Table, Tabs, Tag, Tooltip } from 'antd';
import { ArrowLeftOutlined, MailOutlined, ReloadOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { getMainStatus } from './campaignKolStatus';
import { bindReply, confirmReply, getCampaignReplies, getEmailRecords, getUnmatchedReplies } from './emailApi';
import { subscribeCampaignProgressChanged } from './campaignProgressSync';
import { deriveCampaignStage, deriveProgressText } from './campaignProgress';
import { normalizeCampaignProductMaterial } from './campaignProductMaterial';
import CampaignKols from './CampaignKols';

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

const INTENT_STATUS = {
  interested: { label: '有意向', color: 'green' },
  question: { label: '需要沟通', color: 'gold' },
  unclear: { label: '暂不明确', color: 'default' },
  other: { label: '暂不明确', color: 'default' },
  rejected: { label: '已拒绝', color: 'red' }
};

const OUTREACH_OPTIONS = Object.entries(OUTREACH_STATUS)
  .filter(([value], index, entries) => entries.findIndex(([, item]) => item.label === OUTREACH_STATUS[value].label) === index)
  .map(([value, item]) => ({ value, label: item.label }));

const ageText = (value) => {
  if (!value) return '-';
  const hours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3600000));
  return hours < 24 ? `${hours} 小时` : `${Math.floor(hours / 24)} 天`;
};

const CampaignDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);
  const [kols, setKols] = useState([]);
  const [emailRecords, setEmailRecords] = useState([]);
  const [replies, setReplies] = useState([]);
  const [unmatchedReplies, setUnmatchedReplies] = useState([]);
  const [progressSearch, setProgressSearch] = useState('');
  const [progressOutreach, setProgressOutreach] = useState();
  const [communicationFilter, setCommunicationFilter] = useState('all');
  const [communicationSearch, setCommunicationSearch] = useState('');
  const [communicationOutreach, setCommunicationOutreach] = useState();
  const [communicationIntent, setCommunicationIntent] = useState();
  const [selectedKol, setSelectedKol] = useState(null);
  const [events, setEvents] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [bindingReply, setBindingReply] = useState(null);
  const [bindingCustomerId, setBindingCustomerId] = useState();
  const [bindingSaving, setBindingSaving] = useState(false);
  const [confirmingReply, setConfirmingReply] = useState(null);
  const [confirmIntent, setConfirmIntent] = useState('unclear');
  const [confirmSummary, setConfirmSummary] = useState('');
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');

  const fetchAll = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError('');
    setNotFound(false);
    try {
      const [detailRes, kolsRes, recordsData, replyRows, unmatchedRows] = await Promise.all([
        axios.get(`/api/campaigns/${id}/detail`),
        axios.get('/api/campaign-kols', { params: { campaign_id: id } }),
        getEmailRecords(null, { campaign_id: id }).catch(() => null),
        getCampaignReplies(id).catch(() => []),
        getUnmatchedReplies().catch(() => [])
      ]);
      setDetail(detailRes.data.data || null);
      setKols(kolsRes.data.data || []);
      setEmailRecords(recordsData?.records || (Array.isArray(recordsData) ? recordsData : []));
      setReplies(replyRows || []);
      setUnmatchedReplies(unmatchedRows || []);
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

  const repliesByCustomer = replies.reduce((map, reply) => {
    if (!reply.customer_id) return map;
    const key = Number(reply.customer_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(reply);
    return map;
  }, new Map());
  const recordsByCustomer = emailRecords.reduce((map, record) => {
    if (!record.customer_id) return map;
    const key = Number(record.customer_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(record);
    return map;
  }, new Map());

  const communicationRows = kols.map((kol) => {
    const incoming = [...(repliesByCustomer.get(Number(kol.customer_id)) || [])]
      .sort((a, b) => new Date(b.received_at || b.created_at) - new Date(a.received_at || a.created_at));
    const outgoing = [...(recordsByCustomer.get(Number(kol.customer_id)) || [])]
      .sort((a, b) => new Date(b.sent_at || b.created_at) - new Date(a.sent_at || a.created_at));
    const latestReply = incoming[0];
    const latestSent = outgoing[0];
    const incomingAt = latestReply?.received_at || latestReply?.created_at;
    const outgoingAt = latestSent?.sent_at || latestSent?.created_at;
    const waitingOnUs = Boolean(kol.needs_reply) || (incomingAt && (!outgoingAt || new Date(incomingAt) > new Date(outgoingAt)));
    const latestAt = [incomingAt, outgoingAt, kol.last_outreach_at].filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0];
    const confirmedIntent = latestReply?.confirmed_intent || null;
    const latestSummary = latestReply?.confirmed_summary || latestReply?.ai_summary || kol.last_reply_summary || '';
    let nextAction = '发送首封邮件';
    if (waitingOnUs) nextAction = latestReply?.confirm_status === 'pending' ? '确认意向并回复' : '回复达人';
    else if (outgoingAt) nextAction = '等待达人回复';
    if (['terminated', 'rejected'].includes(kol.outreach_status)) nextAction = '已结束跟进';
    if (kol.pipeline_stage === 'confirmed' || kol.outreach_status === 'confirmed') nextAction = '推进合作履约';
    return { ...kol, incoming, outgoing, latestReply, latestSent, latestAt, waitingOnUs, confirmedIntent, latestSummary, nextAction };
  });

  const normalizedSearch = progressSearch.trim().toLowerCase();
  const filteredProgressKols = communicationRows.filter((kol) => {
    const matchesSearch = !normalizedSearch || [kol.kol_name, kol.kol_name_snapshot, kol.email, kol.email_snapshot]
      .some((value) => String(value || '').toLowerCase().includes(normalizedSearch));
    return matchesSearch && (!progressOutreach || kol.outreach_status === progressOutreach
      || (progressOutreach === 'waiting_reply' && kol.outreach_status === 'replied')
      || (progressOutreach === 'terminated' && kol.outreach_status === 'rejected'));
  });

  const normalizedCommunicationSearch = communicationSearch.trim().toLowerCase();
  const filteredCommunicationRows = communicationRows.filter((kol) => {
    if (communicationFilter === 'mine' && !kol.waitingOnUs) return false;
    if (communicationFilter === 'stale' && !(kol.latestAt && !kol.waitingOnUs && Date.now() - new Date(kol.latestAt).getTime() >= 7 * 86400000)) return false;
    if (communicationOutreach && kol.outreach_status !== communicationOutreach) return false;
    if (communicationIntent && kol.confirmedIntent !== communicationIntent) return false;
    return !normalizedCommunicationSearch || [kol.kol_name, kol.kol_name_snapshot, kol.email, kol.email_snapshot]
      .some((value) => String(value || '').toLowerCase().includes(normalizedCommunicationSearch));
  });

  const openCommunicationDetail = async (kol) => {
    setSelectedKol(kol);
    setEvents([]);
    setDetailLoading(true);
    try {
      const response = await axios.get(`/api/campaign-kols/${kol.id}/events`);
      setEvents(response.data.data || []);
    } catch (detailError) {
      message.error('沟通时间线加载失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleBindReply = async () => {
    if (!bindingReply || !bindingCustomerId) return;
    setBindingSaving(true);
    try {
      await bindReply(bindingReply.id, bindingCustomerId, campaign.id);
      message.success('邮件已绑定，正在生成摘要与意向判断');
      setBindingReply(null);
      setBindingCustomerId(undefined);
      await fetchAll({ silent: true });
    } catch (bindError) {
      message.error(bindError.response?.data?.error || '绑定失败');
    } finally {
      setBindingSaving(false);
    }
  };

  const openIntentConfirm = (reply) => {
    setConfirmingReply(reply);
    setConfirmIntent(reply.ai_intent === 'other' ? 'unclear' : (reply.ai_intent || 'unclear'));
    setConfirmSummary(reply.ai_summary || '');
  };

  const handleIntentConfirm = async () => {
    try {
      await confirmReply(confirmingReply.id, confirmSummary, confirmIntent);
      message.success('意向与沟通进度已更新');
      setConfirmingReply(null);
      await fetchAll({ silent: true });
    } catch (confirmError) {
      message.error(confirmError.response?.data?.error || '确认失败');
    }
  };

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
      title: '最新沟通摘要',
      dataIndex: 'latestSummary',
      key: 'latestSummary',
      width: 240,
      ellipsis: true,
      render: (v) => (v ? <Tooltip title={v}>{v}</Tooltip> : '-')
    },
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: 160,
      render: formatTime
    }
  ];

  const communicationColumns = [
    { title: '达人', width: 190, render: (_, row) => row.kol_name || row.kol_name_snapshot || '-' },
    {
      title: '外联状态', dataIndex: 'outreach_status', width: 110,
      render: (v) => {
        const item = OUTREACH_STATUS[v] || { label: v || '待联系', color: 'default' };
        return <Tag color={item.color}>{item.label}</Tag>;
      }
    },
    {
      title: '当前进度', width: 120,
      render: (_, row) => row.waitingOnUs
        ? <Badge status="processing" text="待我方处理" />
        : <Badge status="default" text={row.latestAt ? '待达人回复' : '尚未联系'} />
    },
    {
      title: '确认意向', dataIndex: 'confirmedIntent', width: 110,
      render: (v, row) => {
        const intent = INTENT_STATUS[v];
        if (intent) return <Tag color={intent.color}>{intent.label}</Tag>;
        return row.latestReply?.confirm_status === 'pending' ? <Tag color="blue">待确认</Tag> : '-';
      }
    },
    { title: '最新沟通摘要', dataIndex: 'latestSummary', ellipsis: true, render: (v) => (v ? <Tooltip title={v}>{v}</Tooltip> : '-') },
    { title: '最近沟通', dataIndex: 'latestAt', width: 170, render: formatTime },
    { title: '等待时长', dataIndex: 'latestAt', width: 90, render: ageText },
    { title: '下一步', dataIndex: 'nextAction', width: 130 },
    {
      title: '操作', width: 100,
      render: (_, row) => <Button type="link" size="small" onClick={(event) => { event.stopPropagation(); openCommunicationDetail(row); }}>查看沟通</Button>
    }
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

  // 旧进度与沟通面板暂时保留，供历史抽屉逻辑和后续迁移核对使用。
  // eslint-disable-next-line no-unused-vars
  const progressTab = (
    <Card size="small" title={`项目达人（${filteredProgressKols.length}/${kols.length}）`}>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search allowClear placeholder="搜索达人名称或邮箱" value={progressSearch} onChange={(event) => setProgressSearch(event.target.value)} style={{ width: 260 }} />
        <Select allowClear placeholder="外联状态" value={progressOutreach} onChange={setProgressOutreach} options={OUTREACH_OPTIONS} style={{ width: 150 }} />
        {(progressSearch || progressOutreach) && <Button onClick={() => { setProgressSearch(''); setProgressOutreach(undefined); }}>清空筛选</Button>}
      </Space>
      <Table
        size="small"
        rowKey="id"
        columns={kolColumns}
        dataSource={filteredProgressKols}
        loading={loading}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        locale={{ emptyText: <Empty description="该项目暂无达人" /> }}
        scroll={{ x: 1350 }}
        onRow={(row) => ({ onClick: () => openCommunicationDetail(row), style: { cursor: 'pointer' } })}
      />
    </Card>
  );

  // eslint-disable-next-line no-unused-vars
  const communicationTab = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Row gutter={[12, 12]}>
        {[
          ['待联系', communicationRows.filter((row) => !row.latestAt).length, 'not_contacted'],
          ['待达人回复', communicationRows.filter((row) => row.latestAt && !row.waitingOnUs).length, 'waiting'],
          ['待我方处理', communicationRows.filter((row) => row.waitingOnUs).length, 'mine'],
          ['沟通中', communicationRows.filter((row) => row.outreach_status === 'negotiating').length, 'negotiating'],
          ['有意向', communicationRows.filter((row) => row.outreach_status === 'interested').length, 'interested'],
          ['未识别邮件', unmatchedReplies.length, 'unmatched']
        ].map(([label, value, key]) => (
          <Col xs={12} md={8} xl={4} key={key}>
            <Card size="small" hoverable onClick={() => {
              if (key === 'mine') setCommunicationFilter('mine');
              else if (key === 'unmatched') setCommunicationFilter('unmatched');
              else if (key === 'waiting') setCommunicationFilter('waiting');
              else { setCommunicationFilter('all'); setCommunicationOutreach(key); }
            }}>
              <Statistic title={label} value={value} />
            </Card>
          </Col>
        ))}
      </Row>
      <Card title="达人沟通看板" size="small" extra={<Button icon={<ReloadOutlined />} onClick={() => fetchAll()}>刷新</Button>}>
        <Space wrap style={{ marginBottom: 16 }}>
          <Input.Search allowClear placeholder="搜索达人名称或邮箱" value={communicationSearch} onChange={(event) => setCommunicationSearch(event.target.value)} style={{ width: 250 }} />
          <Select value={communicationFilter} onChange={setCommunicationFilter} style={{ width: 150 }} options={[
            { value: 'all', label: '全部达人' }, { value: 'mine', label: '待我处理' },
            { value: 'waiting', label: '待达人回复' }, { value: 'stale', label: '超过 7 天无进展' },
            { value: 'unmatched', label: `未识别邮件（${unmatchedReplies.length}）` }
          ]} />
          {communicationFilter !== 'unmatched' && <>
            <Select allowClear placeholder="外联状态" value={communicationOutreach} onChange={setCommunicationOutreach} options={OUTREACH_OPTIONS} style={{ width: 150 }} />
            <Select allowClear placeholder="确认意向" value={communicationIntent} onChange={setCommunicationIntent} options={Object.entries(INTENT_STATUS).filter(([value]) => value !== 'other').map(([value, item]) => ({ value, label: item.label }))} style={{ width: 150 }} />
          </>}
          <Link to={`/emails?campaign_id=${campaign.id}`}><Button icon={<MailOutlined />}>进入邮件中心</Button></Link>
        </Space>
        {communicationFilter === 'unmatched' ? (
          <Table size="small" rowKey="id" dataSource={unmatchedReplies} pagination={{ defaultPageSize: 10 }} columns={[
            { title: '发件人', dataIndex: 'from_address', width: 240 },
            { title: '主题', dataIndex: 'subject', ellipsis: true },
            { title: '收到时间', dataIndex: 'received_at', width: 170, render: formatTime },
            { title: '正文预览', dataIndex: 'body_text', ellipsis: true, render: (v) => v || '-' },
            { title: '操作', width: 110, render: (_, reply) => <Button type="link" onClick={() => { setBindingReply(reply); setBindingCustomerId(undefined); }}>绑定项目达人</Button> }
          ]} />
        ) : (
          <Table
            size="small"
            rowKey="id"
            columns={communicationColumns}
            dataSource={filteredCommunicationRows.filter((row) => communicationFilter !== 'waiting' || (row.latestAt && !row.waitingOnUs))}
            pagination={{ defaultPageSize: 20, showSizeChanger: true }}
            scroll={{ x: 1350 }}
            onRow={(row) => ({ onClick: () => openCommunicationDetail(row), style: { cursor: 'pointer' } })}
          />
        )}
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
      <Tabs
        defaultActiveKey="overview"
        items={[
          { key: 'overview', label: '项目概览', children: <Card className="content-card">{overviewTab}</Card> },
          {
            key: 'candidates',
            label: `候选池（${summary.kols_candidate ?? 0}）`,
            children: (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Alert
                  type="info"
                  showIcon
                  message="候选筛选区"
                  description="集中审核当前项目候选；人工确认合作后，达人会进入合作区，候选记录仍会保留。"
                  action={<Link to={`/finder?campaign_id=${campaign.id}`}><Button>继续寻找达人</Button></Link>}
                />
                <CampaignKols view="candidate" campaignId={campaign.id} embedded />
              </Space>
            )
          },
          {
            key: 'cooperation',
            label: `合作区（${summary.kols_confirmed ?? 0}）`,
            children: (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Alert
                  type="success"
                  showIcon
                  message="正式合作推进区"
                  description="统一处理联系、沟通、报价、寄样、内容履约与发布进度。"
                  action={<Link to={`/emails?campaign_id=${campaign.id}`}><Button icon={<MailOutlined />}>项目邮件</Button></Link>}
                />
                <CampaignKols view="cooperation" campaignId={campaign.id} embedded />
              </Space>
            )
          },
          { key: 'settings', label: '项目设置', children: materialsTab }
        ]}
      />
      <Drawer
        title={selectedKol ? `${selectedKol.kol_name || selectedKol.kol_name_snapshot || '达人'} · 沟通详情` : '沟通详情'}
        width={760}
        open={Boolean(selectedKol)}
        onClose={() => setSelectedKol(null)}
        extra={selectedKol && <Button onClick={() => navigate(`/campaign-kols?campaign_id=${campaign.id}`)}>进入完整达人页</Button>}
      >
        {selectedKol && <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="外联状态">
              <Tag color={(OUTREACH_STATUS[selectedKol.outreach_status] || {}).color}>{(OUTREACH_STATUS[selectedKol.outreach_status] || {}).label || '-'}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="当前进度">{selectedKol.waitingOnUs ? '待我方处理' : (selectedKol.latestAt ? '待达人回复' : '尚未联系')}</Descriptions.Item>
            <Descriptions.Item label="人工确认意向">{INTENT_STATUS[selectedKol.confirmedIntent]?.label || '待确认'}</Descriptions.Item>
            <Descriptions.Item label="最近沟通">{formatTime(selectedKol.latestAt)}</Descriptions.Item>
            <Descriptions.Item label="最新沟通摘要" span={2}>{selectedKol.latestSummary || '-'}</Descriptions.Item>
            <Descriptions.Item label="下一步" span={2}>{selectedKol.nextAction}</Descriptions.Item>
          </Descriptions>
          {selectedKol.latestReply?.confirm_status === 'pending' && (
            <Alert
              type="info"
              showIcon
              message="达人回复尚未确认意向"
              description={selectedKol.latestReply.ai_summary || 'AI 摘要生成中，可查看邮件原文后人工确认。'}
              action={<Button type="primary" size="small" onClick={() => openIntentConfirm(selectedKol.latestReply)}>确认意向</Button>}
            />
          )}
          <div>
            <h3>沟通时间线</h3>
            {detailLoading ? <Spin /> : (() => {
              const timelineItems = [
                ...selectedKol.incoming.map((reply) => ({
                  key: `reply-${reply.id}`, at: reply.received_at || reply.created_at, type: '达人来信', color: 'blue',
                  subject: reply.subject, summary: reply.confirmed_summary || reply.ai_summary || reply.body_text,
                  intent: reply.confirmed_intent || reply.ai_intent, reply
                })),
                ...selectedKol.outgoing.map((record) => ({
                  key: `sent-${record.id}`, at: record.sent_at || record.created_at, type: '我方发信', color: 'green',
                  subject: record.subject, summary: record.body_text || record.to_address
                })),
                ...events.map((event) => ({
                  key: `event-${event.id}`, at: event.occurred_at, type: event.event_type === 'intent_corrected' ? '人工更正意向' : '邮件回复确认',
                  color: 'gold', summary: event.summary, intent: event.confirmed_intent
                }))
              ].sort((a, b) => new Date(b.at) - new Date(a.at));
              return timelineItems.length ? <List dataSource={timelineItems} renderItem={(item) => (
                <List.Item actions={item.reply?.confirm_status === 'pending' ? [<Button type="link" size="small" onClick={() => openIntentConfirm(item.reply)}>确认意向</Button>] : []}>
                  <List.Item.Meta
                    title={<Space wrap><span>{formatTime(item.at)}</span><Tag color={item.color}>{item.type}</Tag>{item.intent && <Tag>{INTENT_STATUS[item.intent]?.label || item.intent}</Tag>}</Space>}
                    description={<Space direction="vertical" size={2}><strong>{item.subject || '无主题'}</strong><span style={{ whiteSpace: 'pre-wrap' }}>{item.summary || '无摘要'}</span></Space>}
                  />
                </List.Item>
              )} /> : <Empty description="暂无沟通记录" />;
            })()}
          </div>
        </Space>}
      </Drawer>
      <Modal
        title="绑定到当前项目达人"
        open={Boolean(bindingReply)}
        onOk={handleBindReply}
        onCancel={() => setBindingReply(null)}
        okText="确认绑定"
        confirmLoading={bindingSaving}
        okButtonProps={{ disabled: !bindingCustomerId }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert type="info" showIcon message="绑定后邮件会进入该达人的沟通时间线，并自动生成摘要和意向判断。" />
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="发件人">{bindingReply?.from_address || '-'}</Descriptions.Item>
            <Descriptions.Item label="主题">{bindingReply?.subject || '-'}</Descriptions.Item>
          </Descriptions>
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="搜索并选择当前项目达人"
            value={bindingCustomerId}
            onChange={setBindingCustomerId}
            style={{ width: '100%' }}
            options={kols.map((kol) => ({
              value: kol.customer_id,
              label: `${kol.kol_name || kol.kol_name_snapshot || '未命名达人'} · ${kol.email || kol.email_snapshot || '无邮箱'}`
            }))}
          />
        </Space>
      </Modal>
      <Modal
        title={`确认意向 · ${selectedKol?.kol_name || selectedKol?.kol_name_snapshot || ''}`}
        open={Boolean(confirmingReply)}
        onOk={handleIntentConfirm}
        onCancel={() => setConfirmingReply(null)}
        okText="确认并更新进度"
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Select value={confirmIntent} onChange={setConfirmIntent} style={{ width: '100%' }} options={Object.entries(INTENT_STATUS).filter(([value]) => value !== 'other').map(([value, item]) => ({ value, label: item.label }))} />
          <Input.TextArea rows={5} value={confirmSummary} onChange={(event) => setConfirmSummary(event.target.value)} placeholder="填写沟通摘要" />
        </Space>
      </Modal>
    </div>
  );
};

export default CampaignDetail;
