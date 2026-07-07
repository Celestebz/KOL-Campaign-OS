module.exports = (sequelize, DataTypes) => {
  const PromptTemplate = sequelize.define('PromptTemplate', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(255), allowNull: false },
    platform: { type: DataTypes.STRING(100), defaultValue: 'all' },
    system_prompt: DataTypes.TEXT,
    user_prompt: { type: DataTypes.TEXT, allowNull: false },
    brand_keywords: DataTypes.TEXT,
    purchase_keywords: DataTypes.TEXT,
    negative_keywords: DataTypes.TEXT,
    is_default: { type: DataTypes.TINYINT, defaultValue: 0 }
  }, {
    tableName: 'prompt_templates',
    timestamps: true,
    underscored: true
  });
  return PromptTemplate;
};
