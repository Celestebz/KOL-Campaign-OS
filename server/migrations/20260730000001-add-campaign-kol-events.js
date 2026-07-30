// Append-only project follow-up timeline. Email summaries and intent corrections
// live here instead of overwriting the manually maintained project_notes field.
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const tables = (await queryInterface.showAllTables()).map(String);

    if (!tables.includes('campaign_kol_events')) {
      await queryInterface.createTable('campaign_kol_events', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        campaign_kol_id: { type: DataTypes.INTEGER, allowNull: false },
        campaign_id: { type: DataTypes.INTEGER, allowNull: false },
        customer_id: { type: DataTypes.INTEGER, allowNull: false },
        event_type: { type: DataTypes.STRING(50), allowNull: false },
        occurred_at: { type: DataTypes.DATE, allowNull: false },
        summary: { type: DataTypes.TEXT },
        source_type: { type: DataTypes.STRING(30) },
        source_id: { type: DataTypes.INTEGER },
        ai_intent: { type: DataTypes.STRING(20) },
        confirmed_intent: { type: DataTypes.STRING(20) },
        outreach_status: { type: DataTypes.STRING(50) },
        previous_outreach_status: { type: DataTypes.STRING(50) },
        actor: { type: DataTypes.STRING(100) },
        created_at: { type: DataTypes.DATE, allowNull: false }
      });
      await queryInterface.addIndex('campaign_kol_events', ['campaign_kol_id', 'occurred_at', 'id'], {
        name: 'campaign_kol_events_timeline'
      });
      await queryInterface.addIndex('campaign_kol_events', ['source_type', 'source_id'], {
        name: 'campaign_kol_events_source'
      });
    }

    if (tables.includes('email_replies')) {
      const columns = await queryInterface.describeTable('email_replies');
      if (!columns.confirmed_intent) {
        await queryInterface.addColumn('email_replies', 'confirmed_intent', {
          type: DataTypes.STRING(20),
          comment: '人工确认意向：interested/question/unclear/rejected'
        });
      }
    }
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (tables.includes('email_replies')) {
      const columns = await queryInterface.describeTable('email_replies');
      if (columns.confirmed_intent) await queryInterface.removeColumn('email_replies', 'confirmed_intent');
    }
    if (tables.includes('campaign_kol_events')) {
      await queryInterface.dropTable('campaign_kol_events', { cascade: true });
    }
  }
};
