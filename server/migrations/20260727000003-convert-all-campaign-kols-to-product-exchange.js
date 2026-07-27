// Business decision: all existing KOL cooperation records use product exchange.
// Preserve quote and estimated-cost history; only normalize the cooperation type,
// final cash fee, currency, and Feishu sync state.
module.exports = {
  async up(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('campaign_kols')) return;

    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        `UPDATE campaign_kols
         SET cooperation_type = 'product_exchange',
             final_fee = 0,
             currency = NULL,
             sync_status = 'sync_pending',
             updated_at = CURRENT_TIMESTAMP`,
        { transaction }
      );

      await queryInterface.sequelize.query(
        `UPDATE customers c
         INNER JOIN campaign_kols ck ON ck.customer_id = c.id
         SET c.sync_status = 'sync_pending', c.updated_at = CURRENT_TIMESTAMP`,
        { transaction }
      );
    });
  },

  async down() {
    // No-op: previous cooperation types and cash fees cannot be reconstructed.
  }
};
