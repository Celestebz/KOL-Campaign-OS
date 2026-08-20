module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (!tables.includes('app_bootstrap_state')) {
      await queryInterface.createTable('app_bootstrap_state', {
        id: { type: Sequelize.INTEGER, primaryKey: true },
        initialized: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
      });
    }

    const [stateRows] = await queryInterface.sequelize.query(
      'SELECT id FROM app_bootstrap_state WHERE id = 1 LIMIT 1'
    );
    if (!stateRows.length) {
      const [userRows] = await queryInterface.sequelize.query('SELECT COUNT(*) AS count FROM users');
      await queryInterface.bulkInsert('app_bootstrap_state', [{
        id: 1,
        initialized: Number(userRows[0]?.count || 0) > 0,
        updated_at: new Date()
      }]);
    }
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('app_bootstrap_state')) {
      await queryInterface.dropTable('app_bootstrap_state');
    }
  }
};
