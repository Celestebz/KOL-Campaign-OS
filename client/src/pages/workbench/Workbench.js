import React, { useCallback, useEffect, useState } from 'react';
import { Card, Col, Empty, Row, Spin, Statistic, Typography } from 'antd';
import {
  CheckCircleOutlined,
  ExceptionOutlined,
  HourglassOutlined,
  WarningOutlined
} from '@ant-design/icons';
import { getWorkbench } from './workbenchApi';
import { sortItemsByRisk } from './constants';
import DecisionCard from './DecisionCard';
import ExceptionCard from './ExceptionCard';
import DecisionDrawer from './DecisionDrawer';
import RecentDecisions from './RecentDecisions';

const POLL_INTERVAL = 30 * 1000;

// 老板工作台首页：第一屏四计数 + 决策队列（事实/观点/风险/行动）+ 最近已处理。
// 无欢迎语、无大输入框、无系统统计图表（见 spec 第五节）。
function Workbench() {
  const [data, setData] = useState({ summary: {}, items: [], recent_decisions: [] });
  const [loading, setLoading] = useState(true);
  // 记录选中卡片 id 而非对象：刷新后可自动拿到该卡片的最新版本（用于 409 冲突后重新打开）。
  const [selectedId, setSelectedId] = useState(null);

  const fetchWorkbench = useCallback(async () => {
    try {
      const result = await getWorkbench();
      setData(result);
    } catch (error) {
      // 后端未就绪或请求失败：保持空态，不打断页面。
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorkbench();
    const timer = setInterval(fetchWorkbench, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchWorkbench]);

  const { summary, recent_decisions: recentDecisions } = data;
  const items = sortItemsByRisk(data.items);
  const selected = selectedId ? data.items.find((i) => i.id === selectedId) || null : null;

  // 刷新后选中卡片已离开队列（如已被他人处理）：自动关闭抽屉。
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selectedId, selected]);

  return (
    <div style={{ padding: '16px 0' }}>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card><Statistic title="待我决定" value={summary.pending || 0} prefix={<HourglassOutlined />} /></Card>
        </Col>
        <Col span={6}>
          <Card><Statistic title="高风险事项" value={summary.high_risk || 0} valueStyle={{ color: '#cf1322' }} prefix={<WarningOutlined />} /></Card>
        </Col>
        <Col span={6}>
          <Card><Statistic title="异常待恢复" value={summary.exceptions || 0} valueStyle={{ color: '#d4380d' }} prefix={<ExceptionOutlined />} /></Card>
        </Col>
        <Col span={6}>
          <Card><Statistic title="今日已处理" value={summary.handled_today || 0} valueStyle={{ color: '#3f8600' }} prefix={<CheckCircleOutlined />} /></Card>
        </Col>
      </Row>

      <Typography.Title level={5}>决策队列</Typography.Title>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
      ) : items.length === 0 ? (
        <Card>
          <Empty description="AI 正在后台工作，暂无需要你决定的事项" />
        </Card>
      ) : (
        items.map((item) =>
          item.type === 'exception' ? (
            <ExceptionCard key={item.id} item={item} onOpen={(i) => setSelectedId(i.id)} />
          ) : (
            <DecisionCard key={item.id} item={item} onOpen={(i) => setSelectedId(i.id)} />
          )
        )
      )}

      <Typography.Title level={5} style={{ marginTop: 24 }}>最近已处理</Typography.Title>
      <Card>
        <RecentDecisions items={recentDecisions} />
      </Card>

      <DecisionDrawer
        item={selected}
        open={Boolean(selectedId)}
        onClose={() => setSelectedId(null)}
        onRefresh={fetchWorkbench}
      />
    </div>
  );
}

export default Workbench;
