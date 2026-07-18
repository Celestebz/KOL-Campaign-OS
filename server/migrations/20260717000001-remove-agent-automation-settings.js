const LEGACY_AGENT_PROVIDERS = [
  'agent.maton_gateway',
  'agent.browseract',
  'agent.playwright_local',
  'agent.custom_tool_gateway'
];

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      'DELETE FROM api_settings WHERE provider IN (?, ?, ?, ?)',
      { replacements: LEGACY_AGENT_PROVIDERS }
    );
  },

  // Deleted obsolete settings cannot be reconstructed safely.
  async down() {}
};
