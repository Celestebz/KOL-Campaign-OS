module.exports = (sequelize, DataTypes) => {
  const VideoComment = sequelize.define('VideoComment', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    video_source_id: { type: DataTypes.INTEGER, allowNull: false },
    platform_comment_id: DataTypes.STRING(255),
    parent_comment_id: DataTypes.STRING(255),
    user_name: DataTypes.STRING(255),
    content: DataTypes.TEXT,
    like_count: DataTypes.INTEGER,
    commented_at: DataTypes.STRING(100),
    raw_data: DataTypes.TEXT
  }, {
    tableName: 'video_comments',
    timestamps: true,
    underscored: true
  });

  VideoComment.associate = models => {
    VideoComment.belongsTo(models.VideoSource, { foreignKey: 'video_source_id', onDelete: 'CASCADE' });
  };

  return VideoComment;
};
