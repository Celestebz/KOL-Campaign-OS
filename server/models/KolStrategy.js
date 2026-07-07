module.exports = (sequelize, DataTypes) => {
  const KolStrategy = sequelize.define('KolStrategy', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    campaign_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: false },
    brand: DataTypes.STRING(255),
    product: DataTypes.STRING(255),
    category: DataTypes.STRING(255),
    target_market: DataTypes.STRING(255),
    language: DataTypes.STRING(255),
    primary_platform: DataTypes.STRING(100),
    secondary_platforms: DataTypes.TEXT,
    campaign_goal: DataTypes.TEXT,
    status: { type: DataTypes.STRING(50), defaultValue: 'draft' },
    product_context: DataTypes.TEXT,
    persona_config: DataTypes.TEXT,
    search_strategy: DataTypes.TEXT,
    scoring_weights: DataTypes.TEXT,
    finder_handoff: DataTypes.TEXT,
    source_material_summary: DataTypes.TEXT,
    source_material_meta: DataTypes.TEXT,
    source_material_type: DataTypes.STRING(100),
    research_status: { type: DataTypes.STRING(50), defaultValue: 'not_started' },
    research_sources: DataTypes.TEXT
  }, {
    tableName: 'kol_strategies',
    timestamps: true,
    underscored: true
  });

  KolStrategy.associate = models => {
    KolStrategy.belongsTo(models.Campaign, { foreignKey: 'campaign_id', onDelete: 'CASCADE' });
    KolStrategy.hasMany(models.FinderTask, { foreignKey: 'strategy_id', onDelete: 'SET NULL' });
    KolStrategy.hasMany(models.FinderVideoEvidence, { foreignKey: 'strategy_id', onDelete: 'SET NULL' });
  };

  return KolStrategy;
};
