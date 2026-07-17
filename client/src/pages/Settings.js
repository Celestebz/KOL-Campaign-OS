import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Col, Form, Input, Row, Select, Space, Switch, Tabs, Tag, Typography, message
} from 'antd';
import { ArrowRightOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import axios from 'axios';
import {
  AGENT_PROVIDERS,
  AI_PROVIDERS,
  DEFAULT_SETTINGS,
  PLATFORM_META,
  SETTINGS_SECTIONS,
  getProviderState,
  mergeSettings,
  providerOptions,
  updateAtPath
} from './settings/settingsContract';
import { ProviderCard, ProviderDrawer } from './settings/SettingsProviderComponents';
import './Settings.css';

const { Text } = Typography;

const Settings = () => {
  const [form] = Form.useForm();
  const [settings, setSettings] = useState(() => mergeSettings(DEFAULT_SETTINGS, {}));
  const [activeSection, setActiveSection] = useState('overview');
  const [activePlatform, setActivePlatform] = useState('youtube');
  const [showReserved, setShowReserved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [drawer, setDrawer] = useState(null);
  const [drawerError, setDrawerError] = useState('');

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const response = await axios.get('/api/settings');
      const next = mergeSettings(DEFAULT_SETTINGS, response.data.data || {});
      setSettings(next);
      form.setFieldsValue({ settings: next });
      setDirty(false);
    } catch (error) {
      setLoadError('获取 API 设置失败，请确认后端服务已启动后重试。');
    } finally {
      setLoading(false);
    }
  }, [form]);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const persistSettings = async (nextSettings, successText = 'API 设置已保存') => {
    setSaving(true);
    try {
      await axios.post('/api/settings', { settings: nextSettings });
      message.success(successText);
      await fetchSettings();
      return true;
    } catch (error) {
      throw new Error(error.response?.data?.error || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const saveSection = async () => {
    try {
      const values = form.getFieldsValue(true).settings || {};
      await persistSettings(mergeSettings(settings, values));
    } catch (error) {
      message.error(error.message);
    }
  };

  const openProvider = (meta, value, path, contextLabel) => {
    setDrawer({ meta, value: value || {}, path, contextLabel });
    setDrawerError('');
  };

  const saveProvider = async (providerValues) => {
    try {
      const pendingPageValues = form.getFieldsValue(true).settings || {};
      const next = updateAtPath(mergeSettings(settings, pendingPageValues), drawer.path, providerValues);
      await persistSettings(next, `${drawer.meta.label} 配置已保存`);
      setDrawer(null);
      setDrawerError('');
    } catch (error) {
      setDrawerError(error.message);
    }
  };

  const sectionItems = SETTINGS_SECTIONS.map(({ key, label }) => ({ key, label }));

  const platform = PLATFORM_META[activePlatform];
  const platformSettings = settings.platforms[activePlatform];

  const overviewItems = useMemo(() => {
    const platformReady = Object.entries(PLATFORM_META).filter(([key, meta]) => {
      const current = settings.platforms[key];
      const active = meta.providers.find((item) => item.value === current.primary);
      return active && getProviderState(active, current.providers?.[active.value], true, true).configured;
    }).length;
    const activeAi = AI_PROVIDERS.find((item) => item.value === settings.aiModels.active);
    const aiReady = activeAi && getProviderState(activeAi, settings.aiModels.providers?.[activeAi.value], true, true).configured;
    const activeAgent = AGENT_PROVIDERS.find((item) => item.value === settings.agents.active);
    const agentReady = activeAgent && getProviderState(activeAgent, settings.agents.providers?.[activeAgent.value], true, true).configured;
    const feishu = settings.cloudStorage.feishu;
    return [
      { key: 'platforms', label: '平台数据源', value: `${platformReady}/3 个平台已就绪`, ready: platformReady === 3 },
      { key: 'ai', label: 'AI 模型', value: settings.aiModels.active, ready: Boolean(aiReady) },
      { key: 'agents', label: 'Agent 自动化', value: settings.agents.active, ready: Boolean(agentReady) },
      { key: 'external', label: 'External Agent API', value: settings.externalAgent.enabled ? '已启用' : '未启用', ready: Boolean(settings.externalAgent.api_token) },
      { key: 'storage', label: '云端存储', value: feishu.app_id && feishu.app_token ? '飞书已配置' : '飞书待配置', ready: Boolean(feishu.app_id && feishu.app_token) },
      { key: 'runtime', label: '运行与备用策略', value: settings.fallbackStrategy.enableFallback ? 'Fallback 已启用' : '仅使用主数据源', ready: true }
    ];
  }, [settings]);

  const SectionHeading = ({ title, description, extra }) => (
    <div className="settings-section-heading">
      <div><h2>{title}</h2><p>{description}</p></div>
      {extra}
    </div>
  );

  const SaveSectionButton = () => (
    <div className="settings-section-actions">
      <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={!dirty} onClick={saveSection}>保存更改</Button>
    </div>
  );

  const renderOverview = () => (
    <>
      <SectionHeading title="配置概览" description="快速检查当前启用项与配置完整度。状态仅代表字段完整，不代表外部服务在线。" />
      <div className="settings-overview-grid">
        {overviewItems.map((item) => (
          <Card key={item.key} className="settings-overview-card" size="small">
            <div className="settings-overview-card__label">{item.label}</div>
            <div className="settings-overview-card__value">{item.value}</div>
            <Space>
              <Tag color={item.ready ? 'success' : 'warning'}>{item.ready ? '配置完整' : '需要检查'}</Tag>
              <Button type="link" icon={<ArrowRightOutlined />} onClick={() => setActiveSection(item.key)}>进入设置</Button>
            </Space>
          </Card>
        ))}
      </div>
    </>
  );

  const renderPlatforms = () => (
    <>
      <SectionHeading
        title="平台数据源"
        description="管理视频表现、评论和创作者主页的数据来源。每个平台独立选择主源和备用源。"
        extra={<Switch aria-label="显示预留项" checked={showReserved} onChange={setShowReserved} checkedChildren="显示预留" unCheckedChildren="隐藏预留" />}
      />
      <Tabs activeKey={activePlatform} onChange={setActivePlatform} items={Object.entries(PLATFORM_META).map(([key, value]) => ({ key, label: value.label }))} />
      <Alert
        type={settings.fallbackStrategy.enableFallback ? 'info' : 'success'}
        showIcon
        message={`主数据源：${platform.providers.find((item) => item.value === platformSettings.primary)?.label || platformSettings.primary}；Fallback ${settings.fallbackStrategy.enableFallback ? '已启用' : '未启用'}`}
        style={{ marginBottom: 16 }}
      />
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Form.Item label="主数据源" name={['settings', 'platforms', activePlatform, 'primary']}>
            <Select options={providerOptions(platform.providers)} />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item label="备用数据源" name={['settings', 'platforms', activePlatform, 'fallbacks']}>
            <Select mode="multiple" allowClear options={providerOptions(platform.providers)} placeholder="开启 Fallback 后按顺序尝试" />
          </Form.Item>
        </Col>
      </Row>
      <div className="settings-provider-grid">
        {platform.providers.map((meta) => (
          <ProviderCard
            key={meta.value}
            meta={meta}
            value={platformSettings.providers?.[meta.value]}
            active={platformSettings.primary === meta.value}
            showReserved={showReserved}
            contextLabel={`${platform.label} 数据 Provider`}
            onConfigure={() => openProvider(meta, platformSettings.providers?.[meta.value], ['platforms', activePlatform, 'providers', meta.value], `${platform.label} 数据 Provider`)}
          />
        ))}
      </div>
      <SaveSectionButton />
    </>
  );

  const renderProviderSection = (kind) => {
    const isAi = kind === 'ai';
    const providers = isAi ? AI_PROVIDERS : AGENT_PROVIDERS;
    const scope = isAi ? settings.aiModels : settings.agents;
    const activeKey = isAi ? 'active' : 'active';
    const rootPath = isAi ? 'aiModels' : 'agents';
    const title = isAi ? 'AI 模型' : 'Agent 自动化';
    const context = isAi ? '分析、总结和报告生成' : '自动找 KOL 与多步骤工具调用';
    return (
      <>
        <SectionHeading
          title={title}
          description={context}
          extra={<Switch aria-label="显示预留项" checked={showReserved} onChange={setShowReserved} checkedChildren="显示预留" unCheckedChildren="隐藏预留" />}
        />
        <Form.Item label={isAi ? '当前 AI 模型' : '默认 Agent Provider'} name={['settings', rootPath, activeKey]}>
          <Select options={providerOptions(providers)} />
        </Form.Item>
        <div className="settings-provider-grid">
          {providers.map((meta) => (
            <ProviderCard
              key={meta.value}
              meta={meta}
              value={scope.providers?.[meta.value]}
              active={scope.active === meta.value}
              showReserved={showReserved}
              contextLabel={context}
              onConfigure={() => openProvider(meta, scope.providers?.[meta.value], [rootPath, 'providers', meta.value], context)}
            />
          ))}
        </div>
        <SaveSectionButton />
      </>
    );
  };

  const renderExternal = () => (
    <>
      <SectionHeading title="External Agent API" description="供 Codex、WorkBuddy 等外部 Agent 读取策略并写入候选池，候选通过仍由人工确认。" />
      <Row gutter={16}>
        <Col xs={24} md={7}><Form.Item label="启用 External Agent API" name={['settings', 'externalAgent', 'enabled']} valuePropName="checked"><Switch /></Form.Item></Col>
        <Col xs={24} md={17}><Form.Item label="Agent API Token" name={['settings', 'externalAgent', 'api_token']}><Input.Password autoComplete="new-password" placeholder="留空保留现有 token；输入新值则更新" /></Form.Item></Col>
      </Row>
      <Form.Item label="Agent 使用备注" name={['settings', 'externalAgent', 'notes']}><Input placeholder="例如：只允许写候选池；通过永远人工确认。" /></Form.Item>
      <Alert type="info" showIcon message="Brief API: GET /api/agent/brief/:strategyId；写入 API: POST /api/agent/raw-candidates/import" />
      <SaveSectionButton />
    </>
  );

  const renderStorage = () => (
    <>
      <SectionHeading title="云端存储" description="飞书多维表格作为已通过 KOL 的云端主库；候选池默认只保存在本地。" />
      <Row gutter={16}>
        <Col xs={24} md={8}><Form.Item label="Feishu App ID" name={['settings', 'cloudStorage', 'feishu', 'app_id']}><Input placeholder="cli_xxx" /></Form.Item></Col>
        <Col xs={24} md={8}><Form.Item label="Feishu App Secret" name={['settings', 'cloudStorage', 'feishu', 'app_secret']}><Input.Password autoComplete="new-password" placeholder="留空保留现有 secret" /></Form.Item></Col>
        <Col xs={24} md={8}><Form.Item label="OpenAPI Base URL" name={['settings', 'cloudStorage', 'feishu', 'base_url']}><Input /></Form.Item></Col>
      </Row>
      <Row gutter={16}>
        <Col xs={24} md={12}><Form.Item label="Base/App Token" name={['settings', 'cloudStorage', 'feishu', 'app_token']}><Input.Password autoComplete="new-password" placeholder="留空保留现有 app_token" /></Form.Item></Col>
        <Col xs={24} md={12}><Form.Item label="飞书 KOL 总表 ID" name={['settings', 'cloudStorage', 'feishu', 'kol_table_id']}><Input placeholder="tbl..." /></Form.Item></Col>
        <Col xs={24} md={12}><Form.Item label="默认项目 KOL 子表" name={['settings', 'cloudStorage', 'feishu', 'campaign_kol_table_id']}><Input placeholder="tbl..." /></Form.Item></Col>
        <Col xs={24} md={12}><Form.Item label="项目表 ID" name={['settings', 'cloudStorage', 'feishu', 'campaign_table_id']}><Input placeholder="tbl...（预留）" /></Form.Item></Col>
      </Row>
      <Form.Item label="项目子表映射" name={['settings', 'cloudStorage', 'feishu', 'campaign_subtable_map']}><Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} placeholder={'项目名称=tbl_xxx\n或 {"项目名称":"tbl_xxx"}'} /></Form.Item>
      <Form.Item label="同步备注" name={['settings', 'cloudStorage', 'feishu', 'notes']}><Input /></Form.Item>
      <SaveSectionButton />
    </>
  );

  const renderRuntime = () => (
    <>
      <SectionHeading title="运行与备用策略" description="主数据源失败后的处理方式，以及诊断信息的保存范围。Fallback 可能额外消耗 API 额度。" />
      <Alert type="warning" showIcon message="Fallback 默认关闭；启用后会按各平台配置的备用数据源顺序尝试。" style={{ marginBottom: 18 }} />
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}><Form.Item label="主源失败后尝试备用源" name={['settings', 'fallbackStrategy', 'enableFallback']} valuePropName="checked"><Switch /></Form.Item></Col>
        <Col xs={24} md={12}><Form.Item label="保存失败原因" name={['settings', 'fallbackStrategy', 'saveFailureReasons']} valuePropName="checked"><Switch /></Form.Item></Col>
        <Col xs={24} md={12}><Form.Item label="保存原始返回" name={['settings', 'fallbackStrategy', 'saveRawResponses']} valuePropName="checked"><Switch /></Form.Item></Col>
        <Col xs={24} md={12}><Form.Item label="允许 AI 自动调用工具" name={['settings', 'fallbackStrategy', 'allowAiToolCalls']} valuePropName="checked"><Switch /></Form.Item></Col>
      </Row>
      <Text type="secondary">AI 自动调用工具将在 KOL 寻找和自动报告阶段使用。</Text>
      <SaveSectionButton />
    </>
  );

  const renderSection = () => ({
    overview: renderOverview,
    platforms: renderPlatforms,
    ai: () => renderProviderSection('ai'),
    agents: () => renderProviderSection('agents'),
    external: renderExternal,
    storage: renderStorage,
    runtime: renderRuntime
  }[activeSection]?.());

  return (
    <div className="settings-page">
      <Tabs className="settings-section-nav" activeKey={activeSection} onChange={setActiveSection} items={sectionItems} />
      <Select className="settings-mobile-nav" aria-label="选择设置分类" value={activeSection} onChange={setActiveSection} options={sectionItems.map(({ key, label }) => ({ value: key, label }))} />

      {loadError ? (
        <Alert type="error" showIcon message={loadError} action={<Button icon={<ReloadOutlined />} onClick={fetchSettings}>重试</Button>} />
      ) : (
        <Form form={form} layout="vertical" onValuesChange={() => setDirty(true)} disabled={loading}>
          <Card className="settings-workspace" loading={loading}>{renderSection()}</Card>
        </Form>
      )}

      <ProviderDrawer drawer={drawer} saving={saving} error={drawerError} onCancel={() => { setDrawer(null); setDrawerError(''); }} onSave={saveProvider} />
    </div>
  );
};

export default Settings;
