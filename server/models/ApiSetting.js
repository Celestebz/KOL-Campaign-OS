module.exports = (sequelize, DataTypes) => {
  const ApiSetting = sequelize.define('ApiSetting', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    owner_user_id: { type: DataTypes.INTEGER, allowNull: true },
    provider: { type: DataTypes.STRING(255), allowNull: false },
    api_key: DataTypes.TEXT,
    base_url: DataTypes.STRING(1024),
    model: DataTypes.STRING(255),
    extra_config: DataTypes.TEXT
  }, {
    tableName: 'api_settings',
    timestamps: true,
    underscored: true,
    indexes: [{ unique: true, fields: ['owner_user_id', 'provider'] }]
  });
  return ApiSetting;
};
