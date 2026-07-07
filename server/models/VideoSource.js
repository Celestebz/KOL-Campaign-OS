module.exports = (sequelize, DataTypes) => {
  const VideoSource = sequelize.define('VideoSource', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    platform: DataTypes.STRING(100),
    platform_video_id: DataTypes.STRING(255),
    source_url: { type: DataTypes.STRING(2048), allowNull: false },
    canonical_url: { type: DataTypes.STRING(2048), allowNull: false },
    canonical_url_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    title: DataTypes.TEXT,
    author_name: DataTypes.STRING(255),
    author_profile_url: DataTypes.STRING(1024),
    author_profile_url_hash: DataTypes.CHAR(64),
    content_type: DataTypes.STRING(100),
    published_at: DataTypes.STRING(100),
    cooperation_price: DataTypes.STRING(255),
    notes: DataTypes.TEXT,
    crawl_status: { type: DataTypes.STRING(50), defaultValue: 'pending' },
    analysis_status: { type: DataTypes.STRING(50), defaultValue: 'not_analyzed' },
    status: { type: DataTypes.STRING(50), defaultValue: 'pending' },
    error_message: DataTypes.TEXT,
    last_crawled_at: DataTypes.DATE,
    latest_snapshot_id: DataTypes.INTEGER
  }, {
    tableName: 'video_sources',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['author_profile_url_hash'] },
      { fields: ['platform', 'platform_video_id'] }
    ]
  });

  VideoSource.associate = models => {
    VideoSource.hasMany(models.VideoSnapshot, { foreignKey: 'video_source_id', onDelete: 'CASCADE' });
    VideoSource.hasMany(models.VideoComment, { foreignKey: 'video_source_id', onDelete: 'CASCADE' });
    VideoSource.hasMany(models.VideoAiAnalysisResult, { foreignKey: 'video_source_id', onDelete: 'CASCADE' });
    VideoSource.hasMany(models.CampaignVideo, { foreignKey: 'video_source_id', onDelete: 'CASCADE' });
    VideoSource.hasMany(models.FinderVideoEvidence, { foreignKey: 'video_source_id', onDelete: 'CASCADE' });
  };

  return VideoSource;
};
