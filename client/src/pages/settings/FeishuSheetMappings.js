import React from 'react';
import { Alert, Button, Empty, Form, Input, Select, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';

const { Text } = Typography;

const FeishuSheetMappings = ({ campaigns = [], value = [], onChange = () => {}, loadError = '', emptyText }) => {
  const rows = Array.isArray(value) ? value : [];
  const selectedCounts = rows.reduce((counts, row) => {
    if (row?.campaign_id) counts[row.campaign_id] = (counts[row.campaign_id] || 0) + 1;
    return counts;
  }, {});
  const updateRow = (index, patch) => onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));

  return (
    <div className="feishu-subtable-mappings">
      {loadError && <Alert type="warning" showIcon message={loadError} className="feishu-subtable-mappings__alert" />}
      {!rows.length && !loadError && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />}
      {rows.map((row, index) => {
        const duplicate = row.campaign_id && selectedCounts[row.campaign_id] > 1;
        return (
          <div className="feishu-subtable-mappings__row" key={`${row.campaign_id || 'new'}-${index}`}>
            <Form.Item validateStatus={!row.campaign_id || duplicate ? 'error' : ''} help={!row.campaign_id ? '请选择系统项目' : duplicate ? '同一项目只能配置一次' : null} className="feishu-subtable-mappings__field">
              <Select
                aria-label="系统项目"
                placeholder="选择系统项目"
                value={row.campaign_id || undefined}
                showSearch
                optionFilterProp="label"
                onChange={(campaignId) => updateRow(index, { campaign_id: campaignId })}
                options={campaigns.map((campaign) => ({
                  value: Number(campaign.id), label: campaign.name,
                  disabled: Number(campaign.id) !== Number(row.campaign_id) && Boolean(selectedCounts[campaign.id])
                }))}
              />
            </Form.Item>
            <Form.Item validateStatus={!String(row.sheet_id || '').trim() ? 'error' : ''} help={!String(row.sheet_id || '').trim() ? '请输入工作表 ID' : null} className="feishu-subtable-mappings__field">
              <Input aria-label="工作表 ID" placeholder="例如：6nUDXq" value={row.sheet_id || ''} onChange={(event) => updateRow(index, { sheet_id: event.target.value })} />
            </Form.Item>
            <Button aria-label="删除项目映射" icon={<DeleteOutlined />} danger type="text" onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))} />
          </div>
        );
      })}
      <Button icon={<PlusOutlined />} disabled={rows.length >= campaigns.length} onClick={() => onChange([...rows, { campaign_id: null, sheet_id: '' }])}>添加项目映射</Button>
      <Text type="secondary" className="feishu-subtable-mappings__note">未配置映射的项目同步时会明确报错，不会写入其他项目的工作表。</Text>
    </div>
  );
};

export default FeishuSheetMappings;
