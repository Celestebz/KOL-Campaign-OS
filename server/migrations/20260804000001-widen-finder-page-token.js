// ScrapeCreators 的 continuationToken 长度远超 YouTube v3 pageToken（实测可达 1KB+），
// finder_search_cache / finder_query_ledger 的 page_token VARCHAR(512) 会写入失败。
// 两列均未建索引，直接放宽为 TEXT。
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (tables.includes('finder_search_cache')) {
      await queryInterface.changeColumn('finder_search_cache', 'page_token', {
        type: Sequelize.DataTypes.TEXT,
        allowNull: false
      });
    }
    if (tables.includes('finder_query_ledger')) {
      await queryInterface.changeColumn('finder_query_ledger', 'page_token', {
        type: Sequelize.DataTypes.TEXT,
        allowNull: false
      });
    }
  },

  async down(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (tables.includes('finder_search_cache')) {
      await queryInterface.changeColumn('finder_search_cache', 'page_token', {
        type: Sequelize.DataTypes.STRING(512),
        allowNull: false,
        defaultValue: ''
      });
    }
    if (tables.includes('finder_query_ledger')) {
      await queryInterface.changeColumn('finder_query_ledger', 'page_token', {
        type: Sequelize.DataTypes.STRING(512),
        allowNull: false,
        defaultValue: ''
      });
    }
  }
};
