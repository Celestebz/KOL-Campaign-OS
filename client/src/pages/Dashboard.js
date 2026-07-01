import React, { useEffect, useState } from 'react';
import { Card, Col, Row, Statistic, Table, Tag, message } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, PlayCircleOutlined, UserOutlined } from '@ant-design/icons';
import axios from 'axios';

const statusColor = (status) => {
  if (status === 'success') return 'green';
  if (['failed', 'analysis_failed'].includes(status)) return 'red';
  if (status === 'crawled') return 'cyan';
  return 'blue';
};

const Dashboard = () => {
  const [videos, setVideos] = useState([]);
  const [kols, setKols] = useState([]);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [videoRes, kolRes] = await Promise.all([
        axios.get('/api/videos'),
        axios.get('/api/customers')
      ]);
      setVideos(videoRes.data.data || []);
      setKols(kolRes.data.data || []);
    } catch (error) {
      message.error('获取 Dashboard 数据失败');
    }
  };

  const successCount = videos.filter((item) => item.status === 'success').length;
  const failedCount = videos.filter((item) => ['failed', 'analysis_failed'].includes(item.status)).length;

  const columns = [
    { title: '平台', dataIndex: 'platform', key: 'platform', width: 110, render: (v) => v || '-' },
    { title: 'KOL', dataIndex: 'kol_name', key: 'kol_name', width: 180, render: (v, r) => v || r.author_name || '-' },
    { title: '标题', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      render: (status) => <Tag color={statusColor(status)}>{status || 'pending'}</Tag>
    },
    { title: '播放数', dataIndex: 'play_count', key: 'play_count', width: 110, render: (v) => v ?? '-' },
    { title: 'AI 摘要', dataIndex: 'ai_summary', key: 'ai_summary', ellipsis: true, render: (v) => v || '-' }
  ];

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
      </div>

      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={6}>
          <Card className="stats-card">
            <Statistic title="视频总数" value={videos.length} prefix={<PlayCircleOutlined />} valueStyle={{ color: '#1677ff' }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card className="stats-card">
            <Statistic title="分析成功" value={successCount} prefix={<CheckCircleOutlined />} valueStyle={{ color: '#52c41a' }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card className="stats-card">
            <Statistic title="失败/待补" value={failedCount} prefix={<CloseCircleOutlined />} valueStyle={{ color: '#ff4d4f' }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card className="stats-card">
            <Statistic title="KOL 记录" value={kols.length} prefix={<UserOutlined />} valueStyle={{ color: '#722ed1' }} />
          </Card>
        </Col>
      </Row>

      <Card title="最近视频分析" className="content-card">
        <Table columns={columns} dataSource={videos.slice(0, 8)} rowKey="id" pagination={false} size="small" />
      </Card>
    </div>
  );
};

export default Dashboard;
