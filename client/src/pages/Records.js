import React, { useEffect, useState } from 'react';
import { Button, Card, Modal, Table, Tag, message } from 'antd';
import { ExclamationCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import axios from 'axios';

const statusColor = (status) => {
  if (status === 'success') return 'green';
  if (['failed', 'analysis_failed'].includes(status)) return 'red';
  if (status === 'crawled') return 'cyan';
  return 'blue';
};

const Records = () => {
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [failModal, setFailModal] = useState({ open: false, reason: '' });

  useEffect(() => {
    fetchVideos();
  }, []);

  const fetchVideos = async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/videos');
      setVideos(res.data.data || []);
    } catch (error) {
      message.error('获取分析记录失败');
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    { title: '视频ID', dataIndex: 'id', key: 'id', width: 90 },
    { title: '平台', dataIndex: 'platform', key: 'platform', width: 110, render: (v) => v || '-' },
    { title: 'KOL', dataIndex: 'kol_name', key: 'kol_name', width: 180, render: (v, r) => v || r.author_name || '-' },
    { title: '标题', dataIndex: 'title', key: 'title', ellipsis: true },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 150,
      render: (status, record) => {
        const failed = ['failed', 'analysis_failed'].includes(status);
        return (
          <Tag color={statusColor(status)}>
            {failed ? (
              <span style={{ cursor: 'pointer' }} onClick={() => setFailModal({ open: true, reason: record.error_message || '未知错误' })}>
                {status} <ExclamationCircleOutlined />
              </span>
            ) : (status || 'pending')}
          </Tag>
        );
      }
    },
    { title: '播放数', dataIndex: 'play_count', key: 'play_count', width: 100, render: (v) => v ?? '-' },
    { title: '点赞数', dataIndex: 'like_count', key: 'like_count', width: 100, render: (v) => v ?? '-' },
    { title: '评论数', dataIndex: 'comment_count', key: 'comment_count', width: 100, render: (v) => v ?? '-' },
    { title: 'AI 评分', dataIndex: 'ai_score', key: 'ai_score', width: 100, render: (v) => v ?? '-' },
    { title: 'AI 摘要', dataIndex: 'ai_summary', key: 'ai_summary', ellipsis: true, render: (v) => v || '-' },
    { title: '最近抓取', dataIndex: 'last_crawled_at', key: 'last_crawled_at', width: 180, render: (v) => v ? new Date(v).toLocaleString() : '-' }
  ];

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">分析记录</h1>
      </div>

      <Card
        className="content-card"
        title="视频分析记录"
        extra={<Button icon={<ReloadOutlined />} onClick={fetchVideos}>刷新</Button>}
      >
        <Table
          columns={columns}
          dataSource={videos}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: true }}
        />
      </Card>

      <Modal
        title="失败原因"
        open={failModal.open}
        onCancel={() => setFailModal({ open: false, reason: '' })}
        footer={null}
      >
        <p>{failModal.reason}</p>
      </Modal>
    </div>
  );
};

export default Records;
