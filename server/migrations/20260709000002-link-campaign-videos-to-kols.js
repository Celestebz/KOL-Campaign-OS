module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('campaign_videos', 'campaign_kol_id', {
      type: Sequelize.INTEGER,
      allowNull: true
    });
    await queryInterface.addConstraint('campaign_videos', {
      fields: ['campaign_kol_id'],
      type: 'foreign key',
      name: 'fk_campaign_videos_campaign_kol',
      references: { table: 'campaign_kols', field: 'id' },
      onDelete: 'SET NULL'
    });
    await queryInterface.addIndex('campaign_videos', ['campaign_kol_id'], {
      name: 'idx_campaign_videos_campaign_kol'
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex('campaign_videos', 'idx_campaign_videos_campaign_kol');
    await queryInterface.removeConstraint('campaign_videos', 'fk_campaign_videos_campaign_kol');
    await queryInterface.removeColumn('campaign_videos', 'campaign_kol_id');
  }
};
