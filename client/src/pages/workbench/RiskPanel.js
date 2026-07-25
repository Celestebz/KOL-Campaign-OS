import React from 'react';
import { Typography } from 'antd';

// 风险面板：展示不确定项（哪里不确定、哪里可能出错）。
function RiskPanel({ risks = [] }) {
  if (!risks.length) {
    return <Typography.Text type="secondary">暂无已知风险</Typography.Text>;
  }
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {risks.map((risk, index) => (
        <li key={index} style={{ marginBottom: 4, color: '#cf1322' }}>{risk}</li>
      ))}
    </ul>
  );
}

export default RiskPanel;
