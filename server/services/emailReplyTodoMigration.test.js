const test = require('node:test');
const assert = require('node:assert/strict');

const migration = require('../migrations/20260729000001-separate-email-reply-todo');

test('email reply todo migration adds fields and backfills legacy waiting states', async () => {
  const added = [];
  const queries = [];
  const queryInterface = {
    showAllTables: async () => ['campaign_kols'],
    describeTable: async () => ({ outreach_status: {} }),
    addColumn: async (table, name, definition) => { added.push({ table, name, definition }); },
    sequelize: { query: async (sql) => { queries.push(String(sql)); } }
  };
  await migration.up(queryInterface, { DataTypes: { BOOLEAN: 'BOOLEAN', DATE: 'DATE' } });

  assert.deepEqual(added.map(({ name }) => name), ['needs_reply', 'last_inbound_at']);
  assert.match(queries[0], /needs_reply = 1/);
  assert.match(queries[0], /outreach_status = 'negotiating'/);
  assert.match(queries[0], /'waiting_reply', 'replied'/);
});
