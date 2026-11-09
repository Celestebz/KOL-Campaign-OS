const test = require('node:test');
const assert = require('node:assert/strict');
const { dbOperations } = require('../database');
const service = require('./emailFilterService');
const { runWithUser } = require('../utils/requestContext');
const aiClient = require('./aiClient');

function withPatchedDb(patch, fn) {
  const originals = {};
  for (const key of Object.keys(patch)) {
    originals[key] = dbOperations[key];
    dbOperations[key] = patch[key];
  }
  return Promise.resolve().then(() => runWithUser({ id: 1 }, fn)).finally(() => {
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
  assert.equal(writes[0].params[0], 1);
  assert.equal(writes[0].params[1], 'sender');
  assert.equal(writes[1].params[2], 'marketing.example.com');
});

test('addRule rejects invalid values', async () => {
  await runWithUser({ id: 1 }, async () => {
    await assert.rejects(() => service.addRule('sender', 'not-an-email'), /有效的邮箱地址/);
    await assert.rejects(() => service.addRule('domain', 'localhost'), /有效的邮箱域名/);
  });
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
  assert.ok(writes.some(({ sql, params }) => sql.includes('email_filter_rules') && params[2] === 'ads.example.com'));
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
  assert.deepEqual(writes[0].params, [0, 2, 1]);
  assert.match(writes[1].sql, /DELETE FROM email_filter_rules/);
});

test('AI cannot hide first-contact, Gmail or Drive video messages even when returning spam or system', async t => {
  const original = aiClient.callActiveAi;
  t.after(() => { aiClient.callActiveAi = original; });
  await withPatchedDb({ get: async () => null, run: async () => { throw new Error('AI classification must not create blocking rules'); } }, async () => {
    for (const classification of ['spam', 'system', 'suspected_kol', 'needs_review']) {
      aiClient.callActiveAi = async (_, prompt) => {
        assert.match(prompt, /没有屏蔽或隐藏邮件的权限/);
        return { parsed: { classification, reason: '个人邮箱分享作品' } };
      };
      const result = await service.classifyIncoming({ fromAddress: 'creator@gmail.com', subject: '2nd collaboration video',
        bodyText: 'Here is the Google Drive link to my video for your review.', matched: false });
      assert.equal(result.classification, classification === 'suspected_kol' ? 'suspected_kol' : 'needs_review');
    }
  });
});

test('an explicit manual rule can still block incoming mail without asking AI', async t => {
  const original = aiClient.callActiveAi;
  t.after(() => { aiClient.callActiveAi = original; });
  aiClient.callActiveAi = async () => { throw new Error('AI should not be called'); };
  await withPatchedDb({ get: async () => ({ id: 1, rule_type: 'sender', active: 1 }) }, async () => {
    const result = await service.classifyIncoming({ fromAddress: 'blocked@example.com', subject: 'Hello', bodyText: 'Hello' });
    assert.equal(result.classification, 'spam');
    assert.equal(result.source, 'rule');
  });
});
