module.exports = (sequelize, DataTypes) => {
  const Customer = sequelize.define('Customer', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(255), allowNull: false },
    email: { type: DataTypes.STRING(255), unique: true },
    company: DataTypes.STRING(255),
    phone: DataTypes.STRING(100),
    group_id: DataTypes.INTEGER,
    notes: DataTypes.TEXT,
    status: { type: DataTypes.STRING(50), defaultValue: 'active' },
    first_name: DataTypes.STRING(255),
    last_name: DataTypes.STRING(255),
    contact_name: DataTypes.STRING(255),
    creator_id: DataTypes.STRING(255),
    platform: DataTypes.STRING(100),
    profile_url: DataTypes.STRING(1024),
    youtube_url: DataTypes.STRING(1024),
    youtube_followers: DataTypes.STRING(100),
    instagram_url: DataTypes.STRING(1024),
    instagram_followers: DataTypes.STRING(100),
    tiktok_url: DataTypes.STRING(1024),
    tiktok_followers: DataTypes.STRING(100),
    country_language: DataTypes.STRING(255),
    country_region: DataTypes.STRING(255),
    creator_type: DataTypes.STRING(255),
    audience_fit: DataTypes.STRING(255),
    contact_route: DataTypes.STRING(255),
    video_price: DataTypes.STRING(255),
    exchange_rate: DataTypes.STRING(100),
    price_rmb: DataTypes.STRING(100),
    rating: DataTypes.STRING(100),
    feishu_record_id: DataTypes.STRING(255),
    sync_status: { type: DataTypes.STRING(50), defaultValue: 'sync_pending' },
    last_synced_at: DataTypes.DATE,
    source_raw_candidate_id: DataTypes.INTEGER,
    last_verified_at: DataTypes.DATE,
    cooperation_status: { type: DataTypes.STRING(50), defaultValue: 'available' },
    cooperation_risk_category: DataTypes.STRING(100),
    cooperation_risk_reason: DataTypes.TEXT,
    cooperation_status_updated_at: DataTypes.DATE,
    cooperation_status_source_raw_candidate_id: DataTypes.INTEGER
  }, {
    tableName: 'customers',
    timestamps: true,
    underscored: true
  });

  Customer.associate = models => {
    Customer.belongsTo(models.CustomerGroup, { foreignKey: 'group_id', onDelete: 'SET NULL' });
    Customer.hasMany(models.KolPlatformAccount, { foreignKey: 'customer_id', onDelete: 'CASCADE' });
    Customer.hasMany(models.CampaignKol, { foreignKey: 'customer_id', onDelete: 'CASCADE' });
  };

  return Customer;
};
