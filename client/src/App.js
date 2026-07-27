import React, { useEffect, useState } from 'react';
import { Button, Layout, Menu, Spin } from 'antd';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import {
  DashboardOutlined,
  DatabaseOutlined,
  LogoutOutlined,
  ProjectOutlined,
  SettingOutlined
} from '@ant-design/icons';

import Workbench from './pages/workbench/Workbench';
import Customers from './pages/Customers';
import Templates from './pages/Templates';
import VideoAnalysis from './pages/VideoAnalysis';
import Records from './pages/Records';
import Settings from './pages/Settings';
import RawCandidates from './pages/RawCandidates';
import FinderTabs from './pages/FinderTabs';
import CampaignKols from './pages/CampaignKols';
import Emails from './pages/Emails';
import KolStrategy from './pages/KolStrategy';
import Products from './pages/Products';
import Campaigns from './pages/Campaigns';
import CampaignDetail from './pages/CampaignDetail';
import Login from './pages/Login';

const { Header, Sider, Content } = Layout;

function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [authState, setAuthState] = useState('loading'); // 'loading' | 'authed' | 'guest'
  const [authRequired, setAuthRequired] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setAuthRequired(Boolean(data.authRequired));
        setAuthState(data.authenticated ? 'authed' : 'guest');
      })
      .catch(() => {
        if (!cancelled) setAuthState('guest');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setAuthState('guest');
  };

  // 一级导航收缩为 4 项；/send、/records 不进菜单，路由保留。
  const menuItems = [
    { key: '/', icon: <DashboardOutlined />, label: '工作台' },
    {
      key: 'project',
      icon: <ProjectOutlined />,
      label: '项目',
      children: [
        { key: '/campaigns', label: '项目与产品' },
        { key: '/finder', label: 'KOL 寻找' },
        { key: '/campaign-kols', label: 'KOL 合作' },
        { key: '/emails', label: '邮件中心' }
      ]
    },
    {
      key: 'library',
      icon: <DatabaseOutlined />,
      label: '资料库',
      children: [
        { key: '/products', label: '产品目录' },
        { key: '/customers', label: 'KOL 管理' }
      ]
    },
    {
      key: 'system',
      icon: <SettingOutlined />,
      label: '系统设置',
      children: [
        { key: '/settings', label: 'API 设置' },
        { key: '/templates', label: 'AI Prompt 模板' }
      ]
    }
  ];

  // 子菜单路由 → 所属父级菜单 key，用于选中态和自动展开。
  const pathToGroup = {
    '/campaigns': 'project',
    '/strategy': 'project',
    '/finder': 'project',
    '/candidate-pool': 'project',
    '/campaign-kols': 'project',
    '/emails': 'project',
    '/products': 'library',
    '/customers': 'library',
    '/settings': 'system',
    '/templates': 'system'
  };
  // 项目详情（/campaigns/:id）不进菜单，归属 project 分组并保持「项目与产品」选中态。
  const resolveMenuGroup = (pathname) => (
    pathToGroup[pathname] || (pathname.startsWith('/campaigns/') ? 'project' : undefined)
  );
  const menuPathKeys = new Set(['/', ...Object.keys(pathToGroup)]);
  // /strategy 已并入「KOL 寻找」入口（页面内 Tab 切换），菜单选中态归并到 /finder。
  const selectedPath = ['/strategy', '/candidate-pool'].includes(location.pathname) ? '/finder' : location.pathname;
  const selectedKey = menuPathKeys.has(selectedPath)
    ? selectedPath
    : (location.pathname.startsWith('/campaigns/') ? '/campaigns' : null);
  const [openKeys, setOpenKeys] = useState(() => {
    const group = resolveMenuGroup(location.pathname);
    return group ? [group] : [];
  });

  // 切换到子菜单路由时自动展开对应父级；隐藏路由不改变展开状态。
  useEffect(() => {
    const group = resolveMenuGroup(location.pathname);
    if (group) {
      setOpenKeys((prev) => (prev.includes(group) ? prev : [...prev, group]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  if (authState === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (authState === 'guest') {
    return <Login onSuccess={() => setAuthState('authed')} />;
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} theme="dark">
        <div className="logo">{collapsed ? 'KOL' : 'KOL Campaign OS'}</div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={selectedKey ? [selectedKey] : []}
          openKeys={collapsed ? [] : openKeys}
          onOpenChange={setOpenKeys}
          items={menuItems}
          onClick={({ key }) => {
            if (key.startsWith('/')) navigate(key);
          }}
        />
      </Sider>
      <Layout>
        <Header style={{ padding: 0, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ padding: '0 24px', fontSize: 18, fontWeight: 700 }}>
            KOL Campaign OS
          </div>
          {authRequired && (
            <Button
              type="text"
              icon={<LogoutOutlined />}
              onClick={handleLogout}
              style={{ marginRight: 16 }}
            >
              退出登录
            </Button>
          )}
        </Header>
        <Content style={{ margin: '0 16px' }}>
          <Routes>
            <Route path="/" element={<Workbench />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/campaigns/:id" element={<CampaignDetail />} />
            <Route path="/products" element={<Products />} />
            <Route path="/strategy" element={<FinderTabs activeKey="strategy"><KolStrategy /></FinderTabs>} />
            <Route path="/finder" element={<FinderTabs activeKey="finder"><RawCandidates /></FinderTabs>} />
            <Route path="/candidate-pool" element={<FinderTabs activeKey="candidate"><CampaignKols view="candidate" /></FinderTabs>} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/campaign-kols" element={<CampaignKols />} />
            <Route path="/emails" element={<Emails />} />
            <Route path="/send" element={<VideoAnalysis />} />
            <Route path="/records" element={<Records />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

export default App;
