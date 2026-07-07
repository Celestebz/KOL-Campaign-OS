module.exports = (sequelize, DataTypes) => {
  const KolPlatformAccount = sequelize.define('KolPlatformAccount', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    customer_id: { type: DataTypes.INTEGER, allowNull: false },
    platform: { type: DataTypes.STRING(100), allowNull: false },
    platform_user_id: DataTypes.STRING(255),
    username: DataTypes.STRING(255),
    profile_url: DataTypes.STRING(1024),
    profile_url_hash: DataTypes.CHAR(64),
    followers_count: DataTypes.INTEGER,
    followers_text: DataTypes.STRING(100),
    avatar_url: DataTypes.STRING(1024),
    bio: DataTypes.TEXT,
    raw_data: DataTypes.TEXT
  }, {
    tableName: 'kol_platform_accounts',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['customer_id', 'platform', 'platform_user_id'] }
    ]
  });

  KolPlatformAccount.associate = models => {
    KolPlatformAccount.belongsTo(models.Customer, { foreignKey: 'customer_id', onDelete: 'CASCADE' });
  };

  return KolPlatformAccount;
};
