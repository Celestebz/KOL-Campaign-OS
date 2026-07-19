module.exports = (sequelize, DataTypes) => {
  const CampaignKolProduct = sequelize.define('CampaignKolProduct', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    campaign_kol_id: { type: DataTypes.INTEGER, allowNull: false },
    campaign_product_id: { type: DataTypes.INTEGER, allowNull: false }
  }, {
    tableName: 'campaign_kol_products',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['campaign_kol_id', 'campaign_product_id'] }
    ]
  });

  CampaignKolProduct.associate = models => {
    CampaignKolProduct.belongsTo(models.CampaignKol, { foreignKey: 'campaign_kol_id' });
    CampaignKolProduct.belongsTo(models.CampaignProduct, { foreignKey: 'campaign_product_id' });
  };

  return CampaignKolProduct;
};
