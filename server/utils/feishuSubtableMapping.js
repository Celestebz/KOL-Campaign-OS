function getCampaignKolTableId(config = {}, row = {}) {
  const map = config.campaign_subtable_map || {};
  return map[row.campaign_id] || map[String(row.campaign_id)] || map[row.campaign_name] || '';
}

function missingCampaignSubtableError(row = {}) {
  return new Error(`项目“${row.campaign_name || '未命名项目'}”尚未配置飞书 KOL 子表`);
}

module.exports = { getCampaignKolTableId, missingCampaignSubtableError };
