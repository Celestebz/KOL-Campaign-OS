import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Descriptions, Drawer, Empty, Form, Input, message, Modal, Popconfirm, Select, Space, Spin, Statistic, Table, Tag, Upload } from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  UploadOutlined
} from '@ant-design/icons';
import axios from 'axios';

const { TextArea } = Input;

const cooperationStatusOptions = [
  { value: 'available', label: '可合作' },
  { value: 'do_not_contact', label: '全局不建议合作' }
];

const cooperationRiskOptions = [
  { value: 'historical_refusal', label: '历史拒绝合作' },
  { value: 'communication_risk', label: '沟通风险' },
  { value: 'price_mismatch', label: '报价不合适' },
  { value: 'brand_safety', label: '品牌安全风险' },
  { value: 'delivery_issue', label: '履约问题' },
  { value: 'other', label: '其他' }
];

const cooperationStatusLabel = (value) => (
  cooperationStatusOptions.find((item) => item.value === value)?.label || value || '可合作'
);

const cooperationRiskLabel = (value) => (
  cooperationRiskOptions.find((item) => item.value === value)?.label || value || '-'
);

const Customers = () => {
  const [kols, setKols] = useState([]);
  const [groups, setGroups] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingKol, setEditingKol] = useState(null);
  const [searchText, setSearchText] = useState('');
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [selectedCooperationStatus, setSelectedCooperationStatus] = useState(null);
  const [selectedPlatform, setSelectedPlatform] = useState(null);
  const [selectedCountry, setSelectedCountry] = useState(null);
  const [filterOptions, setFilterOptions] = useState({ countries: [], platforms: [] });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerKol, setDrawerKol] = useState(null);
  const [projectHistory, setProjectHistory] = useState([]);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState('');
  const [addToProjectOpen, setAddToProjectOpen] = useState(false);
  const [targetCampaignId, setTargetCampaignId] = useState(null);
  const [projectCustomerIds, setProjectCustomerIds] = useState([]);
  const [addingToProject, setAddingToProject] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const drawerRequest = useRef(0);
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [currentPageKolIds, setCurrentPageKolIds] = useState([]);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchGroups();
    axios.get('/api/campaigns')
      .then((response) => setCampaigns(response.data.data || []))
      .catch(() => message.error('获取项目列表失败'));
    axios.get('/api/customers/filter-options')
      .then((response) => setFilterOptions(response.data.data || { countries: [], platforms: [] }))
      .catch(() => message.error('获取筛选选项失败'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchKols();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroup, selectedCooperationStatus, selectedPlatform, selectedCountry]);

  const fetchKols = async () => {
    setLoading(true);
    try {
      const params = {};
      if (searchText) params.search = searchText;
      if (selectedGroup) params.group_id = selectedGroup;
      if (selectedCooperationStatus) params.cooperation_status = selectedCooperationStatus;
      if (selectedPlatform) params.platform = selectedPlatform;
      if (selectedCountry) params.country_region = selectedCountry;
      const response = await axios.get('/api/customers', { params });
      const rows = response.data.data || [];
      setKols(rows);
      setCurrentPageKolIds(rows.slice(0, 20).map((item) => item.id));
      setSelectedRowKeys([]);
    } catch (error) {
      message.error('获取 KOL 列表失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchGroups = async () => {
    try {
      const response = await axios.get('/api/groups');
      setGroups(response.data.data || []);
    } catch (error) {
      message.error('获取分组失败');
    }
  };

  const openDrawer = async (record) => {
    const requestId = ++drawerRequest.current;
    setDrawerOpen(true);
    setDrawerKol(record);
    setProjectHistory([]);
    setDrawerError('');
    setDrawerLoading(true);
    try {
      const [detail, history] = await Promise.all([
        axios.get(`/api/customers/${record.id}`),
        axios.get(`/api/customers/${record.id}/project-history`)
      ]);
      if (requestId !== drawerRequest.current) return;
      setDrawerKol(detail.data.data);
      setProjectHistory(history.data.data || []);
    } catch (error) {
      if (requestId === drawerRequest.current) setDrawerError('详情加载失败，请稍后重试');
    } finally {
      if (requestId === drawerRequest.current) setDrawerLoading(false);
    }
  };

  const closeDrawer = () => {
    drawerRequest.current += 1;
    setDrawerOpen(false);
  };

  const clearFilters = () => {
    setSearchText('');
    setSelectedGroup(null);
    setSelectedCooperationStatus(null);
    setSelectedPlatform(null);
    setSelectedCountry(null);
  };

  const openAddToProject = (ids) => {
    setProjectCustomerIds(ids);
    setTargetCampaignId(null);
    setAddToProjectOpen(true);
  };

  const addToProject = async (campaignId = targetCampaignId) => {
    if (!campaignId) {
      message.warning('请选择项目');
      return;
    }
    setAddingToProject(true);
    try {
      await Promise.all(projectCustomerIds.map((customerId) => (
        axios.post('/api/campaign-kols', {
          campaign_id: campaignId,
          customer_id: customerId
        })
      )));
      message.success(`已将 ${projectCustomerIds.length} 个 KOL 加入项目`);
      setAddToProjectOpen(false);
      setSelectedRowKeys([]);
      await fetchKols();
      if (drawerOpen && drawerKol) await openDrawer(drawerKol);
    } catch (error) {
      message.error(error.response?.data?.error || '加入项目失败');
    } finally {
      setAddingToProject(false);
    }
  };

  const createProject = async () => {
    const name = newProjectName.trim();
    if (!name) {
      message.warning('请输入项目名称');
      return;
    }
    setCreatingProject(true);
    try {
      const response = await axios.post('/api/campaigns', { name, product: name });
      const created = response.data.data;
      setCampaigns((items) => [...items, created]);
      setTargetCampaignId(created.id);
      setNewProjectOpen(false);
      setNewProjectName('');
      message.success('项目已创建');
      await addToProject(created.id);
    } catch (error) {
      message.error(error.response?.data?.error || '创建项目失败');
    } finally {
      setCreatingProject(false);
    }
  };

  const handleAdd = () => {
    setEditingKol(null);
    form.resetFields();
    form.setFieldsValue({ cooperation_status: 'available' });
    setModalVisible(true);
  };

  const handleEdit = (record) => {
    setEditingKol(record);
    form.setFieldsValue(record);
    setModalVisible(true);
  };

  const handleDelete = async (id) => {
    await axios.delete(`/api/customers/${id}`);
    message.success('删除成功');
    setSelectedRowKeys((keys) => keys.filter((key) => key !== id));
    fetchKols();
  };

  const handleBatchDelete = async () => {
    await axios.delete('/api/customers/batch', { data: { ids: selectedRowKeys } });
    message.success(`已删除 ${selectedRowKeys.length} 个 KOL`);
    setSelectedRowKeys([]);
    fetchKols();
  };

  const selectCurrentPage = () => {
    setSelectedRowKeys(currentPageKolIds);
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    if (editingKol) {
      await axios.put(`/api/customers/${editingKol.id}`, values);
      message.success('更新成功');
    } else {
      await axios.post('/api/customers', values);
      message.success('创建成功');
    }
    setModalVisible(false);
    await fetchKols();
    if (drawerOpen && editingKol) await openDrawer(editingKol);
  };

  const handleDownloadTemplate = () => {
    window.location.href = '/api/customers/template/download';
  };

  const handleImport = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    setImporting(true);

    try {
      const response = await axios.post('/api/customers/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      const result = response.data.data;
      message.success(response.data.message || '导入完成');
      if (result?.errors?.length) {
        Modal.warning({
          title: '部分行导入失败',
          width: 720,
          content: (
            <div style={{ maxHeight: 260, overflow: 'auto' }}>
              {result.errors.map((item) => <div key={item}>{item}</div>)}
            </div>
          )
        });
      }
      fetchKols();
      fetchGroups();
    } catch (error) {
      message.error(error.response?.data?.error || '导入失败');
    } finally {
      setImporting(false);
    }

    return false;
  };

  const accountLinks = (accounts = []) => accounts.length ? (
    <Space wrap size={[4, 4]}>{accounts.map((account, index) => (
      account.profile_url
        ? <a key={`${account.platform}-${account.id || index}`} href={account.profile_url} target="_blank" rel="noreferrer"><Tag color="blue">{account.platform}</Tag></a>
        : <Tag key={`${account.platform}-${index}`}>{account.platform}</Tag>
    ))}</Space>
  ) : '-';

  const columns = [
    {
      title: 'KOL',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      fixed: 'left',
      render: (v, r) => (
        <Button type="link" style={{ padding: 0, height: 'auto', maxWidth: '100%', whiteSpace: 'normal', textAlign: 'left', overflowWrap: 'anywhere' }} onClick={() => openDrawer(r)}>
          {v}
        </Button>
      )
    },
    { title: '平台账号', dataIndex: 'platform_accounts', key: 'platform_accounts', width: 220, render: accountLinks },
    { title: '国家地区', dataIndex: 'country_region', key: 'country_region', width: 120, render: (v) => v || '-' },
    { title: '默认报价', key: 'price', width: 150, render: (_, r) => r.video_price || r.price_rmb || '-' },
    {
      title: '合作状态',
      key: 'cooperation_status',
      width: 170,
      render: (_, r) => (
        r.cooperation_status === 'do_not_contact'
          ? <Tag color="red">全局不建议合作</Tag>
          : <Tag color="green">{cooperationStatusLabel(r.cooperation_status)}</Tag>
      )
    },
    { title: '风险', dataIndex: 'cooperation_risk_category', key: 'cooperation_risk_category', width: 140, render: (v) => cooperationRiskLabel(v) },
    { title: '最近项目', key: 'latest_project', width: 180, render: (_, r) => r.latest_project_name || '-' },
    { title: '备注', dataIndex: 'notes', key: 'notes', width: 220, ellipsis: true, render: (v) => v || '-' },
    {
      title: '操作',
      key: 'action',
      width: 150,
      fixed: 'right',
      render: (_, record) => (
        <Space direction="vertical" size={0} align="start">
          <Button type="link" onClick={() => openDrawer(record)}>查看</Button>
          <Button type="link" onClick={() => openAddToProject([record.id])}>加入项目</Button>
          <Button type="link" icon={<EditOutlined />} onClick={() => handleEdit(record)}>编辑</Button>
          <Popconfirm title="确定删除这个 KOL？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">KOL 管理</h1>
        <p className="page-subtitle">已通过审核的 KOL 会沉淀到这里，并可同步到飞书 KOL总表。</p>
      </div>

      <Card className="content-card" style={{ marginBottom: 16 }}>
        <Space size="large" wrap style={{ marginBottom: selectedRowKeys.length ? 16 : 0 }}>
          <Statistic title="总 KOL" value={kols.length} />
          <Statistic title="可合作" value={kols.filter((item) => item.cooperation_status !== 'do_not_contact').length} />
          <Statistic title="不建议合作" value={kols.filter((item) => item.cooperation_status === 'do_not_contact').length} />
          <Statistic title="已选" value={selectedRowKeys.length} />
        </Space>
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="搜索 KOL、联系人、邮箱、平台链接"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            onSearch={fetchKols}
            style={{ width: 300 }}
          />
          <Select
            allowClear
            placeholder="选择分组"
            value={selectedGroup}
            onChange={setSelectedGroup}
            style={{ width: 180 }}
            options={groups.map((item) => ({ value: item.id, label: item.name }))}
          />
          <Select
            allowClear
            placeholder="合作状态"
            value={selectedCooperationStatus}
            onChange={setSelectedCooperationStatus}
            style={{ width: 190 }}
            options={cooperationStatusOptions}
          />
          <Select allowClear placeholder="平台" value={selectedPlatform} onChange={setSelectedPlatform}
            style={{ width: 140 }} options={filterOptions.platforms.map((value) => ({ value, label: value }))} />
          <Select allowClear showSearch placeholder="国家地区" value={selectedCountry} onChange={setSelectedCountry}
            style={{ width: 160 }} options={filterOptions.countries.map((value) => ({ value, label: value }))} />
          <Button onClick={clearFilters}>清空筛选</Button>
          <Button icon={<ReloadOutlined />} onClick={fetchKols}>刷新</Button>
          <Button icon={<DownloadOutlined />} onClick={handleDownloadTemplate}>下载模板</Button>
          <Upload accept=".xlsx,.xls,.csv" showUploadList={false} beforeUpload={handleImport}>
            <Button icon={<UploadOutlined />} loading={importing}>批量导入</Button>
          </Upload>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增 KOL</Button>
        </Space>
      </Card>

      {selectedRowKeys.length > 0 && <Card className="content-card" style={{ marginBottom: 16 }}>
        <Space wrap>
          <span>已选 {selectedRowKeys.length} 个 KOL</span>
          <Button onClick={selectCurrentPage} disabled={!currentPageKolIds.length}>全选当前页</Button>
          <Button onClick={() => setSelectedRowKeys([])} disabled={!selectedRowKeys.length}>清空选择</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openAddToProject(selectedRowKeys)}>加入项目</Button>
          <Popconfirm
            title={`确定删除选中的 ${selectedRowKeys.length} 个 KOL？`}
            description="删除后会同时移除这些 KOL 在项目 KOL 子表里的关联。"
            onConfirm={handleBatchDelete}
            disabled={!selectedRowKeys.length}
          >
            <Button danger icon={<DeleteOutlined />} disabled={!selectedRowKeys.length}>批量删除</Button>
          </Popconfirm>
        </Space>
      </Card>}

      <Card className="content-card">
        <Table
          columns={columns}
          dataSource={kols}
          rowKey="id"
          loading={loading}
          rowSelection={{
            selectedRowKeys,
            onChange: setSelectedRowKeys,
            preserveSelectedRowKeys: true
          }}
          onChange={(_, __, ___, extra) => {
            setCurrentPageKolIds((extra.currentDataSource || []).map((item) => item.id));
          }}
          scroll={{ x: 1900 }}
          pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        />
      </Card>

      <Drawer title={drawerKol?.name || 'KOL 详情'} width={720} open={drawerOpen} onClose={closeDrawer}
        extra={drawerKol && <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openAddToProject([drawerKol.id])}>加入项目</Button>
          <Button icon={<EditOutlined />} onClick={() => handleEdit(drawerKol)}>编辑基本资料</Button>
        </Space>}>
        {drawerLoading ? <Spin /> : drawerError ? <Alert type="error" message={drawerError} /> : drawerKol && (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Descriptions bordered column={2} size="small">
              <Descriptions.Item label="国家地区">{drawerKol.country_region || '-'}</Descriptions.Item>
              <Descriptions.Item label="分组">{drawerKol.group_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Email">{drawerKol.email || '-'}</Descriptions.Item>
              <Descriptions.Item label="电话">{drawerKol.phone || '-'}</Descriptions.Item>
              <Descriptions.Item label="默认报价">{drawerKol.video_price || drawerKol.price_rmb || '-'}</Descriptions.Item>
              <Descriptions.Item label="合作状态">{cooperationStatusLabel(drawerKol.cooperation_status)}</Descriptions.Item>
              <Descriptions.Item label="风险">{cooperationRiskLabel(drawerKol.cooperation_risk_category)}</Descriptions.Item>
              <Descriptions.Item label="备注">{drawerKol.notes || '-'}</Descriptions.Item>
            </Descriptions>
            <div><h3>平台账号</h3>{accountLinks(drawerKol.platform_accounts)}</div>
            <div>
              <h3>项目历史</h3>
              {projectHistory.length ? <Table size="small" rowKey="id" pagination={false} dataSource={projectHistory}
                columns={[
                  { title: '项目', dataIndex: 'campaign_name' },
                  { title: '状态', dataIndex: 'project_status' },
                  { title: '项目报价', dataIndex: 'quoted_fee' },
                  { title: '最终费用', dataIndex: 'final_fee' },
                  { title: '跟进人', dataIndex: 'owner' },
                  { title: '证据', dataIndex: 'best_evidence_url', render: (v) => v ? <a href={v} target="_blank" rel="noreferrer">查看</a> : '-' },
                  { title: '备注', dataIndex: 'project_notes', ellipsis: true }
                ]} /> : <Empty description="暂无项目历史" />}
            </div>
          </Space>
        )}
      </Drawer>

      <Modal
        title={`加入项目（${projectCustomerIds.length} 个 KOL）`}
        open={addToProjectOpen}
        onCancel={() => setAddToProjectOpen(false)}
        onOk={() => addToProject()}
        confirmLoading={addingToProject}
      >
        <Select
          showSearch
          optionFilterProp="label"
          placeholder="请选择项目"
          value={targetCampaignId}
          onChange={setTargetCampaignId}
          style={{ width: '100%' }}
          options={campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name }))}
        />
        <Button type="link" icon={<PlusOutlined />} style={{ paddingLeft: 0, marginTop: 8 }} onClick={() => setNewProjectOpen(true)}>
          新建项目
        </Button>
      </Modal>

      <Modal
        title="新建项目"
        open={newProjectOpen}
        onCancel={() => setNewProjectOpen(false)}
        onOk={createProject}
        confirmLoading={creatingProject}
      >
        <Input
          autoFocus
          placeholder="请输入项目名称"
          value={newProjectName}
          onChange={(event) => setNewProjectName(event.target.value)}
          onPressEnter={createProject}
        />
      </Modal>

      <Modal
        title={editingKol ? '编辑 KOL' : '新增 KOL'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={handleSubmit}
        width={820}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="KOL" name="name" rules={[{ required: true, message: '请输入 KOL 名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="联系人" name="contact_name">
            <Input />
          </Form.Item>
          <Form.Item label="YouTube" name="youtube_url">
            <Input />
          </Form.Item>
          <Form.Item label="YouTube粉丝量" name="youtube_followers">
            <Input />
          </Form.Item>
          <Form.Item label="Instagram" name="instagram_url">
            <Input />
          </Form.Item>
          <Form.Item label="Instagram 粉丝量" name="instagram_followers">
            <Input />
          </Form.Item>
          <Form.Item label="TikTok" name="tiktok_url">
            <Input />
          </Form.Item>
          <Form.Item label="TikTok 粉丝量" name="tiktok_followers">
            <Input />
          </Form.Item>
          <Form.Item label="Email" name="email">
            <Input />
          </Form.Item>
          <Form.Item label="电话" name="phone">
            <Input />
          </Form.Item>
          <Form.Item label="国家地区" name="country_region">
            <Input />
          </Form.Item>
          <Form.Item label="视频价格" name="video_price">
            <Input />
          </Form.Item>
          <Form.Item label="汇率" name="exchange_rate">
            <Input />
          </Form.Item>
          <Form.Item label="价格（RMB）" name="price_rmb">
            <Input />
          </Form.Item>
          <Form.Item label="评分" name="rating">
            <Input />
          </Form.Item>
          <Form.Item label="合作状态" name="cooperation_status">
            <Select options={cooperationStatusOptions} />
          </Form.Item>
          <Form.Item label="不建议合作类型" name="cooperation_risk_category">
            <Select allowClear options={cooperationRiskOptions} />
          </Form.Item>
          <Form.Item
            label="不建议合作原因"
            name="cooperation_risk_reason"
            rules={[({ getFieldValue }) => ({
              validator(_, value) {
                if (getFieldValue('cooperation_status') !== 'do_not_contact' || value) return Promise.resolve();
                return Promise.reject(new Error('标记全局不建议合作时必须填写原因'));
              }
            })]}
          >
            <TextArea rows={3} />
          </Form.Item>
          <Form.Item label="分组" name="group_id">
            <Select allowClear options={groups.map((item) => ({ value: item.id, label: item.name }))} />
          </Form.Item>
          <Form.Item label="备注" name="notes">
            <TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Customers;
