const assert = require('node:assert/strict');
const test = require('node:test');
const { feishuFieldToText, mapFeishuRecordToKol, findMatchingCustomer } = require('./feishuKolImport');

test('feishuFieldToText extracts plain strings', () => {
  assert.equal(feishuFieldToText('Alice'), 'Alice');
  assert.equal(feishuFieldToText('  Alice  '), 'Alice');
});

test('feishuFieldToText concatenates text segment arrays', () => {
  assert.equal(feishuFieldToText([{ text: 'Ali' }, { text: 'ce' }]), 'Alice');
});

test('feishuFieldToText prefers link in hyperlink objects', () => {
  assert.equal(feishuFieldToText({ link: 'https://x.com/a', text: 'https://x.com/a' }), 'https://x.com/a');
  assert.equal(feishuFieldToText({ text: 'fallback' }), 'fallback');
});

test('feishuFieldToText stringifies numbers', () => {
  assert.equal(feishuFieldToText(12300), '12300');
});

test('feishuFieldToText maps empty values to empty string', () => {
  assert.equal(feishuFieldToText(null), '');
  assert.equal(feishuFieldToText(undefined), '');
  assert.equal(feishuFieldToText(''), '');
});

test('mapFeishuRecordToKol maps all known fields', () => {
  const record = {
    record_id: 'rec1',
    fields: {
      'KOL名称': 'Alice',
      '平台': 'YouTube',
      creator_id: 'alice01',
      '联系人': 'Alice Manager',
      'YouTube主页': { link: 'https://youtube.com/@alice', text: 'https://youtube.com/@alice' },
      'YouTube粉丝量': 12300,
      'Instagram主页': 'https://instagram.com/alice',
      'Instagram粉丝量': 8900,
      Email: 'alice@example.com',
      '国家地区': 'UK',
      '内容类型': 'KOL',
      '备注': '重点推荐'
    }
  };
  assert.deepEqual(mapFeishuRecordToKol(record), {
    feishu_record_id: 'rec1',
    name: 'Alice',
    platform: 'YouTube',
    creator_id: 'alice01',
    contact_name: 'Alice Manager',
    youtube_url: 'https://youtube.com/@alice',
    youtube_followers: '12300',
    instagram_url: 'https://instagram.com/alice',
    instagram_followers: '8900',
    tiktok_url: '',
    tiktok_followers: '',
    email: 'alice@example.com',
    country_region: 'UK',
    creator_type: 'KOL',
    notes: '重点推荐'
  });
});

test('mapFeishuRecordToKol tolerates missing fields', () => {
  const kol = mapFeishuRecordToKol({ record_id: 'rec2', fields: { 'KOL名称': 'Bob' } });
  assert.equal(kol.name, 'Bob');
  assert.equal(kol.email, '');
  assert.equal(kol.platform, '');
  assert.equal(kol.feishu_record_id, 'rec2');
});

const matchingCustomers = [
  { id: 1, feishu_record_id: 'rec_keep', creator_id: 'other', name: 'Alice', platform: 'YouTube' },
  { id: 2, feishu_record_id: null, creator_id: 'alice01', name: 'Renamed', platform: 'TikTok' },
  { id: 3, feishu_record_id: null, creator_id: '', name: 'Bob', platform: 'YouTube' }
];

test('findMatchingCustomer prefers feishu_record_id over other keys', () => {
  const kol = { feishu_record_id: 'rec_keep', creator_id: 'alice01', name: 'Bob', platform: 'YouTube' };
  assert.equal(findMatchingCustomer(kol, matchingCustomers).id, 1);
});

test('findMatchingCustomer matches creator_id before name and platform', () => {
  const kol = { feishu_record_id: 'rec_new', creator_id: 'alice01', name: 'Bob', platform: 'YouTube' };
  assert.equal(findMatchingCustomer(kol, matchingCustomers).id, 2);
});

test('findMatchingCustomer matches name and platform when ids are absent', () => {
  const kol = { feishu_record_id: 'rec_new', creator_id: '', name: 'Bob', platform: 'YouTube' };
  assert.equal(findMatchingCustomer(kol, matchingCustomers).id, 3);
});

test('findMatchingCustomer never matches by name alone when platform is empty', () => {
  const kol = { feishu_record_id: 'rec_new', creator_id: '', name: 'Bob', platform: '' };
  assert.equal(findMatchingCustomer(kol, matchingCustomers), null);
});

test('findMatchingCustomer returns null without any match', () => {
  const kol = { feishu_record_id: 'rec_new', creator_id: '', name: 'Carol', platform: 'YouTube' };
  assert.equal(findMatchingCustomer(kol, matchingCustomers), null);
});
