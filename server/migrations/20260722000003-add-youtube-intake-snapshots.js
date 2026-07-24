/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const customers = await queryInterface.describeTable('customers');
    const fields = {
      youtube_avg_views_30d: Sequelize.DataTypes.BIGINT,
      youtube_median_views_30d: Sequelize.DataTypes.BIGINT,
      youtube_posts_30d: Sequelize.DataTypes.INTEGER,
      youtube_engagement_rate_30d: Sequelize.DataTypes.DECIMAL(12, 8),
      youtube_snapshot_status: Sequelize.DataTypes.STRING(50),
      youtube_snapshot_error: Sequelize.DataTypes.TEXT,
      youtube_snapshot_updated_at: Sequelize.DataTypes.DATE
    };
    for (const [name, type] of Object.entries(fields)) {
      if (!customers[name]) await queryInterface.addColumn('customers', name, { type, allowNull: true });
    }

    const tables = await queryInterface.showAllTables();
    if (!tables.map(String).includes('kol_youtube_snapshot_videos')) {
      await queryInterface.createTable('kol_youtube_snapshot_videos', {
        id: { type: Sequelize.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        customer_id: { type: Sequelize.DataTypes.INTEGER, allowNull: false },
        youtube_video_id: { type: Sequelize.DataTypes.STRING(64), allowNull: false },
        title: { type: Sequelize.DataTypes.TEXT },
        video_url: { type: Sequelize.DataTypes.STRING(1024), allowNull: false },
        published_at: { type: Sequelize.DataTypes.DATE },
        duration_seconds: { type: Sequelize.DataTypes.INTEGER },
        play_count: { type: Sequelize.DataTypes.BIGINT },
        like_count: { type: Sequelize.DataTypes.BIGINT },
        comment_count: { type: Sequelize.DataTypes.BIGINT },
        is_short: { type: Sequelize.DataTypes.BOOLEAN, defaultValue: false },
        is_live: { type: Sequelize.DataTypes.BOOLEAN, defaultValue: false },
        included_in_aggregate: { type: Sequelize.DataTypes.BOOLEAN, defaultValue: true },
        exclusion_reason: { type: Sequelize.DataTypes.STRING(100) },
        snapshot_at: { type: Sequelize.DataTypes.DATE, allowNull: false },
        created_at: { type: Sequelize.DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
      });
      await queryInterface.addIndex('kol_youtube_snapshot_videos', ['customer_id', 'snapshot_at']);
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('kol_youtube_snapshot_videos');
    for (const name of ['youtube_avg_views_30d', 'youtube_median_views_30d', 'youtube_posts_30d', 'youtube_engagement_rate_30d', 'youtube_snapshot_status', 'youtube_snapshot_error', 'youtube_snapshot_updated_at']) {
      await queryInterface.removeColumn('customers', name);
    }
  }
};
