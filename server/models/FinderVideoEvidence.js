module.exports = (sequelize, DataTypes) => {
  const FinderVideoEvidence = sequelize.define('FinderVideoEvidence', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    finder_task_id: { type: DataTypes.INTEGER, allowNull: false },
    strategy_id: DataTypes.INTEGER,
    campaign_id: DataTypes.INTEGER,
    video_source_id: { type: DataTypes.INTEGER, allowNull: false },
    target_platform: { type: DataTypes.STRING(100), allowNull: false },
    evidence_platform: { type: DataTypes.STRING(100), allowNull: false },
    discovery_scope: { type: DataTypes.STRING(100), defaultValue: 'target_platform_only' },
    discovery_route: { type: DataTypes.STRING(255), defaultValue: 'target_platform_first' },
    source_signal: DataTypes.STRING(100),
    source_query: DataTypes.TEXT,
    evidence_reason: DataTypes.TEXT,
    status: { type: DataTypes.STRING(50), defaultValue: 'discovered' },
    raw_data: DataTypes.TEXT('medium')
  }, {
    tableName: 'finder_video_evidence',
    timestamps: true,
    underscored: true
  });

  FinderVideoEvidence.associate = models => {
    FinderVideoEvidence.belongsTo(models.FinderTask, { foreignKey: 'finder_task_id', onDelete: 'CASCADE' });
    FinderVideoEvidence.belongsTo(models.KolStrategy, { foreignKey: 'strategy_id', onDelete: 'SET NULL' });
    FinderVideoEvidence.belongsTo(models.Campaign, { foreignKey: 'campaign_id', onDelete: 'SET NULL' });
    FinderVideoEvidence.belongsTo(models.VideoSource, { foreignKey: 'video_source_id', onDelete: 'CASCADE' });
  };

  return FinderVideoEvidence;
};
