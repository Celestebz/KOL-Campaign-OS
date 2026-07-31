module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map(String);

    // 邮件会话线程表：按规范化主题聚合往来邮件，供上下文摘要使用
    if (!tables.includes('email_threads')) {
      await queryInterface.createTable('email_threads', {
        id: { type: Sequelize.DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        campaign_id: { type: Sequelize.DataTypes.INTEGER, allowNull: true },
        customer_id: { type: Sequelize.DataTypes.INTEGER, allowNull: true },
        normalized_subject: { type: Sequelize.DataTypes.STRING(500), allowNull: false, defaultValue: '' },
        last_message_at: { type: Sequelize.DataTypes.DATE, allowNull: true },
        message_count: { type: Sequelize.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        context_summary: { type: Sequelize.DataTypes.TEXT, allowNull: true },
        summary_through_message_id: { type: Sequelize.DataTypes.STRING(500), allowNull: true },
        created_at: { type: Sequelize.DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
      });
      await queryInterface.addIndex('email_threads', ['campaign_id'], { name: 'idx_email_threads_campaign' });
      await queryInterface.addIndex('email_threads', ['customer_id'], { name: 'idx_email_threads_customer' });
    }

    // 收件（email_replies）：线程关联 + 标准 MIME 解析产物
    if (tables.includes('email_replies')) {
      const columns = await queryInterface.describeTable('email_replies');
      const addReply = async (name, definition) => {
        if (!columns[name]) await queryInterface.addColumn('email_replies', name, definition);
      };
      await addReply('thread_id', { type: Sequelize.DataTypes.INTEGER, allowNull: true });
      await addReply('in_reply_to', { type: Sequelize.DataTypes.STRING(500), allowNull: true });
      await addReply('references_json', { type: Sequelize.DataTypes.TEXT, allowNull: true, comment: 'References头的Message-ID数组JSON' });
      await addReply('reply_to_message_id', { type: Sequelize.DataTypes.STRING(500), allowNull: true, comment: '匹配到的本地邮件message-id' });
      await addReply('clean_body_text', { type: Sequelize.DataTypes.TEXT('medium'), allowNull: true, comment: '对方本次新写内容' });
      await addReply('body_html', { type: Sequelize.DataTypes.TEXT('medium'), allowNull: true, comment: '清洗后可展示HTML' });
      await addReply('quoted_body_text', { type: Sequelize.DataTypes.TEXT('medium'), allowNull: true, comment: '携带的旧沟通记录' });
      await addReply('signature_text', { type: Sequelize.DataTypes.TEXT, allowNull: true });
      await addReply('raw_source', { type: Sequelize.DataTypes.TEXT('long'), allowNull: true, comment: 'RFC822原始源，供日后重解析；附件内容不存' });
      await addReply('parse_status', { type: Sequelize.DataTypes.STRING(20), allowNull: false, defaultValue: 'ok', comment: 'ok/failed/legacy' });
      await addReply('parse_error', { type: Sequelize.DataTypes.TEXT, allowNull: true });
      // 存量行未经过新标准解析：仅首次加列时整体标记 legacy，供列表接口走旧兼容清洗
      if (!columns.parse_status) {
        await queryInterface.sequelize.query(
          "UPDATE email_replies SET parse_status = 'legacy' WHERE clean_body_text IS NULL"
        );
      }
      if (!columns.thread_id) {
        await queryInterface.addIndex('email_replies', ['thread_id'], { name: 'idx_email_replies_thread' });
      }
    }

    // 发件记录（email_records）：线程关联 + 发送时的回复链头
    if (tables.includes('email_records')) {
      const columns = await queryInterface.describeTable('email_records');
      const addRecord = async (name, definition) => {
        if (!columns[name]) await queryInterface.addColumn('email_records', name, definition);
      };
      await addRecord('thread_id', { type: Sequelize.DataTypes.INTEGER, allowNull: true });
      await addRecord('in_reply_to', { type: Sequelize.DataTypes.STRING(500), allowNull: true });
      await addRecord('references_json', { type: Sequelize.DataTypes.TEXT, allowNull: true });
      if (!columns.thread_id) {
        await queryInterface.addIndex('email_records', ['thread_id'], { name: 'idx_email_records_thread' });
      }
    }

    // 草稿（email_drafts）：线程关联 + 生成时上下文快照
    if (tables.includes('email_drafts')) {
      const columns = await queryInterface.describeTable('email_drafts');
      const addDraft = async (name, definition) => {
        if (!columns[name]) await queryInterface.addColumn('email_drafts', name, definition);
      };
      await addDraft('thread_id', { type: Sequelize.DataTypes.INTEGER, allowNull: true });
      await addDraft('reply_to_message_id', { type: Sequelize.DataTypes.STRING(500), allowNull: true });
      await addDraft('context_message_ids', { type: Sequelize.DataTypes.TEXT, allowNull: true, comment: '上下文消息ID数组JSON' });
      await addDraft('context_summary_snapshot', { type: Sequelize.DataTypes.TEXT, allowNull: true });
    }
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (tables.includes('email_threads')) await queryInterface.dropTable('email_threads');

    const dropColumns = async (table, names) => {
      if (!tables.includes(table)) return;
      const columns = await queryInterface.describeTable(table);
      for (const name of names) {
        if (columns[name]) await queryInterface.removeColumn(table, name);
      }
    };
    await dropColumns('email_replies', [
      'parse_error', 'parse_status', 'raw_source', 'signature_text',
      'quoted_body_text', 'body_html', 'clean_body_text',
      'reply_to_message_id', 'references_json', 'in_reply_to', 'thread_id'
    ]);
    await dropColumns('email_records', ['references_json', 'in_reply_to', 'thread_id']);
    await dropColumns('email_drafts', [
      'context_summary_snapshot', 'context_message_ids', 'reply_to_message_id', 'thread_id'
    ]);
  }
};
