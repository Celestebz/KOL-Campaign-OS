module.exports = {
  async up(queryInterface) {
    const table = await queryInterface.describeTable('campaign_kols');
    if (table.product_value) await queryInterface.removeColumn('campaign_kols', 'product_value');
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('campaign_kols', 'product_value', {
      type: Sequelize.STRING(255),
      allowNull: true
    });
  }
};
