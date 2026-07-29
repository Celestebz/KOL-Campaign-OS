module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('campaign_kols')) return;

    const columns = await queryInterface.describeTable('campaign_kols');
    if (!columns.needs_reply) {
      await queryInterface.addColumn('campaign_kols', 'needs_reply', {
        type: Sequelize.DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Whether the latest email turn requires our reply'
      });
    }
    if (!columns.last_inbound_at) {
      await queryInterface.addColumn('campaign_kols', 'last_inbound_at', {
        type: Sequelize.DataTypes.DATE,
        allowNull: true,
        comment: 'Most recent matched inbound email time'
      });
    }

    await queryInterface.sequelize.query(
      `UPDATE campaign_kols
       SET needs_reply = 1, outreach_status = 'negotiating'
       WHERE outreach_status IN ('waiting_reply', 'replied')`
    );
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('campaign_kols')) return;
    const columns = await queryInterface.describeTable('campaign_kols');
    if (columns.last_inbound_at) await queryInterface.removeColumn('campaign_kols', 'last_inbound_at');
    if (columns.needs_reply) await queryInterface.removeColumn('campaign_kols', 'needs_reply');
  }
};
