module.exports = (sequelize, DataTypes) => {
  const CampaignKolProduct = sequelize.define('CampaignKolProduct', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    campaign_kol_id: { type: DataTypes.INTEGER, allowNull: false },
    campaign_product_id: { type: DataTypes.INTEGER, allowNull: false },
    source_raw_candidate_product_fit_id: DataTypes.INTEGER,
    fit_score: DataTypes.INTEGER,
    fit_status: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'pending' },
    evidence_summary: DataTypes.TEXT,
    assignment_status: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'active' },
    quoted_fee: DataTypes.STRING(255),
    sample_status: DataTypes.STRING(50),
    deliverables: DataTypes.TEXT,
    content_status: DataTypes.STRING(50),
    result_summary: DataTypes.TEXT
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
    CampaignKolProduct.belongsTo(models.RawCandidateProductFit, {
      foreignKey: 'source_raw_candidate_product_fit_id'
    });
  };

  return CampaignKolProduct;
};
