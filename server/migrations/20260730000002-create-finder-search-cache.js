module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('finder_search_cache')) {
      await queryInterface.createTable('finder_search_cache', {
        id: { type: Sequelize.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        cache_key: { type: Sequelize.DataTypes.CHAR(64), allowNull: false },
        provider: { type: Sequelize.DataTypes.STRING(80), allowNull: false },
        platform: { type: Sequelize.DataTypes.STRING(40), allowNull: false },
        query_text: { type: Sequelize.DataTypes.TEXT, allowNull: false },
        page_token: { type: Sequelize.DataTypes.STRING(512), allowNull: false, defaultValue: '' },
        max_results: { type: Sequelize.DataTypes.INTEGER, allowNull: false },
        response_json: { type: Sequelize.DataTypes.TEXT('long'), allowNull: false },
        result_count: { type: Sequelize.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        hit_count: { type: Sequelize.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        expires_at: { type: Sequelize.DataTypes.DATE, allowNull: false },
        last_hit_at: { type: Sequelize.DataTypes.DATE },
        created_at: { type: Sequelize.DataTypes.DATE, allowNull: false },
        updated_at: { type: Sequelize.DataTypes.DATE, allowNull: false }
      });
      await queryInterface.addIndex('finder_search_cache', ['cache_key'], { unique: true, name: 'uniq_finder_search_cache_key' });
      await queryInterface.addIndex('finder_search_cache', ['provider', 'platform', 'expires_at'], { name: 'idx_finder_search_cache_expiry' });
    }

    if (!tables.includes('finder_query_ledger')) {
      await queryInterface.createTable('finder_query_ledger', {
        id: { type: Sequelize.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        finder_task_id: { type: Sequelize.DataTypes.INTEGER },
        provider: { type: Sequelize.DataTypes.STRING(80), allowNull: false },
        platform: { type: Sequelize.DataTypes.STRING(40), allowNull: false },
        query_text: { type: Sequelize.DataTypes.TEXT, allowNull: false },
        query_hash: { type: Sequelize.DataTypes.CHAR(64), allowNull: false },
        page_token: { type: Sequelize.DataTypes.STRING(512), allowNull: false, defaultValue: '' },
        cache_hit: { type: Sequelize.DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        returned_count: { type: Sequelize.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        excluded_count: { type: Sequelize.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        new_channel_count: { type: Sequelize.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        request_cost: { type: Sequelize.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        status: { type: Sequelize.DataTypes.STRING(30), allowNull: false, defaultValue: 'success' },
        error_message: { type: Sequelize.DataTypes.TEXT },
        created_at: { type: Sequelize.DataTypes.DATE, allowNull: false }
      });
      await queryInterface.addIndex('finder_query_ledger', ['platform', 'query_hash', 'created_at'], { name: 'idx_finder_query_performance' });
      await queryInterface.addIndex('finder_query_ledger', ['finder_task_id', 'created_at'], { name: 'idx_finder_query_task' });
    }
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (tables.includes('finder_query_ledger')) await queryInterface.dropTable('finder_query_ledger');
    if (tables.includes('finder_search_cache')) await queryInterface.dropTable('finder_search_cache');
  }
};
