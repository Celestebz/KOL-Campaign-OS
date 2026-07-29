module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('email_replies')) return;
    const columns = await queryInterface.describeTable('email_replies');
    const add = async (name, definition) => {
      if (!columns[name]) await queryInterface.addColumn('email_replies', name, definition);
    };
    await add('classification', { type: Sequelize.DataTypes.STRING(30), allowNull: false, defaultValue: 'needs_review', comment: 'kol_reply/suspected_kol/system/spam/needs_review' });
    await add('classification_source', { type: Sequelize.DataTypes.STRING(20), allowNull: true, comment: 'rule/ai/human/system' });
    await add('classification_reason', { type: Sequelize.DataTypes.TEXT, allowNull: true });
    await add('classified_at', { type: Sequelize.DataTypes.DATE, allowNull: true });
    await add('spam_marked_by', { type: Sequelize.DataTypes.STRING(100), allowNull: true });

    if (!tables.includes('email_filter_rules')) {
      await queryInterface.createTable('email_filter_rules', {
        id: { type: Sequelize.DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        rule_type: { type: Sequelize.DataTypes.STRING(20), allowNull: false, comment: 'sender/domain' },
        rule_value: { type: Sequelize.DataTypes.STRING(320), allowNull: false },
        active: { type: Sequelize.DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        created_by: { type: Sequelize.DataTypes.STRING(100), allowNull: true },
        created_at: { type: Sequelize.DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
      });
      await queryInterface.addIndex('email_filter_rules', ['rule_type', 'rule_value'], { unique: true, name: 'uq_email_filter_rule' });
    }
  },
  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (tables.includes('email_filter_rules')) await queryInterface.dropTable('email_filter_rules');
    if (!tables.includes('email_replies')) return;
    const columns = await queryInterface.describeTable('email_replies');
    for (const name of ['spam_marked_by', 'classified_at', 'classification_reason', 'classification_source', 'classification']) {
      if (columns[name]) await queryInterface.removeColumn('email_replies', name);
    }
  }
};
