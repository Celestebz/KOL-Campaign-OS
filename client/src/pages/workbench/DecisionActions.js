import React from 'react';
import { Button, Space } from 'antd';
import { useNavigate } from 'react-router-dom';

// 行动按钮组：按 actions 数组渲染，点击跳转到对应原页面处理。
// 阶段 B 原则：工作台不重写业务，按钮只做跳转，具体处理仍在原页面完成。
function DecisionActions({ actions = [], size }) {
  const navigate = useNavigate();
  if (!actions.length) return null;
  return (
    <Space wrap size={[8, 8]}>
      {actions.map((action) => (
        <Button
          key={action.key || action.label}
          size={size}
          type={action.key === 'open' ? 'primary' : 'default'}
          onClick={(event) => {
            event.stopPropagation();
            if (action.href) navigate(action.href);
          }}
        >
          {action.label}
        </Button>
      ))}
    </Space>
  );
}

export default DecisionActions;
