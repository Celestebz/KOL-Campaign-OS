module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('campaign_kols');
    if (!table.cooperation_platforms) {
      await queryInterface.addColumn('campaign_kols', 'cooperation_platforms', {
        type: Sequelize.DataTypes.TEXT,
        allowNull: true
      });
    }

    await queryInterface.sequelize.query(`
      UPDATE campaign_kols ck
      LEFT JOIN kol_platform_accounts kpa ON kpa.id = ck.platform_account_id
      SET ck.cooperation_platforms = JSON_ARRAY(
        COALESCE(NULLIF(kpa.platform, ''), NULLIF(ck.target_platform, ''), 'YouTube')
      )
      WHERE ck.cooperation_platforms IS NULL OR ck.cooperation_platforms = ''
    `);
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('campaign_kols');
    if (table.cooperation_platforms) {
      await queryInterface.removeColumn('campaign_kols', 'cooperation_platforms');
    }
  }
};
