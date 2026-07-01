import React, { useState } from 'react';
import { Layout, Menu } from 'antd';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import {
  BarChartOutlined,
  DashboardOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  UserOutlined
} from '@ant-design/icons';

import Dashboard from './pages/Dashboard';
import Customers from './pages/Customers';
import Templates from './pages/Templates';
import VideoAnalysis from './pages/VideoAnalysis';
import Records from './pages/Records';
import Settings from './pages/Settings';

const { Header, Sider, Content } = Layout;

function App() {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const menuItems = [
    { key: '/', icon: <DashboardOutlined />, label: 'Dashboard' },
    { key: '/customers', icon: <UserOutlined />, label: 'KOL 管理' },
    { key: '/send', icon: <PlayCircleOutlined />, label: '视频数据' },
    { key: '/records', icon: <BarChartOutlined />, label: '分析记录' },
    { key: '/templates', icon: <FileTextOutlined />, label: 'AI Prompt 模板' },
    { key: '/settings', icon: <SettingOutlined />, label: 'API 设置' }
  ];

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
        <Header style={{ padding: 0, background: '#fff' }}>
          <div style={{ padding: '0 24px', fontSize: 18, fontWeight: 700 }}>
            KOL Campaign OS
          </div>
        </Header>
        <Content style={{ margin: '0 16px' }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/customers" element={<Customers />} />
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
