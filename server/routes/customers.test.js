const test = require('node:test');
const assert = require('node:assert/strict');

const customersRoute = require('./customers');

test('normalized platform accounts take precedence and legacy fills missing platforms', () => {
  const customer = {
    id: 7,
    youtube_url: 'https://youtube.com/legacy',
    youtube_followers: '10K',
    instagram_url: 'https://instagram.com/legacy',
    instagram_followers: '5K'
  };
  const normalized = [{
    id: 11,
    customer_id: 7,
    platform: 'youtube',
    username: '@new',
    profile_url: 'https://youtube.com/new',
    followers_text: '20K'
  }];

  assert.deepEqual(customersRoute.mergePlatformAccounts(customer, normalized), [
    {
      id: 11, platform: 'youtube', username: '@new',
      profile_url: 'https://youtube.com/new', followers_text: '20K',
      followers_count: null, source: 'normalized'
    },
    {
      id: null, platform: 'instagram', username: null,
      profile_url: 'https://instagram.com/legacy', followers_text: '5K',
      followers_count: null, source: 'legacy'
    }
  ]);
});

test('project history uses compatibility fields when v2 fields are empty', () => {
  assert.deepEqual(customersRoute.toProjectHistory({
    id: 3,
    campaign_id: 4,
    campaign_name: 'Launch',
    project_status: 'contacted',
    quoted_fee: null,
    quoted_price: '$500',
    final_fee: null,
    price_rmb: '3600',
    project_notes: null,
    notes: 'legacy note'
  }), {
    id: 3,
    campaign_id: 4,
    campaign_name: 'Launch',
    project_status: 'contacted',
    quoted_fee: '$500',
    final_fee: '3600',
    currency: null,
    owner: null,
    best_evidence_url: null,
    youtube_video_link: null,
    instagram_video_link: null,
    tiktok_video_link: null,
    project_notes: 'legacy note',
    created_at: null,
    updated_at: null
  });
});

test('evidence summaries and completed cooperation statuses are normalized for the KOL view', () => {
  assert.equal(
    customersRoute.parseEvidenceSummary(JSON.stringify({ summary: 'Relevant workshop evidence' })),
    'Relevant workshop evidence'
  );
  assert.equal(customersRoute.isHistoricalCooperation({ project_status: 'confirmed' }), true);
  assert.equal(customersRoute.isHistoricalCooperation({ content_status: 'published' }), true);
  assert.equal(customersRoute.isHistoricalCooperation({ project_status: 'candidate' }), false);
  assert.equal(customersRoute.isActiveProject({ project_status: 'negotiating' }), true);
  assert.equal(customersRoute.isActiveProject({ project_status: 'published' }), false);
  assert.equal(customersRoute.projectStatusLabel('confirmed'), '已确认');
});

test('best SKU fit is selected by approval and score instead of recency', () => {
  const selected = customersRoute.selectBestFit([
    { product_sku: 'TRA-0429', fit_score: 72, decision_status: 'approved', updated_at: '2026-07-23' },
    { product_sku: 'TMB-1401', fit_score: 88, decision_status: 'approved', updated_at: '2026-07-20' }
  ]);
  assert.equal(selected.product_sku, 'TMB-1401');
});

test('creator grade follows the approved median-view and engagement thresholds', () => {
  assert.equal(customersRoute.creatorGrade(5, 50000, 0.03), 'A');
  assert.equal(customersRoute.creatorGrade(3, 15000, 0.015), 'B');
  assert.equal(customersRoute.creatorGrade(8, 14999, 0.2), 'C');
  assert.equal(customersRoute.creatorGrade(2, 100000, 0.1), '待评估');
});

// ---- POST /:id/candidate-pool（KOL 总表加入项目候选池）----
const { dbOperations } = require('../database');

function findRouteHandler(router, method, path) {
  const layer = router.stack.find((item) => (
    item.route?.path === path && item.route?.methods?.[method]
  ));
  assert.ok(layer, `Missing ${method.toUpperCase()} ${path} handler`);
  return layer.route.stack[0].handle;
}

function invoke(handler, { body = {}, params = {} } = {}) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; resolve(this); return this; }
    };
    Promise.resolve(handler({ body, params }, response, reject)).catch(reject);
  });
}

async function runCandidatePool({
  customer = { id: 7, name: 'Alice', youtube_url: 'https://youtube.com/@alice' },
  campaign = { id: 2, name: 'TMB-1401｜Finishing Mower', campaign_type: 'active_project', status: 'active' },
  existing = null,
  body = { campaign_id: 2, cooperation_platforms: ['YouTube'], priority_level: 'T1', notes: '适合农场设备内容' },
  accounts = [],
  customerId = 7
} = {}) {
  const writes = [];
  const createdRow = { id: 501, campaign_id: 2, customer_id: 7, pipeline_stage: 'candidate' };
  const originalGet = dbOperations.get;
  const originalQuery = dbOperations.query;
  const originalRun = dbOperations.run;

  dbOperations.get = async (sql) => {
    const text = String(sql);
    if (text.includes('FROM customers WHERE id = ?')) return customer;
    if (text.includes('FROM campaigns WHERE id = ?')) return campaign;
    if (text.includes('FROM campaign_kols WHERE campaign_id = ? AND customer_id = ?')) return existing;
    if (text.includes('FROM campaign_kols WHERE id = ?')) return createdRow;
    return null;
  };
  dbOperations.query = async (sql) => {
    if (String(sql).includes('FROM kol_platform_accounts')) return accounts;
    return [];
  };
  dbOperations.run = async (sql, params = []) => {
    writes.push({ sql: String(sql), params });
    if (String(sql).startsWith('INSERT INTO campaign_kols')) return { id: 501, changes: 1 };
    return { changes: 1 };
  };

  try {
    const handler = findRouteHandler(customersRoute, 'post', '/:id/candidate-pool');
    const response = await invoke(handler, { body, params: { id: String(customerId) } });
    return { response, writes, createdRow };
  } finally {
    dbOperations.get = originalGet;
    dbOperations.query = originalQuery;
    dbOperations.run = originalRun;
  }
}

test('candidate-pool creates a candidate-stage row pending confirmation and sync', async () => {
  const { response, writes } = await runCandidatePool();

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.success, true);
  assert.equal(response.payload.message, '已加入项目候选池');
  assert.equal(response.payload.duplicate, undefined);
  assert.equal(response.payload.warning, null);

  const insert = writes.find((write) => write.sql.startsWith('INSERT INTO campaign_kols'));
  assert.ok(insert, 'expected an INSERT into campaign_kols');
  assert.ok(insert.sql.includes("'candidate'"));
  assert.ok(insert.sql.includes("'pending_confirmation'"));
  assert.ok(insert.sql.includes("'sync_pending'"));
  assert.equal(insert.params[0], 2);
  assert.equal(insert.params[1], 7);
  assert.equal(insert.params[2], 't1', 'priority is normalized to lowercase t-level');
  assert.equal(insert.params[3], JSON.stringify(['youtube']));
  assert.equal(insert.params[4], '适合农场设备内容');

  const customerSync = writes.find((write) => write.sql.includes('UPDATE customers'));
  assert.ok(customerSync, 'expected the KOL master sync_status to be marked pending');
});

test('candidate-pool returns the existing record without creating a duplicate', async () => {
  const existing = { id: 88, campaign_id: 2, customer_id: 7, pipeline_stage: 'candidate' };
  const { response, writes } = await runCandidatePool({ existing });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.success, true);
  assert.equal(response.payload.duplicate, true);
  assert.equal(response.payload.message, '该 KOL 已在此项目候选池中');
  assert.equal(response.payload.data.id, 88);
  assert.equal(writes.filter((write) => write.sql.startsWith('INSERT INTO campaign_kols')).length, 0);
});

test('candidate-pool returns 404 for a missing KOL', async () => {
  const { response } = await runCandidatePool({ customer: null, customerId: 9999 });

  assert.equal(response.statusCode, 404);
  assert.equal(response.payload.success, false);
  assert.ok(response.payload.error.includes('not found'));
});

test('candidate-pool rejects non active_project campaigns', async () => {
  const historical = { id: 20, name: 'BILTHARD 历史合作｜TMA-0560', campaign_type: 'historical_archive', status: 'archived' };
  const { response, writes } = await runCandidatePool({ campaign: historical, body: { campaign_id: 20 } });

  assert.equal(response.statusCode, 400);
  assert.ok(response.payload.error.includes('只有进行中的当前项目才能加入候选池'));
  assert.equal(writes.filter((write) => write.sql.startsWith('INSERT INTO campaign_kols')).length, 0);

  const archived = { id: 1, name: 'Default Campaign', campaign_type: 'system_default', status: 'archived' };
  const { response: response2 } = await runCandidatePool({ campaign: archived, body: { campaign_id: 1 } });
  assert.equal(response2.statusCode, 400);
});

test('candidate-pool warns when the KOL has no primary platform profile', async () => {
  const { response } = await runCandidatePool({
    customer: { id: 678, name: 'K&H Tractors' },
    customerId: 678,
    accounts: []
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.success, true);
  assert.equal(response.payload.warning, '该 KOL 尚未填写主平台主页，飞书中的主页和粉丝数据将为空。');
});
