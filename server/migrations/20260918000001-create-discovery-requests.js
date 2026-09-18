module.exports = {
  async up(q, Sequelize) {
    const D = Sequelize.DataTypes;
    await q.createTable('discovery_requests', {
      id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
      owner_user_id: { type: D.INTEGER, allowNull: false },
      request_key: { type: D.STRING(80), allowNull: false },
      campaign_id: { type: D.INTEGER, allowNull: false },
      campaign_product_id: { type: D.INTEGER, allowNull: false },
      strategy_id: { type: D.INTEGER, allowNull: false },
      finder_task_id: { type: D.INTEGER },
      target_platform: { type: D.STRING(20), allowNull: false },
      target_count: { type: D.INTEGER, allowNull: false },
      requirements: { type: D.TEXT, allowNull: false },
      status: { type: D.STRING(20), allowNull: false, defaultValue: 'queued' },
      stage: { type: D.STRING(30), allowNull: false, defaultValue: 'waiting' },
      execution_id: { type: D.STRING(80) },
      progress_note: { type: D.TEXT },
      heartbeat_at: { type: D.DATE },
      created_at: { type: D.DATE, allowNull: false },
      updated_at: { type: D.DATE, allowNull: false }
    });
    await q.addIndex('discovery_requests', ['owner_user_id', 'request_key'], { unique: true, name: 'discovery_request_idempotency' });
    await q.addIndex('discovery_requests', ['owner_user_id', 'status', 'id'], { name: 'discovery_request_queue' });
  },
  async down(q) { await q.dropTable('discovery_requests'); }
};
