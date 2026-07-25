import React from 'react';
import { Typography } from 'antd';

// 观点面板：展示 AI 的建议（AI 建议怎么做）。
function OpinionPanel({ opinion }) {
  if (!opinion) {
    return <Typography.Text type="secondary">暂无 AI 观点</Typography.Text>;
  }
  return (
    <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
      {opinion}
    </Typography.Paragraph>
  );
}

export default OpinionPanel;
