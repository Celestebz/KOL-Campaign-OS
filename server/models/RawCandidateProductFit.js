module.exports = (sequelize, DataTypes) => {
  const RawCandidateProductFit = sequelize.define('RawCandidateProductFit', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    latest_raw_candidate_id: DataTypes.INTEGER,
    existing_customer_id: DataTypes.INTEGER,
    campaign_product_id: { type: DataTypes.INTEGER, allowNull: false },
    platform: DataTypes.STRING(100),
    identity_key_hash: { type: DataTypes.CHAR(64), allowNull: false },
    strategy_id: DataTypes.INTEGER,
    finder_task_id: DataTypes.INTEGER,
    identity_status: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'unresolved' },
    fit_score: DataTypes.INTEGER,
    matched_persona: DataTypes.STRING(255),
    evidence_summary: DataTypes.TEXT,
    decision_status: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'pending' },
    analysis_version: DataTypes.STRING(100)
  }, {
    tableName: 'raw_candidate_product_fits',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['campaign_product_id', 'identity_key_hash'] }
    ]
  });

  RawCandidateProductFit.associate = models => {
    RawCandidateProductFit.belongsTo(models.RawCandidate, { foreignKey: 'latest_raw_candidate_id' });
    RawCandidateProductFit.belongsTo(models.Customer, { foreignKey: 'existing_customer_id' });
    RawCandidateProductFit.belongsTo(models.CampaignProduct, { foreignKey: 'campaign_product_id' });
    RawCandidateProductFit.belongsTo(models.KolStrategy, { foreignKey: 'strategy_id' });
    RawCandidateProductFit.belongsTo(models.FinderTask, { foreignKey: 'finder_task_id' });
  };

  return RawCandidateProductFit;
};
