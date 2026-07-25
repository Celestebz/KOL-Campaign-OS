import React from 'react';
import { Card, Space, Tag, Typography } from 'antd';
import { getItemType, getRiskLevel } from './constants';
import DecisionActions from './DecisionActions';

// 决策卡片：项目名、类型标签、risk Tag、事实摘要（前 3 条）、AI 观点、风险数、行动按钮。
// 点击卡片空白处打开 DecisionDrawer。
function DecisionCard({ item, onOpen }) {
  const type = getItemType(item.type);
  const risk = getRiskLevel(item.risk_level);
  const facts = (item.facts || []).slice(0, 3);
  const riskCount = (item.risks || []).length;

  return (
    <Card hoverable onClick={() => onOpen(item)} style={{ marginBottom: 12 }}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space wrap size={[8, 4]}>
          <Typography.Text type="secondary">{item.campaign_name || '未关联项目'}</Typography.Text>
          <Tag color={type.color}>{type.label}</Tag>
          <Tag color={risk.color}>{risk.label}</Tag>
        </Space>
        <Typography.Text strong style={{ fontSize: 15 }}>{item.title}</Typography.Text>
        {facts.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 18, color: '#555' }}>
            {facts.map((fact, index) => (
              <li key={index}>{fact}</li>
            ))}
          </ul>
        )}
        {item.opinion && (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }} ellipsis={{ rows: 2 }}>
            AI 观点：{item.opinion}
          </Typography.Paragraph>
        )}
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Typography.Text type={riskCount > 0 ? 'danger' : 'secondary'}>
            {riskCount > 0 ? `风险 ${riskCount} 项` : '暂无已知风险'}
          </Typography.Text>
          <DecisionActions actions={item.actions} size="small" />
        </Space>
      </Space>
    </Card>
  );
}

export default DecisionCard;
