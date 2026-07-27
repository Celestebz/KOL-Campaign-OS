// 修复 20260727000005 的映射写入问题：原配置中 campaign_subtable_map 是
// JSON 字符串，被对象展开污染成字符索引键。本迁移把映射规范化为只含
// 数字 Campaign ID → tbl 表 ID 的干净对象，并确保当前项目（2/3/59）
// 都指向统一候选池 tblhk2nDkERA6jM4。
const UNIFIED_POOL_TABLE_ID = 'tblhk2nDkERA6jM4';

function normalizeSubtableMap(value) {
  let map = value;
  if (typeof map === 'string') {
    try { map = JSON.parse(map); } catch (error) { map = {}; }
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) map = {};
  const clean = {};
  for (const [key, tableId] of Object.entries(map)) {
    if (/^\d+$/.test(key) && typeof tableId === 'string' && tableId.startsWith('tbl')) {
      clean[key] = tableId;
    }
  }
  return clean;
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const [configRows] = await sequelize.query(
      `SELECT extra_config FROM api_settings WHERE provider = 'cloud.feishu_bitable'`
    );
    if (!configRows.length) return;

    const extra = JSON.parse(configRows[0].extra_config || '{}');
    const map = normalizeSubtableMap(extra.campaign_subtable_map);
    // 所有当前项目（active_project）都必须映射到统一候选池
    const [activeCampaigns] = await sequelize.query(
      `SELECT id FROM campaigns WHERE campaign_type = 'active_project'`
    );
    for (const row of activeCampaigns) {
      map[String(row.id)] = UNIFIED_POOL_TABLE_ID;
    }
    extra.campaign_subtable_map = map;
    await sequelize.query(
      `UPDATE api_settings SET extra_config = ? WHERE provider = 'cloud.feishu_bitable'`,
      { replacements: [JSON.stringify(extra)] }
    );
    console.log(`[migration] campaign_subtable_map 规范化完成: ${JSON.stringify(map)}`);
  },

  async down() {
    // 映射修复不需要回滚
  }
};
