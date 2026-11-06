module.exports = {
  async up(q, Sequelize) {
    const D = Sequelize.DataTypes;
    const drafts = await q.describeTable('email_drafts');
    for (const name of ['campaign_id', 'customer_id']) {
      if (!drafts[name].allowNull) await q.changeColumn('email_drafts', name, { type: D.INTEGER, allowNull: true });
    }
    const settings = await q.describeTable('email_settings');
    if (!settings.last_unread_scan_at) await q.addColumn('email_settings', 'last_unread_scan_at', { type: D.DATE, allowNull: true });
    if (!settings.unread_scan_error) await q.addColumn('email_settings', 'unread_scan_error', { type: D.STRING(255), allowNull: true });
  },
  async down() { throw new Error('保留陌生来信草稿及同步记录，不自动收紧非空约束。'); }
};
