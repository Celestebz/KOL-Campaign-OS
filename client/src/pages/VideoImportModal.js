import React, { useState } from 'react';
import { Alert, Button, Form, Modal, Select, Space, Table, Tag, Upload, message } from 'antd';
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import axios from 'axios';

const currencies = ['USD', 'CNY', 'EUR', 'GBP', 'JPY', 'HKD', 'CAD', 'AUD', 'SGD'];
const statusLabels = { new: '新增', update: '更新', skip: '跳过', invalid: '错误', imported: '已新增', updated: '已更新', skipped: '已跳过', failed: '失败' };
const statusColors = { new: 'green', update: 'blue', invalid: 'red', imported: 'green', updated: 'blue', failed: 'red' };

function downloadErrors(rows) {
  const cell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const data = [['视频链接', '合作报价', '达人名称', '备注', '原始行号', '错误原因'], ...rows.map(row => [row.source_url, row.quote, row.kol_name, row.notes, row.row_number, row.reason])];
  const url = URL.createObjectURL(new Blob(['\uFEFF', data.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'video-import-errors.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function VideoImportModal({ campaigns, onClose, onImported, onView, onCrawl }) {
  const [file, setFile] = useState(null);
  const [options, setOptions] = useState({ default_currency: 'USD', duplicate_mode: 'skip' });
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const changeOption = (key, value) => { setOptions(current => ({ ...current, [key]: value })); setPreview(null); };
  const requestError = error => message.error(error.response?.data?.error || '请求失败，请重试');
  const previewFile = async () => {
    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', file);
      Object.entries(options).forEach(([key, value]) => { if (value !== undefined) body.append(key, value); });
      const response = await axios.post('/api/videos/import/preview', body);
      setPreview(response.data.data);
    } catch (error) { requestError(error); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true);
    try {
      const response = await axios.post('/api/videos/import/confirm', { ...options, rows: preview.rows.map(({ row_number, source_url, quote, kol_name, notes }) => ({ row_number, source_url, quote, kol_name, notes })) });
      setResult(response.data.data);
      onImported(response.data.data.ids);
    } catch (error) { requestError(error); }
    finally { setBusy(false); }
  };
  const rows = result?.rows || preview?.rows || [];
  const errors = rows.filter(row => ['invalid', 'failed'].includes(row.status));
  const count = preview ? preview.summary.new + preview.summary.update : 0;
  const columns = [
    { title: '行号', dataIndex: 'row_number', width: 65 },
    { title: '视频链接', dataIndex: 'source_url', width: 260, render: value => <span style={{ overflowWrap: 'anywhere' }}>{value}</span> },
    { title: '合作报价', width: 140, render: (_, row) => row.price?.display || row.quote || '—' },
    { title: '达人名称', dataIndex: 'kol_name', width: 110 },
    { title: '备注', dataIndex: 'notes', width: 150, ellipsis: true },
    { title: '结果', width: 230, render: (_, row) => <><Tag color={statusColors[row.status]}>{statusLabels[row.status]}</Tag><span>{row.reason}</span></> }
  ];
  return <Modal open title="表格导入" width={1000} onCancel={onClose} closable={!busy} maskClosable={!busy} keyboard={!busy} footer={result ? (
    <Space>
      <Button onClick={onClose}>关闭</Button>
      <Button disabled={!result.ids.length} onClick={() => onView(result.ids)}>查看本次导入</Button>
      <Button type="primary" disabled={!result.ids.length} onClick={() => onCrawl(result.ids)}>抓取本次导入</Button>
    </Space>
  ) : <Space>
    <Button onClick={onClose} disabled={busy}>取消</Button>
    <Button onClick={previewFile} disabled={!file || busy} loading={busy && !preview}>预览校验</Button>
    <Button type="primary" disabled={!preview || !count || busy} loading={busy && Boolean(preview)} onClick={confirm}>确认导入{preview ? ` ${count} 条` : ''}</Button>
  </Space>}>
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {!result && <>
        <Alert type="info" showIcon message="仅视频链接必填，标题和平台由抓取补充，无需绑定达人。" description="支持 Excel（.xlsx）/ CSV，最多 500 行、5 MB，仅读取第一个工作表。合作报价可填 USD 500、3000元；纯数字使用默认币种。" />
        <Space wrap>
          <Button icon={<DownloadOutlined />} href="/api/videos/import/template">下载模板</Button>
          <Upload accept=".xlsx,.csv" maxCount={1} fileList={file ? [file] : []} disabled={busy} beforeUpload={next => {
            if (!/\.(xlsx|csv)$/i.test(next.name) || next.size > 5 * 1024 * 1024) { message.error('请上传不超过 5 MB 的 .xlsx 或 .csv 文件'); return Upload.LIST_IGNORE; }
            setFile(next); setPreview(null); return false;
          }} onRemove={() => { setFile(null); setPreview(null); }}><Button icon={<UploadOutlined />}>选择文件</Button></Upload>
        </Space>
        <Form layout="vertical" disabled={busy}>
          <Space align="start" wrap>
            <Form.Item label="所属项目（可选）"><Select aria-label="所属项目" allowClear showSearch optionFilterProp="label" style={{ width: 260 }} placeholder="未关联项目" options={campaigns} value={options.campaign_id} onChange={value => changeOption('campaign_id', value)} /></Form.Item>
            <Form.Item label="默认币种（仅用于纯数字报价）"><Select aria-label="默认币种" style={{ width: 220 }} options={currencies.map(value => ({ value, label: value }))} value={options.default_currency} onChange={value => changeOption('default_currency', value)} /></Form.Item>
            <Form.Item label="已存在的链接"><Select aria-label="重复处理方式" style={{ width: 220 }} options={[{ value: 'skip', label: '跳过（保留已有记录）' }, { value: 'update', label: '更新非空信息' }]} value={options.duplicate_mode} onChange={value => changeOption('duplicate_mode', value)} /></Form.Item>
          </Space>
          {options.duplicate_mode === 'update' && <Alert type="warning" message="更新仅覆盖非空报价、达人名称和备注，并关联所选项目；保留原有标题、抓取数据和分析结果。" />}
        </Form>
      </>}
      {preview && !result && <Alert type={errors.length ? 'warning' : 'success'} message={`新增 ${preview.summary.new} 条，更新 ${preview.summary.update} 条，跳过 ${preview.summary.skip} 条，错误 ${preview.summary.invalid} 条`} description={errors.length ? '确认后仅导入有效行。可下载错误行，修正后重新导入。' : '请核对报价、币种和重复处理结果后确认导入。'} />}
      {result && <Alert type={result.failed ? 'warning' : 'success'} message={`导入完成：新增 ${result.imported} 条，更新 ${result.updated} 条，跳过 ${result.skipped} 条，失败 ${result.failed} 条`} description="链接已保存，尚未自动抓取或分析。" />}
      {errors.length > 0 && <Button icon={<DownloadOutlined />} onClick={() => downloadErrors(errors)}>下载错误行 ({errors.length})</Button>}
      {rows.length > 0 && <Table size="small" rowKey="row_number" dataSource={rows} columns={columns} pagination={{ pageSize: 10 }} scroll={{ x: 955 }} />}
    </Space>
  </Modal>;
}
