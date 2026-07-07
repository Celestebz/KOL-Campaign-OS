module.exports = (sequelize, DataTypes) => {
  const Campaign = sequelize.define('Campaign', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(255), allowNull: false },
    brand: DataTypes.STRING(255),
    product: DataTypes.STRING(255),
    brand_keywords: DataTypes.TEXT,
    purchase_keywords: DataTypes.TEXT,
    negative_keywords: DataTypes.TEXT
  }, {
    tableName: 'campaigns',
    timestamps: true,
    underscored: true
  });

  Campaign.associate = models => {
    Campaign.hasMany(models.KolStrategy, { foreignKey: 'campaign_id', onDelete: 'CASCADE' });
    Campaign.hasMany(models.CampaignKol, { foreignKey: 'campaign_id', onDelete: 'CASCADE' });
    Campaign.hasMany(models.CampaignVideo, { foreignKey: 'campaign_id', onDelete: 'CASCADE' });
  };

  return Campaign;
};
