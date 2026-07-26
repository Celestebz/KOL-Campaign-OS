// 老板工作台阶段 D：automation_runs 后台任务运行记录。
// 设计依据 docs/superpowers/specs/2026-07-25-boss-workbench-upgrade.md 第十一节：
// 长耗时自动化任务（批量邮件起草等）落库运行状态 + 检查点 + 进度，
// 支持失败可见化（工作台异常卡）、只重跑失败项、服务重启后状态可恢复。
// idempotency_key 唯一索引保证同一任务不重复执行（spec 11.3 幂等原则）。
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const tables = (await queryInterface.showAllTables()).map(String);
    if (tables.includes('automation_runs')) return;

    await queryInterface.createTable('automation_runs', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      campaign_id: { type: DataTypes.INTEGER, comment: '项目ID' },
      run_type: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '任务类型：email_draft_batch批量邮件起草等'
      },
      subject_type: { type: DataTypes.STRING(50), comment: '业务对象类型：campaign等' },
      subject_id: { type: DataTypes.INTEGER, comment: '业务对象ID' },
      current_node: { type: DataTypes.STRING(100), comment: '当前执行节点' },
      status: {
        type: DataTypes.ENUM('running', 'success', 'partial_failed', 'failed'),
        allowNull: false,
        defaultValue: 'running',
        comment: '运行状态：running执行中/success全部成功/partial_failed部分失败/failed全部失败或中断'
      },
      checkpoint_json: { type: DataTypes.JSON, comment: '检查点：已完成条目及每条结果 {done_customer_ids[], items[{customer_id,kind,ok,draft_id,error}]}，用于只重跑失败项' },
      progress_json: { type: DataTypes.JSON, comment: '进度快照：{total,completed,succeeded,failed}' },
      retry_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, comment: '已重试次数' },
      max_retries: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3, comment: '最大重试次数' },
      last_error: { type: DataTypes.TEXT, comment: '最近一次错误信息（含服务重启中断标记）' },
      started_at: { type: DataTypes.DATE, comment: '开始时间' },
      finished_at: { type: DataTypes.DATE, comment: '结束时间' },
      locked_at: { type: DataTypes.DATE, comment: '锁定时间（预留：多实例抢占执行）' },
      idempotency_key: { type: DataTypes.STRING(255), comment: '幂等键：同一任务唯一，避免重复执行' },
      created_at: { type: DataTypes.DATE, comment: '创建时间' },
      updated_at: { type: DataTypes.DATE, comment: '更新时间' }
    });
    await queryInterface.addIndex('automation_runs', ['idempotency_key'], {
      unique: true,
      name: 'automation_runs_idempotency_key_unique'
    });
    await queryInterface.addIndex('automation_runs', ['status'], { name: 'automation_runs_status' });
    await queryInterface.addIndex('automation_runs', ['campaign_id'], { name: 'automation_runs_campaign_id' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('automation_runs', { cascade: true }).catch(() => {});
  }
};
