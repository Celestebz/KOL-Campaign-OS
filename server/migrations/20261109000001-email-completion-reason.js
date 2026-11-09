module.exports = {
  async up(q, Sequelize) {
    const columns = await q.describeTable('email_replies');
    if (!columns.completion_reason) await q.addColumn('email_replies', 'completion_reason', {
      type: Sequelize.DataTypes.STRING(30), allowNull: true
    });
  },
  async down(q) { await q.removeColumn('email_replies', 'completion_reason'); }
};
