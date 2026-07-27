import React from 'react';
import { Tabs } from 'antd';
import { useNavigate } from 'react-router-dom';

const tabItems = [
  { key: 'finder', label: 'Raw候选' },
  { key: 'candidate', label: '项目候选池' },
  { key: 'strategy', label: '策略管理' }
];

const tabPaths = {
  finder: '/finder',
  candidate: '/candidate-pool',
  strategy: '/strategy'
};

// 「KOL 寻找」合并入口：寻找审批与策略管理共用 Tab，两个路由保持独立可直达。
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
