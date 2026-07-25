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
              decision.decided_at
                ? new Date(decision.decided_at).toLocaleString('zh-CN')
                : null
            }
          />
          {decision.decision && <Tag color="green">{decision.decision}</Tag>}
        </List.Item>
      )}
    />
  );
}

export default RecentDecisions;
