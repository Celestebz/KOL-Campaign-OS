function getCampaignKolTableId(config = {}, row = {}) {
  const map = config.campaign_subtable_map || {};
  return map[row.campaign_id] || map[String(row.campaign_id)] || map[row.campaign_name] || '';
}

// 项目跟进表同样是每项目一张，查找逻辑与候选池子表一致。
function getCampaignTrackingTableId(config = {}, row = {}) {
  const map = config.campaign_tracking_map || {};
  return map[row.campaign_id] || map[String(row.campaign_id)] || map[row.campaign_name] || '';
}

function missingCampaignSubtableError(row = {}) {
  return new Error(`项目“${row.campaign_name || '未命名项目'}”尚未配置飞书 KOL 子表`);
}

function missingCampaignTrackingTableError(row = {}) {
  return new Error(`项目“${row.campaign_name || '未命名项目'}”尚未配置飞书项目跟进表`);
}

module.exports = {
  getCampaignKolTableId,
  getCampaignTrackingTableId,
  missingCampaignSubtableError,
  missingCampaignTrackingTableError
};
