module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('app_bootstrap_state', {
      id: { type: Sequelize.INTEGER, primaryKey: true },
      initialized: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
    await queryInterface.bulkInsert('app_bootstrap_state', [{ id: 1, initialized: false, updated_at: new Date() }]);
    await queryInterface.createTable('users', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      username: { type: Sequelize.STRING(50), allowNull: false, unique: true },
      display_name: { type: Sequelize.STRING(100), allowNull: false },
      password_hash: { type: Sequelize.STRING(255), allowNull: false },
      role: { type: Sequelize.ENUM('admin', 'member'), allowNull: false, defaultValue: 'member' },
      status: { type: Sequelize.ENUM('active', 'disabled'), allowNull: false, defaultValue: 'active' },
      token_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      last_login_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
    await queryInterface.createTable('invite_codes', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      code: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      note: { type: Sequelize.STRING(255), allowNull: true },
      max_uses: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      used_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      revoked_at: { type: Sequelize.DATE, allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT' },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
    await queryInterface.addIndex('invite_codes', ['expires_at', 'revoked_at'], { name: 'idx_invite_codes_validity' });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('invite_codes');
    await queryInterface.dropTable('users');
    await queryInterface.dropTable('app_bootstrap_state');
  }
};
