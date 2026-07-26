const assert = require('node:assert/strict');
const test = require('node:test');
const {
  getCampaignKolTableId,
  getCampaignTrackingTableId,
  missingCampaignSubtableError,
  missingCampaignTrackingTableError
} = require('./feishuSubtableMapping');

const config = {
  campaign_subtable_map: { '7': 'tblById', 'Old Name': 'tblByName' },
  campaign_tracking_map: { '7': 'tblTrackById', 'Old Name': 'tblTrackByName' }
};

test('selects project subtable by id before legacy name', () => {
  assert.equal(getCampaignKolTableId(config, { campaign_id: 7, campaign_name: 'Old Name' }), 'tblById');
  assert.equal(getCampaignKolTableId(config, { campaign_id: 8, campaign_name: 'Old Name' }), 'tblByName');
});

test('does not fall back to any default table', () => {
  assert.equal(getCampaignKolTableId(config, { campaign_id: 99, campaign_name: 'Missing' }), '');
  assert.equal(missingCampaignSubtableError({ campaign_name: 'Missing' }).message, '项目“Missing”尚未配置飞书 KOL 子表');
});

test('selects project tracking table by id before legacy name', () => {
  assert.equal(getCampaignTrackingTableId(config, { campaign_id: 7, campaign_name: 'Old Name' }), 'tblTrackById');
  assert.equal(getCampaignTrackingTableId(config, { campaign_id: 8, campaign_name: 'Old Name' }), 'tblTrackByName');
});

test('missing tracking mapping returns empty and a dedicated error', () => {
  assert.equal(getCampaignTrackingTableId(config, { campaign_id: 99, campaign_name: 'Missing' }), '');
  assert.equal(missingCampaignTrackingTableError({ campaign_name: 'Missing' }).message, '项目“Missing”尚未配置飞书项目跟进表');
});
