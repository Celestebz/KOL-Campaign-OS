import React, { useEffect, useState } from 'react';
import { Button, Layout, Menu, Space, Spin } from 'antd';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import {
  DatabaseOutlined,
  LogoutOutlined,
  ProjectOutlined,
  SettingOutlined,
  TeamOutlined
} from '@ant-design/icons';

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
import UserManagement from './pages/UserManagement';

const { Header, Sider, Content } = Layout;

function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [authState, setAuthState] = useState('loading'); // 'loading' | 'authed' | 'guest'
  const [authRequired, setAuthRequired] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setAuthRequired(Boolean(data.authRequired));
        setCurrentUser(data.user || null);
        setNeedsBootstrap(Boolean(data.needsBootstrap));
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
    setCurrentUser(null);
  };

  // 一级导航收缩为 4 项；/records 不进菜单，路由保留；/send 以「内容分析」归入资料库。
  const menuItems = [
    {
      key: 'project',
      icon: <ProjectOutlined />,
      label: '项目',
      children: [
        { key: '/campaigns', label: '项目管理' },
        { key: '/finder', label: 'KOL 寻找' },
        { key: '/emails', label: '邮件中心' }
      ]
    },
    {
      key: 'library',
      icon: <DatabaseOutlined />,
      label: '资料库',
      children: [
        { key: '/products', label: '产品目录' },
        { key: '/customers', label: 'KOL 管理' },
        { key: '/send', label: '内容分析' }
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
    },
    ...(currentUser?.role === 'admin' ? [{ key: '/users', icon: <TeamOutlined />, label: '用户与邀请' }] : [])
  ];

  // 子菜单路由 → 所属父级菜单 key，用于选中态和自动展开。
  const pathToGroup = {
    '/campaigns': 'project',
    '/strategy': 'project',
    '/finder': 'project',
    '/finder-tasks': 'project',
    '/candidate-pool': 'project',
    '/campaign-kols': 'project',
    '/emails': 'project',
    '/products': 'library',
    '/customers': 'library',
    '/send': 'library',
    '/settings': 'system',
    '/templates': 'system',
    '/users': 'system'
  };
  // 项目详情（/campaigns/:id）不进菜单，归属 project 分组并保持「项目管理」选中态。
  const resolveMenuGroup = (pathname) => (
    pathToGroup[pathname] || (pathname.startsWith('/campaigns/') ? 'project' : undefined)
  );
  const menuPathKeys = new Set(Object.keys(pathToGroup));
  // 策略与任务属于「KOL 寻找」内部 Tab；候选池旧地址也继续归到该入口。
  const selectedPath = ['/strategy', '/finder-tasks', '/candidate-pool'].includes(location.pathname)
    ? '/finder'
    : location.pathname;
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
    return <Login needsBootstrap={needsBootstrap} onSuccess={(user) => { setCurrentUser(user); setNeedsBootstrap(false); setAuthState('authed'); }} />;
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
            <Space>
              <span>{currentUser?.display_name || currentUser?.username}</span>
            <Button
              type="text"
              icon={<LogoutOutlined />}
              onClick={handleLogout}
              style={{ marginRight: 16 }}
            >
              退出登录
            </Button>
            </Space>
          )}
        </Header>
        <Content style={{ margin: '0 16px' }}>
          <Routes>
            <Route path="/" element={<Navigate to="/campaigns" replace />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/campaigns/:id" element={<CampaignDetail />} />
            <Route path="/products" element={<Products />} />
            <Route path="/strategy" element={<FinderTabs activeKey="strategy"><KolStrategy /></FinderTabs>} />
            <Route path="/finder" element={<FinderTabs activeKey="finder"><RawCandidates /></FinderTabs>} />
            <Route path="/candidate-pool" element={<FinderTabs activeKey="candidate"><CampaignKols view="candidate" /></FinderTabs>} />
            <Route path="/finder-tasks" element={<FinderTabs activeKey="tasks"><RawCandidates view="tasks" /></FinderTabs>} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/campaign-kols" element={<CampaignKols />} />
            <Route path="/emails" element={<Emails />} />
            <Route path="/send" element={<VideoAnalysis />} />
            <Route path="/records" element={<Records />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/settings" element={<Settings />} />
            {currentUser?.role === 'admin' && <Route path="/users" element={<UserManagement />} />}
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

export default App;
