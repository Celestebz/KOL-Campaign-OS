module.exports = (sequelize, DataTypes) => {
  const Product = sequelize.define('Product', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    brand: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
    name: { type: DataTypes.STRING(255), allowNull: false }
  }, {
    tableName: 'products',
    timestamps: true,
    underscored: true,
    indexes: [
      { unique: true, fields: ['brand', 'name'] }
    ]
  });

  Product.associate = models => {
    Product.hasMany(models.CampaignProduct, { foreignKey: 'product_id' });
  };

  return Product;
};
