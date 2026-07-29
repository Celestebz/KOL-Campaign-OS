module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('email_replies')) return;
    const columns = await queryInterface.describeTable('email_replies');
    if (!columns.handled_at) {
      await queryInterface.addColumn('email_replies', 'handled_at', {
        type: Sequelize.DataTypes.DATE,
        allowNull: true,
        comment: 'Time when a reply todo was completed manually'
      });
    }
    if (!columns.handled_by) {
      await queryInterface.addColumn('email_replies', 'handled_by', {
        type: Sequelize.DataTypes.STRING(100),
        allowNull: true,
        comment: 'Operator who completed the reply todo manually'
      });
    }
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('email_replies')) return;
    const columns = await queryInterface.describeTable('email_replies');
    if (columns.handled_by) await queryInterface.removeColumn('email_replies', 'handled_by');
    if (columns.handled_at) await queryInterface.removeColumn('email_replies', 'handled_at');
  }
};
