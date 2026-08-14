// 历史草稿/发送记录回填邮箱归属：活动已绑定邮箱时，把 mailbox_id 为空的行补上，
// 避免审批台显示未绑定、发送时误落默认邮箱。
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const transaction = await sequelize.transaction();
    try {
      await sequelize.query(
        `UPDATE email_drafts d
         JOIN campaigns c ON c.id = d.campaign_id
         SET d.mailbox_id = c.mailbox_id
         WHERE d.mailbox_id IS NULL AND c.mailbox_id IS NOT NULL`,
        { transaction }
      );
      await sequelize.query(
        `UPDATE email_records r
         JOIN campaigns c ON c.id = r.campaign_id
         SET r.mailbox_id = c.mailbox_id
         WHERE r.mailbox_id IS NULL AND c.mailbox_id IS NOT NULL`,
        { transaction }
      );
      await transaction.commit();
      console.log('[migration] draft/record mailbox backfill ready');
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down() {
    // 回填不可逆，不做反向操作。
  }
};
