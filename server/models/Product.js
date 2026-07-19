module.exports = (sequelize, DataTypes) => {
  const Product = sequelize.define('Product', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    brand: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    name: { type: DataTypes.STRING(255), allowNull: false },
    sku: DataTypes.STRING(255),
    category: DataTypes.STRING(255),
    product_url: DataTypes.STRING(1024),
    price: DataTypes.DECIMAL(15, 2),
    currency: DataTypes.STRING(50),
    description: DataTypes.TEXT,
    selling_points: DataTypes.TEXT,
    status: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'active' },
    catalog_key_hash: { type: DataTypes.CHAR(64), allowNull: false }
  }, {
    tableName: 'products',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['catalog_key_hash'] }
    ]
  });

  Product.associate = models => {
    Product.hasMany(models.CampaignProduct, { foreignKey: 'product_id' });
  };

  return Product;
};
