// 邮件审批台 P1：邮箱配置、模板（写作规范/固定模板）、AI草稿、发送记录、回复、草稿版本六张表；
// campaign_kols 增加最近外联时间、跟进次数、最近回复摘要三列。
const STYLE_GUIDE_BODY = `三段式：第一句自我介绍加来意并引用达人1-2条真实视频；中段说清能提供什么（免费寄样归达人、5%佣金、明确说明无固定费、一条完播视频及截止日期）；最后一句call to action（回复即发规格，或确认设备兼容性）。
自然语言连贯段落，不用列表符号、不用破折号，简单口语化表达，正文不超过120个英文单词。
只允许引用上下文里给出的真实视频标题和数据，禁止编造。
草坪养护类达人必须在CTA中确认是否有15-45HP PTO拖拉机。`;

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const tables = (await queryInterface.showAllTables()).map(String);
    const has = (name) => tables.includes(name);

    if (!has('email_settings')) {
      await queryInterface.createTable('email_settings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        smtp_host: { type: DataTypes.STRING(255), comment: 'SMTP服务器' },
        smtp_port: { type: DataTypes.INTEGER, defaultValue: 465, comment: 'SMTP端口' },
        smtp_secure: { type: DataTypes.BOOLEAN, defaultValue: true, comment: 'SMTP是否SSL' },
        imap_host: { type: DataTypes.STRING(255), comment: 'IMAP服务器' },
        imap_port: { type: DataTypes.INTEGER, defaultValue: 993, comment: 'IMAP端口' },
        imap_secure: { type: DataTypes.BOOLEAN, defaultValue: true, comment: 'IMAP是否TLS' },
        username: { type: DataTypes.STRING(255), comment: '邮箱账号' },
        password: { type: DataTypes.TEXT, comment: '三方客户端安全密码' },
        sender_name: { type: DataTypes.STRING(255), comment: '发件人显示名' },
        default_cc: { type: DataTypes.TEXT, comment: '默认抄送' },
        poll_interval_minutes: { type: DataTypes.INTEGER, defaultValue: 5, comment: 'IMAP轮询间隔分钟，0关闭' },
        last_poll_at: { type: DataTypes.DATE, comment: '最近轮询时间' },
        created_at: { type: DataTypes.DATE },
        updated_at: { type: DataTypes.DATE }
      });
    }

    if (!has('email_templates')) {
      await queryInterface.createTable('email_templates', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: DataTypes.STRING(255), allowNull: false, comment: '模板名称' },
        kind: { type: DataTypes.STRING(20), defaultValue: 'fixed', comment: 'style_guide写作规范/fixed固定模板' },
        subject: { type: DataTypes.STRING(500), comment: '邮件主题（fixed用）' },
        body_html: { type: DataTypes.TEXT, allowNull: false, comment: '写作规范内容或正文HTML' },
        created_at: { type: DataTypes.DATE },
        updated_at: { type: DataTypes.DATE }
      });
    }

    if (!has('email_drafts')) {
      await queryInterface.createTable('email_drafts', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        campaign_id: { type: DataTypes.INTEGER, allowNull: false, comment: '项目ID' },
        customer_id: { type: DataTypes.INTEGER, allowNull: false, comment: '达人ID' },
        kind: { type: DataTypes.STRING(20), allowNull: false, comment: 'first_touch/follow_up/reply' },
        subject: { type: DataTypes.STRING(500), comment: '邮件主题' },
        body_text: { type: DataTypes.TEXT, comment: '邮件正文纯文本' },
        status: { type: DataTypes.STRING(20), defaultValue: 'pending_review', comment: 'pending_review/approved/rejected/sent/send_failed' },
        risk_level: { type: DataTypes.STRING(10), defaultValue: 'none', comment: 'none/low/high' },
        risk_reasons: { type: DataTypes.TEXT, comment: 'JSON数组 [{code,message}]' },
        evidence: { type: DataTypes.TEXT, comment: 'JSON 证据：快照日期/引用视频/指标/匹配理由' },
        source_reply_id: { type: DataTypes.INTEGER, comment: 'reply类草稿来源回复ID' },
        template_id: { type: DataTypes.INTEGER, comment: '使用的写作规范模板ID' },
        prompt_version: { type: DataTypes.STRING(50), comment: '提示词版本' },
        ai_model: { type: DataTypes.STRING(100), comment: '生成所用模型' },
        reviewer_note: { type: DataTypes.TEXT, comment: '审批备注/驳回原因' },
        generated_at: { type: DataTypes.DATE, comment: 'AI生成时间' },
        reviewed_at: { type: DataTypes.DATE, comment: '人工审批时间' },
        created_at: { type: DataTypes.DATE },
        updated_at: { type: DataTypes.DATE }
      });
      await queryInterface.addIndex('email_drafts', ['campaign_id', 'status']);
      await queryInterface.addIndex('email_drafts', ['customer_id']);
    }

    if (!has('email_records')) {
      await queryInterface.createTable('email_records', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        draft_id: { type: DataTypes.INTEGER, comment: '来源草稿ID' },
        campaign_id: { type: DataTypes.INTEGER, comment: '项目ID' },
        customer_id: { type: DataTypes.INTEGER, comment: '达人ID' },
        kol_name: { type: DataTypes.STRING(255), comment: '达人名称快照' },
        to_address: { type: DataTypes.STRING(255), comment: '收件人' },
        cc: { type: DataTypes.TEXT, comment: '实际抄送' },
        subject: { type: DataTypes.STRING(500), comment: '实际发送主题' },
        body_text: { type: DataTypes.TEXT, comment: '实际发送正文' },
        status: { type: DataTypes.STRING(20), allowNull: false, comment: 'success/failed' },
        error: { type: DataTypes.TEXT, comment: '失败原因' },
        smtp_message_id: { type: DataTypes.STRING(500), comment: 'SMTP返回Message-ID' },
        created_at: { type: DataTypes.DATE }
      });
      await queryInterface.addIndex('email_records', ['customer_id']);
      await queryInterface.addIndex('email_records', ['to_address']);
    }

    if (!has('email_replies')) {
      await queryInterface.createTable('email_replies', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        email_record_id: { type: DataTypes.INTEGER, comment: '匹配到的发送记录' },
        campaign_id: { type: DataTypes.INTEGER, comment: '项目ID' },
        customer_id: { type: DataTypes.INTEGER, allowNull: false, comment: '达人ID' },
        from_address: { type: DataTypes.STRING(255), allowNull: false, comment: '发件人' },
        message_id: { type: DataTypes.STRING(500), comment: '邮件Message-ID，幂等去重' },
        subject: { type: DataTypes.STRING(500), comment: '回复主题' },
        body_text: { type: DataTypes.TEXT, comment: '纯文本正文，截断8000字符' },
        received_at: { type: DataTypes.DATE, comment: '收信时间' },
        ai_status: { type: DataTypes.STRING(20), defaultValue: 'pending', comment: 'pending/success/failed' },
        ai_summary: { type: DataTypes.TEXT, comment: 'AI摘要' },
        ai_intent: { type: DataTypes.STRING(20), comment: 'interested/question/rejected/other' },
        confirm_status: { type: DataTypes.STRING(20), defaultValue: 'pending', comment: 'pending/confirmed/ignored' },
        confirmed_summary: { type: DataTypes.TEXT, comment: '人工确认后的摘要' },
        created_at: { type: DataTypes.DATE },
        updated_at: { type: DataTypes.DATE }
      });
      await queryInterface.addIndex('email_replies', ['customer_id']);
      await queryInterface.addIndex('email_replies', ['confirm_status']);
      await queryInterface.addIndex('email_replies', ['message_id']);
    }

    if (!has('email_draft_versions')) {
      await queryInterface.createTable('email_draft_versions', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        draft_id: { type: DataTypes.INTEGER, allowNull: false, comment: '草稿ID' },
        subject: { type: DataTypes.STRING(500) },
        body_text: { type: DataTypes.TEXT },
        source: { type: DataTypes.STRING(20), comment: 'ai/human/regenerate' },
        feedback: { type: DataTypes.TEXT, comment: '重新生成时的人工反馈' },
        created_at: { type: DataTypes.DATE }
      });
      await queryInterface.addIndex('email_draft_versions', ['draft_id']);
    }

    const ck = await queryInterface.describeTable('campaign_kols');
    if (!ck.last_outreach_at) {
      await queryInterface.addColumn('campaign_kols', 'last_outreach_at', { type: DataTypes.DATE, comment: '最近一次外联发送时间' });
    }
    if (!ck.follow_up_count) {
      await queryInterface.addColumn('campaign_kols', 'follow_up_count', { type: DataTypes.INTEGER, defaultValue: 0, comment: '跟进邮件次数' });
    }
    if (!ck.last_reply_summary) {
      await queryInterface.addColumn('campaign_kols', 'last_reply_summary', { type: DataTypes.TEXT, comment: '最近一封已确认回复的摘要，同步飞书跟进记录' });
    }

    const [styleGuide] = await queryInterface.sequelize.query(
      "SELECT id FROM email_templates WHERE kind = 'style_guide' LIMIT 1"
    );
    if (!styleGuide.length) {
      await queryInterface.sequelize.query(
        `INSERT INTO email_templates (name, kind, subject, body_html, created_at, updated_at)
         VALUES ('外联邮件写作规范 v1', 'style_guide', '', ?, NOW(), NOW())`,
        { replacements: [STYLE_GUIDE_BODY] }
      );
    }
  },

  async down(queryInterface) {
    const ck = await queryInterface.describeTable('campaign_kols');
    for (const col of ['last_outreach_at', 'follow_up_count', 'last_reply_summary']) {
      if (ck[col]) await queryInterface.removeColumn('campaign_kols', col);
    }
    for (const table of ['email_draft_versions', 'email_replies', 'email_records', 'email_drafts', 'email_templates', 'email_settings']) {
      await queryInterface.dropTable(table, { cascade: true }).catch(() => {});
    }
  }
};
