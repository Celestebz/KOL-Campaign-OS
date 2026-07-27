// New KOL cooperation records default to product exchange. Existing explicit
// choices remain unchanged; only null/blank legacy rows are normalized.
module.exports = {
  async up(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('campaign_kols')) return;
    const columns = await queryInterface.describeTable('campaign_kols');
    if (!columns.cooperation_type) return;

    await queryInterface.sequelize.query(
      `UPDATE campaign_kols
       SET cooperation_type = 'product_exchange', updated_at = CURRENT_TIMESTAMP
       WHERE cooperation_type IS NULL OR TRIM(cooperation_type) = ''`
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE campaign_kols
       MODIFY COLUMN cooperation_type VARCHAR(50) NULL DEFAULT 'product_exchange'
       COMMENT '合作方式，例如付费加寄样或仅寄样'`
    );
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('campaign_kols')) return;
    const columns = await queryInterface.describeTable('campaign_kols');
    if (!columns.cooperation_type) return;
    await queryInterface.sequelize.query(
      `ALTER TABLE campaign_kols
       MODIFY COLUMN cooperation_type VARCHAR(50) NULL DEFAULT 'paid_product'
       COMMENT '合作方式，例如付费加寄样或仅寄样'`
    );
  }
};
