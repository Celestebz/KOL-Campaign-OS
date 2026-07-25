import React from 'react';
import { Alert, Card, Space, Tag, Typography } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import { getItemType } from './constants';
import DecisionActions from './DecisionActions';

// 异常卡片：exception 类型事项的单独风格，突出失败节点与错误信息。
// facts 承载已完成进度/失败节点，risks 承载影响范围，opinion 为推荐恢复方式。
function ExceptionCard({ item, onOpen }) {
  const type = getItemType(item.type);
  const facts = (item.facts || []).slice(0, 3);
  const riskCount = (item.risks || []).length;

  return (
    <Card
      hoverable
      onClick={() => onOpen(item)}
      style={{ marginBottom: 12, borderColor: '#ff4d4f', background: '#fff2f0' }}
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space wrap size={[8, 4]}>
          <Typography.Text type="secondary">{item.campaign_name || '未关联项目'}</Typography.Text>
          <Tag color={type.color} icon={<WarningOutlined />}>{type.label}</Tag>
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
          <Alert
            type="warning"
            showIcon
            message={`AI 建议：${item.opinion}`}
            style={{ padding: '4px 12px' }}
          />
        )}
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Typography.Text type={riskCount > 0 ? 'danger' : 'secondary'}>
            {riskCount > 0 ? `影响 ${riskCount} 项` : '影响范围待确认'}
          </Typography.Text>
          <DecisionActions actions={item.actions} size="small" />
        </Space>
      </Space>
    </Card>
  );
}

export default ExceptionCard;
