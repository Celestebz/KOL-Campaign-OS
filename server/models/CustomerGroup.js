module.exports = (sequelize, DataTypes) => {
  const CustomerGroup = sequelize.define('CustomerGroup', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(255), allowNull: false, unique: true },
    description: DataTypes.TEXT
  }, {
    tableName: 'customer_groups',
    timestamps: true,
    underscored: true
  });
  return CustomerGroup;
};
