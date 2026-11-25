const { sequelize } = require('../database');
const { QueryTypes } = require('sequelize');
const { sanitizeBindParams } = require('../utils/mysqlDateTime');

function createStore(transaction = null, database = sequelize) {
  const select = (sql, replacements) => database.query(sql, { replacements: sanitizeBindParams(replacements), transaction, type: QueryTypes.SELECT, logging: false });
  const get = async (sql, replacements) => (await select(sql, replacements))[0] || null;
  const update = async (sql, replacements) => (await database.query(sql, { replacements: sanitizeBindParams(replacements), transaction, type: QueryTypes.UPDATE, logging: false }))[1];
  const insert = (table, values) => database.getQueryInterface().bulkInsert(table, [values], { transaction });
  const lock = transaction ? ' FOR UPDATE' : '';
  return {
    transaction: (fn) => database.transaction((t) => fn(createStore(t, database))),
    insertDevice: (row) => insert('agent_login_devices', row),
    pruneDevices: (before) => database.query('DELETE FROM agent_login_devices WHERE expires_at < ? LIMIT 1000', { replacements: sanitizeBindParams([before]), transaction, logging: false }),
    findDevice: (hash) => get('SELECT * FROM agent_login_devices WHERE device_hash = ?' + lock, [hash]),
    findDeviceByCode: (hash) => get('SELECT * FROM agent_login_devices WHERE user_code_hash = ?', [hash]),
    findUser: (id) => get('SELECT id, status, token_version FROM users WHERE id = ?' + lock, [id]),
    decideDevice: (hash, owner, status, now) => update(
      "UPDATE agent_login_devices SET status = ?, owner_user_id = ? WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ?",
      [status, owner, hash, now]),
    pollDevice: (id, now) => update('UPDATE agent_login_devices SET last_poll_at = ? WHERE id = ?', [now, id]),
    consumeDevice: (id) => update("UPDATE agent_login_devices SET status = 'consumed' WHERE id = ?", [id]),
    insertGrant: (row) => insert('agent_login_grants', row),
    findGrant: (kind, hash) => {
      if (!['access', 'refresh'].includes(kind)) throw new Error('Invalid credential type');
      return get(`SELECT g.*, u.status AS user_status, u.token_version AS user_token_version
        FROM agent_login_grants g JOIN users u ON u.id = g.owner_user_id
        WHERE g.${kind}_hash = ?${lock}`, [hash]);
    },
    renewGrant: (id, hash, expiry) => update('UPDATE agent_login_grants SET access_hash = ?, access_expires_at = ? WHERE id = ?', [hash, expiry, id]),
    listGrants: (owner) => select(`SELECT g.id, g.label, g.created_at, g.refresh_expires_at, g.revoked_at
      FROM agent_login_grants g JOIN users u ON u.id = g.owner_user_id
      WHERE g.owner_user_id = ? AND g.revoked_at IS NULL AND g.refresh_expires_at > CURRENT_TIMESTAMP
        AND u.status = 'active' AND g.token_version = u.token_version ORDER BY g.id DESC`, [owner]),
    revokeGrant: (id, owner, now) => update('UPDATE agent_login_grants SET revoked_at = ? WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL', [now, id, owner])
  };
}
module.exports = { createStore };
