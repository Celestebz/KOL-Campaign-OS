/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const customers = await queryInterface.describeTable('customers');
    for (const platform of ['instagram', 'tiktok']) {
      const fields = {
        [platform + '_avg_views_10']: Sequelize.DataTypes.BIGINT,
        [platform + '_median_views_10']: Sequelize.DataTypes.BIGINT,
        [platform + '_posts_10']: Sequelize.DataTypes.INTEGER,
        [platform + '_engagement_rate_10']: Sequelize.DataTypes.DECIMAL(12, 8),
        [platform + '_snapshot_status']: Sequelize.DataTypes.STRING(50),
        [platform + '_snapshot_error']: Sequelize.DataTypes.TEXT,
        [platform + '_snapshot_updated_at']: Sequelize.DataTypes.DATE
      };
      for (const [name, type] of Object.entries(fields)) {
        if (!customers[name]) await queryInterface.addColumn('customers', name, { type, allowNull: true });
      }
    }
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('kol_social_snapshot_videos')) {
      await queryInterface.createTable('kol_social_snapshot_videos', {
        id: { type: Sequelize.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        customer_id: { type: Sequelize.DataTypes.INTEGER, allowNull: false },
        platform: { type: Sequelize.DataTypes.STRING(30), allowNull: false },
        platform_video_id: { type: Sequelize.DataTypes.STRING(255), allowNull: false },
        title: Sequelize.DataTypes.TEXT,
        video_url: { type: Sequelize.DataTypes.STRING(1024), allowNull: false },
        published_at: Sequelize.DataTypes.DATE,
        play_count: Sequelize.DataTypes.BIGINT,
        like_count: Sequelize.DataTypes.BIGINT,
        comment_count: Sequelize.DataTypes.BIGINT,
        snapshot_at: { type: Sequelize.DataTypes.DATE, allowNull: false },
        created_at: { type: Sequelize.DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
      });
      await queryInterface.addIndex('kol_social_snapshot_videos', ['customer_id', 'platform', 'snapshot_at'], { name: 'idx_kol_social_snapshot' });
    }
  },
  async down(queryInterface) {
    await queryInterface.dropTable('kol_social_snapshot_videos');
    for (const platform of ['instagram', 'tiktok']) {
      for (const suffix of ['avg_views_10', 'median_views_10', 'posts_10', 'engagement_rate_10', 'snapshot_status', 'snapshot_error', 'snapshot_updated_at']) {
        await queryInterface.removeColumn('customers', platform + '_' + suffix);
      }
    }
  }
};
