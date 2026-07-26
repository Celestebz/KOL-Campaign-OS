// 老板工作台阶段 D2（spec 第十一节“任务失败恢复”）：finder_tasks 增加 checkpoint_json。
// 记录搜索/导入/分析/候选各节点进度，供失败后断点续跑（已完成节点不重跑）与服务重启恢复。
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('finder_tasks')) return;
    const columns = await queryInterface.describeTable('finder_tasks');
    if (columns.checkpoint_json) return;
    await queryInterface.addColumn('finder_tasks', 'checkpoint_json', {
      type: Sequelize.JSON,
      allowNull: true,
      comment: '断点续跑检查点：{search_completed, search_candidates, videos_imported, imported_video_urls, import_failures, videos_analyzed, failed_video_ids, candidates_generated, updated_at}'
    });
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('finder_tasks')) return;
    const columns = await queryInterface.describeTable('finder_tasks');
    if (!columns.checkpoint_json) return;
    await queryInterface.removeColumn('finder_tasks', 'checkpoint_json');
  }
};
