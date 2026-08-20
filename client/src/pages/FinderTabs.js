import React from 'react';
import { Tabs } from 'antd';
import { useNavigate } from 'react-router-dom';

const tabItems = [
  { key: 'finder', label: '原始候选' },
  { key: 'strategy', label: '策略管理' },
  { key: 'tasks', label: '寻找任务' }
];

const tabPaths = {
  finder: '/finder',
  strategy: '/strategy',
  tasks: '/finder-tasks'
};

// 「KOL 寻找」统一入口：各业务阶段共用 Tab，每个路由保持独立可直达。
const FinderTabs = ({ activeKey, children }) => {
  const navigate = useNavigate();
  return (
    <div>
      <Tabs
        activeKey={activeKey}
        items={tabItems}
        onChange={(key) => navigate(tabPaths[key])}
      />
      {children}
    </div>
  );
};

export default FinderTabs;
