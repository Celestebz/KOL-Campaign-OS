module.exports = (sequelize, DataTypes) => {
  const CampaignProduct = sequelize.define('CampaignProduct', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    campaign_id: { type: DataTypes.INTEGER, allowNull: false },
    product_id: { type: DataTypes.INTEGER, allowNull: false },
    role: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'primary' },
    priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    campaign_brief: DataTypes.TEXT,
    status: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'active' }
  }, {
    tableName: 'campaign_products',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['campaign_id', 'product_id'] }
    ]
  });

  CampaignProduct.associate = models => {
    CampaignProduct.belongsTo(models.Campaign, { foreignKey: 'campaign_id' });
    CampaignProduct.belongsTo(models.Product, { foreignKey: 'product_id' });
    CampaignProduct.hasMany(models.RawCandidateProductFit, { foreignKey: 'campaign_product_id' });
    CampaignProduct.hasMany(models.CampaignKolProduct, { foreignKey: 'campaign_product_id' });
    CampaignProduct.hasMany(models.KolStrategy, { foreignKey: 'campaign_product_id' });
    CampaignProduct.hasMany(models.FinderTask, { foreignKey: 'campaign_product_id' });
  };

  return CampaignProduct;
};
