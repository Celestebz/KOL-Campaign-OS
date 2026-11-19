module.exports = (sequelize, D) => sequelize.define('CampaignKolTask', {
  id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
  task_id: { type: D.INTEGER, allowNull: false }, campaign_kol_id: { type: D.INTEGER, allowNull: false },
  review_status: { type: D.STRING(30), allowNull: false, defaultValue: 'pending' },
  cooperation_status: { type: D.STRING(30), allowNull: false, defaultValue: 'candidate' },
  intent: { type: D.STRING(30), allowNull: false, defaultValue: 'unknown' },
  next_follow_up_at: D.DATE, agreed_publish_at: D.DATEONLY, received_at: D.DATEONLY,
  draft_due_at: D.DATEONLY, published_at: D.DATEONLY, video_url: D.STRING(2048), quoted_fee: D.STRING(255), notes: D.TEXT
}, { tableName: 'campaign_kol_tasks', underscored: true,
  indexes: [{ unique: true, fields: ['task_id', 'campaign_kol_id'] }] });
