module.exports = (sequelize, D) => sequelize.define('CampaignTask', {
  id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
  campaign_id: { type: D.INTEGER, allowNull: false }, name: { type: D.STRING(255), allowNull: false },
  task_type: { type: D.STRING(30), allowNull: false, defaultValue: 'recruitment' },
  status: { type: D.STRING(30), allowNull: false, defaultValue: 'active' },
  priority: { type: D.INTEGER, allowNull: false, defaultValue: 0 }, owner: D.STRING(255),
  approval_due_at: D.DATEONLY, publish_from: D.DATEONLY, publish_due_at: D.DATEONLY,
  sample_min: D.INTEGER, sample_max: D.INTEGER, candidate_target: D.INTEGER, requirements: D.TEXT, import_key: D.STRING(64)
}, { tableName: 'campaign_tasks', underscored: true });
