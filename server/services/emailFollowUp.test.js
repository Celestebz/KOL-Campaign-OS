const test = require('node:test');
const assert = require('node:assert/strict');
const { dbOperations } = require('../database');
const emailDrafter = require('../services/emailDrafter');
const followUp = require('../services/emailFollowUp');

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

test('scanOnce drafts follow-ups, increments follow_up_count, skips drafter failures', async () => {
  const draftedArgs = [];
  const original = emailDrafter.draftForCustomer;
  emailDrafter.draftForCustomer = async (args) => {
    draftedArgs.push(args);
    return args.customerId === 8 ? { ok: false, error: 'AI 超时' } : { ok: true, draftId: 50 };
  };
  const statements = [];
  const queries = [];
  try {
    await withPatchedDb({
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (/INTERVAL \? HOUR/.test(sql)) {
          return [
            { campaign_id: 2, customer_id: 7, follow_up_count: 0, last_outreach_at: new Date() },
            { campaign_id: 2, customer_id: 8, follow_up_count: 1, last_outreach_at: new Date() }
          ];
        }
        return [{ campaign_id: 2, customer_id: 9, last_outreach_at: new Date() }]; // give-up 查询
      },
      run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
    }, async () => {
      const result = await followUp.scanOnce();
      assert.equal(result.drafted, 1);
      assert.equal(result.giveUps, 1);
    });
  } finally {
    emailDrafter.draftForCustomer = original;
  }

  assert.deepEqual(draftedArgs.map((a) => [a.campaignId, a.customerId, a.kind]), [[2, 7, 'follow_up'], [2, 8, 'follow_up']]);
  // 仅起草成功的那条回写 follow_up_count
  const increments = statements.filter((s) => /UPDATE campaign_kols SET follow_up_count/.test(s.sql));
  assert.equal(increments.length, 1);
  assert.deepEqual(increments[0].params, [2, 7]);

  const scanSql = queries[0].sql;
  assert.match(scanSql, /confirm_status = 'confirmed'/);
  assert.match(scanSql, /d\.kind = 'follow_up'/);
  assert.deepEqual(queries[0].params, [48, 5, 2]);
  assert.deepEqual(queries[1].params, [5]);
});

test('scanOnce with no candidates does nothing', async () => {
  const original = emailDrafter.draftForCustomer;
  let called = 0;
  emailDrafter.draftForCustomer = async () => { called += 1; return { ok: true }; };
  try {
    await withPatchedDb({
      query: async () => [],
      run: async () => { throw new Error('不应有写操作'); }
    }, async () => {
      const result = await followUp.scanOnce();
      assert.deepEqual(result, { drafted: 0, giveUps: 0 });
    });
  } finally {
    emailDrafter.draftForCustomer = original;
  }
  assert.equal(called, 0);
});
