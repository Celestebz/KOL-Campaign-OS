module.exports = {
  async up(q, Sequelize) {
    const columns = await q.describeTable('video_sources');
    if (!columns.cooperation_amount) await q.addColumn('video_sources', 'cooperation_amount', { type: Sequelize.DECIMAL(14, 2), allowNull: true });
    if (!columns.cooperation_currency) await q.addColumn('video_sources', 'cooperation_currency', { type: Sequelize.STRING(3), allowNull: true });
  },
  async down(q) {
    await q.removeColumn('video_sources', 'cooperation_currency');
    await q.removeColumn('video_sources', 'cooperation_amount');
  }
};
