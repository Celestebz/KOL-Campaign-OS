// Separate project candidates from confirmed cooperation while keeping one
// local campaign_kols relationship. Feishu record ids are table-scoped, so the
// candidate-pool and tracking-table ids must be stored independently.
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('campaign_kols')) return;
    const columns = await queryInterface.describeTable('campaign_kols');

    if (!columns.pipeline_stage) {
      await queryInterface.addColumn('campaign_kols', 'pipeline_stage', {
        type: Sequelize.STRING(30), allowNull: false, defaultValue: 'candidate',
        comment: 'candidate=项目候选；confirmed=已确认合作'
      });
    }
    if (!columns.confirmed_at) {
      await queryInterface.addColumn('campaign_kols', 'confirmed_at', {
        type: Sequelize.DATE, allowNull: true, comment: '人工确认合作时间'
      });
    }
    if (!columns.candidate_feishu_record_id) {
      await queryInterface.addColumn('campaign_kols', 'candidate_feishu_record_id', {
        type: Sequelize.STRING(255), allowNull: true, comment: '飞书候选池记录ID'
      });
    }
    if (!columns.tracking_feishu_record_id) {
      await queryInterface.addColumn('campaign_kols', 'tracking_feishu_record_id', {
        type: Sequelize.STRING(255), allowNull: true, comment: '飞书项目跟进表记录ID'
      });
    }

    await queryInterface.sequelize.query(
      `UPDATE campaign_kols
       SET pipeline_stage = 'candidate',
           project_status = 'pending_confirmation',
           confirmed_at = NULL,
           candidate_feishu_record_id = COALESCE(candidate_feishu_record_id, feishu_record_id),
           tracking_feishu_record_id = NULL,
           sync_status = 'sync_pending',
           updated_at = CURRENT_TIMESTAMP`
    );
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('campaign_kols')) return;
    const columns = await queryInterface.describeTable('campaign_kols');
    for (const name of ['tracking_feishu_record_id', 'candidate_feishu_record_id', 'confirmed_at', 'pipeline_stage']) {
      if (columns[name]) await queryInterface.removeColumn('campaign_kols', name);
    }
  }
};
