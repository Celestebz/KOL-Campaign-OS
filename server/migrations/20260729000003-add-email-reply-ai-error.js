module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('email_replies');
    if (!table.ai_error) {
      await queryInterface.addColumn('email_replies', 'ai_error', {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'AI 摘要最近一次失败原因'
      });
    }
    await queryInterface.sequelize.query(
      `UPDATE api_settings
       SET base_url = 'https://api.minimaxi.com/anthropic',
           extra_config = JSON_SET(COALESCE(NULLIF(extra_config, ''), '{}'), '$.api_protocol', 'anthropic_token_plan')
       WHERE provider = 'ai.minimax'
         AND model = 'MiniMax-M3'
         AND (base_url IS NULL OR base_url = '' OR base_url IN (
           'https://api.minimaxi.com/v1', 'https://api.minimax.com/v1', 'https://api.minimax.io/v1'
         ))`
    );
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('email_replies');
    if (table.ai_error) await queryInterface.removeColumn('email_replies', 'ai_error');
  }
};
