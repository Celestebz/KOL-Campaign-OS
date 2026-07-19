const assert = require('node:assert/strict');
const test = require('node:test');
const { getCampaignKolTableId, missingCampaignSubtableError } = require('./feishuSubtableMapping');

const config = {
  campaign_subtable_map: { '7': 'tblById', 'Old Name': 'tblByName' },
  campaign_kol_table_id: 'tblDefault'
};

test('selects project subtable by id before legacy name', () => {
  assert.equal(getCampaignKolTableId(config, { campaign_id: 7, campaign_name: 'Old Name' }), 'tblById');
  assert.equal(getCampaignKolTableId(config, { campaign_id: 8, campaign_name: 'Old Name' }), 'tblByName');
});

test('does not fall back to the legacy default table', () => {
  assert.equal(getCampaignKolTableId(config, { campaign_id: 99, campaign_name: 'Missing' }), '');
  assert.equal(missingCampaignSubtableError({ campaign_name: 'Missing' }).message, '项目“Missing”尚未配置飞书 KOL 子表');
});
