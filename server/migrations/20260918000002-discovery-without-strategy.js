module.exports = {
  async up(q, S) {
    await q.changeColumn('discovery_requests', 'strategy_id', { type: S.DataTypes.INTEGER, allowNull: true });
    await q.addColumn('discovery_requests', 'context_json', { type: S.DataTypes.TEXT('long'), allowNull: true });
  },
  async down() { throw new Error('Strategy-free requests cannot be converted to mandatory strategies; retain this additive schema on release rollback.'); }
};
