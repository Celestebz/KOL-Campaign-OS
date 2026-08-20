// 支撑项目候选池/合作区按项目、阶段和优先级稳定分页，避免宽行 filesort。
module.exports = {
  async up(queryInterface) {
    const [indexes] = await queryInterface.sequelize.query(
      "SHOW INDEX FROM campaign_kols WHERE Key_name = 'idx_campaign_kols_stage_priority'"
    );
    if (!indexes.length) {
      await queryInterface.sequelize.query(
        `CREATE INDEX idx_campaign_kols_stage_priority
         ON campaign_kols (campaign_id, pipeline_stage, candidate_priority_score DESC, created_at DESC, id DESC)`
      );
    }
  },

  async down(queryInterface) {
    const [indexes] = await queryInterface.sequelize.query(
      "SHOW INDEX FROM campaign_kols WHERE Key_name = 'idx_campaign_kols_stage_priority'"
    );
    if (indexes.length) {
      await queryInterface.removeIndex('campaign_kols', 'idx_campaign_kols_stage_priority');
    }
  }
};
