const test = require('node:test');
const assert = require('node:assert/strict');
const { profileKey, mapSystemRow, buildPreview, applyFieldPolicies } = require('./feishuSheetSync');

test('profileKey normalizes platform profile URLs', () => {
  assert.equal(profileKey('TikTok', 'https://www.tiktok.com/@Demo.Creator/'), 'tiktok|demo.creator');
  assert.equal(profileKey('Instagram', [{ type: 'url', text: 'demo', link: 'https://instagram.com/demo/' }]), 'instagram|demo');
});

test('mapSystemRow maps system columns and leaves manual columns blank on append', () => {
  const mapped = mapSystemRow({
    id: 7,
    customer_id: 42,
    kol_name: 'Demo Creator',
    platform_account_platform: 'TikTok',
    platform_account_username: 'demo',
    platform_account_url: 'https://www.tiktok.com/@demo',
    platform_account_followers: 12000,
    owner: 'Celeste',
    email: 'demo@example.com',
    priority_level: 't2',
    cooperation_type: 'product_exchange',
    project_status: 'shipped'
  });
  assert.equal(mapped.systemId, 'KOL-42');
  assert.equal(mapped.values.append.length, 25);
  assert.equal(mapped.values.append[3], 'Celeste');
  assert.equal(mapped.values.append[8], '');
  assert.equal(mapped.values.append[19], '');
  assert.equal(mapped.values.append[22], 'KOL-42');
});

test('buildPreview prefers stable system id and otherwise matches platform profile', () => {
  const row = mapSystemRow({
    id: 7,
    customer_id: 42,
    kol_name: 'Demo Creator',
    platform_account_platform: 'TikTok',
    platform_account_username: 'demo',
    platform_account_url: 'https://www.tiktok.com/@demo'
  });
  const sheet = [
    ['达人名称', '平台'],
    [[{ type: 'url', text: 'Demo', link: 'https://www.tiktok.com/@demo' }], 'TikTok']
  ];
  const preview = buildPreview([row], sheet);
  assert.equal(preview.updated, 1);
  assert.equal(preview.created, 0);
  assert.equal(preview.plan[0].sheetRow, 2);
});

test('applyFieldPolicies changes only explicitly requested columns', () => {
  const system = Array(25).fill('');
  const sheet = Array(25).fill('');
  system[8] = 500;
  system[9] = 'New address';
  system[23] = 'TRACK-1';
  sheet[8] = 400;
  sheet[9] = 'Existing address';
  sheet[19] = 'Keep this note';

  const result = applyFieldPolicies(system, sheet, {
    I: 'overwrite',
    J: 'fill_empty',
    X: 'overwrite_nonempty'
  });

  assert.equal(result[8], 500);
  assert.equal(result[9], 'Existing address');
  assert.equal(result[19], 'Keep this note');
  assert.equal(result[23], 'TRACK-1');
});
