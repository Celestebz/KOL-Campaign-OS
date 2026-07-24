const express = require('express');
const { dbOperations } = require('../database');
const { getCampaignKolTableId, missingCampaignSubtableError } = require('../utils/feishuSubtableMapping');
const { mapFeishuRecordToKol, findMatchingCustomer } = require('../utils/feishuKolImport');
const { attachPlatformAccounts, attachKolInsights } = require('./customers');

const router = express.Router();

const FEISHU_PROVIDER_KEY = 'cloud.feishu_bitable';

const KOL_MASTER_FIELD_SCHEMA = [
  { field_name: 'KOL名称', type: 1 },
  { field_name: '邮箱', type: 1, ui_type: 'Email' },
  { field_name: '国家/地区', type: 1 },
  { field_name: '内容类目', type: 1 },
  { field_name: '主平台', type: 3, property: { options: [{ name: 'YouTube' }, { name: 'Instagram' }, { name: 'TikTok' }, { name: 'Facebook' }, { name: 'X' }] } },
  { field_name: '粉丝数', type: 2 },
  { field_name: '近30天平均曝光', type: 2 },
  { field_name: '近30天中位曝光', type: 2 },
  { field_name: '近30天作品数', type: 2 },
  { field_name: '互动率', type: 2 },
  { field_name: '合作状态', type: 3, property: { options: [{ name: '可合作' }, { name: '不建议合作' }] } },
  { field_name: '匹配SKU', type: 1 },
  { field_name: 'SKU匹配分', type: 2 },
  { field_name: 'SKU匹配理由', type: 1 },
  { field_name: '识别状态', type: 3, property: { options: [{ name: '新 KOL' }, { name: '已有 KOL · 新产品匹配' }, { name: '已有匹配 · 证据已更新' }, { name: '待识别' }] } },
  { field_name: '进行中项目数', type: 2 },
  { field_name: '进行中项目及进度', type: 1 },
  { field_name: '最近项目更新时间', type: 5 },
  { field_name: '历史合作次数', type: 2 },
  { field_name: '历史合作SKU', type: 1 },
  { field_name: '最近合作项目', type: 1 },
  { field_name: '最近合作评价', type: 1 },
  { field_name: '是否建议复投', type: 3, property: { options: [{ name: '是' }, { name: '否' }, { name: '待判断' }] } },
  { field_name: '开发人', type: 1 },
  { field_name: '风险原因', type: 1 },
  { field_name: '覆盖平台', type: 4, property: { options: [{ name: 'YouTube' }, { name: 'Instagram' }, { name: 'TikTok' }, { name: 'Facebook' }, { name: 'X' }] } },
  { field_name: '平台账号名', type: 1 },
  { field_name: '平台主页链接', type: 15 },
  { field_name: '最后更新时间', type: 5 }
  ,{ field_name: 'YouTube数据更新时间', type: 5 }
  ,{ field_name: 'YouTube抓取状态', type: 3, property: { options: [{ name: '待抓取' }, { name: '抓取中' }, { name: '成功' }, { name: '部分成功' }, { name: '失败' }] } }
  ,{ field_name: '抓取失败原因', type: 1 }
  ,{ field_name: '数据口径', type: 1 }
  ,{ field_name: '达人等级', type: 3, property: { options: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: '待评估' }] } }
];

const OBSOLETE_KOL_MASTER_FIELDS = [
  '项目状态',
  'Instagram主页', 'Instagram粉丝量',
  'YouTube主页', 'YouTube粉丝量',
  'TikTok主页', 'TikTok粉丝量',
  'Email', '国家地区', 'Tier',
  '项目报价', '汇率', '价格RMB',
  '跟进人', '联系状态', '回复状态',
  '推荐原因', '推荐内容角度', '项目备注',
  '来源RawCandidate', '创建时间', '代表证据', 'SKU审核结果'
];

const KOL_FIELD_RENAMES = {
  平台: '主平台',
  主平台粉丝数: '粉丝数',
  主平台近30天平均曝光: '近30天平均曝光',
  主平台近30天中位曝光: '近30天中位曝光',
  主平台近30天作品数: '近30天作品数',
  主平台互动率: '互动率',
  合作平台: '覆盖平台',
  主平台账号名: '平台账号名',
  主主页链接: '平台主页链接',
  本次目标SKU: '匹配SKU',
  当前SKU匹配分: 'SKU匹配分',
  当前SKU匹配理由: 'SKU匹配理由'
};

const PROJECT_TRACKING_FIELD_SCHEMA = [
  { field_name: '达人名称', aliases: ['KOL名称'], type: 1, accepted_types: [1] },
  { field_name: '跟进人', aliases: ['负责人'], type: 1, accepted_types: [1] },
  { field_name: '邮箱', aliases: ['Email'], type: 1, accepted_types: [1] },
  {
    field_name: '优先级', aliases: ['合作优先级', '达人等级', 'Tier'], type: 3, accepted_types: [1, 3],
    property: { options: [{ name: 'T1' }, { name: 'T2' }, { name: 'T3' }, { name: 'T4' }] }
  },
  { field_name: '合作SKU', aliases: ['推荐产品/SKU'], type: 1, accepted_types: [1, 3, 4] },
  {
    field_name: '合作平台', aliases: ['平台'], type: 4, accepted_types: [4], convert_alias_type: true,
    property: { options: [{ name: 'YouTube' }, { name: 'Instagram' }, { name: 'TikTok' }, { name: 'Facebook' }, { name: 'X' }] }
  },
  { field_name: '主平台主页', aliases: [], type: 15, accepted_types: [15] },
  { field_name: '合作方式', aliases: [], type: 1, accepted_types: [1, 3] },
  { field_name: '收货地址', aliases: [], type: 1, accepted_types: [1] },
  { field_name: '交付内容', aliases: [], type: 1, accepted_types: [1] },
  { field_name: '预计上线时间', aliases: [], type: 5, accepted_types: [5] },
  { field_name: '内容形式', aliases: ['内容模板'], type: 1, accepted_types: [1, 3, 4] },
  { field_name: 'KOL合作费', aliases: ['KOL合作费USD', '达人现金报价USD', '项目报价'], type: 2, accepted_types: [2], property: { formatter: '0.00', currency_code: 'USD' } },
  { field_name: '总预计成本', aliases: ['总预计成本USD'], type: 2, accepted_types: [2], property: { formatter: '0.00', currency_code: 'USD' } },
  { field_name: '粉丝数', aliases: [], type: 2, accepted_types: [2] },
  { field_name: '近30天中位曝光', aliases: [], type: 2, accepted_types: [2] },
  { field_name: '近30天作品数', aliases: [], type: 2, accepted_types: [2] },
  { field_name: '近30天平均曝光', aliases: [], type: 2, accepted_types: [2] },
  { field_name: '互动率', aliases: [], type: 2, accepted_types: [2], property: { formatter: '0.00%' } },
  { field_name: '数据更新时间', aliases: [], type: 5, accepted_types: [5] },
  { field_name: '预计合作曝光', aliases: [], type: 2, accepted_types: [2] },
  { field_name: '预估CPM', aliases: [], type: 2, accepted_types: [2] },
  { field_name: '预算审批状态', aliases: [], type: 3, accepted_types: [3], property: { options: [{ name: '待审批' }, { name: '已通过' }, { name: '未通过' }] } },
  {
    field_name: '项目状态', aliases: [], type: 3, accepted_types: [3],
    replace_options: true,
    property: { options: [
      { name: '待确认' }, { name: '待发货' }, { name: '已发货' }, { name: '已签收' },
      { name: '内容准备中' }, { name: '待上线' }, { name: '已上线' }, { name: '已取消' }
    ] }
  },
  { field_name: '备注', aliases: ['合作备注', '项目备注'], type: 1, accepted_types: [1], merge_alias: true },
  { field_name: '发货日期', aliases: [], type: 5, accepted_types: [5] },
  { field_name: '物流单号', aliases: [], type: 1, accepted_types: [1] },
  { field_name: '达人系统编号', aliases: [], type: 1, accepted_types: [1] }
];

// Statuses at or after the shipping stage sync to the project tracking table
// (campaign_kol_table_id); earlier stages sync to the campaign's candidate pool
// subtable from campaign_subtable_map.
const EXECUTION_STATUSES = new Set([
  'pending_shipping', 'shipped', 'delivered', 'content_preparation',
  'pending_publish', 'published', 'cancelled'
]);

const CANDIDATE_POOL_STATUS_LABELS = {
  candidate: '候选',
  to_contact: '候选',
  contacted: '已联络',
  replied: '已回复',
  no_reply: '没回复',
  negotiating: '沟通中',
  pending_confirmation: '沟通中',
  confirmed: '已确定',
  not_fit: '不合适'
};

// Mirrors the candidate pool table curated by the user in Feishu. The system
// only adds missing fields/options here; it never recreates the logistics and
// lifecycle fields the user removed (项目状态/发货日期/物流单号/交付内容/预计上线时间/收货地址).
const CANDIDATE_POOL_FIELD_SCHEMA = [
  { field_name: '达人名称', type: 1 },
  { field_name: '国家地区', type: 1 },
  { field_name: '邮箱', type: 1, ui_type: 'Email' },
  { field_name: '主平台主页', type: 15 },
  { field_name: '状态', type: 3, property: { options: [{ name: '候选' }, { name: '已联络' }, { name: '已回复' }, { name: '没回复' }, { name: '沟通中' }, { name: '已确定' }, { name: '不合适' }] } },
  { field_name: '合作SKU', type: 1 },
  { field_name: '合作平台', type: 4, property: { options: [{ name: 'YouTube' }, { name: 'Instagram' }, { name: 'TikTok' }, { name: 'Facebook' }, { name: 'X' }] } },
  { field_name: '粉丝数', type: 2 },
  { field_name: '近30天作品数', type: 2 },
  { field_name: '近30天平均曝光', type: 2 },
  { field_name: '近30天中位曝光', type: 2 },
  { field_name: '互动率', type: 2 },
  { field_name: '优先级', type: 3, property: { options: [{ name: 'T1' }, { name: 'T2' }, { name: 'T3' }, { name: 'T4' }] } },
  { field_name: 'KOL合作费', type: 2, property: { formatter: '0.00', currency_code: 'USD' } },
  { field_name: '汇率', type: 2 },
  { field_name: '价格RMB', type: 2, property: { formatter: '0.00', currency_code: 'CNY' } },
  { field_name: '备注', type: 1 },
  { field_name: '预估CPM', type: 2 },
  { field_name: '总预计成本', type: 2 },
  { field_name: '预算审批状态', type: 3, property: { options: [{ name: '待审批' }, { name: '已通过' }, { name: '未通过' }] } },
  { field_name: '合作方式', type: 1 },
  { field_name: '达人系统编号', type: 1 },
  { field_name: '创建时间', type: 5 },
  { field_name: '数据更新时间', type: 5 },
  { field_name: '内容形式', type: 1 },
  { field_name: '预计合作曝光', type: 2 },
  { field_name: '跟进人', type: 1 }
];

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function compact(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

// Feishu field type 15 (hyperlink) requires a { link, text } object.
function setHyperlinkField(fields, name, value) {
  const url = compact(value).trim();
  if (!url) return;
  fields[name] = { link: url, text: url };
}

// Feishu field type 2 (number) requires a numeric value; non-numeric or empty
// values must be omitted rather than sent as '' (which fails the whole record).
function setNumberField(fields, name, value) {
  const text = compact(value).trim().replace(/,/g, '');
  if (!text) return;
  const number = Number(text);
  if (!Number.isFinite(number)) return;
  fields[name] = number;
}

function parseCampaignSubtableMap(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  const text = String(value).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return text.split(/\r?\n|,/).reduce((acc, line) => {
      const [name, tableId] = line.split('=').map((part) => part && part.trim());
      if (name && tableId) acc[name] = tableId;
      return acc;
    }, {});
  }
}

async function fetchJson(url, options = {}) {
  if (typeof fetch !== 'function') throw new Error('Node.js 18+ is required for Feishu sync');
  const response = await fetch(url, options);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || (data.code !== undefined && data.code !== 0)) {
    const error = new Error(data.msg || data.message || `HTTP ${response.status}`);
    error.code = data.code;
    throw error;
  }
  return data;
}

async function getFeishuConfig() {
  const row = await dbOperations.get('SELECT * FROM api_settings WHERE provider = ?', [FEISHU_PROVIDER_KEY]);
  const extra = parseJson(row?.extra_config, {});
  return {
    base_url: (row?.base_url || extra.base_url || 'https://open.feishu.cn').replace(/\/$/, ''),
    app_id: extra.app_id || '',
    app_secret: row?.api_key || extra.app_secret || '',
    app_token: extra.app_token || '',
    kol_table_id: extra.kol_table_id || '',
    campaign_kol_table_id: extra.campaign_kol_table_id || '',
    campaign_table_id: extra.campaign_table_id || '',
    campaign_subtable_map: parseCampaignSubtableMap(extra.campaign_subtable_map)
  };
}

function requireFeishuConfig(config) {
  const missing = [];
  if (!config.app_id) missing.push('App ID');
  if (!config.app_secret) missing.push('App Secret');
  if (!config.app_token) missing.push('Base/App Token');
  if (!config.kol_table_id) missing.push('KOL Master Table ID');
  if (missing.length) throw new Error(`Feishu Bitable is not configured: ${missing.join(', ')}`);
}

async function getTenantAccessToken(config) {
  const data = await fetchJson(`${config.base_url}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: config.app_id, app_secret: config.app_secret })
  });
  return data.tenant_access_token;
}

async function listBitableFields(config, token, tableId) {
  const fields = [];
  let pageToken = '';
  do {
    const suffix = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '';
    const url = `${config.base_url}/open-apis/bitable/v1/apps/${encodeURIComponent(config.app_token)}/tables/${encodeURIComponent(tableId)}/fields?page_size=100${suffix}`;
    const data = await fetchJson(url, { headers: { Authorization: `Bearer ${token}` } });
    fields.push(...(data.data?.items || []));
    pageToken = data.data?.has_more ? data.data?.page_token : '';
  } while (pageToken);
  return fields;
}

async function createBitableField(config, token, tableId, definition) {
  const url = `${config.base_url}/open-apis/bitable/v1/apps/${encodeURIComponent(config.app_token)}/tables/${encodeURIComponent(tableId)}/fields`;
  const data = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(definition)
  });
  return data.data?.field;
}

async function deleteBitableField(config, token, tableId, fieldId) {
  const url = `${config.base_url}/open-apis/bitable/v1/apps/${encodeURIComponent(config.app_token)}/tables/${encodeURIComponent(tableId)}/fields/${encodeURIComponent(fieldId)}`;
  await fetchJson(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
}

async function renameBitableField(config, token, tableId, field, fieldName) {
  const url = `${config.base_url}/open-apis/bitable/v1/apps/${encodeURIComponent(config.app_token)}/tables/${encodeURIComponent(tableId)}/fields/${encodeURIComponent(field.field_id)}`;
  const body = { field_name: fieldName, type: Number(field.type) };
  if (field.property && Object.keys(field.property).length) body.property = field.property;
  await fetchJson(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
}

async function renameKolMasterFields(config, token, fieldRenames = KOL_FIELD_RENAMES) {
  let current = await listBitableFields(config, token, config.kol_table_id);
  const byName = new Map(current.map((field) => [String(field.field_name || '').trim(), field]));
  const summary = { renamed: [], merged: [], deleted_duplicates: [], already_named: [], missing: [], failed: [] };
  for (const [oldName, newName] of Object.entries(fieldRenames)) {
    if (byName.has(newName)) {
      const oldField = byName.get(oldName);
      if (!oldField) {
        summary.already_named.push(newName);
        continue;
      }
      try {
        const records = await listBitableRecords(config, token, config.kol_table_id);
        const updates = [];
        for (const record of records) {
          const oldValue = record.fields?.[oldName];
          const newValue = record.fields?.[newName];
          if (!fieldHasValue(oldValue) || fieldHasValue(newValue)) continue;
          updates.push({ record_id: record.record_id, fields: { [newName]: oldValue } });
        }
        await batchUpdateBitableRecords(config, token, config.kol_table_id, updates);
        await deleteBitableField(config, token, config.kol_table_id, oldField.field_id);
        summary.merged.push({ from: oldName, to: newName, copied: updates.length });
        summary.deleted_duplicates.push(oldName);
      } catch (error) {
        summary.failed.push({ from: oldName, to: newName, error: error.message });
      }
      continue;
    }
    const field = byName.get(oldName);
    if (!field) {
      summary.missing.push(oldName);
      continue;
    }
    try {
      await renameBitableField(config, token, config.kol_table_id, field, newName);
      summary.renamed.push({ from: oldName, to: newName });
      await new Promise((resolve) => setTimeout(resolve, 150));
    } catch (error) {
      summary.failed.push({ from: oldName, to: newName, error: error.message });
    }
  }
  current = await listBitableFields(config, token, config.kol_table_id);
  const remaining = current;
  summary.remaining_old_names = remaining.map((field) => field.field_name).filter((name) => fieldRenames[name]);
  return summary;
}

async function deleteObsoleteKolMasterFields(config, token) {
  const current = await listBitableFields(config, token, config.kol_table_id);
  const byName = new Map(current.map((field) => [String(field.field_name || '').trim(), field]));
  const summary = { deleted: [], missing: [], failed: [] };
  for (const fieldName of OBSOLETE_KOL_MASTER_FIELDS) {
    const field = byName.get(fieldName);
    if (!field) {
      summary.missing.push(fieldName);
      continue;
    }
    try {
      await deleteBitableField(config, token, config.kol_table_id, field.field_id);
      summary.deleted.push(fieldName);
      await new Promise((resolve) => setTimeout(resolve, 150));
    } catch (error) {
      summary.failed.push({ field_name: fieldName, error: error.message });
    }
  }
  const remaining = await listBitableFields(config, token, config.kol_table_id);
  summary.remaining_fields = remaining.map((field) => field.field_name);
  summary.obsolete_remaining = summary.remaining_fields.filter((name) => OBSOLETE_KOL_MASTER_FIELDS.includes(name));
  return summary;
}

async function updateBitableField(config, token, tableId, field, definition) {
  const url = `${config.base_url}/open-apis/bitable/v1/apps/${encodeURIComponent(config.app_token)}/tables/${encodeURIComponent(tableId)}/fields/${encodeURIComponent(field.field_id)}`;
  const desiredOptions = definition.property?.options || [];
  const currentOptions = field.property?.options || [];
  const optionNames = new Set(currentOptions.map((option) => option.name));
  const property = Number(field.type) === 3
    ? { ...(field.property || {}), options: definition.replace_options
      ? desiredOptions
      : [...currentOptions, ...desiredOptions.filter((option) => !optionNames.has(option.name))] }
    : { ...(field.property || {}), ...(definition.property || {}) };
  const body = { field_name: definition.field_name, type: Number(field.type) };
  if (property) body.property = property;
  if (field.ui_type) body.ui_type = field.ui_type;
  const data = await fetchJson(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  return data.data?.field;
}

async function deleteBitableField(config, token, tableId, fieldId) {
  const url = `${config.base_url}/open-apis/bitable/v1/apps/${encodeURIComponent(config.app_token)}/tables/${encodeURIComponent(tableId)}/fields/${encodeURIComponent(fieldId)}`;
  await fetchJson(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
}

async function ensureKolMasterFields(config, token) {
  const current = await listBitableFields(config, token, config.kol_table_id);
  const byName = new Map(current.map((field) => [String(field.field_name || '').trim(), field]));
  const summary = { created: [], existing: [], conflicts: [] };

  for (const definition of KOL_MASTER_FIELD_SCHEMA) {
    const existing = byName.get(definition.field_name);
    if (existing) {
      if (Number(existing.type) === Number(definition.type)) {
        summary.existing.push(definition.field_name);
      } else {
        summary.conflicts.push({
          field_name: definition.field_name,
          expected_type: definition.type,
          actual_type: existing.type
        });
      }
    }
  }

  if (summary.conflicts.length) {
    const names = summary.conflicts.map((item) => item.field_name).join('、');
    const error = new Error(`飞书字段类型冲突：${names}。系统未自动修改已有字段。`);
    error.field_summary = summary;
    throw error;
  }

  for (const definition of KOL_MASTER_FIELD_SCHEMA) {
    if (byName.has(definition.field_name)) continue;
    const created = await createBitableField(config, token, config.kol_table_id, definition);
    summary.created.push(created?.field_name || definition.field_name);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return summary;
}

async function ensureProjectTrackingFields(config, token, tableId, { backfillPlatforms = false } = {}) {
  if (!tableId) throw new Error('飞书项目跟进表 ID 未配置');
  let current = await listBitableFields(config, token, tableId);
  const summary = { created: [], renamed: [], converted: [], existing: [], removed_empty_duplicates: [], conflicts: [] };
  let byName = new Map(current.map((field) => [String(field.field_name || '').trim(), field]));
  let records = null;

  for (const definition of PROJECT_TRACKING_FIELD_SCHEMA) {
    const canonical = byName.get(definition.field_name);
    const alias = definition.aliases.map((name) => byName.get(name)).find(Boolean);
    if (canonical || !alias || !definition.convert_alias_type || Number(alias.type) === Number(definition.type)) continue;
    if (!records) records = await listBitableRecords(config, token, tableId);
    const { aliases, accepted_types, convert_alias_type, ...createDefinition } = definition;
    await createBitableField(config, token, tableId, createDefinition);
    for (const record of records) {
      const rawValue = record.fields?.[alias.field_name];
      const values = Array.isArray(rawValue)
        ? rawValue.map((value) => compact(value).trim()).filter(Boolean)
        : compact(rawValue).split(/[,，、/]/).map((value) => value.trim()).filter(Boolean);
      const normalizedValues = definition.field_name === '合作平台' ? values.map(normalizePlatform).filter(Boolean) : values;
      if (normalizedValues.length) await pushBitableRecord(config, token, tableId, record.record_id, { [definition.field_name]: normalizedValues });
    }
    await deleteBitableField(config, token, tableId, alias.field_id);
    summary.converted.push({ from: alias.field_name, to: definition.field_name, records: records.length });
    current = await listBitableFields(config, token, tableId);
    byName = new Map(current.map((field) => [String(field.field_name || '').trim(), field]));
    records = await listBitableRecords(config, token, tableId);
  }

  for (const definition of PROJECT_TRACKING_FIELD_SCHEMA) {
    const canonical = byName.get(definition.field_name);
    const alias = definition.aliases.map((name) => byName.get(name)).find(Boolean);
    if (!canonical || !alias) continue;
    if (!records) records = await listBitableRecords(config, token, tableId);
    if (definition.merge_alias) {
      for (const record of records) {
        const canonicalValue = String(record.fields?.[definition.field_name] || '').trim();
        const aliasValue = String(record.fields?.[alias.field_name] || '').trim();
        if (!aliasValue || canonicalValue === aliasValue) continue;
        const mergedValue = canonicalValue ? `${canonicalValue}\n${aliasValue}` : aliasValue;
        await pushBitableRecord(config, token, tableId, record.record_id, { [definition.field_name]: mergedValue });
      }
      await deleteBitableField(config, token, tableId, alias.field_id);
      summary.removed_empty_duplicates.push(alias.field_name);
      current = current.filter((field) => field.field_id !== alias.field_id);
      byName = new Map(current.map((field) => [String(field.field_name || '').trim(), field]));
      records = await listBitableRecords(config, token, tableId);
      await new Promise((resolve) => setTimeout(resolve, 120));
      continue;
    }
    const populatedCount = records.filter((record) => {
      const value = record.fields?.[definition.field_name];
      return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
    }).length;
    if (populatedCount > 0) {
      summary.conflicts.push({
        field_name: definition.field_name,
        alias_name: alias.field_name,
        reason: 'duplicate_fields_both_in_use'
      });
      continue;
    }
    await deleteBitableField(config, token, tableId, canonical.field_id);
    summary.removed_empty_duplicates.push(definition.field_name);
    current = current.filter((field) => field.field_id !== canonical.field_id);
    byName = new Map(current.map((field) => [String(field.field_name || '').trim(), field]));
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  if (summary.conflicts.length) {
    const names = summary.conflicts.map((item) => item.field_name).join('、');
    const error = new Error(`飞书项目存在重复且都有数据的字段：${names}。系统未自动合并。`);
    error.field_summary = summary;
    throw error;
  }
  const actions = PROJECT_TRACKING_FIELD_SCHEMA.map((definition) => {
    const canonical = byName.get(definition.field_name);
    const alias = definition.aliases.map((name) => byName.get(name)).find(Boolean);
    const field = canonical || alias || null;
    const currentOptions = new Set((field?.property?.options || []).map((option) => option.name));
    const desiredOptions = definition.property?.options || [];
    const needsOptionUpdate = definition.replace_options
      ? currentOptions.size !== desiredOptions.length || desiredOptions.some((option) => !currentOptions.has(option.name))
      : desiredOptions.some((option) => !currentOptions.has(option.name));
    const desiredProperty = definition.property || {};
    const needsPropertyUpdate = Number(field?.type) !== 3 && Object.entries(desiredProperty)
      .filter(([key]) => key !== 'currency_code')
      .some(([key, value]) => JSON.stringify(field?.property?.[key]) !== JSON.stringify(value));
    return { definition, field, rename: !canonical && Boolean(alias), needsOptionUpdate, needsPropertyUpdate };
  });

  for (const action of actions) {
    if (!action.field) continue;
    const accepted = action.definition.accepted_types || [action.definition.type];
    if (!accepted.includes(Number(action.field.type))) {
      summary.conflicts.push({
        field_name: action.field.field_name,
        target_name: action.definition.field_name,
        expected_types: accepted,
        actual_type: action.field.type
      });
    } else if (!action.rename) {
      summary.existing.push(action.definition.field_name);
    }
  }
  if (summary.conflicts.length) {
    const names = summary.conflicts.map((item) => item.field_name).join('、');
    const error = new Error(`飞书项目字段类型冲突：${names}。系统未修改已有字段。`);
    error.field_summary = summary;
    throw error;
  }

  const statusMap = {
    未联系: '待确认', 已联系: '待确认', 已回复: '待确认', 未回复: '待确认',
    confirmed: '待发货', rejected: '已取消', archived: '已取消'
  };
  const validStatuses = new Set(['待确认', '待发货', '已发货', '已签收', '内容准备中', '待上线', '已上线', '已取消']);
  const shouldNormalizeStatuses = actions.some((action) => action.definition.field_name === '项目状态' && action.needsOptionUpdate);
  let normalizedStatuses = [];
  if (shouldNormalizeStatuses) {
    const statusRecords = await listBitableRecords(config, token, tableId);
    normalizedStatuses = statusRecords.map((record) => {
      const oldStatus = record.fields?.项目状态;
      return {
        record_id: record.record_id,
        status: validStatuses.has(oldStatus) ? oldStatus : (statusMap[oldStatus] || '待确认')
      };
    });
  }

  for (const action of actions) {
    let mutated = false;
    if (!action.field) {
      const { aliases, accepted_types, replace_options, merge_alias, convert_alias_type, ...definition } = action.definition;
      const created = await createBitableField(config, token, tableId, definition);
      summary.created.push(created?.field_name || definition.field_name);
      mutated = true;
    } else if (action.rename || action.needsOptionUpdate || action.needsPropertyUpdate) {
      const updated = await updateBitableField(config, token, tableId, action.field, action.definition);
      if (action.rename) summary.renamed.push({ from: action.field.field_name, to: updated?.field_name || action.definition.field_name });
      mutated = true;
    }
    if (mutated) await new Promise((resolve) => setTimeout(resolve, 120));
  }

  summary.normalized_status_records = 0;
  // Replacing single-select options changes their internal option IDs in Feishu.
  // Restore the captured values only after the schema update.
  for (const record of normalizedStatuses) {
    await pushBitableRecord(config, token, tableId, record.record_id, { 项目状态: record.status });
    summary.normalized_status_records += 1;
  }

  summary.backfilled_cooperation_platforms = 0;
  if (backfillPlatforms) {
    const latestRecords = await listBitableRecords(config, token, tableId);
    const missingPlatformRecordIds = new Set(latestRecords
      .filter((record) => !Array.isArray(record.fields?.合作平台) || record.fields.合作平台.length === 0)
      .map((record) => record.record_id));
    const localRows = await dbOperations.query(`
      SELECT ck.feishu_record_id, COALESCE(kpa.platform, ck.target_platform) platform
      FROM campaign_kols ck
      LEFT JOIN kol_platform_accounts kpa ON kpa.id = ck.platform_account_id
      WHERE ck.feishu_record_id IS NOT NULL AND ck.feishu_record_id <> ''
    `);
    for (const row of localRows) {
      if (!missingPlatformRecordIds.has(row.feishu_record_id)) continue;
      const platform = normalizePlatform(row.platform);
      if (!platform) continue;
      await pushBitableRecord(config, token, tableId, row.feishu_record_id, { 合作平台: [platform] });
      summary.backfilled_cooperation_platforms += 1;
    }
  }
  return summary;
}

// Candidate pool tables are curated by the user in Feishu: only create missing
// fields and merge missing select options, never delete, rename, or replace.
async function ensureCandidatePoolFields(config, token, tableId) {
  if (!tableId) throw new Error('飞书候选池表 ID 未配置');
  const current = await listBitableFields(config, token, tableId);
  const byName = new Map(current.map((field) => [String(field.field_name || '').trim(), field]));
  const summary = { created: [], options_added: [], existing: [], conflicts: [] };
  for (const definition of CANDIDATE_POOL_FIELD_SCHEMA) {
    const existing = byName.get(definition.field_name);
    if (!existing) {
      await createBitableField(config, token, tableId, definition);
      summary.created.push(definition.field_name);
      await new Promise((resolve) => setTimeout(resolve, 120));
      continue;
    }
    if (Number(existing.type) !== Number(definition.type)) {
      summary.conflicts.push({ field_name: definition.field_name, expected_type: definition.type, actual_type: existing.type });
      continue;
    }
    summary.existing.push(definition.field_name);
    const desiredOptions = definition.property?.options || [];
    if (desiredOptions.length && [3, 4].includes(Number(existing.type))) {
      const currentOptions = existing.property?.options || [];
      const names = new Set(currentOptions.map((option) => option.name));
      const missing = desiredOptions.filter((option) => !names.has(option.name));
      if (missing.length) {
        const url = `${config.base_url}/open-apis/bitable/v1/apps/${encodeURIComponent(config.app_token)}/tables/${encodeURIComponent(tableId)}/fields/${encodeURIComponent(existing.field_id)}`;
        await fetchJson(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            field_name: existing.field_name,
            type: Number(existing.type),
            property: { ...(existing.property || {}), options: [...currentOptions, ...missing] }
          })
        });
        summary.options_added.push({ field_name: definition.field_name, options: missing.map((option) => option.name) });
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
  }
  if (summary.conflicts.length) {
    const names = summary.conflicts.map((item) => item.field_name).join('、');
    const error = new Error(`飞书候选池字段类型冲突：${names}。系统未修改已有字段。`);
    error.field_summary = summary;
    throw error;
  }
  return summary;
}

async function pushBitableRecord(config, token, tableId, recordId, fields) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  };
  const base = `${config.base_url}/open-apis/bitable/v1/apps/${encodeURIComponent(config.app_token)}/tables/${encodeURIComponent(tableId)}/records`;
  const createRecord = async () => {
    const data = await fetchJson(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ fields })
    });
    return data.data?.record?.record_id;
  };
  if (recordId) {
    try {
      const data = await fetchJson(`${base}/${encodeURIComponent(recordId)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ fields })
      });
      return data.data?.record?.record_id || recordId;
    } catch (error) {
      if (error.code !== 1254043 && !String(error.message).includes('RecordIdNotFound')) throw error;
      return createRecord();
    }
  }
  return createRecord();
}

function legacyKolFields(row) {
  return {
    'KOL名称': compact(row.name),
    '平台': compact(row.platform),
    creator_id: compact(row.creator_id),
    '联系人': compact(row.contact_name),
    'YouTube主页': compact(row.youtube_url),
    'YouTube粉丝量': compact(row.youtube_followers),
    'Instagram主页': compact(row.instagram_url),
    'Instagram粉丝量': compact(row.instagram_followers),
    Email: compact(row.email),
    '国家地区': compact(row.country_region),
    '内容类型': compact(row.creator_type || 'KOL'),
    '标签': 'KOL Campaign OS',
    '备注': compact(row.notes),
    '最后更新时间': compact(row.updated_at || row.last_verified_at)
  };
}

async function batchUpdateBitableRecords(config, token, tableId, records) {
  if (!records.length) return;
  const url = `${config.base_url}/open-apis/bitable/v1/apps/${encodeURIComponent(config.app_token)}/tables/${encodeURIComponent(tableId)}/records/batch_update`;
  for (let index = 0; index < records.length; index += 500) {
    await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ records: records.slice(index, index + 500) })
    });
  }
}

async function batchCreateBitableRecords(config, token, tableId, records) {
  const url = `${config.base_url}/open-apis/bitable/v1/apps/${encodeURIComponent(config.app_token)}/tables/${encodeURIComponent(tableId)}/records/batch_create`;
  const data = await fetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ records })
  });
  return data.data?.records || [];
}

async function syncKolsBatch(config, token, ids) {
  if (!ids.length) return [];
  const rows = await attachKolInsights(await attachPlatformAccounts(await dbOperations.query(
    `SELECT * FROM customers WHERE id IN (${ids.map(() => '?').join(',')})
     AND (feishu_record_id IS NULL OR sync_status <> 'synced') ORDER BY id`,
    ids
  )));
  const results = [];
  for (let offset = 0; offset < rows.length; offset += 100) {
    const chunk = rows.slice(offset, offset + 100);
    try {
      const created = await batchCreateBitableRecords(
        config, token, config.kol_table_id,
        chunk.map((row) => ({ fields: kolFields(row) }))
      );
      for (let index = 0; index < chunk.length; index += 1) {
        const row = chunk[index];
        const recordId = created[index]?.record_id;
        if (!recordId) {
          results.push({ type: 'kol', id: row.id, success: false, error: 'Feishu batch response missing record id' });
          continue;
        }
        await dbOperations.run(
          `UPDATE customers SET feishu_record_id = ?, sync_status = 'synced', last_synced_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [recordId, row.id]
        );
        results.push({ type: 'kol', id: row.id, success: true, record_id: recordId });
      }
    } catch (error) {
      for (const row of chunk) {
        await dbOperations.run("UPDATE customers SET sync_status = 'sync_failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
        results.push({ type: 'kol', id: row.id, success: false, error: error.message });
      }
    }
  }
  return results;
}

async function syncKolsBulk(config, token, ids) {
  if (!ids.length) return [];
  const rows = await attachKolInsights(await attachPlatformAccounts(await dbOperations.query(
    `SELECT * FROM customers WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    ids
  )));
  const existing = rows.filter((row) => row.feishu_record_id);
  const missing = rows.filter((row) => !row.feishu_record_id);
  const results = [];

  for (let offset = 0; offset < existing.length; offset += 500) {
    const chunk = existing.slice(offset, offset + 500);
    try {
      await batchUpdateBitableRecords(
        config,
        token,
        config.kol_table_id,
        chunk.map((row) => ({ record_id: row.feishu_record_id, fields: kolFields(row) }))
      );
      for (const row of chunk) {
        await dbOperations.run(
          `UPDATE customers SET sync_status = 'synced', last_synced_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [row.id]
        );
        results.push({ type: 'kol', id: row.id, success: true, record_id: row.feishu_record_id });
      }
    } catch (error) {
      for (const row of chunk) {
        await dbOperations.run("UPDATE customers SET sync_status = 'sync_failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
        results.push({ type: 'kol', id: row.id, success: false, error: error.message });
      }
    }
  }

  for (let offset = 0; offset < missing.length; offset += 100) {
    const chunk = missing.slice(offset, offset + 100);
    try {
      const created = await batchCreateBitableRecords(
        config,
        token,
        config.kol_table_id,
        chunk.map((row) => ({ fields: kolFields(row) }))
      );
      for (let index = 0; index < chunk.length; index += 1) {
        const row = chunk[index];
        const recordId = created[index]?.record_id;
        if (!recordId) throw new Error('Feishu batch response missing record id');
        await dbOperations.run(
          `UPDATE customers SET feishu_record_id = ?, sync_status = 'synced',
           last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [recordId, row.id]
        );
        results.push({ type: 'kol', id: row.id, success: true, record_id: recordId });
      }
    } catch (error) {
      for (const row of chunk) {
        await dbOperations.run("UPDATE customers SET sync_status = 'sync_failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
        results.push({ type: 'kol', id: row.id, success: false, error: error.message });
      }
    }
  }
  return results;
}

function setDateTimeField(fields, name, value) {
  if (!value) return;
  const timestamp = new Date(value).getTime();
  if (Number.isFinite(timestamp)) fields[name] = timestamp;
}

function setTextField(fields, name, value) {
  const text = compact(value).trim();
  if (text) fields[name] = text;
}

function kolFields(row) {
  const accounts = Array.isArray(row.platform_accounts) ? row.platform_accounts : [];
  const account = accounts.find((item) => String(item.platform || '').toLowerCase() === String(row.primary_platform || '').toLowerCase())
    || accounts[0]
    || (row.youtube_url && { platform: 'YouTube', profile_url: row.youtube_url, followers_text: row.youtube_followers })
    || (row.instagram_url && { platform: 'Instagram', profile_url: row.instagram_url, followers_text: row.instagram_followers })
    || (row.tiktok_url && { platform: 'TikTok', profile_url: row.tiktok_url, followers_text: row.tiktok_followers })
    || { platform: row.platform || '', profile_url: '', followers_text: '' };
  const fields = {
    'KOL名称': compact(row.name),
    '邮箱': compact(row.email),
    '国家/地区': compact(row.country_region),
    '内容类目': compact(row.content_category || row.creator_type),
    '主平台': compact(row.primary_platform || account.platform),
    '覆盖平台': Array.isArray(row.covered_platforms) ? row.covered_platforms : [],
    '平台账号名': compact(row.primary_account_name || account.username),
    '识别状态': ({
      new: '新 KOL', new_kol: '新 KOL',
      existing: '已有 KOL · 新产品匹配', known_kol_new_product_fit: '已有 KOL · 新产品匹配',
      existing_product_fit_updated: '已有匹配 · 证据已更新', unresolved: '待识别'
    })[row.identity_status] || compact(row.identity_status),
    '进行中项目及进度': compact(row.active_project_summary),
    '历史合作SKU': Array.isArray(row.historical_cooperation_skus) ? row.historical_cooperation_skus.join('、') : compact(row.historical_cooperation_skus),
    '最近合作项目': compact(row.latest_cooperation_project || row.latest_project_name),
    '最近合作评价': compact(row.latest_cooperation_review),
    '是否建议复投': compact(row.repurpose_recommended),
    '开发人': compact(row.developer),
    '合作状态': row.cooperation_status === 'do_not_contact' ? '不建议合作' : '可合作',
    '风险原因': compact(row.cooperation_risk_reason)
  };
  const fitApproved = row.current_fit_decision === 'approved';
  fields['匹配SKU'] = fitApproved ? compact(row.current_target_sku) : null;
  fields['SKU匹配理由'] = fitApproved ? compact(row.current_fit_reason) : null;
  setHyperlinkField(fields, '平台主页链接', row.primary_profile_url || account.profile_url);
  setNumberField(fields, '粉丝数', row.primary_followers ?? account.followers_count ?? account.followers_text);
  setNumberField(fields, '近30天平均曝光', row.avg_views_30d);
  setNumberField(fields, '近30天中位曝光', row.median_views_30d);
  setNumberField(fields, '近30天作品数', row.posts_30d);
  setNumberField(fields, '互动率', row.engagement_rate_30d);
  if (fitApproved) setNumberField(fields, 'SKU匹配分', row.current_fit_score);
  else fields['SKU匹配分'] = null;
  setNumberField(fields, '进行中项目数', row.active_project_count);
  setNumberField(fields, '历史合作次数', row.historical_cooperation_count);
  setDateTimeField(fields, '最近项目更新时间', row.latest_project_updated_at);
  setDateTimeField(fields, '最后更新时间', row.updated_at || row.last_verified_at);
  setDateTimeField(fields, 'YouTube数据更新时间', row.youtube_snapshot_updated_at);
  fields['YouTube抓取状态'] = ({ pending: '待抓取', fetching: '抓取中', success: '成功', partial: '部分成功', failed: '失败' })[row.youtube_snapshot_status] || '待抓取';
  setTextField(fields, '抓取失败原因', row.youtube_snapshot_error);
  setTextField(fields, '数据口径', '近30天YouTube长视频，不含Shorts和直播');
  fields['达人等级'] = compact(row.creator_grade) || '待评估';
  return fields;
}

const CAMPAIGN_KOL_STATUS_LABELS = {
  candidate: '候选',
  to_contact: '待联系',
  contacted: '已联系',
  replied: '已回复',
  no_reply: '没回复',
  negotiating: '沟通中',
  confirmed: '已确定',
  published: '已发布',
  not_fit: '不合适',
  pending_confirmation: '待确认',
  pending_shipping: '待发货',
  shipped: '已发货',
  delivered: '已签收',
  content_preparation: '内容准备中',
  pending_publish: '待上线',
  published: '已上线',
  cancelled: '已取消'
};

function campaignKolStatusLabel(status) {
  const normalized = compact(status);
  return CAMPAIGN_KOL_STATUS_LABELS[normalized] || normalized;
}

function candidatePoolStatusLabel(status) {
  const normalized = compact(status);
  return CANDIDATE_POOL_STATUS_LABELS[normalized] || normalized;
}

function legacyCampaignKolFields(row) {
  const fields = {
    'KOL名称': compact(row.kol_name || row.kol_name_snapshot),
    '项目状态': campaignKolStatusLabel(row.project_status),
    '平台': compact(row.platform),
    Email: compact(row.email || row.email_snapshot),
    '国家地区': compact(row.country_region || row.country_region_snapshot),
    Tier: '',
    '跟进人': compact(row.owner),
    '推荐内容角度': '',
    '备注': compact(row.project_notes),
    '来源RawCandidate': row.raw_candidate_id ? `raw_candidate_${row.raw_candidate_id}` : ''
  };
  setHyperlinkField(fields, 'Instagram主页', row.instagram_url || row.instagram_url_snapshot);
  setHyperlinkField(fields, 'YouTube主页', row.youtube_url || row.youtube_url_snapshot);
  setHyperlinkField(fields, 'TikTok主页', row.tiktok_url || row.tiktok_url_snapshot);
  setNumberField(fields, 'Instagram粉丝量', row.instagram_followers || row.instagram_followers_snapshot);
  setNumberField(fields, 'YouTube粉丝量', row.youtube_followers || row.youtube_followers_snapshot);
  setNumberField(fields, 'TikTok粉丝量', row.tiktok_followers || row.tiktok_followers_snapshot);
  setNumberField(fields, '项目报价', row.quoted_price);
  setNumberField(fields, '汇率', row.exchange_rate);
  setNumberField(fields, '价格RMB', row.price_rmb);
  return fields;
}

function campaignKolFields(row) {
  const platform = compact(row.platform_account_platform || row.platform || row.target_platform);
  const normalizedPlatform = platform.toLowerCase();
  const followers = row.platform_account_followers
    || (normalizedPlatform === 'instagram' ? row.instagram_followers || row.instagram_followers_snapshot : '')
    || (normalizedPlatform === 'tiktok' ? row.tiktok_followers || row.tiktok_followers_snapshot : '')
    || row.youtube_followers || row.youtube_followers_snapshot;
  const fields = {};
  setTextField(fields, '达人名称', row.kol_name || row.kol_name_snapshot);
  const cooperationPlatforms = Array.isArray(row.cooperation_platforms)
    ? row.cooperation_platforms
    : parseJson(row.cooperation_platforms, []);
  fields['合作平台'] = (cooperationPlatforms.length ? cooperationPlatforms : [platform])
    .map(normalizePlatform).filter(Boolean);
  const primaryProfileUrl = row.platform_account_url
    || (normalizedPlatform === 'instagram' ? row.instagram_url || row.instagram_url_snapshot : '')
    || (normalizedPlatform === 'tiktok' ? row.tiktok_url || row.tiktok_url_snapshot : '')
    || row.youtube_url || row.youtube_url_snapshot;
  setHyperlinkField(fields, '主平台主页', primaryProfileUrl);
  setNumberField(fields, '粉丝数', followers);
  setTextField(fields, '跟进人', row.owner);
  setTextField(fields, '邮箱', row.email || row.email_snapshot);
  setTextField(fields, '优先级', ({
    t1: 'T1', t2: 'T2', t3: 'T3', t4: 'T4'
  })[row.priority_level] || row.priority_level);
  setTextField(fields, '合作SKU', row.product_sku || row.product_name);
  setTextField(fields, '合作方式', ({
    paid_product: '付费＋产品', product_exchange: '产品置换', other: '其他'
  })[row.cooperation_type] || row.cooperation_type);
  setTextField(fields, '收货地址', row.shipping_address);
  setTextField(fields, '交付内容', row.deliverables);
  setDateTimeField(fields, '预计上线时间', row.expected_publish_at);
  setTextField(fields, '内容形式', row.content_format);
  setNumberField(fields, 'KOL合作费', row.final_fee || row.quoted_fee || row.quoted_price);
  setNumberField(fields, '总预计成本', row.estimated_total_cost_usd);
  setNumberField(fields, '近30天中位曝光', row.median_views_30d_snapshot);
  setNumberField(fields, '近30天作品数', row.posts_30d_snapshot);
  setNumberField(fields, '近30天平均曝光', row.avg_views_30d_snapshot);
  setNumberField(fields, '互动率', row.engagement_rate_30d_snapshot);
  setDateTimeField(fields, '数据更新时间', row.youtube_snapshot_updated_at);
  setNumberField(fields, '预计合作曝光', row.expected_views);
  setNumberField(fields, '预估CPM', row.estimated_cpm);
  setTextField(fields, '预算审批状态', row.budget_approval_status);
  setTextField(fields, '项目状态', campaignKolStatusLabel(row.project_status));
  setTextField(fields, '备注', row.project_notes || row.notes);
  setDateTimeField(fields, '发货日期', row.shipping_date);
  setTextField(fields, '物流单号', row.tracking_number);
  setTextField(fields, '达人系统编号', row.customer_id ? `KOL-${row.customer_id}` : '');
  return fields;
}

// Fields the user removed from the candidate pool table; never written there.
const CANDIDATE_POOL_OMITTED_FIELDS = ['项目状态', '交付内容', '预计上线时间', '收货地址', '发货日期', '物流单号'];

function candidatePoolKolFields(row) {
  const fields = campaignKolFields(row);
  for (const name of CANDIDATE_POOL_OMITTED_FIELDS) delete fields[name];
  fields['状态'] = candidatePoolStatusLabel(row.project_status);
  return fields;
}

function isExecutionStatus(status) {
  return EXECUTION_STATUSES.has(compact(status));
}

// Execution-stage rows go to the project tracking table; earlier stages go to
// the campaign's candidate pool subtable.
function campaignKolTargetTableId(config, row) {
  if (isExecutionStatus(row.project_status)) return compact(config.campaign_kol_table_id).trim();
  return getCampaignKolTableId(config, row);
}

function isCandidatePoolTable(config, tableId) {
  if (!tableId) return false;
  if (compact(config.campaign_kol_table_id).trim() === tableId) return false;
  return Object.values(config.campaign_subtable_map || {}).includes(tableId);
}

// Best-effort: when a KOL moves to the execution table, mark its old candidate
// pool record as confirmed. Callers ignore failures (the old record may be gone).
async function markCandidatePoolConfirmed(config, token, tableId, recordId) {
  const url = `${config.base_url}/open-apis/bitable/v1/apps/${encodeURIComponent(config.app_token)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`;
  await fetchJson(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: { 状态: '已确定' } })
  });
}

function campaignFields(row) {
  return {
    '项目/产品名': compact(row.name),
    '品牌': compact(row.brand),
    '产品品类': compact(row.product),
    '品牌关键词': compact(row.brand_keywords),
    '购买意向关键词': compact(row.purchase_keywords),
    '负面关键词': compact(row.negative_keywords),
    '备注': compact(row.notes)
  };
}

async function syncKols(config, token, ids = []) {
  const params = [];
  let sql = 'SELECT * FROM customers WHERE 1=1';
  if (ids.length) {
    sql += ` AND id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  } else {
    sql += " AND (sync_status IS NULL OR sync_status IN ('sync_pending', 'sync_failed'))";
  }
  const baseRows = await dbOperations.query(sql, params);
  const rows = await attachKolInsights(await attachPlatformAccounts(baseRows));
  const results = [];

  for (const row of rows) {
    try {
      const recordId = await pushBitableRecord(config, token, config.kol_table_id, row.feishu_record_id, kolFields(row));
      await dbOperations.run(
        `UPDATE customers SET feishu_record_id = ?, sync_status = ?, last_synced_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [recordId, 'synced', row.id]
      );
      results.push({ type: 'kol', id: row.id, success: true, record_id: recordId });
    } catch (error) {
      await dbOperations.run('UPDATE customers SET sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['sync_failed', row.id]);
      results.push({ type: 'kol', id: row.id, success: false, error: error.message });
    }
  }
  return results;
}

async function syncCampaigns(config, token, ids = []) {
  if (!config.campaign_table_id) {
    if (ids.length) throw new Error('Feishu Campaigns Table ID is not configured');
    return [];
  }

  const params = [];
  let sql = 'SELECT * FROM campaigns WHERE 1=1';
  if (ids.length) {
    sql += ` AND id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }
  sql += ' ORDER BY id';
  const rows = await dbOperations.query(sql, params);
  const results = [];

  for (const row of rows) {
    try {
      const recordId = await pushBitableRecord(config, token, config.campaign_table_id, null, campaignFields(row));
      results.push({ type: 'campaign', id: row.id, success: true, record_id: recordId });
    } catch (error) {
      results.push({ type: 'campaign', id: row.id, success: false, error: error.message });
    }
  }
  return results;
}

async function syncCampaignKols(config, token, ids = []) {
  const params = [];
  let sql = `
    SELECT ck.*, c.name as campaign_name,
      k.name as kol_name, k.contact_name, k.email, k.country_region,
      k.platform, k.youtube_url, k.youtube_followers, k.instagram_url, k.instagram_followers,
      k.tiktok_url, k.tiktok_followers,
      kpa.platform as platform_account_platform, kpa.profile_url as platform_account_url,
      kpa.followers_text as platform_account_followers,
      (SELECT p.sku FROM campaign_kol_products ckp
       JOIN campaign_products cp ON cp.id = ckp.campaign_product_id
       JOIN products p ON p.id = cp.product_id
       WHERE ckp.campaign_kol_id = ck.id ORDER BY cp.priority DESC, ckp.id LIMIT 1) product_sku,
      (SELECT p.name FROM campaign_kol_products ckp
       JOIN campaign_products cp ON cp.id = ckp.campaign_product_id
       JOIN products p ON p.id = cp.product_id
       WHERE ckp.campaign_kol_id = ck.id ORDER BY cp.priority DESC, ckp.id LIMIT 1) product_name
    FROM campaign_kols ck
    JOIN campaigns c ON c.id = ck.campaign_id
    JOIN customers k ON k.id = ck.customer_id
    LEFT JOIN kol_platform_accounts kpa ON kpa.id = ck.platform_account_id
    WHERE 1=1
  `;
  if (ids.length) {
    sql += ` AND ck.id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  } else {
    sql += " AND (ck.sync_status IS NULL OR ck.sync_status IN ('sync_pending', 'sync_failed'))";
  }
  const rows = await dbOperations.query(sql, params);
  const results = [];

  const tableIds = Array.from(new Set(rows.map((row) => campaignKolTargetTableId(config, row)).filter(Boolean)));
  for (const tableId of tableIds) {
    if (isCandidatePoolTable(config, tableId)) await ensureCandidatePoolFields(config, token, tableId);
    else await ensureProjectTrackingFields(config, token, tableId);
  }

  for (const row of rows) {
    try {
      const tableId = campaignKolTargetTableId(config, row);
      if (!tableId) throw missingCampaignSubtableError(row);
      const targetIsPool = isCandidatePoolTable(config, tableId);
      const recordId = await pushBitableRecord(
        config,
        token,
        tableId,
        row.feishu_record_id,
        targetIsPool ? candidatePoolKolFields(row) : campaignKolFields(row)
      );
      // The row moved from the candidate pool to the execution table: mark the
      // old pool record as confirmed (best effort, the pool record may be gone).
      if (!targetIsPool && row.feishu_record_id && recordId !== row.feishu_record_id) {
        const poolTableId = getCampaignKolTableId(config, row);
        if (poolTableId && isCandidatePoolTable(config, poolTableId)) {
          try {
            await markCandidatePoolConfirmed(config, token, poolTableId, row.feishu_record_id);
          } catch (error) {
            // best effort
          }
        }
      }
      await dbOperations.run(
        `UPDATE campaign_kols SET feishu_record_id = ?, sync_status = ?, last_synced_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [recordId, 'synced', row.id]
      );
      results.push({ type: 'campaign_kol', id: row.id, success: true, record_id: recordId });
    } catch (error) {
      await dbOperations.run('UPDATE campaign_kols SET sync_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['sync_failed', row.id]);
      results.push({ type: 'campaign_kol', id: row.id, success: false, error: error.message });
    }
  }
  return results;
}

async function syncRefreshedKolAndCandidates(customerId) {
  const id = Number(customerId);
  if (!id) throw new Error('KOL id is required');
  const config = await getFeishuConfig();
  requireFeishuConfig(config);
  const token = await getTenantAccessToken(config);
  await ensureKolMasterFields(config, token);
  const candidateRows = await dbOperations.query(
    `SELECT id FROM campaign_kols
     WHERE customer_id = ? AND project_status IN ('candidate', 'pending_confirmation')`,
    [id]
  );
  const [kolResults, candidateResults] = await Promise.all([
    syncKols(config, token, [id]),
    candidateRows.length
      ? syncCampaignKols(config, token, candidateRows.map((row) => row.id))
      : Promise.resolve([])
  ]);
  const results = [...kolResults, ...candidateResults];
  return {
    success_count: results.filter((item) => item.success).length,
    failed_count: results.filter((item) => !item.success).length,
    candidate_count: candidateRows.length,
    results
  };
}

async function listBitableRecords(config, token, tableId) {
  const records = [];
  let pageToken = '';
  do {
    const suffix = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '';
    const url = `${config.base_url}/open-apis/bitable/v1/apps/${encodeURIComponent(config.app_token)}/tables/${encodeURIComponent(tableId)}/records?page_size=100${suffix}`;
    const data = await fetchJson(url, { headers: { Authorization: `Bearer ${token}` } });
    records.push(...(data.data?.items || []));
    pageToken = data.data?.has_more ? data.data?.page_token : '';
  } while (pageToken);
  return records;
}

async function deleteBitableRecord(config, token, tableId, recordId) {
  const url = `${config.base_url}/open-apis/bitable/v1/apps/${encodeURIComponent(config.app_token)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`;
  await fetchJson(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
}

async function deleteBlankKolMasterRecords(config, token) {
  const records = await listBitableRecords(config, token, config.kol_table_id);
  const blank = records.filter((record) => !compact(record.fields?.['KOL名称']).trim());
  const summary = { scanned: records.length, deleted: [], failed: [] };
  for (const record of blank) {
    try {
      await deleteBitableRecord(config, token, config.kol_table_id, record.record_id);
      summary.deleted.push(record.record_id);
    } catch (error) {
      summary.failed.push({ record_id: record.record_id, error: error.message });
    }
  }
  summary.remaining = (await listBitableRecords(config, token, config.kol_table_id)).length;
  return summary;
}

function fieldHasValue(value) {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Boolean(value.link || value.text || Object.keys(value).length);
  return true;
}

function hyperlinkValue(value) {
  if (!fieldHasValue(value)) return null;
  if (typeof value === 'object' && value.link) return value;
  const url = compact(value).trim();
  return url ? { link: url, text: url } : null;
}

function normalizePlatform(value) {
  const text = compact(value).trim().toLowerCase();
  if (text.includes('youtube')) return 'YouTube';
  if (text.includes('instagram')) return 'Instagram';
  if (text.includes('tiktok')) return 'TikTok';
  if (text === 'x' || text.includes('twitter')) return 'X';
  if (text.includes('facebook')) return 'Facebook';
  return '';
}

function accountNameFromUrl(value) {
  const url = typeof value === 'object' ? value.link : compact(value);
  if (!url) return '';
  try {
    const path = new URL(url).pathname.split('/').filter(Boolean);
    const candidate = path.find((part) => part.startsWith('@')) || path[path.length - 1] || '';
    return decodeURIComponent(candidate).replace(/^@/, '');
  } catch (error) {
    return '';
  }
}

function migratedKolFields(fields = {}) {
  const updates = {};
  const copyIfEmpty = (target, source, transform = (value) => value) => {
    if (fieldHasValue(fields[target]) || !fieldHasValue(fields[source])) return;
    const value = transform(fields[source]);
    if (fieldHasValue(value)) updates[target] = value;
  };

  copyIfEmpty('邮箱', 'Email');
  copyIfEmpty('国家/地区', '国家地区');
  copyIfEmpty('平台', '主平台', normalizePlatform);
  copyIfEmpty('粉丝数', '主平台粉丝数');
  copyIfEmpty('近30天平均曝光', '主平台近30天平均曝光');
  copyIfEmpty('近30天中位曝光', '主平台近30天中位曝光');
  copyIfEmpty('近30天作品数', '主平台近30天作品数');
  copyIfEmpty('互动率', '主平台互动率');

  const platform = normalizePlatform(fields['平台'] || updates['平台'] || fields['主平台']);
  const platformLinkField = platform === 'Instagram' ? 'Instagram主页'
    : platform === 'TikTok' ? 'TikTok主页'
      : platform === 'YouTube' ? 'YouTube主页' : '';
  if (!fieldHasValue(fields['平台主页链接'])) {
    const source = fields['主主页链接'] || fields['主页链接'] || (platformLinkField && fields[platformLinkField]);
    const link = hyperlinkValue(source);
    if (link) updates['平台主页链接'] = link;
  }

  if (!fieldHasValue(fields['平台账号名'])) {
    const accountName = accountNameFromUrl(updates['平台主页链接'] || fields['平台主页链接'] || fields['主主页链接']);
    if (accountName) updates['平台账号名'] = accountName;
  }

  if (!fieldHasValue(fields['合作平台'])) {
    const covered = [];
    if (fieldHasValue(fields['YouTube主页'])) covered.push('YouTube');
    if (fieldHasValue(fields['Instagram主页'])) covered.push('Instagram');
    if (fieldHasValue(fields['TikTok主页'])) covered.push('TikTok');
    if (platform && !covered.includes(platform)) covered.push(platform);
    if (covered.length) updates['合作平台'] = covered;
  }
  return updates;
}

async function migrateKolMasterRecords(config, token) {
  const records = await listBitableRecords(config, token, config.kol_table_id);
  const summary = { fetched: records.length, updated: 0, unchanged: 0, failed: 0, errors: [] };
  for (const record of records) {
    const updates = migratedKolFields(record.fields || {});
    if (!Object.keys(updates).length) {
      summary.unchanged += 1;
      continue;
    }
    try {
      await pushBitableRecord(config, token, config.kol_table_id, record.record_id, updates);
      summary.updated += 1;
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({ record_id: record.record_id, error: error.message });
    }
  }
  const verified = await listBitableRecords(config, token, config.kol_table_id);
  summary.verification = verified.reduce((result, record) => {
    const fields = record.fields || {};
    if (fieldHasValue(fields['主平台']) && !fieldHasValue(fields['平台'])) result.missing_main_platform += 1;
    if ((fieldHasValue(fields['主页链接']) || fieldHasValue(fields['YouTube主页']) || fieldHasValue(fields['Instagram主页']) || fieldHasValue(fields['TikTok主页']))
      && !fieldHasValue(fields['平台主页链接'])) result.missing_main_profile += 1;
    if (fieldHasValue(fields['主平台粉丝数']) && !fieldHasValue(fields['粉丝数'])) result.missing_main_followers += 1;
    return result;
  }, { records: verified.length, missing_main_platform: 0, missing_main_profile: 0, missing_main_followers: 0 });
  return summary;
}

// Columns written by a KOL master import. Unmapped columns (cooperation status,
// groups, prices, ids) are never touched by updates.
const IMPORT_COLUMNS = [
  'name', 'platform', 'creator_id', 'contact_name',
  'youtube_url', 'youtube_followers', 'instagram_url', 'instagram_followers',
  'tiktok_url', 'tiktok_followers', 'email', 'country_region', 'creator_type', 'notes'
];

router.post('/feishu/pull', async (req, res) => {
  try {
    const config = await getFeishuConfig();
    requireFeishuConfig(config);
    const token = await getTenantAccessToken(config);
    const records = await listBitableRecords(config, token, config.kol_table_id);
    const customers = await dbOperations.query('SELECT * FROM customers');
    const summary = { fetched: records.length, created: 0, updated: 0, skipped: 0, failed: 0, errors: [] };

    for (const record of records) {
      const kol = mapFeishuRecordToKol(record);
      if (!kol.name) {
        summary.skipped += 1;
        continue;
      }
      try {
        const existing = findMatchingCustomer(kol, customers);
        if (existing) {
          // Only overwrite with non-empty Feishu values: an empty Feishu field
          // must never erase data the local record already has.
          const writable = IMPORT_COLUMNS.filter((column) => kol[column]);
          const assignments = writable.map((column) => `${column} = ?`).join(', ');
          await dbOperations.run(
            `UPDATE customers SET ${assignments ? `${assignments}, ` : ''}feishu_record_id = ?, sync_status = 'synced',
             last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [...writable.map((column) => kol[column]), kol.feishu_record_id, existing.id]
          );
          // Keep the in-memory mirror fresh so later records in the same batch
          // match against the just-updated row.
          for (const column of writable) existing[column] = kol[column];
          existing.feishu_record_id = kol.feishu_record_id;
          summary.updated += 1;
        } else {
          const columns = [...IMPORT_COLUMNS, 'feishu_record_id', 'sync_status'];
          const placeholders = columns.map(() => '?').join(', ');
          const result = await dbOperations.run(
            `INSERT INTO customers (${columns.join(', ')}, last_synced_at) VALUES (${placeholders}, CURRENT_TIMESTAMP)`,
            [...IMPORT_COLUMNS.map((column) => kol[column] || null), kol.feishu_record_id, 'synced']
          );
          customers.push({ ...kol, id: result?.id });
          summary.created += 1;
        }
      } catch (error) {
        summary.failed += 1;
        summary.errors.push({ record_id: kol.feishu_record_id, error: error.message });
      }
    }

    res.json({ success: true, data: summary });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/feishu/ensure-kol-fields', async (req, res) => {
  try {
    const config = await getFeishuConfig();
    requireFeishuConfig(config);
    const token = await getTenantAccessToken(config);
    const summary = await ensureKolMasterFields(config, token);
    res.json({ success: true, data: summary });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message, data: error.field_summary || null });
  }
});

router.post('/feishu/ensure-project-fields', async (req, res) => {
  try {
    const config = await getFeishuConfig();
    requireFeishuConfig(config);
    const tableId = compact(req.body?.table_id || config.campaign_kol_table_id).trim();
    const token = await getTenantAccessToken(config);
    const summary = await ensureProjectTrackingFields(config, token, tableId, { backfillPlatforms: true });
    res.json({ success: true, data: summary });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message, data: error.field_summary || null });
  }
});

router.post('/feishu/inspect-project-fields', async (req, res) => {
  try {
    const config = await getFeishuConfig();
    requireFeishuConfig(config);
    const tableId = compact(req.body?.table_id || config.campaign_kol_table_id).trim();
    if (!tableId) throw new Error('飞书项目跟进表 ID 未配置');
    const token = await getTenantAccessToken(config);
    const fields = await listBitableFields(config, token, tableId);
    const records = await listBitableRecords(config, token, tableId);
    res.json({ success: true, data: fields.map((field) => ({
      field_id: field.field_id, field_name: field.field_name, type: field.type, property: field.property,
      populated_count: records.filter((record) => {
        const value = record.fields?.[field.field_name];
        return value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
      }).length
    })) });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/feishu/migrate-kol-fields', async (req, res) => {
  try {
    const config = await getFeishuConfig();
    requireFeishuConfig(config);
    const token = await getTenantAccessToken(config);
    await ensureKolMasterFields(config, token);
    const summary = await migrateKolMasterRecords(config, token);
    res.json({ success: true, data: summary });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/feishu/delete-blank-kol-records', async (req, res) => {
  try {
    const config = await getFeishuConfig();
    requireFeishuConfig(config);
    const token = await getTenantAccessToken(config);
    const summary = await deleteBlankKolMasterRecords(config, token);
    res.json({ success: summary.failed.length === 0, data: summary });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.get('/feishu/kol-record-count', async (req, res) => {
  try {
    const config = await getFeishuConfig();
    requireFeishuConfig(config);
    const token = await getTenantAccessToken(config);
    const records = await listBitableRecords(config, token, config.kol_table_id);
    const named = records.filter((record) => compact(record.fields?.['KOL名称']).trim());
    res.json({ success: true, data: { total: records.length, named: named.length, blank: records.length - named.length } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/feishu/delete-orphan-kol-records', async (req, res) => {
  try {
    const config = await getFeishuConfig();
    requireFeishuConfig(config);
    const token = await getTenantAccessToken(config);
    const records = await listBitableRecords(config, token, config.kol_table_id);
    const linked = await dbOperations.query("SELECT feishu_record_id FROM customers WHERE COALESCE(feishu_record_id, '') <> ''");
    const linkedIds = new Set(linked.map((row) => row.feishu_record_id));
    const orphaned = records.filter((record) => !linkedIds.has(record.record_id));
    const summary = { scanned: records.length, deleted: [], failed: [] };
    for (const record of orphaned) {
      try {
        await deleteBitableRecord(config, token, config.kol_table_id, record.record_id);
        summary.deleted.push(record.record_id);
      } catch (error) {
        summary.failed.push({ record_id: record.record_id, error: error.message });
      }
    }
    summary.remaining = records.length - summary.deleted.length;
    res.json({ success: summary.failed.length === 0, data: summary });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/feishu/delete-obsolete-kol-fields', async (req, res) => {
  try {
    const config = await getFeishuConfig();
    requireFeishuConfig(config);
    const token = await getTenantAccessToken(config);
    const summary = await deleteObsoleteKolMasterFields(config, token);
    res.json({ success: summary.failed.length === 0 && summary.obsolete_remaining.length === 0, data: summary });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/feishu/rename-kol-fields', async (req, res) => {
  try {
    const config = await getFeishuConfig();
    requireFeishuConfig(config);
    const token = await getTenantAccessToken(config);
    const fieldRenames = req.body?.platform_only
      ? { '平台': '主平台', '合作平台': '覆盖平台' }
      : KOL_FIELD_RENAMES;
    const summary = await renameKolMasterFields(config, token, fieldRenames);
    res.json({ success: summary.failed.length === 0 && summary.remaining_old_names.length === 0, data: summary });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/feishu/push', async (req, res) => {
  try {
    const config = await getFeishuConfig();
    requireFeishuConfig(config);
    const token = await getTenantAccessToken(config);
    const scope = req.body.scope || 'all';
    const ids = (req.body.ids || []).map((id) => Number(id)).filter(Boolean);

    let fieldSummary = null;
    if (scope === 'all' || scope === 'kols') {
      fieldSummary = await ensureKolMasterFields(config, token);
    }

    let results = [];
    if (scope === 'all' || scope === 'kols') results = results.concat(await syncKols(config, token, scope === 'kols' ? ids : []));
    if (scope === 'all' || scope === 'campaigns') results = results.concat(await syncCampaigns(config, token, scope === 'campaigns' ? ids : []));
    if (scope === 'all' || scope === 'campaign_kols') {
      results = results.concat(await syncCampaignKols(config, token, scope === 'campaign_kols' ? ids : []));
    }

    res.json({
      success: true,
      data: {
        success_count: results.filter((item) => item.success).length,
        failed_count: results.filter((item) => !item.success).length,
        field_summary: fieldSummary,
        results
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message, data: error.field_summary || null });
  }
});

router.post('/feishu/push-kols-batch', async (req, res) => {
  try {
    const config = await getFeishuConfig();
    requireFeishuConfig(config);
    const token = await getTenantAccessToken(config);
    const ids = (req.body.ids || []).map((id) => Number(id)).filter(Boolean);
    await ensureKolMasterFields(config, token);
    const results = await syncKolsBatch(config, token, ids);
    res.json({
      success: results.every((item) => item.success),
      data: {
        success_count: results.filter((item) => item.success).length,
        failed_count: results.filter((item) => !item.success).length,
        results
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/feishu/push-kols-bulk', async (req, res) => {
  try {
    const config = await getFeishuConfig();
    requireFeishuConfig(config);
    const token = await getTenantAccessToken(config);
    const ids = (req.body.ids || []).map((id) => Number(id)).filter(Boolean);
    await ensureKolMasterFields(config, token);
    const results = await syncKolsBulk(config, token, ids);
    res.json({
      success: results.every((item) => item.success),
      data: {
        success_count: results.filter((item) => item.success).length,
        failed_count: results.filter((item) => !item.success).length,
        results
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
module.exports.kolFields = kolFields;
module.exports.ensureKolMasterFields = ensureKolMasterFields;
module.exports.KOL_MASTER_FIELD_SCHEMA = KOL_MASTER_FIELD_SCHEMA;
module.exports.ensureProjectTrackingFields = ensureProjectTrackingFields;
module.exports.PROJECT_TRACKING_FIELD_SCHEMA = PROJECT_TRACKING_FIELD_SCHEMA;
module.exports.campaignKolFields = campaignKolFields;
module.exports.migratedKolFields = migratedKolFields;
module.exports.OBSOLETE_KOL_MASTER_FIELDS = OBSOLETE_KOL_MASTER_FIELDS;
module.exports.KOL_FIELD_RENAMES = KOL_FIELD_RENAMES;
module.exports.syncRefreshedKolAndCandidates = syncRefreshedKolAndCandidates;
module.exports.syncKolsBulk = syncKolsBulk;
module.exports.candidatePoolKolFields = candidatePoolKolFields;
module.exports.candidatePoolStatusLabel = candidatePoolStatusLabel;
module.exports.ensureCandidatePoolFields = ensureCandidatePoolFields;
module.exports.CANDIDATE_POOL_FIELD_SCHEMA = CANDIDATE_POOL_FIELD_SCHEMA;
module.exports.CANDIDATE_POOL_STATUS_LABELS = CANDIDATE_POOL_STATUS_LABELS;
module.exports.EXECUTION_STATUSES = EXECUTION_STATUSES;
module.exports.campaignKolTargetTableId = campaignKolTargetTableId;
module.exports.isCandidatePoolTable = isCandidatePoolTable;
