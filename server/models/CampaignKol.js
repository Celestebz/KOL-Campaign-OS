module.exports = (sequelize, DataTypes) => {
  const CampaignKol = sequelize.define('CampaignKol', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    campaign_id: { type: DataTypes.INTEGER, allowNull: false },
    strategy_id: DataTypes.INTEGER,
    finder_task_id: DataTypes.INTEGER,
    raw_candidate_id: DataTypes.INTEGER,
    customer_id: { type: DataTypes.INTEGER, allowNull: false },
    platform_account_id: DataTypes.INTEGER,
    target_platform: DataTypes.STRING(100),
    source: DataTypes.STRING(255),

    project_status: { type: DataTypes.STRING(50), defaultValue: 'candidate' },
    priority_level: { type: DataTypes.STRING(50), defaultValue: 'normal' },
    candidate_priority_score: DataTypes.INTEGER,

    quoted_fee: DataTypes.STRING(255),
    final_fee: DataTypes.STRING(255),
    currency: DataTypes.STRING(50),
    deliverables: DataTypes.TEXT,

    contact_email_override: DataTypes.STRING(255),
    contact_name_override: DataTypes.STRING(255),

    outreach_status: DataTypes.STRING(50),
    negotiation_status: DataTypes.STRING(50),
    contract_status: DataTypes.STRING(50),
    payment_status: DataTypes.STRING(50),
    content_status: DataTypes.STRING(50),

    project_notes: DataTypes.TEXT,
    internal_notes: DataTypes.TEXT,

    best_evidence_video_id: DataTypes.INTEGER,
    best_evidence_url: DataTypes.STRING(1024),
    evidence_summary: DataTypes.TEXT,

    master_snapshot: DataTypes.TEXT,
    project_override: DataTypes.TEXT,

    // Compatibility fields
    kol_name_snapshot: DataTypes.STRING(255),
    contact_name_snapshot: DataTypes.STRING(255),
    youtube_url_snapshot: DataTypes.STRING(1024),
    youtube_followers_snapshot: DataTypes.STRING(100),
    instagram_url_snapshot: DataTypes.STRING(1024),
    instagram_followers_snapshot: DataTypes.STRING(100),
    tiktok_url_snapshot: DataTypes.STRING(1024),
    tiktok_followers_snapshot: DataTypes.STRING(100),
    email_snapshot: DataTypes.STRING(255),
    country_region_snapshot: DataTypes.STRING(255),
    quoted_price: DataTypes.STRING(255),
    exchange_rate: DataTypes.STRING(100),
    price_rmb: DataTypes.STRING(100),
    status: { type: DataTypes.STRING(50), defaultValue: 'candidate' },
    owner: DataTypes.STRING(255),
    youtube_video_link: DataTypes.STRING(1024),
    instagram_video_link: DataTypes.STRING(1024),
    tiktok_video_link: DataTypes.STRING(1024),
    notes: DataTypes.TEXT,
    feishu_record_id: DataTypes.STRING(255),
    sync_status: { type: DataTypes.STRING(50), defaultValue: 'sync_pending' },
    last_synced_at: DataTypes.DATE
  }, {
    tableName: 'campaign_kols',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['campaign_id', 'platform_account_id'] }
    ]
  });

  CampaignKol.associate = models => {
    CampaignKol.belongsTo(models.Campaign, { foreignKey: 'campaign_id', onDelete: 'CASCADE' });
    CampaignKol.belongsTo(models.KolStrategy, { foreignKey: 'strategy_id', onDelete: 'SET NULL' });
    CampaignKol.belongsTo(models.FinderTask, { foreignKey: 'finder_task_id', onDelete: 'SET NULL' });
    CampaignKol.belongsTo(models.Customer, { foreignKey: 'customer_id', onDelete: 'CASCADE' });
    CampaignKol.belongsTo(models.KolPlatformAccount, { foreignKey: 'platform_account_id', onDelete: 'SET NULL' });
    CampaignKol.belongsTo(models.RawCandidate, { foreignKey: 'raw_candidate_id', onDelete: 'SET NULL' });
    CampaignKol.belongsTo(models.VideoSource, { foreignKey: 'best_evidence_video_id', onDelete: 'SET NULL' });
  };

  return CampaignKol;
};
