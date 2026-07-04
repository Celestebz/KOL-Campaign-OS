import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Divider, Form, Input, message, Row, Select, Space, Switch, Tag, Typography } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Text } = Typography;

const PLATFORM_OPTIONS = {
  youtube: [
    { value: 'google_official', label: 'Google Official' },
    { value: 'maton_gateway', label: 'Maton Gateway' },
    { value: 'scrapecreators', label: 'ScrapeCreators（预留）' },
    { value: 'brightdata', label: 'Bright Data（预留）' },
    { value: 'custom', label: 'Custom（预留）' }
  ],
  instagram: [
    { value: 'scrapecreators', label: 'ScrapeCreators' },
    { value: 'brightdata', label: 'Bright Data（预留）' },
    { value: 'apify', label: 'Apify（预留）' },
    { value: 'maton_gateway', label: 'Maton Gateway（预留）' },
    { value: 'custom', label: 'Custom（预留）' }
  ],
  tiktok: [
    { value: 'scrapecreators', label: 'ScrapeCreators' },
    { value: 'brightdata', label: 'Bright Data（预留）' },
    { value: 'apify', label: 'Apify（预留）' },
    { value: 'maton_gateway', label: 'Maton Gateway（预留）' },
    { value: 'custom', label: 'Custom（预留）' }
  ]
};

const PLATFORM_LABELS = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok'
};

const AI_OPTIONS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'custom_openai_compatible', label: 'Custom OpenAI-Compatible' },
  { value: 'custom_http_api', label: 'Custom HTTP API（仅预留）' }
];

const AGENT_OPTIONS = [
  { value: 'maton_gateway', label: 'Maton Gateway' },
  { value: 'browseract', label: 'BrowserAct（预留）' },
  { value: 'playwright_local', label: 'Playwright Local（预留）' },
  { value: 'custom_tool_gateway', label: 'Custom Tool Gateway（预留）' }
];

const DEFAULT_SETTINGS = {
  platforms: {
    youtube: { primary: 'google_official', fallbacks: [], providers: {} },
    instagram: { primary: 'scrapecreators', fallbacks: [], providers: {} },
    tiktok: { primary: 'scrapecreators', fallbacks: [], providers: {} }
  },
  aiModels: { active: 'deepseek', providers: {} },
  agents: { active: 'maton_gateway', providers: {} },
  cloudStorage: {
    primary: 'feishu_bitable',
    feishu: {
      app_id: '',
      app_secret: '',
      base_url: 'https://open.feishu.cn',
      app_token: '',
      kol_table_id: '',
      campaign_kol_table_id: '',
      campaign_table_id: '',
      campaign_subtable_map: '',
      notes: ''
    }
  },
  externalAgent: {
    enabled: true,
    api_token: '',
    notes: ''
  },
  fallbackStrategy: {
    enableFallback: false,
    saveFailureReasons: true,
    saveRawResponses: true,
    allowAiToolCalls: false
  }
};

const providerLabel = (provider) => {
  const map = {
    google_official: 'Google Official',
    scrapecreators: 'ScrapeCreators',
    brightdata: 'Bright Data',
    apify: 'Apify',
    maton_gateway: 'Maton Gateway',
    custom: 'Custom',
    openai: 'OpenAI',
    deepseek: 'DeepSeek',
    minimax: 'MiniMax',
    custom_openai_compatible: 'Custom OpenAI-Compatible',
    custom_http_api: 'Custom HTTP API',
    browseract: 'BrowserAct',
    playwright_local: 'Playwright Local',
    custom_tool_gateway: 'Custom Tool Gateway'
  };
  return map[provider] || provider;
};

const ProviderFields = ({ baseName, provider, showModel = false, custom = false, maton = false, reserved = false }) => (
  <div style={{ marginBottom: 18 }}>
    <Divider orientation="left" plain>
      <Space>
        {providerLabel(provider)}
        {reserved ? <Tag>预留</Tag> : null}
      </Space>
    </Divider>
    {custom ? (
      <Form.Item label="Provider 名称" name={[...baseName, 'custom_provider_name']}>
        <Input placeholder="例如：某个新的数据服务商" />
      </Form.Item>
    ) : null}
    <Row gutter={16}>
      <Col span={showModel ? 8 : 12}>
        <Form.Item label="API Key" name={[...baseName, 'api_key']}>
          <Input.Password autoComplete="new-password" placeholder="留空表示暂不启用" />
        </Form.Item>
      </Col>
      <Col span={showModel ? 8 : 12}>
        <Form.Item label="Base URL" name={[...baseName, 'base_url']}>
          <Input placeholder="可留空使用默认值" />
        </Form.Item>
      </Col>
      {showModel ? (
        <Col span={8}>
          <Form.Item label="Model" name={[...baseName, 'model']}>
            <Input placeholder="例如：deepseek-chat / gpt-4o-mini" />
          </Form.Item>
        </Col>
      ) : null}
    </Row>
    {custom ? (
      <Row gutter={16}>
        <Col span={8}>
          <Form.Item label="Auth Header Name" name={[...baseName, 'auth_header_name']}>
            <Input placeholder="Authorization" />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item label="Auth Scheme" name={[...baseName, 'auth_scheme']}>
            <Input placeholder="Bearer" />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item label="备注" name={[...baseName, 'notes']}>
            <Input placeholder="用途、限制或接入说明" />
          </Form.Item>
        </Col>
      </Row>
    ) : null}
    {maton ? (
      <Form.Item label="Maton Connection ID" name={[...baseName, 'connection_id']}>
        <Input placeholder="可选：同一 app 有多个 connection 时填写" />
      </Form.Item>
    ) : null}
  </div>
);

const Settings = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchSettings = async () => {
    try {
      const response = await axios.get('/api/settings');
      form.setFieldsValue({ settings: { ...DEFAULT_SETTINGS, ...(response.data.data || {}) } });
    } catch (error) {
      message.error('获取 API 设置失败');
    }
  };

  const onFinish = async (values) => {
    setLoading(true);
    try {
      await axios.post('/api/settings', values);
      message.success('API 设置已保存');
      await fetchSettings();
    } catch (error) {
      message.error(error.response?.data?.error || '保存失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">API 设置</h1>
      </div>

      <Form form={form} layout="vertical" onFinish={onFinish}>
        <Card title="Platform Data Providers" className="content-card" style={{ marginBottom: 16 }}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="平台 Provider 负责抓数据：视频表现、评论、主页信息。当前已接入 Google Official YouTube、YouTube Maton Gateway、ScrapeCreators Instagram/TikTok。"
          />
          {Object.entries(PLATFORM_OPTIONS).map(([platform, options]) => (
            <div key={platform} style={{ marginBottom: 26 }}>
              <Divider orientation="left">{PLATFORM_LABELS[platform]}</Divider>
              <Row gutter={16}>
                <Col span={12}>
                  <Form.Item label="主数据源" name={['settings', 'platforms', platform, 'primary']}>
                    <Select options={options} />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="备用数据源" name={['settings', 'platforms', platform, 'fallbacks']}>
                    <Select mode="multiple" allowClear options={options} placeholder="开启 fallback 后才会尝试" />
                  </Form.Item>
                </Col>
              </Row>
              {options.map((option) => (
                <ProviderFields
                  key={option.value}
                  baseName={['settings', 'platforms', platform, 'providers', option.value]}
                  provider={option.value}
                  custom={option.value === 'custom'}
                  maton={option.value === 'maton_gateway'}
                  reserved={option.label.includes('预留')}
                />
              ))}
            </div>
          ))}
        </Card>

        <Card title="AI Model Providers" className="content-card" style={{ marginBottom: 16 }}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="AI Model Provider 负责分析、总结和生成报告；它不是平台抓数 API。Custom HTTP API 先预留，暂不可用于分析。"
          />
          <Form.Item label="当前 AI 模型" name={['settings', 'aiModels', 'active']}>
            <Select options={AI_OPTIONS} />
          </Form.Item>
          {AI_OPTIONS.map((option) => (
            <ProviderFields
              key={option.value}
              baseName={['settings', 'aiModels', 'providers', option.value]}
              provider={option.value}
              showModel
              custom={option.value === 'custom_openai_compatible' || option.value === 'custom_http_api'}
              reserved={option.value === 'custom_http_api'}
            />
          ))}
        </Card>

        <Card title="Agent / Automation Providers" className="content-card" style={{ marginBottom: 16 }}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="Agent Provider 负责未来自动找 KOL、自动调工具、执行多步骤任务；当前视频分析流程不会直接调用这些工具。"
          />
          <Form.Item label="默认 Agent Provider" name={['settings', 'agents', 'active']}>
            <Select options={AGENT_OPTIONS} />
          </Form.Item>
          {AGENT_OPTIONS.map((option) => (
            <ProviderFields
              key={option.value}
              baseName={['settings', 'agents', 'providers', option.value]}
              provider={option.value}
              custom={option.value === 'custom_tool_gateway'}
              maton={option.value === 'maton_gateway'}
              reserved={option.value !== 'maton_gateway'}
            />
          ))}
        </Card>

        <Card title="External Agent API" className="content-card" style={{ marginBottom: 16 }}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="给 Codex / WorkBuddy 等外部高级 Agent 使用：Agent 可读取 Strategy Brief 并自动写入 Raw Candidates，但不能 Approve 到 KOL Master。"
          />
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item label="启用 External Agent API" name={['settings', 'externalAgent', 'enabled']} valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={18}>
              <Form.Item label="Agent API Token" name={['settings', 'externalAgent', 'api_token']}>
                <Input.Password autoComplete="new-password" placeholder="外部 Agent 调用 /api/agent/* 时使用 Bearer Token" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="Agent 使用备注" name={['settings', 'externalAgent', 'notes']}>
            <Input placeholder="例如：只允许写 Raw Candidates；Approve 永远人工确认。" />
          </Form.Item>
          <Text type="secondary">
            Brief API: GET /api/agent/brief/:strategyId；写入 API: POST /api/agent/raw-candidates/import；请求头使用 Authorization: Bearer &lt;Agent API Token&gt;。
          </Text>
        </Card>

        <Card title="Cloud Data Storage" className="content-card" style={{ marginBottom: 16 }}>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="飞书多维表格作为 Approved KOL 的云端主库；每个 Campaign 可以同步到自己的项目子表，Raw Candidates 默认只保存在本地。"
          />
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label="Feishu App ID" name={['settings', 'cloudStorage', 'feishu', 'app_id']}>
                <Input placeholder="cli_xxx" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="Feishu App Secret" name={['settings', 'cloudStorage', 'feishu', 'app_secret']}>
                <Input.Password autoComplete="new-password" placeholder="留空表示暂不启用同步" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="OpenAPI Base URL" name={['settings', 'cloudStorage', 'feishu', 'base_url']}>
                <Input placeholder="https://open.feishu.cn" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item label="Base/App Token" name={['settings', 'cloudStorage', 'feishu', 'app_token']}>
                <Input placeholder="多维表格 app_token" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="KOL Master Table ID" name={['settings', 'cloudStorage', 'feishu', 'kol_table_id']}>
                <Input placeholder="tbl..." />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="默认 Campaign KOL 表" name={['settings', 'cloudStorage', 'feishu', 'campaign_kol_table_id']}>
                <Input placeholder="tbl...（无子表映射时使用）" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="Campaigns Table ID" name={['settings', 'cloudStorage', 'feishu', 'campaign_table_id']}>
                <Input placeholder="tbl...（预留）" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="Campaign 子表映射" name={['settings', 'cloudStorage', 'feishu', 'campaign_subtable_map']}>
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 5 }}
              placeholder={`Campaign Name=tbl_xxx\n或 {"Campaign Name":"tbl_xxx"}`}
            />
          </Form.Item>
          <Form.Item label="同步备注" name={['settings', 'cloudStorage', 'feishu', 'notes']}>
            <Input placeholder="例如字段名版本、权限说明或表格链接" />
          </Form.Item>
        </Card>

        <Card title="Fallback Strategy" className="content-card" style={{ marginBottom: 16 }}>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="Fallback 会在主源失败后尝试备用源，能提高成功率，但可能额外消耗备用 API 额度。默认关闭。"
          />
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item label="主源失败后尝试备用源" name={['settings', 'fallbackStrategy', 'enableFallback']} valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="保存失败原因" name={['settings', 'fallbackStrategy', 'saveFailureReasons']} valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="保存原始返回" name={['settings', 'fallbackStrategy', 'saveRawResponses']} valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item label="允许 AI 自动调用工具" name={['settings', 'fallbackStrategy', 'allowAiToolCalls']} valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
          <Text type="secondary">当前版本会保存 Provider 配置和策略；AI 自动调用工具将在 KOL Finder / 自动报告阶段接入。</Text>
        </Card>

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} icon={<SaveOutlined />}>
            保存设置
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default Settings;
