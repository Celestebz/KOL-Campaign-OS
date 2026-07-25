// 供应商 payload 超过 TEXT(64KB)/MEDIUMTEXT(16MB) 导致导入失败（如 TikTok finder 报
// Data too long for column 'raw_data'）。统一把所有 raw_data 列扩为 LONGTEXT。
const TABLES = ['finder_video_evidence', 'kol_platform_accounts', 'raw_candidates', 'video_comments', 'video_snapshots'];

module.exports = {
  async up(queryInterface) {
    const existing = (await queryInterface.showAllTables()).map(String);
    for (const table of TABLES) {
      if (!existing.includes(table)) continue;
      const columns = await queryInterface.describeTable(table);
      if (!columns.raw_data) continue;
      await queryInterface.sequelize.query(
        `ALTER TABLE \`${table}\` MODIFY COLUMN \`raw_data\` LONGTEXT NULL COMMENT '供应商原始返回payload'`
      );
    }
  },

  async down(queryInterface) {
    const existing = (await queryInterface.showAllTables()).map(String);
    for (const table of TABLES) {
      if (!existing.includes(table)) continue;
      const columns = await queryInterface.describeTable(table);
      if (!columns.raw_data) continue;
      // 回退统一为 MEDIUMTEXT，避免数据截断报错。
      await queryInterface.sequelize.query(
        `ALTER TABLE \`${table}\` MODIFY COLUMN \`raw_data\` MEDIUMTEXT NULL COMMENT '供应商原始返回payload'`
      );
    }
  }
};
