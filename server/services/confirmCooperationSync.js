const { dbOperations } = require('../database');
const { getConfig: getSheetConfig, pushToSheet } = require('../routes/feishuSheetSync');
const { getCampaignTrackingTableId } = require('../utils/feishuSubtableMapping');

async function loadConfirmedRow(campaignKolId) {
  return dbOperations.get(
    `SELECT ck.*, c.name AS campaign_name
     FROM campaign_kols ck
     JOIN campaigns c ON c.id = ck.campaign_id
     WHERE ck.id = ?`,
    [campaignKolId]
  );
}

async function syncOrdinarySheetTarget(row, runtime = {}) {
  const getConfig = runtime.getSheetConfig || getSheetConfig;
  const push = runtime.pushToSheet || pushToSheet;
  let config;
  try {
    config = await getConfig('cooperation_tracking', row.campaign_id);
  } catch (error) {
    return null;
  }
  if (!config?.sheetId) return null;
  try {
    const result = await push([row.id], row.campaign_id, 'cooperation_tracking');
    return { type: 'sheet', label: '普通表格', success: true, ...result };
  } catch (error) {
    return { type: 'sheet', label: '普通表格', success: false, error: error.message };
  }
}

async function syncBitableTarget(row, runtime = {}) {
  const syncRoutes = runtime.syncRoutes || require('../routes/sync');
  const getFeishuConfig = runtime.getFeishuConfig || syncRoutes.getFeishuConfig;
  const getToken = runtime.getTenantAccessToken || syncRoutes.getTenantAccessToken;
  const syncRows = runtime.syncCampaignKols || syncRoutes.syncCampaignKols;
  const resolveTableId = runtime.getCampaignTrackingTableId || getCampaignTrackingTableId;
  try {
    const config = await getFeishuConfig();
    const tableId = resolveTableId(config, row);
    if (!tableId) return null;
    const token = await getToken(config);
    const results = await syncRows(config, token, [row.id]);
    const failed = (results || []).find((item) => !item.success);
    if (failed) {
      return { type: 'bitable', label: '多维表格', success: false, error: failed.error || '同步失败' };
    }
    return { type: 'bitable', label: '多维表格', success: true };
  } catch (error) {
    return { type: 'bitable', label: '多维表格', success: false, error: error.message || '同步失败' };
  }
}

async function syncConfirmedToFeishu(campaignKolId, runtime = {}) {
  const loadRow = runtime.loadRow || loadConfirmedRow;
  let row;
  try {
    row = await loadRow(campaignKolId);
  } catch (error) {
    return { targets: [{ type: 'unknown', label: '飞书', success: false, error: error.message || '读取确认记录失败' }] };
  }
  if (!row) return { targets: [] };

  const targets = [];
  try {
    const sheet = await syncOrdinarySheetTarget(row, runtime);
    if (sheet) targets.push(sheet);
  } catch (error) {
    targets.push({ type: 'sheet', label: '普通表格', success: false, error: error.message || '普通表格同步失败' });
  }
  try {
    const bitable = await syncBitableTarget(row, runtime);
    if (bitable) targets.push(bitable);
  } catch (error) {
    targets.push({ type: 'bitable', label: '多维表格', success: false, error: error.message || '多维表格同步失败' });
  }
  return { targets };
}

module.exports = {
  syncConfirmedToFeishu,
  syncOrdinarySheetTarget,
  syncBitableTarget,
  loadConfirmedRow
};
