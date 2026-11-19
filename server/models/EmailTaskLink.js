module.exports = (sequelize, D) => sequelize.define('EmailTaskLink', {
  id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
  draft_id: { type: D.INTEGER, allowNull: false }, kol_task_id: { type: D.INTEGER, allowNull: false },
  snapshot: { type: D.TEXT, allowNull: false }
}, { tableName: 'email_task_links', underscored: true,
  indexes: [{ unique: true, fields: ['draft_id', 'kol_task_id'] }] });
