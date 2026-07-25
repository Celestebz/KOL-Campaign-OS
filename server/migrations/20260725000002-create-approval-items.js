// 老板工作台阶段 C：统一审核数据模型 approval_items。
// 设计依据 docs/superpowers/specs/2026-07-25-boss-workbench-upgrade.md 第九节：
// 六类审核（strategy/candidate/outreach/reply/budget/exception）共用一张表，
// facts/opinion/risks/actions 保存审批时快照，dedupe_key 保证同一待办重复扫描不重复建行，
// version 用于乐观并发控制（老板基于旧版本提交决定时返回 409）。
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const tables = (await queryInterface.showAllTables()).map(String);
    if (tables.includes('approval_items')) return;

    await queryInterface.createTable('approval_items', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      campaign_id: { type: DataTypes.INTEGER, comment: '项目ID' },
      type: {
        type: DataTypes.ENUM('strategy', 'candidate', 'outreach', 'reply', 'budget', 'exception'),
        allowNull: false,
        comment: '审核类型：strategy策略/candidate候选达人/outreach触达邮件/reply达人回复/budget预算/exception异常'
      },
      subject_type: {
        type: DataTypes.STRING(50),
        comment: '业务对象类型：kol_strategy/campaign_kol/email_draft/email_reply/finder'
      },
      subject_id: { type: DataTypes.INTEGER, comment: '业务对象ID' },
      status: {
        type: DataTypes.ENUM('pending', 'approved', 'rejected', 'cancelled'),
        allowNull: false,
        defaultValue: 'pending',
        comment: '审核状态：pending待审核/approved已批准/rejected已驳回/cancelled已取消'
      },
      priority: { type: DataTypes.STRING(20), defaultValue: 'none', comment: '优先级（沿用风险等级口径）：none/low/high' },
      facts_json: { type: DataTypes.JSON, comment: '事实快照：{title,campaign_name,facts[]}，含卡片标题与项目名' },
      opinion_json: { type: DataTypes.JSON, comment: 'AI观点快照（字符串）' },
      risks_json: { type: DataTypes.JSON, comment: '风险快照（字符串数组）' },
      actions_json: { type: DataTypes.JSON, comment: '行动快照 [{key,label,href}]' },
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, comment: '快照版本号：源数据变化或要求修改时+1，提交决定需携带' },
      decision: {
        type: DataTypes.STRING(20),
        comment: '人工决定：approve/reject/request_changes/pause/retry/skip/stop；source_gone表示源数据消失自动取消'
      },
      decision_note: { type: DataTypes.TEXT, comment: '决定备注' },
      decided_by: { type: DataTypes.STRING(100), comment: '决定人' },
      decided_at: { type: DataTypes.DATE, comment: '决定时间' },
      dedupe_key: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: '去重键：{type}:{subject_type}:{subject_id}，如 outreach:email_draft:12、exception:finder:7'
      },
      created_at: { type: DataTypes.DATE, comment: '创建时间' },
      updated_at: { type: DataTypes.DATE, comment: '更新时间' }
    });
    await queryInterface.addIndex('approval_items', ['dedupe_key'], {
      unique: true,
      name: 'approval_items_dedupe_key_unique'
    });
    await queryInterface.addIndex('approval_items', ['status', 'type'], { name: 'approval_items_status_type' });
    await queryInterface.addIndex('approval_items', ['campaign_id'], { name: 'approval_items_campaign_id' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('approval_items', { cascade: true }).catch(() => {});
  }
};
