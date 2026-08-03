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

// ---- recordManualOutreach ----

test('recordManualOutreach bumps follow_up_count and writes nothing else when no audit info', async () => {
  const writes = [];
  const queries = [];
  const state = { follow_up_count: 0 };
  await withPatchedDb({
    query: async (sql, params) => { queries.push({ sql, params }); return []; },
    run: async (sql, params) => {
      writes.push({ sql, params });
      if (/UPDATE campaign_kols/.test(sql) && /follow_up_count/.test(sql)) {
        state.follow_up_count += 1;
      }
      return { changes: 1 };
    },
    get: async (sql, params) => {
      if (/FROM campaign_kols WHERE id = \?/.test(sql)) {
        return {
          id: params[0],
          campaign_id: 3,
          customer_id: 11,
          follow_up_count: state.follow_up_count,
          outreach_status: 'contacted'
        };
      }
      if (/FROM customers WHERE id = \?/.test(sql)) {
        return { id: 11, name: 'Creator', email: 'c@example.com' };
      }
      return null;
    }
  }, async () => {
    const result = await followUp.recordManualOutreach({ campaignKolId: 42 });
    assert.equal(result.campaign_kol_id, 42);
    assert.equal(result.follow_up_count, 1);
    const increment = writes.find((w) => /UPDATE campaign_kols/.test(w.sql) && /follow_up_count/.test(w.sql));
    assert.ok(increment, 'must bump follow_up_count');
    assert.deepEqual(increment.params, [42]);
    const audit = writes.find((w) => /INSERT INTO email_records/.test(w.sql));
    assert.equal(audit, undefined, 'no audit fields → no email_records insert');
  });
});

test('recordManualOutreach writes an email_records audit row when subject/body/note supplied', async () => {
  const writes = [];
  await withPatchedDb({
    query: async () => [],
    run: async (sql, params) => { writes.push({ sql, params }); return { changes: 1 }; },
    get: async (sql, params) => {
      if (/FROM campaign_kols WHERE id = \?/.test(sql)) {
        return { id: params[0], campaign_id: 3, customer_id: 11, follow_up_count: 1, outreach_status: 'waiting_reply' };
      }
      if (/FROM customers WHERE id = \?/.test(sql)) {
        return { id: 11, name: 'Creator', email: 'c@example.com' };
      }
      return null;
    }
  }, async () => {
    await followUp.recordManualOutreach({
      campaignKolId: 42,
      subject: 'Re: 跟进',
      bodyText: '再问一次',
      note: 'IM 后已发邮件'
    });
    const audit = writes.find((w) => /INSERT INTO email_records/.test(w.sql));
    assert.ok(audit, 'must insert email_records');
    // Params: [campaign_id, customer_id, kol_name, to_address, subject, body_text, error_note]
    assert.equal(audit.params[0], 3, 'campaign_id');
    assert.equal(audit.params[1], 11, 'customer_id');
    assert.equal(audit.params[2], 'Creator', 'kol_name');
    assert.equal(audit.params[3], 'c@example.com', 'to_address');
    assert.equal(audit.params[4], 'Re: 跟进', 'subject');
    assert.equal(audit.params[5], '再问一次', 'body_text');
    assert.equal(audit.params[6], 'IM 后已发邮件', 'note');
  });
});

test('recordManualOutreach rejects when a confirmed reply already exists', async () => {
  await withPatchedDb({
    query: async () => [],
    run: async () => ({ changes: 1 }),
    get: async (sql, params) => {
      if (/FROM campaign_kols WHERE id = \?/.test(sql)) {
        return { id: 42, campaign_id: 3, customer_id: 11, follow_up_count: 0, outreach_status: 'contacted' };
      }
      if (/FROM email_replies/.test(sql)) return { id: 99 };
      return null;
    }
  }, async () => {
    await assert.rejects(
      () => followUp.recordManualOutreach({ campaignKolId: 42 }),
      (error) => error.statusCode === 409 && /确认回复/.test(error.message)
    );
  });
});

test('recordManualOutreach rejects on hard bounce', async () => {
  await withPatchedDb({
    query: async () => [],
    run: async () => ({ changes: 1 }),
    get: async (sql, params) => {
      if (/FROM campaign_kols WHERE id = \?/.test(sql)) {
        return { id: 42, campaign_id: 3, customer_id: 11, follow_up_count: 0, outreach_status: 'contacted' };
      }
      if (/FROM email_replies/.test(sql)) return null;
      if (/FROM email_bounces/.test(sql)) return { id: 7 };
      return null;
    }
  }, async () => {
    await assert.rejects(
      () => followUp.recordManualOutreach({ campaignKolId: 42 }),
      (error) => error.statusCode === 409 && /硬退信/.test(error.message)
    );
  });
});

test('recordManualOutreach rejects when follow_up_count already at cap', async () => {
  await withPatchedDb({
    query: async () => [],
    run: async () => ({ changes: 1 }),
    get: async (sql, params) => {
      if (/FROM campaign_kols WHERE id = \?/.test(sql)) {
        return { id: 42, campaign_id: 3, customer_id: 11, follow_up_count: 2, outreach_status: 'contacted' };
      }
      return null;
    }
  }, async () => {
    await assert.rejects(
      () => followUp.recordManualOutreach({ campaignKolId: 42 }),
      (error) => error.statusCode === 409 && /上限/.test(error.message)
    );
  });
});

test('recordManualOutreach throws 404 when the candidate row does not exist', async () => {
  await withPatchedDb({
    query: async () => [],
    run: async () => ({ changes: 1 }),
    get: async () => null
  }, async () => {
    await assert.rejects(
      () => followUp.recordManualOutreach({ campaignKolId: 9999 }),
      (error) => error.statusCode === 404
    );
  });
});
