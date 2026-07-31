module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('finder_creator_memory')) {
      await queryInterface.createTable('finder_creator_memory', {
        id: { type: Sequelize.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        platform: { type: Sequelize.DataTypes.STRING(40), allowNull: false },
        creator_key: { type: Sequelize.DataTypes.STRING(255), allowNull: false },
        creator_name: { type: Sequelize.DataTypes.STRING(255), allowNull: false, defaultValue: '' },
        profile_url: { type: Sequelize.DataTypes.TEXT, allowNull: false },
        source_query: { type: Sequelize.DataTypes.TEXT, allowNull: false, defaultValue: '' },
        candidate_json: { type: Sequelize.DataTypes.TEXT('long'), allowNull: false },
        memory_status: { type: Sequelize.DataTypes.STRING(40), allowNull: false, defaultValue: 'discovered' },
        rejection_reason: { type: Sequelize.DataTypes.STRING(80), allowNull: false, defaultValue: '' },
        cooldown_until: { type: Sequelize.DataTypes.DATE },
        first_seen_at: { type: Sequelize.DataTypes.DATE, allowNull: false },
        last_seen_at: { type: Sequelize.DataTypes.DATE, allowNull: false },
        last_evaluated_at: { type: Sequelize.DataTypes.DATE },
        created_at: { type: Sequelize.DataTypes.DATE, allowNull: false },
        updated_at: { type: Sequelize.DataTypes.DATE, allowNull: false }
      });
      await queryInterface.addIndex('finder_creator_memory', ['platform', 'creator_key'], {
        unique: true,
        name: 'uniq_finder_creator_memory_identity'
      });
      await queryInterface.addIndex('finder_creator_memory', ['platform', 'memory_status', 'cooldown_until'], {
        name: 'idx_finder_creator_memory_reuse'
      });
    }

    if (!tables.includes('finder_query_cursors')) {
      await queryInterface.createTable('finder_query_cursors', {
        id: { type: Sequelize.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        provider: { type: Sequelize.DataTypes.STRING(80), allowNull: false },
        platform: { type: Sequelize.DataTypes.STRING(40), allowNull: false },
        query_text: { type: Sequelize.DataTypes.TEXT, allowNull: false },
        query_hash: { type: Sequelize.DataTypes.CHAR(64), allowNull: false },
        next_page_token: { type: Sequelize.DataTypes.STRING(512), allowNull: false, defaultValue: '' },
        pages_fetched: { type: Sequelize.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        exhausted: { type: Sequelize.DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        last_requested_at: { type: Sequelize.DataTypes.DATE },
        created_at: { type: Sequelize.DataTypes.DATE, allowNull: false },
        updated_at: { type: Sequelize.DataTypes.DATE, allowNull: false }
      });
      await queryInterface.addIndex('finder_query_cursors', ['provider', 'platform', 'query_hash'], {
        unique: true,
        name: 'uniq_finder_query_cursor'
      });
    }
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (tables.includes('finder_query_cursors')) await queryInterface.dropTable('finder_query_cursors');
    if (tables.includes('finder_creator_memory')) await queryInterface.dropTable('finder_creator_memory');
  }
};
