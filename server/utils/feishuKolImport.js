// Pure helpers for importing Feishu Bitable KOL master records into `customers`.
// Kept free of network and database access so the merge rules can be unit tested.

// Feishu field values arrive as strings, numbers, [{ text }] segment arrays, or
// hyperlink { link, text } objects depending on the column type. Extract a
// trimmed string for any of those shapes and never throw.
function feishuFieldToText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === undefined || item === null) return '';
      if (typeof item === 'object') return item.text || item.link || '';
      return String(item);
    }).join('').trim();
  }
  if (typeof value === 'object') return String(value.link || value.text || '').trim();
  return String(value).trim();
}

const FIELD_MAP = {
  name: 'KOL名称',
  platform: '平台',
  creator_id: 'creator_id',
  contact_name: '联系人',
  youtube_url: 'YouTube主页',
  youtube_followers: 'YouTube粉丝量',
  instagram_url: 'Instagram主页',
  instagram_followers: 'Instagram粉丝量',
  tiktok_url: 'TikTok主页',
  tiktok_followers: 'TikTok粉丝量',
  email: 'Email',
  country_region: '国家地区',
  creator_type: '内容类型',
  notes: '备注'
};

function mapFeishuRecordToKol(record) {
  const fields = record?.fields || {};
  const kol = { feishu_record_id: record?.record_id || '' };
  for (const [column, fieldName] of Object.entries(FIELD_MAP)) {
    kol[column] = feishuFieldToText(fields[fieldName]);
  }
  return kol;
}

function key(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

// Match priority: feishu_record_id, then non-empty creator_id, then name plus a
// non-empty platform (name alone is too ambiguous to merge on).
function findMatchingCustomer(kol, customers) {
  const recordId = key(kol.feishu_record_id);
  const creatorId = key(kol.creator_id);
  const name = key(kol.name);
  const platform = key(kol.platform);

  if (recordId) {
    const byRecordId = customers.find((customer) => key(customer.feishu_record_id) === recordId);
    if (byRecordId) return byRecordId;
  }
  if (creatorId) {
    const byCreatorId = customers.find((customer) => key(customer.creator_id) && key(customer.creator_id) === creatorId);
    if (byCreatorId) return byCreatorId;
  }
  if (name && platform) {
    const byName = customers.find((customer) => key(customer.name) === name && key(customer.platform) === platform);
    if (byName) return byName;
  }
  return null;
}

module.exports = { feishuFieldToText, mapFeishuRecordToKol, findMatchingCustomer };
