module.exports = (sequelize, DataTypes) => {
  const FinderTask = sequelize.define('FinderTask', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    campaign_id: DataTypes.INTEGER,
    strategy_id: DataTypes.INTEGER,
    name: DataTypes.STRING(255),
    platform: DataTypes.STRING(100),
    keywords: DataTypes.TEXT,
    status: { type: DataTypes.STRING(50), defaultValue: 'draft' },
    result_count: { type: DataTypes.INTEGER, defaultValue: 0 },
    notes: DataTypes.TEXT,
    search_sources: DataTypes.TEXT,
    discovery_routes: DataTypes.TEXT,
    target_platforms: DataTypes.TEXT,
    success_count: { type: DataTypes.INTEGER, defaultValue: 0 },
    failed_count: { type: DataTypes.INTEGER, defaultValue: 0 },
    provider_attempts: DataTypes.TEXT,
    error_message: DataTypes.TEXT,
    raw_request: DataTypes.TEXT,
    raw_response_summary: DataTypes.TEXT,
    source_agent: DataTypes.STRING(255),
    started_at: DataTypes.DATE,
    finished_at: DataTypes.DATE
  }, {
    tableName: 'finder_tasks',
    timestamps: true,
    underscored: true
  });

  FinderTask.associate = models => {
    FinderTask.belongsTo(models.Campaign, { foreignKey: 'campaign_id', onDelete: 'SET NULL' });
    FinderTask.belongsTo(models.KolStrategy, { foreignKey: 'strategy_id', onDelete: 'SET NULL' });
    FinderTask.hasMany(models.FinderVideoEvidence, { foreignKey: 'finder_task_id', onDelete: 'CASCADE' });
    FinderTask.hasMany(models.RawCandidate, { foreignKey: 'finder_task_id', onDelete: 'SET NULL' });
  };

  return FinderTask;
};
