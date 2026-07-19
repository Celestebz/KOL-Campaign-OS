module.exports = (sequelize, DataTypes) => {
  const RawCandidateProductFit = sequelize.define('RawCandidateProductFit', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    raw_candidate_id: { type: DataTypes.INTEGER, allowNull: false },
    campaign_product_id: { type: DataTypes.INTEGER, allowNull: false },
    identity_key_hash: { type: DataTypes.CHAR(64), allowNull: false }
  }, {
    tableName: 'raw_candidate_product_fits',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['campaign_product_id', 'identity_key_hash'] }
    ]
  });

  RawCandidateProductFit.associate = models => {
    RawCandidateProductFit.belongsTo(models.RawCandidate, { foreignKey: 'raw_candidate_id' });
    RawCandidateProductFit.belongsTo(models.CampaignProduct, { foreignKey: 'campaign_product_id' });
  };

  return RawCandidateProductFit;
};
