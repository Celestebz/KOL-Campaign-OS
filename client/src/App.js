import React, { useEffect, useState } from 'react';
import { Button, Layout, Menu, Spin } from 'antd';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import {
  BarChartOutlined,
  DashboardOutlined,
  FileTextOutlined,
  LogoutOutlined,
  PlayCircleOutlined,
  ProductOutlined,
  ProfileOutlined,
  ProjectOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined
} from '@ant-design/icons';

import Dashboard from './pages/Dashboard';
import Customers from './pages/Customers';
import Templates from './pages/Templates';
import VideoAnalysis from './pages/VideoAnalysis';
import Records from './pages/Records';
import Settings from './pages/Settings';
import RawCandidates from './pages/RawCandidates';
import CampaignKols from './pages/CampaignKols';
import KolStrategy from './pages/KolStrategy';
import Products from './pages/Products';
import Campaigns from './pages/Campaigns';
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

  const menuItems = [
    { key: '/', icon: <DashboardOutlined />, label: 'Dashboard' },
    { key: '/campaigns', icon: <ProjectOutlined />, label: '项目与产品' },
    { key: '/products', icon: <ProductOutlined />, label: '产品目录' },
    { key: '/strategy', icon: <ProfileOutlined />, label: 'KOL 策略' },
    { key: '/finder', icon: <SearchOutlined />, label: 'KOL 寻找' },
    { key: '/customers', icon: <UserOutlined />, label: 'KOL 管理' },
    { key: '/campaign-kols', icon: <TeamOutlined />, label: 'KOL 合作' },
    { key: '/send', icon: <PlayCircleOutlined />, label: '视频数据' },
    { key: '/records', icon: <BarChartOutlined />, label: '分析记录' },
    { key: '/templates', icon: <FileTextOutlined />, label: 'AI Prompt 模板' },
    { key: '/settings', icon: <SettingOutlined />, label: 'API 设置' }
  ];

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
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
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
            <Route path="/" element={<Dashboard />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/products" element={<Products />} />
            <Route path="/strategy" element={<KolStrategy />} />
            <Route path="/finder" element={<RawCandidates />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/campaign-kols" element={<CampaignKols />} />
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
