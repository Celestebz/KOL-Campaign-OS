module.exports = (sequelize, D) => sequelize.define('CampaignTaskEvent', {
  id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
  kol_task_id: { type: D.INTEGER, allowNull: false }, actor_id: D.INTEGER,
  event_type: { type: D.STRING(50), allowNull: false }, summary: D.TEXT,
  occurred_at: { type: D.DATE, allowNull: false }
}, { tableName: 'campaign_task_events', underscored: true });
