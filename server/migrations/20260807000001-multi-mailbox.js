// 多邮箱：email_settings 从单行配置升级为每行一个邮箱（label/is_default/enabled），
// 邮件业务表加 mailbox_id 归属列。现有单行自动成为默认邮箱，历史邮件数据回填默认邮箱。
module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;
    const transaction = await sequelize.transaction();

    try {
      const settingsColumns = await queryInterface.describeTable("email_settings", { transaction });
      if (!settingsColumns.label) {
        await queryInterface.addColumn("email_settings", "label", {
          type: Sequelize.STRING(100), allowNull: true, comment: "邮箱别名（列表展示用）"
        }, { transaction });
      }
      if (!settingsColumns.is_default) {
        await queryInterface.addColumn("email_settings", "is_default", {
          type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false,
          comment: "是否默认邮箱（全表至多一行，应用层保证）"
        }, { transaction });
      }
      if (!settingsColumns.enabled) {
        await queryInterface.addColumn("email_settings", "enabled", {
          type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true,
          comment: "停用后不新发、不同步收信，历史数据保留"
        }, { transaction });
      }

      // 现有唯一一行升级为默认邮箱
      await sequelize.query(
        `UPDATE email_settings SET is_default = 1, enabled = 1,
           label = COALESCE(NULLIF(label, ""), "默认邮箱")
         WHERE id = (SELECT t.min_id FROM (SELECT MIN(id) AS min_id FROM email_settings) t)`,
        { transaction }
      );

      const mailboxColumn = {
        type: Sequelize.INTEGER, allowNull: true,
        comment: "归属邮箱 email_settings.id（campaigns 上 NULL=默认邮箱）"
      };
      for (const table of ["campaigns", "email_drafts", "email_records", "email_replies", "email_threads"]) {
        const columns = await queryInterface.describeTable(table, { transaction });
        if (!columns.mailbox_id) {
          await queryInterface.addColumn(table, "mailbox_id", mailboxColumn, { transaction });
        }
        const [indexes] = await sequelize.query(
          `SHOW INDEX FROM ${table} WHERE Key_name = "idx_${table}_mailbox_id"`,
          { transaction }
        );
        if (!indexes.length) {
          await queryInterface.addIndex(table, ["mailbox_id"], { name: `idx_${table}_mailbox_id`, transaction });
        }
      }

      // 历史邮件数据回填默认邮箱（此前只有一个邮箱，归属明确）；campaigns 不回填（NULL=默认邮箱）
      const [defaultRows] = await sequelize.query(
        "SELECT id FROM email_settings WHERE is_default = 1 ORDER BY id LIMIT 1",
        { transaction }
      );
      const defaultId = defaultRows[0]?.id;
      if (defaultId) {
        for (const table of ["email_drafts", "email_records", "email_replies", "email_threads"]) {
          await sequelize.query(
            `UPDATE ${table} SET mailbox_id = ? WHERE mailbox_id IS NULL`,
            { replacements: [defaultId], transaction }
          );
        }
      }

      await transaction.commit();
      console.log("[migration] multi-mailbox schema ready");
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const transaction = await sequelize.transaction();
    try {
      for (const table of ["campaigns", "email_drafts", "email_records", "email_replies", "email_threads"]) {
        const [indexes] = await sequelize.query(
          `SHOW INDEX FROM ${table} WHERE Key_name = "idx_${table}_mailbox_id"`,
          { transaction }
        );
        if (indexes.length) {
          await queryInterface.removeIndex(table, `idx_${table}_mailbox_id`, { transaction });
        }
        const columns = await queryInterface.describeTable(table, { transaction });
        if (columns.mailbox_id) {
          await queryInterface.removeColumn(table, "mailbox_id", { transaction });
        }
      }
      const settingsColumns = await queryInterface.describeTable("email_settings", { transaction });
      for (const name of ["label", "is_default", "enabled"]) {
        if (settingsColumns[name]) {
          await queryInterface.removeColumn("email_settings", name, { transaction });
        }
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
