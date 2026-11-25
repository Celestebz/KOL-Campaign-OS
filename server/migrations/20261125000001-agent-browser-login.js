module.exports = {
  async up(q, S) {
    const owner = () => ({ type: S.INTEGER, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' });
    await q.createTable('agent_login_devices', {
      id: { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      device_hash: { type: S.STRING(64), allowNull: false, unique: true },
      user_code_hash: { type: S.STRING(64), allowNull: false, unique: true },
      challenge: { type: S.STRING(43), allowNull: false },
      label: { type: S.STRING(100), allowNull: false },
      status: { type: S.STRING(16), allowNull: false, defaultValue: 'pending' },
      owner_user_id: owner(),
      expires_at: { type: S.DATE, allowNull: false },
      last_poll_at: { type: S.DATE, allowNull: true },
      created_at: { type: S.DATE, allowNull: false }
    });
    await q.addIndex('agent_login_devices', ['expires_at']);
    await q.createTable('agent_login_grants', {
      id: { type: S.INTEGER, primaryKey: true, autoIncrement: true },
      owner_user_id: { ...owner(), allowNull: false },
      token_version: { type: S.INTEGER, allowNull: false },
      label: { type: S.STRING(100), allowNull: false },
      access_hash: { type: S.STRING(64), allowNull: false, unique: true },
      refresh_hash: { type: S.STRING(64), allowNull: false, unique: true },
      access_expires_at: { type: S.DATE, allowNull: false },
      refresh_expires_at: { type: S.DATE, allowNull: false },
      revoked_at: { type: S.DATE, allowNull: true },
      created_at: { type: S.DATE, allowNull: false }
    });
    await q.addIndex('agent_login_grants', ['owner_user_id', 'revoked_at']);
  },
  async down(q) {
    await q.dropTable('agent_login_grants');
    await q.dropTable('agent_login_devices');
  }
};
