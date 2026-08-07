// 多邮箱解析：所有"取邮箱配置"的统一入口。
// 规则：默认邮箱 = is_default=1 的行（兜底最早一行）；
// 草稿/发送解析链：回复继承来信邮箱 → Campaign 绑定 → 默认邮箱；
// 候选行不存在或已停用（enabled=0）时沿链回退。
const { dbOperations } = require("../database");

async function getDefaultMailbox() {
  const row = await dbOperations.get("SELECT * FROM email_settings WHERE is_default = 1 ORDER BY id LIMIT 1");
  if (row) return row;
  return dbOperations.get("SELECT * FROM email_settings ORDER BY id LIMIT 1");
}

async function getMailboxById(id) {
  if (!id) return null;
  return dbOperations.get("SELECT * FROM email_settings WHERE id = ?", [id]);
}

async function listMailboxes({ enabledOnly = false } = {}) {
  const where = enabledOnly ? "WHERE enabled = 1" : "";
  return dbOperations.query(`SELECT * FROM email_settings ${where} ORDER BY is_default DESC, id`);
}

async function getEnabledMailboxOrNull(id) {
  const row = await getMailboxById(id);
  return row && row.enabled ? row : null;
}

async function resolveMailboxForDraft({ campaignId = null, sourceReplyId = null } = {}) {
  if (sourceReplyId) {
    const reply = await dbOperations.get("SELECT mailbox_id FROM email_replies WHERE id = ?", [sourceReplyId]);
    const row = await getEnabledMailboxOrNull(reply?.mailbox_id);
    if (row) return row;
  }
  if (campaignId) {
    const campaign = await dbOperations.get("SELECT mailbox_id FROM campaigns WHERE id = ?", [campaignId]);
    const row = await getEnabledMailboxOrNull(campaign?.mailbox_id);
    if (row) return row;
  }
  return getDefaultMailbox();
}

module.exports = { getDefaultMailbox, getMailboxById, listMailboxes, resolveMailboxForDraft };
