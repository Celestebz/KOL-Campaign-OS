module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('campaign_kols');
    const fields = {
      posts_30d_snapshot: Sequelize.DataTypes.INTEGER,
      avg_views_30d_snapshot: Sequelize.DataTypes.BIGINT,
      engagement_rate_30d_snapshot: Sequelize.DataTypes.DECIMAL(12, 8),
      youtube_snapshot_updated_at: Sequelize.DataTypes.DATE
    };
    for (const [name, definition] of Object.entries(fields)) {
      if (!table[name]) await queryInterface.addColumn('campaign_kols', name, definition);
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('campaign_kols');
    for (const name of ['posts_30d_snapshot', 'avg_views_30d_snapshot', 'engagement_rate_30d_snapshot', 'youtube_snapshot_updated_at']) {
      if (table[name]) await queryInterface.removeColumn('campaign_kols', name);
    }
  }
};
