const test = require('node:test');
const assert = require('node:assert/strict');
const { dbOperations } = require('../database');
const service = require('./emailFilterService');

function withPatchedDb(patch, fn) {
  const originals = {};
  for (const key of Object.keys(patch)) {
    originals[key] = dbOperations[key];
    dbOperations[key] = patch[key];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of Object.keys(originals)) dbOperations[key] = originals[key];
  });
}

test('addRule normalizes sender and domain rules', async () => {
  const writes = [];
  await withPatchedDb({
    run: async (sql, params) => { writes.push({ sql, params }); return { changes: 1 }; }
  }, async () => {
    assert.deepEqual(await service.addRule('sender', ' Ads@Example.COM '), {
      rule_type: 'sender', rule_value: 'ads@example.com'
    });
    assert.deepEqual(await service.addRule('domain', '@Marketing.Example.com'), {
      rule_type: 'domain', rule_value: 'marketing.example.com'
    });
  });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].params[0], 'sender');
  assert.equal(writes[1].params[1], 'marketing.example.com');
});

test('addRule rejects invalid values', async () => {
  await assert.rejects(() => service.addRule('sender', 'not-an-email'), /有效的邮箱地址/);
  await assert.rejects(() => service.addRule('domain', 'localhost'), /有效的邮箱域名/);
});

test('markSpam creates selected rule and moves reply to blocked classification', async () => {
  const writes = [];
  await withPatchedDb({
    get: async (sql) => (sql.includes('email_replies') ? { id: 7, from_address: 'offer@ads.example.com' } : null),
    run: async (sql, params) => { writes.push({ sql, params }); return { changes: 1 }; }
  }, async () => {
    const result = await service.markSpam(7, { blockScope: 'domain', handledBy: 'boss' });
    assert.deepEqual(result, { id: 7, classification: 'spam' });
  });
  assert.ok(writes.some(({ sql, params }) => sql.includes('email_filter_rules') && params[1] === 'ads.example.com'));
  assert.ok(writes.some(({ sql }) => sql.includes("classification = 'spam'") && sql.includes("confirm_status = 'spam'")));
});

test('restoreReply returns a blocked email to manual review', async () => {
  const writes = [];
  await withPatchedDb({
    get: async () => ({ id: 9 }),
    run: async (sql, params) => { writes.push({ sql, params }); return { changes: 1 }; }
  }, async () => service.restoreReply(9));
  assert.match(writes[0].sql, /classification = 'needs_review'/);
  assert.match(writes[0].sql, /confirm_status = 'pending'/);
  assert.deepEqual(writes[0].params, [9]);
});

test('rule management lists, disables, and deletes rules', async () => {
  const writes = [];
  await withPatchedDb({
    query: async () => [{ id: 2, rule_type: 'sender', rule_value: 'ads@example.com', active: 1 }],
    get: async () => ({ id: 2 }),
    run: async (sql, params) => { writes.push({ sql, params }); return { changes: 1 }; }
  }, async () => {
    assert.equal((await service.listRules()).length, 1);
    assert.deepEqual(await service.setRuleActive(2, false), { id: 2, active: false });
    await service.deleteRule(2);
  });
  assert.deepEqual(writes[0].params, [0, 2]);
  assert.match(writes[1].sql, /DELETE FROM email_filter_rules/);
});
