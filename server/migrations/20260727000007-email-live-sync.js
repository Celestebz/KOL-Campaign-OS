// 准实时收信：email_settings 增加收信模式与 UID 游标；email_replies 支持
// 未识别回复（customer_id 可空）并给 message_id 加唯一约束兜底幂等。
module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;
    const transaction = await sequelize.transaction();

    try {
      const settingsColumns = await queryInterface.describeTable('email_settings', { transaction });
      if (!settingsColumns.sync_mode) {
        await queryInterface.addColumn('email_settings', 'sync_mode', {
          type: Sequelize.STRING(20), allowNull: false, defaultValue: 'idle',
          comment: '收信模式：idle=实时监听；poll=定时轮询；off=关闭回复同步'
        }, { transaction });
      }
      if (!settingsColumns.last_uid) {
        await queryInterface.addColumn('email_settings', 'last_uid', {
          type: Sequelize.BIGINT, allowNull: false, defaultValue: 0,
          comment: 'IMAP UID 增量游标（0=未初始化，首次连接时取当前最大 UID）'
        }, { transaction });
      }

      // 未识别回复没有归属 KOL
      await queryInterface.changeColumn('email_replies', 'customer_id', {
        type: Sequelize.INTEGER, allowNull: true, comment: '达人ID（未识别回复为空）'
      }, { transaction });

      // Message-ID 唯一约束兜底幂等（先查重；有重复则跳过并输出报告）
      const [duplicates] = await sequelize.query(
        `SELECT message_id, COUNT(*) AS c FROM email_replies
         WHERE message_id IS NOT NULL AND message_id <> ''
         GROUP BY message_id HAVING c > 1`,
        { transaction }
      );
      const [indexes] = await sequelize.query(
        `SHOW INDEX FROM email_replies WHERE Key_name = 'uniq_email_replies_message_id'`,
        { transaction }
      );
      if (!indexes.length) {
        if (duplicates.length) {
          console.warn(`[migration] email_replies.message_id 存在重复，跳过唯一索引: ${JSON.stringify(duplicates.slice(0, 10))}`);
        } else {
          await queryInterface.addIndex('email_replies', ['message_id'], {
            unique: true, name: 'uniq_email_replies_message_id', transaction
          });
        }
      }

      await transaction.commit();
      console.log('[migration] email live sync schema ready');
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const transaction = await sequelize.transaction();
    try {
      const [indexes] = await sequelize.query(
        `SHOW INDEX FROM email_replies WHERE Key_name = 'uniq_email_replies_message_id'`,
        { transaction }
      );
      if (indexes.length) {
        await queryInterface.removeIndex('email_replies', 'uniq_email_replies_message_id', { transaction });
      }
      const settingsColumns = await queryInterface.describeTable('email_settings', { transaction });
      for (const name of ['last_uid', 'sync_mode']) {
        if (settingsColumns[name]) await queryInterface.removeColumn('email_settings', name, { transaction });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
