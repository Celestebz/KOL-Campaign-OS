// API credentials and mailbox-derived data are private to one user.
// Existing rows are assigned to the first administrator during upgrade.
module.exports = {
  async up(queryInterface, Sequelize) {
    const removeIndexIfPresent = async (table, name) => {
      try {
        await queryInterface.removeIndex(table, name);
      } catch (error) {
        if (error?.original?.code !== 'ER_CANT_DROP_FIELD_OR_KEY' && error?.parent?.code !== 'ER_CANT_DROP_FIELD_OR_KEY') throw error;
      }
    };
    const addIndexIfMissing = async (table, fields, options) => {
      const [rows] = await queryInterface.sequelize.query(`SHOW INDEX FROM ${table}`);
      if (!rows.some((row) => row.Key_name === options.name)) await queryInterface.addIndex(table, fields, options);
    };
    const ownerColumn = {
      type: Sequelize.INTEGER, allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'RESTRICT', onUpdate: 'CASCADE'
    };
    const tables = ['api_settings', 'email_settings', 'email_drafts', 'email_records', 'email_replies', 'email_threads', 'email_filter_rules', 'email_bounces', 'approval_items'];
    for (const table of tables) {
      const columns = await queryInterface.describeTable(table);
      if (!columns.owner_user_id) await queryInterface.addColumn(table, 'owner_user_id', ownerColumn);
    }

    const [admins] = await queryInterface.sequelize.query("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
    const fallbackOwnerId = admins[0]?.id;
    if (fallbackOwnerId) {
      await queryInterface.sequelize.query('UPDATE api_settings SET owner_user_id = ? WHERE owner_user_id IS NULL', { replacements: [fallbackOwnerId] });
      await queryInterface.sequelize.query('UPDATE email_settings SET owner_user_id = ? WHERE owner_user_id IS NULL', { replacements: [fallbackOwnerId] });
      for (const table of ['email_drafts', 'email_records', 'email_replies', 'email_threads']) {
        await queryInterface.sequelize.query(
          `UPDATE ${table} p LEFT JOIN email_settings m ON m.id = p.mailbox_id
           SET p.owner_user_id = COALESCE(m.owner_user_id, ?) WHERE p.owner_user_id IS NULL`,
          { replacements: [fallbackOwnerId] }
        );
      }
      await queryInterface.sequelize.query('UPDATE email_filter_rules SET owner_user_id = ? WHERE owner_user_id IS NULL', { replacements: [fallbackOwnerId] });
      await queryInterface.sequelize.query(
        `UPDATE email_bounces b LEFT JOIN email_replies r ON r.id = b.email_reply_id
         SET b.owner_user_id = COALESCE(r.owner_user_id, ?) WHERE b.owner_user_id IS NULL`,
        { replacements: [fallbackOwnerId] }
      );
      await queryInterface.sequelize.query(
        `UPDATE approval_items ai
         LEFT JOIN email_drafts d ON ai.subject_type = 'email_draft' AND d.id = ai.subject_id
         LEFT JOIN email_replies r ON ai.subject_type = 'email_reply' AND r.id = ai.subject_id
         SET ai.owner_user_id = COALESCE(d.owner_user_id, r.owner_user_id, ?)
         WHERE ai.owner_user_id IS NULL AND ai.subject_type IN ('email_draft', 'email_reply')`,
        { replacements: [fallbackOwnerId] }
      );
    } else {
      for (const table of tables) {
        const [countRows] = await queryInterface.sequelize.query(`SELECT COUNT(*) AS count FROM ${table}`);
        if (Number(countRows[0]?.count) > 0) throw new Error(`Cannot assign existing ${table} rows without an administrator account`);
      }
    }

    const [indexes] = await queryInterface.sequelize.query('SHOW INDEX FROM api_settings');
    const providerUnique = [...new Set(indexes.filter((row) => Number(row.Non_unique) === 0 && row.Column_name === 'provider').map((row) => row.Key_name))];
    for (const name of providerUnique) await removeIndexIfPresent('api_settings', name);
    const [ruleIndexes] = await queryInterface.sequelize.query('SHOW INDEX FROM email_filter_rules');
    const ruleUnique = [...new Set(ruleIndexes.filter((row) => Number(row.Non_unique) === 0 && ['rule_type', 'rule_value'].includes(row.Column_name)).map((row) => row.Key_name))];
    for (const name of ruleUnique) await removeIndexIfPresent('email_filter_rules', name);
    const [draftIndexes] = await queryInterface.sequelize.query('SHOW INDEX FROM email_drafts');
    const draftDedupeUnique = [...new Set(draftIndexes.filter((row) => Number(row.Non_unique) === 0 && row.Column_name === 'dedupe_key').map((row) => row.Key_name))];
    for (const name of draftDedupeUnique) await removeIndexIfPresent('email_drafts', name);
    await addIndexIfMissing('api_settings', ['owner_user_id', 'provider'], { unique: true, name: 'uniq_api_settings_owner_provider' });
    await addIndexIfMissing('email_settings', ['owner_user_id', 'is_default'], { name: 'idx_email_settings_owner_default' });
    await addIndexIfMissing('email_filter_rules', ['owner_user_id', 'rule_type', 'rule_value'], { unique: true, name: 'uniq_email_filter_rules_owner_rule' });
    await addIndexIfMissing('email_drafts', ['owner_user_id', 'dedupe_key'], { unique: true, name: 'uniq_email_drafts_owner_dedupe' });
    for (const table of ['email_drafts', 'email_records', 'email_replies', 'email_threads', 'email_filter_rules', 'email_bounces']) {
      await addIndexIfMissing(table, ['owner_user_id'], { name: `idx_${table}_owner_user_id` });
    }
    await addIndexIfMissing('approval_items', ['owner_user_id', 'status'], { name: 'idx_approval_items_owner_status' });
    // Keep the column nullable at schema level for legacy maintenance scripts.
    // Authenticated application writes always provide an owner and all reads exclude NULL.
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('api_settings', 'uniq_api_settings_owner_provider');
    await queryInterface.removeIndex('email_filter_rules', 'uniq_email_filter_rules_owner_rule');
    await queryInterface.removeIndex('email_drafts', 'uniq_email_drafts_owner_dedupe');
    for (const table of ['approval_items', 'email_bounces', 'email_filter_rules', 'email_threads', 'email_replies', 'email_records', 'email_drafts', 'email_settings', 'api_settings']) {
      const columns = await queryInterface.describeTable(table);
      if (columns.owner_user_id) await queryInterface.removeColumn(table, 'owner_user_id');
    }
    await queryInterface.addIndex('api_settings', ['provider'], { unique: true, name: 'api_settings_provider_unique' });
  }
};
