// Keep legacy candidate data intact and expose collaboration-only data through
// confirmed-stage database views. API writes are guarded in campaignKols.js.
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.query('DROP VIEW IF EXISTS confirmed_campaign_kol_videos');
    await sequelize.query('DROP VIEW IF EXISTS confirmed_campaign_kol_collaboration');

    await sequelize.query(`
      CREATE VIEW confirmed_campaign_kol_collaboration AS
      SELECT id, campaign_id, customer_id,
             shipping_address, content_format, expected_publish_at,
             shipping_date, tracking_number, project_notes
      FROM campaign_kols
      WHERE pipeline_stage = 'confirmed'
    `);

    await sequelize.query(`
      CREATE VIEW confirmed_campaign_kol_videos AS
      SELECT cv.*
      FROM campaign_videos cv
      INNER JOIN campaign_kols ck ON ck.id = cv.campaign_kol_id
      WHERE ck.pipeline_stage = 'confirmed'
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP VIEW IF EXISTS confirmed_campaign_kol_videos');
    await queryInterface.sequelize.query('DROP VIEW IF EXISTS confirmed_campaign_kol_collaboration');
  }
};
