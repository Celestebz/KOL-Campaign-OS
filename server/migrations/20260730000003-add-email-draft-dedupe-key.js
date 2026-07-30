module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('email_drafts')) return;
    const columns = await queryInterface.describeTable('email_drafts');
    if (!columns.dedupe_key) {
      await queryInterface.addColumn('email_drafts', 'dedupe_key', {
        type: Sequelize.DataTypes.STRING(255),
        allowNull: true,
        comment: 'Stable business key used to prevent concurrent duplicate drafts'
      });
    }
    const indexes = await queryInterface.showIndex('email_drafts');
    if (!indexes.some((index) => index.name === 'uq_email_drafts_dedupe_key')) {
      await queryInterface.addIndex('email_drafts', ['dedupe_key'], {
        unique: true,
        name: 'uq_email_drafts_dedupe_key'
      });
    }
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('email_drafts')) return;
    const indexes = await queryInterface.showIndex('email_drafts');
    if (indexes.some((index) => index.name === 'uq_email_drafts_dedupe_key')) {
      await queryInterface.removeIndex('email_drafts', 'uq_email_drafts_dedupe_key');
    }
    const columns = await queryInterface.describeTable('email_drafts');
    if (columns.dedupe_key) await queryInterface.removeColumn('email_drafts', 'dedupe_key');
  }
};
