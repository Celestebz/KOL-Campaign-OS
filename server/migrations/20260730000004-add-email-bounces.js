module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('email_replies')) return;

    const replyColumns = await queryInterface.describeTable('email_replies');
    if (!replyColumns.system_mail_type) {
      await queryInterface.addColumn('email_replies', 'system_mail_type', {
        type: Sequelize.DataTypes.STRING(30),
        allowNull: true,
        comment: 'bounce/auto_reply/other_system'
      });
    }

    if (!tables.includes('email_bounces')) {
      await queryInterface.createTable('email_bounces', {
        id: { type: Sequelize.DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        email_reply_id: { type: Sequelize.DataTypes.INTEGER, allowNull: false, comment: '退信通知邮件ID' },
        email_record_id: { type: Sequelize.DataTypes.INTEGER, allowNull: true, comment: '对应发送记录ID' },
        campaign_id: { type: Sequelize.DataTypes.INTEGER, allowNull: true },
        customer_id: { type: Sequelize.DataTypes.INTEGER, allowNull: true },
        recipient: { type: Sequelize.DataTypes.STRING(320), allowNull: true, comment: '原始收件人' },
        bounce_type: { type: Sequelize.DataTypes.STRING(20), allowNull: false, defaultValue: 'unknown', comment: 'hard/soft/unknown' },
        status_code: { type: Sequelize.DataTypes.STRING(30), allowNull: true, comment: 'SMTP/DSN状态码' },
        reason: { type: Sequelize.DataTypes.TEXT, allowNull: true },
        received_at: { type: Sequelize.DataTypes.DATE, allowNull: true },
        created_at: { type: Sequelize.DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
      });
      await queryInterface.addIndex('email_bounces', ['email_reply_id'], { unique: true, name: 'uq_email_bounces_reply' });
      await queryInterface.addIndex('email_bounces', ['email_record_id'], { name: 'idx_email_bounces_record' });
      await queryInterface.addIndex('email_bounces', ['received_at'], { name: 'idx_email_bounces_received' });
    }
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (tables.includes('email_bounces')) await queryInterface.dropTable('email_bounces');
    if (!tables.includes('email_replies')) return;
    const columns = await queryInterface.describeTable('email_replies');
    if (columns.system_mail_type) await queryInterface.removeColumn('email_replies', 'system_mail_type');
  }
};
