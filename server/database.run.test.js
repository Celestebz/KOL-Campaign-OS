// dbOperations.run 对 mysql2 两种返回形态的兼容回归：
// INSERT 返回 [insertId, affectedRows]（数字），UPDATE/DELETE 返回 ResultSetHeader 对象。
const test = require('node:test');
const assert = require('node:assert/strict');
const { dbOperations, sequelize } = require('./database');

const originalQuery = sequelize.query;

test.afterEach(() => {
  sequelize.query = originalQuery;
});

test('run() reads affectedRows from ResultSetHeader objects (UPDATE/DELETE)', async () => {
  sequelize.query = async () => [
    { fieldCount: 0, affectedRows: 3, insertId: 0, changedRows: 2 },
    { fieldCount: 0, affectedRows: 3, insertId: 0, changedRows: 2 }
  ];
  const result = await dbOperations.run('UPDATE email_drafts SET status = ? WHERE id = ?', ['x', 1]);
  assert.deepEqual(result, { id: 0, changes: 3 });
});

test('run() returns changes 0 when the ResultSetHeader reports no match', async () => {
  sequelize.query = async () => [
    { fieldCount: 0, affectedRows: 0, insertId: 0, changedRows: 0 },
    { fieldCount: 0, affectedRows: 0, insertId: 0, changedRows: 0 }
  ];
  const result = await dbOperations.run('UPDATE email_drafts SET status = ? WHERE id = ?', ['x', 99999]);
  assert.equal(result.changes, 0);
});

test('run() keeps numeric INSERT results working (insertId + affectedRows)', async () => {
  sequelize.query = async () => [42, 1];
  const result = await dbOperations.run('INSERT INTO email_replies (from_address) VALUES (?)', ['a@b.c']);
  assert.deepEqual(result, { id: 42, changes: 1 });
});
