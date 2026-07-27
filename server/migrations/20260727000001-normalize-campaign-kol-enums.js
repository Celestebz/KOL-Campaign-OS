// Normalize legacy values that predate the current KOL cooperation workflow.
// The mapping is intentionally one-way because the old values were ambiguous
// and are no longer accepted by the editing API.
module.exports = {
  async up(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('campaign_kols')) return;

    await queryInterface.sequelize.query(
      `UPDATE campaign_kols
       SET project_status = CASE
         WHEN LOWER(project_status) = 'confirmed' THEN 'pending_shipping'
         WHEN LOWER(project_status) = 'candidate' THEN 'pending_confirmation'
         ELSE LOWER(project_status)
       END,
       updated_at = CURRENT_TIMESTAMP
       WHERE LOWER(project_status) IN ('confirmed', 'candidate')`
    );

    await queryInterface.sequelize.query(
      `UPDATE campaign_kols
       SET priority_level = 't2', updated_at = CURRENT_TIMESTAMP
       WHERE LOWER(priority_level) = 'normal'`
    );
  },

  async down() {
    // No-op: the legacy values do not map back unambiguously.
  }
};
