import React from 'react';
import { Button, Card, Collapse, List, Space, Tag, Typography } from 'antd';
import { ExclamationCircleOutlined } from '@ant-design/icons';

const URGENCY = {
  high: { label: '阻塞业务', color: 'red' },
  medium: { label: '需要配置', color: 'orange' },
  low: { label: '一般提醒', color: 'blue' }
};

function ExceptionProblemCard({ group, items, onOpen }) {
  const urgency = URGENCY[group.urgency] || URGENCY.medium;
  const affectedItems = group.item_ids.map((id) => items.find((item) => item.id === id)).filter(Boolean);
  const impact = group.affected_count === 1
    ? '影响 1 个自动任务'
    : `影响 ${group.affected_count} 个自动任务`;

  return (
    <Card className="workbench-problem-card">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap>
          <ExclamationCircleOutlined className="workbench-problem-icon" />
          <Typography.Title level={5} style={{ margin: 0 }}>{group.title}</Typography.Title>
          <Tag color={urgency.color}>{urgency.label}</Tag>
          <Tag>{impact}</Tag>
        </Space>

        <div className="workbench-problem-section">
          <Typography.Text strong>发生了什么</Typography.Text>
          <Typography.Paragraph>{group.what_happened}</Typography.Paragraph>
        </div>
        <div className="workbench-problem-section">
          <Typography.Text strong>影响范围</Typography.Text>
          <Typography.Paragraph>
            {impact}{group.campaigns.length ? `，涉及：${group.campaigns.join('、')}` : ''}。
          </Typography.Paragraph>
        </div>
        <div className="workbench-problem-recommendation">
          <Typography.Text strong>建议下一步</Typography.Text>
          <Typography.Paragraph style={{ marginBottom: 0 }}>{group.recommendation}</Typography.Paragraph>
        </div>

        <Collapse ghost size="small" items={[{
          key: 'records',
          label: `查看受影响记录与技术详情（${group.affected_count}）`,
          children: (
            <Space direction="vertical" style={{ width: '100%' }}>
              {group.technical_details.length > 0 && (
                <Typography.Paragraph type="secondary" copyable>
                  {group.technical_details.join('\n')}
                </Typography.Paragraph>
              )}
              <List
                size="small"
                dataSource={affectedItems.slice(0, 20)}
                footer={affectedItems.length > 20 ? `仅展示前 20 条，共 ${affectedItems.length} 条` : null}
                renderItem={(item) => (
                  <List.Item actions={[<Button key="open" type="link" onClick={() => onOpen(item)}>查看记录</Button>]}>
                    <List.Item.Meta title={item.title} description={item.campaign_name || '未关联项目'} />
                  </List.Item>
                )}
              />
            </Space>
          )
        }]} />
      </Space>
    </Card>
  );
}

export default ExceptionProblemCard;
