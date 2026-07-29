module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (tables.includes('agent_api_requests')) return;
    await queryInterface.createTable('agent_api_requests', {
      id: { type: Sequelize.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      idempotency_key: { type: Sequelize.DataTypes.STRING(255), allowNull: false },
      operation: { type: Sequelize.DataTypes.STRING(80), allowNull: false },
      campaign_id: { type: Sequelize.DataTypes.INTEGER },
      request_hash: { type: Sequelize.DataTypes.STRING(64), allowNull: false },
      response_json: { type: Sequelize.DataTypes.TEXT('long') },
      status: { type: Sequelize.DataTypes.STRING(20), allowNull: false, defaultValue: 'running' },
      created_at: { type: Sequelize.DataTypes.DATE, allowNull: false },
      completed_at: { type: Sequelize.DataTypes.DATE }
    });
    await queryInterface.addIndex('agent_api_requests', ['operation', 'idempotency_key'], {
      unique: true,
      name: 'uniq_agent_api_operation_key'
    });
    await queryInterface.addIndex('agent_api_requests', ['campaign_id', 'created_at']);
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (tables.includes('agent_api_requests')) {
      await queryInterface.dropTable('agent_api_requests');
    }
  }
};
