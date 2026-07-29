import React from 'react';
import { List, Tag } from 'antd';
import { Link } from 'react-router-dom';

// 最近已处理：展示老板今天（最近）已经做过的决定。
function RecentDecisions({ items = [] }) {
  return (
    <List
      dataSource={items}
      locale={{ emptyText: '暂无已处理决定' }}
      renderItem={(decision, index) => (
        <List.Item key={index}>
          <List.Item.Meta
            title={
              decision.href
                ? <Link to={decision.href}>{decision.title}</Link>
                : decision.title
            }
            description={
              <span>
                {decision.decided_at ? new Date(decision.decided_at).toLocaleString('zh-CN') : ''}
                {decision.followup_summary ? ` · AI 后续：${decision.followup_summary}` : ' · 无需自动后续动作'}
              </span>
            }
          />
          {decision.decision && <Tag color="green">{decision.decision}</Tag>}
        </List.Item>
      )}
    />
  );
}

export default RecentDecisions;
