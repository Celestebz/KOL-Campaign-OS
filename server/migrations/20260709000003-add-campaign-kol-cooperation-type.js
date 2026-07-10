module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('campaign_kols', 'cooperation_type', {
      type: Sequelize.STRING(50),
      allowNull: false,
      defaultValue: 'paid_product'
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('campaign_kols', 'cooperation_type');
  }
};
