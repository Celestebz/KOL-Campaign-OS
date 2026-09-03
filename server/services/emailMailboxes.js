// 多邮箱解析：所有"取邮箱配置"的统一入口。
// 规则：默认邮箱 = is_default=1 的行（兜底最早一行）；
// 草稿/发送解析链：回复继承来信邮箱 → Campaign 绑定 → 默认邮箱；
// 候选行不存在或已停用（enabled=0）时沿链回退。
const { dbOperations } = require("../database");

async function getDefaultMailbox(ownerUserId = null) {
  const ownerWhere = ownerUserId ? ' AND owner_user_id = ?' : '';
  const ownerParams = ownerUserId ? [ownerUserId] : [];
  const row = await dbOperations.get(`SELECT * FROM email_settings WHERE is_default = 1${ownerWhere} ORDER BY id LIMIT 1`, ownerParams);
  if (row) return row;
  return dbOperations.get(`SELECT * FROM email_settings${ownerUserId ? ' WHERE owner_user_id = ?' : ''} ORDER BY id LIMIT 1`, ownerParams);
}

async function getMailboxById(id, ownerUserId = null) {
  if (!id) return null;
  return dbOperations.get(`SELECT * FROM email_settings WHERE id = ?${ownerUserId ? ' AND owner_user_id = ?' : ''}`, ownerUserId ? [id, ownerUserId] : [id]);
}

async function listMailboxes({ enabledOnly = false, ownerUserId = null } = {}) {
  const conditions = [];
  const params = [];
  if (enabledOnly) conditions.push('enabled = 1');
  if (ownerUserId) { conditions.push('owner_user_id = ?'); params.push(ownerUserId); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return dbOperations.query(`SELECT * FROM email_settings ${where} ORDER BY is_default DESC, id`, params);
}

async function getEnabledMailboxOrNull(id) {
  const row = await getMailboxById(id);
  return row && row.enabled ? row : null;
}

async function resolveMailboxForDraft({ campaignId = null, sourceReplyId = null, ownerUserId = null } = {}) {
  if (sourceReplyId) {
    const reply = await dbOperations.get("SELECT mailbox_id FROM email_replies WHERE id = ?", [sourceReplyId]);
    const row = await getMailboxById(reply?.mailbox_id, ownerUserId);
    if (row?.enabled) return row;
  }
  if (campaignId) {
    const campaign = await dbOperations.get("SELECT mailbox_id FROM campaigns WHERE id = ?", [campaignId]);
    const row = await getMailboxById(campaign?.mailbox_id, ownerUserId);
    if (row?.enabled) return row;
  }
  return getDefaultMailbox(ownerUserId);
}

module.exports = { getDefaultMailbox, getMailboxById, listMailboxes, resolveMailboxForDraft };
