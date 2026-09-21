module.exports = (sequelize, D) => sequelize.define('DiscoveryRequest', {
  id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
  owner_user_id: { type: D.INTEGER, allowNull: false },
  request_key: { type: D.STRING(80), allowNull: false },
  campaign_id: D.INTEGER,
  campaign_product_id: D.INTEGER,
  strategy_id: D.INTEGER,
  finder_task_id: D.INTEGER,
  target_platform: D.STRING(20),
  target_count: D.INTEGER,
  requirements: D.TEXT,
  context_json: D.TEXT('long'),
  status: { type: D.STRING(20), defaultValue: 'queued' },
  stage: { type: D.STRING(30), defaultValue: 'waiting' },
  execution_id: D.STRING(80),
  progress_note: D.TEXT,
  heartbeat_at: D.DATE
}, { tableName: 'discovery_requests', timestamps: true, underscored: true,
  indexes: [{ unique: true, fields: ['owner_user_id', 'request_key'] }] });
