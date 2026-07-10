module.exports = (sequelize, DataTypes) => {
  const RawCandidate = sequelize.define('RawCandidate', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    finder_task_id: DataTypes.INTEGER,
    campaign_id: DataTypes.INTEGER,
    strategy_id: DataTypes.INTEGER,
    platform: DataTypes.STRING(100),
    kol_name: { type: DataTypes.STRING(255), allowNull: false },
    contact_name: DataTypes.STRING(255),
    profile_url: DataTypes.STRING(1024),
    video_url: DataTypes.STRING(1024),
    video_title: DataTypes.TEXT,
    followers: DataTypes.STRING(100),
    avg_views: DataTypes.STRING(100),
    email: DataTypes.STRING(255),
    phone: DataTypes.STRING(100),
    country_region: DataTypes.STRING(255),
    matched_keywords: DataTypes.TEXT,
    ai_score: DataTypes.INTEGER,
    ai_match_reason: DataTypes.TEXT,
    status: { type: DataTypes.STRING(50), defaultValue: 'new' },
    source: DataTypes.STRING(255),
    discovery_route: DataTypes.STRING(255),
    source_platform: DataTypes.STRING(100),
    target_platform: DataTypes.STRING(100),
    source_agent: DataTypes.STRING(255),
    raw_data: DataTypes.TEXT,
    approved_customer_id: DataTypes.INTEGER,
    approved_campaign_kol_id: DataTypes.INTEGER,
    error_message: DataTypes.TEXT,
    matched_persona: DataTypes.TEXT,
    scoring_breakdown: DataTypes.TEXT,
    evidence_url: DataTypes.STRING(1024),
    evidence_title: DataTypes.TEXT,
    evidence_type: DataTypes.STRING(100),
    source_query: DataTypes.TEXT,
    rejection_scope: DataTypes.STRING(50),
    rejection_category: DataTypes.STRING(100),
    rejection_reason: DataTypes.TEXT
  }, {
    tableName: 'raw_candidates',
    timestamps: true,
    underscored: true
  });

  RawCandidate.associate = models => {
    RawCandidate.belongsTo(models.FinderTask, { foreignKey: 'finder_task_id', onDelete: 'SET NULL' });
    RawCandidate.belongsTo(models.Campaign, { foreignKey: 'campaign_id', onDelete: 'SET NULL' });
    RawCandidate.belongsTo(models.KolStrategy, { foreignKey: 'strategy_id', onDelete: 'SET NULL' });
    RawCandidate.belongsTo(models.Customer, { foreignKey: 'approved_customer_id', onDelete: 'SET NULL' });
  };

  return RawCandidate;
};
