module.exports = (sequelize, D) => sequelize.define('CampaignTaskProduct', {
  id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
  task_id: { type: D.INTEGER, allowNull: false }, campaign_product_id: { type: D.INTEGER, allowNull: false }
}, { tableName: 'campaign_task_products', underscored: true,
  indexes: [{ unique: true, fields: ['task_id', 'campaign_product_id'] }] });
