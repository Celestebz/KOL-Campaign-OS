import React from 'react';
import { Alert, Button, Empty, Form, Input, Select, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';

const { Text } = Typography;

const FeishuSubtableMappings = ({ campaigns = [], value = [], onChange = () => {}, disabled = false, loadError = '' }) => {
  const rows = Array.isArray(value) ? value : [];
  const selectedCounts = rows.reduce((counts, row) => {
    if (row?.campaign_id) counts[row.campaign_id] = (counts[row.campaign_id] || 0) + 1;
    return counts;
  }, {});

  const updateRow = (index, patch) => onChange(rows.map((row, rowIndex) => (
    rowIndex === index ? { ...row, ...patch } : row
  )));

  return (
    <div className="feishu-subtable-mappings">
      {loadError && <Alert type="warning" showIcon message={loadError} className="feishu-subtable-mappings__alert" />}
      {!rows.length && !loadError && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未配置项目子表；需要同步的每个项目都必须单独配置。" />
      )}
      {rows.map((row, index) => {
        const duplicate = row.campaign_id && selectedCounts[row.campaign_id] > 1;
        const tableId = String(row.table_id ?? '');
        const tableError = !tableId.trim()
          ? '请输入飞书子表 ID'
          : !/^tbl\S+$/.test(tableId.trim()) ? 'Table ID 必须以 tbl 开头' : '';
        const projectError = !row.campaign_id ? '请选择系统项目' : duplicate ? '同一项目只能配置一次' : '';
        return (
          <div className="feishu-subtable-mappings__row" key={`${row.campaign_id || 'new'}-${index}`}>
            <Form.Item validateStatus={projectError ? 'error' : ''} help={projectError || null} className="feishu-subtable-mappings__field">
              <Select
                aria-label="系统项目"
                placeholder="选择系统项目"
                value={row.campaign_id || undefined}
                disabled={disabled || Boolean(loadError)}
                onChange={(campaignId) => updateRow(index, { campaign_id: campaignId })}
                options={campaigns.map((campaign) => ({
                  value: Number(campaign.id),
                  label: campaign.name,
                  disabled: Number(campaign.id) !== Number(row.campaign_id) && Boolean(selectedCounts[campaign.id])
                }))}
              />
            </Form.Item>
            <Form.Item validateStatus={tableError ? 'error' : ''} help={tableError || null} className="feishu-subtable-mappings__field">
              <Input
                aria-label="飞书子表 ID"
                placeholder="tbl..."
                value={tableId}
                disabled={disabled || Boolean(loadError)}
                onChange={(event) => updateRow(index, { table_id: event.target.value })}
              />
            </Form.Item>
            <Button
              aria-label="删除项目映射"
              icon={<DeleteOutlined />}
              danger
              type="text"
              disabled={disabled || Boolean(loadError)}
              onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}
            />
          </div>
        );
      })}
      <Button
        aria-label="添加项目映射"
        icon={<PlusOutlined />}
        disabled={disabled || Boolean(loadError) || rows.length >= campaigns.length}
        onClick={() => onChange([...rows, { campaign_id: null, table_id: '' }])}
      >
        添加项目映射
      </Button>
      <Text type="secondary" className="feishu-subtable-mappings__note">未配置映射的项目在同步时会明确报错，不会写入其他项目的子表。</Text>
    </div>
  );
};

export default FeishuSubtableMappings;
