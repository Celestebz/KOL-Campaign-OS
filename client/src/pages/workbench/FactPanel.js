import React from 'react';
import { Typography } from 'antd';

// 事实面板：展示客观依据列表（判断依据是什么）。
function FactPanel({ facts = [] }) {
  if (!facts.length) {
    return <Typography.Text type="secondary">暂无事实依据</Typography.Text>;
  }
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {facts.map((fact, index) => (
        <li key={index} style={{ marginBottom: 4 }}>{fact}</li>
      ))}
    </ul>
  );
}

export default FactPanel;
