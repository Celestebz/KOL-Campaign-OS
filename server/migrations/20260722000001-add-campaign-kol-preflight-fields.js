/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('campaign_kols');
    const fields = {
      shipping_address: Sequelize.DataTypes.TEXT,
      expected_publish_at: Sequelize.DataTypes.DATE,
      content_format: Sequelize.DataTypes.TEXT,
      estimated_total_cost_usd: Sequelize.DataTypes.DECIMAL(15, 2),
      median_views_30d_snapshot: Sequelize.DataTypes.BIGINT,
      expected_views: Sequelize.DataTypes.BIGINT,
      estimated_cpm: Sequelize.DataTypes.DECIMAL(15, 2),
      budget_approval_status: Sequelize.DataTypes.STRING(50),
      shipping_date: Sequelize.DataTypes.DATE,
      tracking_number: Sequelize.DataTypes.STRING(255)
    };
    for (const [name, definition] of Object.entries(fields)) {
      if (!table[name]) await queryInterface.addColumn('campaign_kols', name, definition);
    }

    await queryInterface.sequelize.query(
      `UPDATE campaign_kols SET project_status = CASE project_status
        WHEN 'confirmed' THEN 'pending_shipping'
        WHEN 'published' THEN 'published'
        WHEN 'not_fit' THEN 'cancelled'
        ELSE 'pending_confirmation'
       END
       WHERE project_status IN ('candidate', 'to_contact', 'contacted', 'replied', 'no_reply', 'negotiating', 'confirmed', 'published', 'not_fit')`
    );
    await queryInterface.sequelize.query(
      `UPDATE campaign_kols SET priority_level = CASE priority_level
        WHEN 'high' THEN 't1'
        WHEN 'low' THEN 't3'
        ELSE 't2'
       END
       WHERE priority_level IS NULL OR priority_level IN ('', 'high', 'normal', 'low')`
    );
    await queryInterface.changeColumn('campaign_kols', 'project_status', {
      type: Sequelize.DataTypes.STRING(50), allowNull: true, defaultValue: 'pending_confirmation'
    });
    await queryInterface.changeColumn('campaign_kols', 'priority_level', {
      type: Sequelize.DataTypes.STRING(50), allowNull: true, defaultValue: 't2'
    });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('campaign_kols');
    for (const name of [
      'shipping_address', 'expected_publish_at', 'content_format', 'estimated_total_cost_usd',
      'median_views_30d_snapshot', 'expected_views', 'estimated_cpm', 'budget_approval_status',
      'shipping_date', 'tracking_number'
    ]) {
      if (table[name]) await queryInterface.removeColumn('campaign_kols', name);
    }
  }
};
