module.exports = (sequelize, DataTypes) => {
  const VideoSnapshot = sequelize.define('VideoSnapshot', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    video_source_id: { type: DataTypes.INTEGER, allowNull: false },
    play_count: DataTypes.INTEGER,
    like_count: DataTypes.INTEGER,
    comment_count: DataTypes.INTEGER,
    collect_count: DataTypes.INTEGER,
    share_count: DataTypes.INTEGER,
    primary_exposure_count: DataTypes.INTEGER,
    exposure_metric_type: DataTypes.STRING(100),
    data_quality_note: DataTypes.TEXT,
    raw_data: DataTypes.TEXT,
    snapshot_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
  }, {
    tableName: 'video_snapshots',
    timestamps: true,
    underscored: true
  });

  VideoSnapshot.associate = models => {
    VideoSnapshot.belongsTo(models.VideoSource, { foreignKey: 'video_source_id', onDelete: 'CASCADE' });
  };

  return VideoSnapshot;
};
