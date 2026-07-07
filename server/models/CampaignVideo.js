module.exports = (sequelize, DataTypes) => {
  const CampaignVideo = sequelize.define('CampaignVideo', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    campaign_id: { type: DataTypes.INTEGER, allowNull: false },
    video_source_id: { type: DataTypes.INTEGER, allowNull: false },
    added_reason: { type: DataTypes.STRING(100), defaultValue: 'manual' },
    added_by_finder_task_id: DataTypes.INTEGER
  }, {
    tableName: 'campaign_videos',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['campaign_id', 'video_source_id'] }
    ]
  });

  CampaignVideo.associate = models => {
    CampaignVideo.belongsTo(models.Campaign, { foreignKey: 'campaign_id', onDelete: 'CASCADE' });
    CampaignVideo.belongsTo(models.VideoSource, { foreignKey: 'video_source_id', onDelete: 'CASCADE' });
    CampaignVideo.belongsTo(models.FinderTask, { foreignKey: 'added_by_finder_task_id', onDelete: 'SET NULL' });
  };

  return CampaignVideo;
};
