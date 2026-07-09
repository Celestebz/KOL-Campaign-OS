module.exports = (sequelize, DataTypes) => {
  const VideoAiAnalysisResult = sequelize.define('VideoAiAnalysisResult', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    video_source_id: { type: DataTypes.INTEGER, allowNull: false },
    analysis_type: { type: DataTypes.STRING(100), allowNull: false },
    analysis_scope_id: DataTypes.INTEGER,
    score: DataTypes.INTEGER,
    summary: DataTypes.TEXT,
    sentiment_positive: DataTypes.INTEGER,
    sentiment_neutral: DataTypes.INTEGER,
    sentiment_negative: DataTypes.INTEGER,
    purchase_intent_count: DataTypes.INTEGER,
    purchase_intent_keywords: DataTypes.TEXT,
    brand_mentions: DataTypes.TEXT,
    risks: DataTypes.TEXT,
    product_feedback: DataTypes.TEXT,
    cooperation_advice: DataTypes.TEXT,
    content_suggestions: DataTypes.TEXT,
    full_report: DataTypes.TEXT,
    final_prompt: DataTypes.TEXT,
    raw_result: DataTypes.TEXT,
    extra_data: DataTypes.TEXT,
    evidence_signals: DataTypes.TEXT('long'),
    model_name: DataTypes.STRING(255),
    status: { type: DataTypes.STRING(50), defaultValue: 'success' },
    error_message: DataTypes.TEXT
  }, {
    tableName: 'video_ai_analysis_results',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['video_source_id', 'analysis_type', 'analysis_scope_id'] }
    ]
  });

  VideoAiAnalysisResult.associate = models => {
    VideoAiAnalysisResult.belongsTo(models.VideoSource, { foreignKey: 'video_source_id', onDelete: 'CASCADE' });
  };

  return VideoAiAnalysisResult;
};
