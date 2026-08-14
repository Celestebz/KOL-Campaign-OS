// 邮箱品牌化 + 品牌/邮箱归属回填：
// - email_settings 增加 brand，AI 起草署名不再依赖写作规范里的固定品牌；
// - 历史邮箱按绑定活动品牌回填，缺失时退回邮箱别名；
// - 写作规范去掉写死的 BILTHARD 落款；
// - 活动邮箱归属为空时按品牌匹配回填，避免品牌邮箱混用。
module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;
    const transaction = await sequelize.transaction();
    try {
      const settingsColumns = await queryInterface.describeTable('email_settings', { transaction });
      if (!settingsColumns.brand) {
        await queryInterface.addColumn('email_settings', 'brand', {
          type: Sequelize.STRING(255), allowNull: true,
          comment: '邮箱对外品牌名（AI 起草署名与介绍使用）'
        }, { transaction });
      }

      await sequelize.query(
        `UPDATE email_settings ms
         LEFT JOIN (
           SELECT mailbox_id, MAX(brand) AS brand
           FROM campaigns
           WHERE mailbox_id IS NOT NULL AND brand IS NOT NULL AND TRIM(brand) <> ''
           GROUP BY mailbox_id
         ) c ON c.mailbox_id = ms.id
         SET ms.brand = COALESCE(NULLIF(TRIM(c.brand), ''), NULLIF(TRIM(ms.label), ''))
         WHERE ms.brand IS NULL OR TRIM(ms.brand) = ''`,
        { transaction }
      );

      await sequelize.query(
        `UPDATE email_templates
         SET body_html = REPLACE(body_html,
           'Sign off with the sender name Celeste on one line and the brand name BILTHARD on the next line. Never use [Name] or any other placeholder.',
           'Sign off with the exact sender name on one line and the exact brand name provided in the current prompt (from the mailbox or campaign) on the next line. Never use [Name] or any other placeholder, and never invent a brand.'),
             updated_at = NOW()
         WHERE kind = 'style_guide'`,
        { transaction }
      );

      await sequelize.query(
        `UPDATE campaigns c
         JOIN email_settings ms
           ON LOWER(REPLACE(ms.label, ' ', '')) = LOWER(REPLACE(c.brand, ' ', ''))
         SET c.mailbox_id = ms.id
         WHERE c.mailbox_id IS NULL
           AND ms.enabled = 1
           AND c.brand IS NOT NULL
           AND TRIM(c.brand) <> ''`,
        { transaction }
      );

      await transaction.commit();
      console.log('[migration] mailbox brand + brand backfill ready');
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const settingsColumns = await queryInterface.describeTable('email_settings');
    if (settingsColumns.brand) {
      await queryInterface.removeColumn('email_settings', 'brand');
    }
  }
};
