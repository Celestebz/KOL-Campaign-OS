import React, { useEffect } from 'react';
import { Alert, Button, Card, Drawer, Form, Input, Space, Tag, Typography } from 'antd';
import { CheckCircleOutlined, SettingOutlined, WarningOutlined } from '@ant-design/icons';
import { getProviderState } from './settingsContract';

const { Text } = Typography;

const STATUS_META = {
  configured: { color: 'success', label: '已配置', icon: <CheckCircleOutlined /> },
  partial: { color: 'warning', label: '配置不完整', icon: <WarningOutlined /> },
  unconfigured: { color: 'default', label: '待配置', icon: null }
};

export const ProviderCard = ({ meta, value, active, showReserved, contextLabel, onConfigure }) => {
  const state = getProviderState(meta, value, active, showReserved);
  if (!state.visible) return null;
  const status = STATUS_META[state.status];

  return (
    <Card className={`settings-provider-card ${active ? 'settings-provider-card--active' : ''}`} size="small">
      <div className="settings-provider-card__topline">
        <div>
          <Space size={6} wrap>
            <Text strong>{meta.label}</Text>
            {active ? <Tag color="blue">当前启用</Tag> : null}
            {meta.reserved ? <Tag>预留</Tag> : null}
          </Space>
          <div className="settings-provider-card__context">{contextLabel}</div>
        </div>
        <Tag color={status.color} icon={status.icon}>{status.label}</Tag>
      </div>
      <div className="settings-provider-card__footer">
        <Text type="secondary">{state.summary}</Text>
        <Button
          type="text"
          icon={<SettingOutlined />}
          aria-label={`配置 ${meta.label}`}
          onClick={() => onConfigure(meta, value)}
        >
          配置
        </Button>
      </div>
    </Card>
  );
};

const FIELD_META = {
  custom_provider_name: { label: 'Provider 名称', placeholder: '例如：新的数据服务商' },
  api_key: { label: 'API Key', password: true, placeholder: '留空保留现有密钥；输入新值则更新' },
  base_url: { label: 'Base URL', placeholder: '可留空使用默认值' },
  model: { label: 'Model', placeholder: '例如：deepseek-chat / gpt-4o-mini' },
  connection_id: { label: 'Maton Connection ID', placeholder: '同一 app 有多个 connection 时填写' },
  auth_header_name: { label: 'Auth Header Name', placeholder: 'Authorization' },
  auth_scheme: { label: 'Auth Scheme', placeholder: 'Bearer' },
  notes: { label: '备注', placeholder: '用途、限制或接入说明' }
};

export const ProviderDrawer = ({ drawer, saving, error, onCancel, onSave }) => {
  const [form] = Form.useForm();

  useEffect(() => {
    if (drawer) form.setFieldsValue(drawer.value || {});
    else form.resetFields();
  }, [drawer, form]);

  const meta = drawer?.meta;

  return (
    <Drawer
      title={meta ? `配置 ${meta.label}` : '配置 Provider'}
      open={Boolean(drawer)}
      width={420}
      onClose={onCancel}
      destroyOnClose={false}
      forceRender
      className="settings-provider-drawer"
      footer={(
        <div className="settings-provider-drawer__footer">
          <Button onClick={onCancel}>取消</Button>
          <Button type="primary" loading={saving} onClick={() => form.submit()}>保存此配置</Button>
        </div>
      )}
    >
      {drawer ? (
        <>
          <Text type="secondary">{drawer.contextLabel}</Text>
          {error ? <Alert type="error" showIcon message={error} className="settings-drawer-error" /> : null}
          <Form form={form} layout="vertical" onFinish={onSave} className="settings-provider-form">
            {meta.fields.map((field) => {
              const config = FIELD_META[field];
              if (!config) return null;
              const Control = config.password ? Input.Password : field === 'notes' ? Input.TextArea : Input;
              return (
                <Form.Item key={field} name={field} label={config.label}>
                  <Control
                    autoComplete={config.password ? 'new-password' : undefined}
                    placeholder={config.placeholder}
                    autoSize={field === 'notes' ? { minRows: 2, maxRows: 4 } : undefined}
                  />
                </Form.Item>
              );
            })}
          </Form>
          <div className="settings-secret-note">密钥留空或保持遮罩值时，系统会保留已保存的密钥。</div>
        </>
      ) : null}
    </Drawer>
  );
};
