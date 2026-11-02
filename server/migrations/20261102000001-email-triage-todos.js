module.exports = {
  async up(q, Sequelize) {
    const D = Sequelize.DataTypes;
    const columns = await q.describeTable('email_replies');
    const additions = {
      delivery_key: { type: D.STRING(64), allowNull: true },
      mail_seen: { type: D.BOOLEAN, allowNull: true },
      todo_status: { type: D.STRING(20), allowNull: false, defaultValue: 'excluded' },
      todo_enqueued_at: { type: D.DATE, allowNull: true },
      todo_completed_at: { type: D.DATE, allowNull: true },
      triage_status: { type: D.STRING(20), allowNull: true },
      triage_attempts: { type: D.INTEGER, allowNull: false, defaultValue: 0 },
      triage_lease: { type: D.STRING(64), allowNull: true },
      triage_lease_until: { type: D.DATE, allowNull: true },
      triage_retry_at: { type: D.DATE, allowNull: true },
      business_category: { type: D.STRING(40), allowNull: true },
      business_priority: { type: D.STRING(20), allowNull: true },
      triage_reason: { type: D.TEXT, allowNull: true },
      suggested_action: { type: D.TEXT, allowNull: true }
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!columns[name]) await q.addColumn('email_replies', name, definition);
    }
    const indexes = await q.showIndex('email_replies');
    if (!indexes.some(i => i.name === 'email_delivery_key_unique')) {
      await q.addIndex('email_replies', ['delivery_key'], { unique: true, name: 'email_delivery_key_unique' });
    }
    // Message-ID can legitimately occur in different users' mailboxes.
    if (indexes.some(i => i.name === 'uniq_email_replies_message_id')) {
      await q.removeIndex('email_replies', 'uniq_email_replies_message_id');
    }
    if (!indexes.some(i => i.name === 'email_todo_owner_status')) {
      await q.addIndex('email_replies', ['owner_user_id', 'todo_status', 'received_at'], { name: 'email_todo_owner_status' });
    }
  },
  async down() {
    throw new Error('邮件待办迁移保留处理记录，不支持自动回滚；请切回兼容旧代码的 release。');
  }
};
