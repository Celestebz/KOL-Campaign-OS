const assert = require('node:assert/strict');
const test = require('node:test');
const { dbOperations } = require('../database');

function findHandler(router, method, path) {
  const layer = router.stack.find((item) => (
    item.route?.path === path && item.route?.methods?.[method]
  ));
  assert.ok(layer, `Missing ${method.toUpperCase()} ${path} handler`);
  return layer.route.stack[0].handle;
}

function callHandler(handler, { body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        resolve(this);
        return this;
      }
    };
    Promise.resolve(handler({ body }, response, reject)).catch(reject);
  });
}

const feishuConfigRow = {
  provider: 'cloud.feishu_bitable',
  api_key: 'feishu-secret',
  base_url: 'https://open.feishu.cn',
  extra_config: JSON.stringify({
    app_id: 'cli_test',
    app_token: 'base-token',
    kol_table_id: 'tbl_kol_master',
    campaign_subtable_map: { 3: 'tbl_pool_3' },
    campaign_tracking_map: { 3: 'tbl_campaign_kols' }
  })
};

test('migratedKolFields fills new master fields without overwriting existing values', () => {
  const { migratedKolFields } = require('./sync');
  const updates = migratedKolFields({
    主平台: 'YouTube',
    YouTube主页: { link: 'https://youtube.com/@alice', text: 'Alice' },
    Instagram主页: { link: 'https://instagram.com/alice', text: 'Alice' },
    主平台粉丝数: 12300,
    主平台近30天平均曝光: 5000,
    主平台互动率: 0.032,
    Email: 'old@example.com',
    邮箱: 'keep@example.com'
  });
  assert.equal(updates.平台, 'YouTube');
  assert.deepEqual(updates.平台主页链接, { link: 'https://youtube.com/@alice', text: 'Alice' });
  assert.equal(updates.平台账号名, 'alice');
  assert.equal(updates.粉丝数, 12300);
  assert.equal(updates.近30天平均曝光, 5000);
  assert.equal(updates.互动率, 0.032);
  assert.deepEqual(updates.合作平台, ['YouTube', 'Instagram']);
  assert.equal(updates.邮箱, undefined);
});

test('migratedKolFields never replaces populated new master fields', () => {
  const { migratedKolFields } = require('./sync');
  const updates = migratedKolFields({
    主平台: 'YouTube',
    平台: 'TikTok',
    主页链接: { link: 'https://youtube.com/@old', text: 'Old' },
    平台主页链接: { link: 'https://tiktok.com/@new', text: 'New' },
    主平台粉丝数: 100,
    粉丝数: 200,
    合作平台: ['TikTok']
  });
  assert.equal(updates.平台, undefined);
  assert.equal(updates.平台主页链接, undefined);
  assert.equal(updates.粉丝数, undefined);
  assert.equal(updates.合作平台, undefined);
  assert.equal(updates.平台账号名, 'new');
});

function buildCampaignKolRow(overrides = {}) {
  return {
    id: 7,
    campaign_id: 3,
    customer_id: 11,
    raw_candidate_id: 21,
    feishu_record_id: null,
    project_status: 'pending_confirmation',
    priority_level: 't2',
    final_fee: '1000',
    quoted_price: '150.5',
    exchange_rate: '9.1',
    price_rmb: '1369.55',
    owner: 'Celeste',
    notes: '重点推荐',
    project_notes: '第一版项目备注',
    campaign_name: 'Lobster Co',
    kol_name: 'Alice',
    contact_name: 'Alice Manager',
    email: 'alice@example.com',
    country_region: 'UK',
    platform: 'YouTube',
    youtube_url: 'https://youtube.com/@alice',
    youtube_followers: '12300',
    instagram_url: 'https://instagram.com/alice',
    instagram_followers: '8,900',
    tiktok_url: '',
    tiktok_followers: '',
    ...overrides
  };
}

async function runCampaignKolPush(rows, { recordHandler, configRow = feishuConfigRow } = {}) {
  const calls = [];
  const writes = [];
  const originalGet = dbOperations.get;
  const originalQuery = dbOperations.query;
  const originalRun = dbOperations.run;
  const originalFetch = global.fetch;

  dbOperations.get = async () => configRow;
  dbOperations.query = async () => rows;
  dbOperations.run = async (sql, params = []) => {
    writes.push({ sql: String(sql), params });
    return { changes: 1 };
  };
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/tenant_access_token/')) {
      return { ok: true, text: async () => JSON.stringify({ code: 0, tenant_access_token: 'tenant-token' }) };
    }
    if (String(url).includes('/fields') && !options.method) {
      const schema = require('./sync').PROJECT_TRACKING_FIELD_SCHEMA;
      return { ok: true, text: async () => JSON.stringify({ code: 0, data: { items: schema.map((field, index) => ({
        field_id: `fld_${index}`, field_name: field.field_name, type: field.type, property: field.property
      })) } }) };
    }
    if (recordHandler) return recordHandler(String(url), options, calls);
    return { ok: true, text: async () => JSON.stringify({ code: 0, data: { record: { record_id: 'rec_created' } } }) };
  };

  try {
    const handler = findHandler(require('./sync'), 'post', '/feishu/push');
    const response = await callHandler(handler, { body: { scope: 'campaign_kols', ids: rows.map((row) => row.id) } });
    return { response, calls, writes };
  } finally {
    dbOperations.get = originalGet;
    dbOperations.query = originalQuery;
    dbOperations.run = originalRun;
    global.fetch = originalFetch;
  }
}

function pushedFields(calls, index = 0) {
  const recordCalls = calls.filter((call) => call.url.includes('/tables/tbl_campaign_kols/records'));
  assert.ok(recordCalls[index], 'Expected a Bitable record push call');
  return JSON.parse(recordCalls[index].options.body).fields;
}

test('KOL master mapping uses the new business-facing Feishu headers', () => {
  const fields = require('./sync').kolFields({
    name: 'Alice', email: 'alice@example.com', country_region: 'US',
    cooperation_status: 'available', content_category: 'Garden tools',
    current_target_sku: 'TMB-1401', current_fit_score: 91,
    current_fit_reason: 'Strong lawn-care evidence', current_fit_decision: 'approved',
    identity_status: 'known_kol_new_product_fit', current_evidence_url: 'https://youtube.com/watch?v=1',
    covered_platforms: ['YouTube', 'Instagram'], primary_platform: 'YouTube',
    primary_account_name: '@alice', primary_profile_url: 'https://youtube.com/@alice', primary_followers: 12300,
    active_project_count: 2, active_project_summary: 'Summer Garden｜沟通中｜TMB-1401',
    latest_project_updated_at: '2026-07-21T00:00:00.000Z',
    historical_cooperation_count: 2, historical_cooperation_skus: ['CTA-7004', 'TSA-0512'],
    latest_cooperation_project: 'Summer Garden', developer: 'Crush',
    updated_at: '2026-07-22T00:00:00.000Z',
    platform_accounts: [{
      platform: 'youtube', profile_url: 'https://youtube.com/@alice', followers_count: 12300
    }]
  });
  assert.equal(fields['KOL名称'], 'Alice');
  assert.equal(fields['匹配SKU'], 'TMB-1401');
  assert.equal(fields['SKU匹配分'], 91);
  assert.equal(fields['历史合作次数'], 2);
  assert.equal(fields['历史合作SKU'], 'CTA-7004、TSA-0512');
  assert.equal(fields['识别状态'], '已有 KOL · 新产品匹配');
  assert.equal(fields['主平台'], 'YouTube');
  assert.deepEqual(fields['覆盖平台'], ['YouTube', 'Instagram']);
  assert.equal(fields['平台账号名'], '@alice');
  assert.equal(fields['粉丝数'], 12300);
  assert.equal(fields['进行中项目数'], 2);
  assert.deepEqual(fields['平台主页链接'], {
    link: 'https://youtube.com/@alice', text: 'https://youtube.com/@alice'
  });
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '代表证据'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fields, 'SKU审核结果'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '账号Handle'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '近30天中位曝光'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '项目状态'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '推荐内容角度'), false);
});

test('KOL field initializer creates only missing fields and is idempotent by name and type', async () => {
  const syncRoute = require('./sync');
  assert.ok(syncRoute.KOL_MASTER_FIELD_SCHEMA.length >= 29);
  const missing = syncRoute.KOL_MASTER_FIELD_SCHEMA.at(-1);
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (!options.method) {
      return { ok: true, text: async () => JSON.stringify({
        code: 0,
        data: { items: syncRoute.KOL_MASTER_FIELD_SCHEMA.slice(0, -1).map((field) => ({ ...field, field_id: `fld_${field.field_name}` })) }
      }) };
    }
    return { ok: true, text: async () => JSON.stringify({
      code: 0, data: { field: { ...missing, field_id: 'fld_created' } }
    }) };
  };
  try {
    const summary = await syncRoute.ensureKolMasterFields({
      base_url: 'https://open.feishu.cn', app_token: 'base', kol_table_id: 'tbl'
    }, 'token');
    assert.deepEqual(summary.created, [missing.field_name]);
    assert.equal(summary.existing.length, syncRoute.KOL_MASTER_FIELD_SCHEMA.length - 1);
    assert.equal(calls.filter((call) => call.options.method === 'POST').length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('KOL field initializer reports type conflicts without modifying the field', async () => {
  const syncRoute = require('./sync');
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({
    code: 0, data: { items: [{ field_id: 'fld_bad', field_name: '粉丝数', type: 1 }] }
  }) });
  try {
    await assert.rejects(
      syncRoute.ensureKolMasterFields({ base_url: 'https://open.feishu.cn', app_token: 'base', kol_table_id: 'tbl' }, 'token'),
      /粉丝数/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('campaign KOL push sends hyperlinks as link/text objects and numbers as numbers', async () => {
  const { response, calls } = await runCampaignKolPush([buildCampaignKolRow({ project_status: 'pending_shipping' })]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.failed_count, 0, JSON.stringify(response.payload.data.results));

  const fields = pushedFields(calls);
  assert.equal(fields['粉丝数'], 12300);
  assert.equal(fields['KOL合作费'], 1000);
  assert.equal(fields['优先级'], 'T2');
  assert.deepEqual(fields['主平台主页'], {
    link: 'https://youtube.com/@alice', text: 'https://youtube.com/@alice'
  });
  assert.equal(fields['项目状态'], '待发货');
  assert.equal(typeof fields['项目状态'], 'string');
  assert.equal(fields['达人名称'], 'Alice');
  assert.equal(fields['邮箱'], 'alice@example.com');
  assert.equal(fields['备注'], '第一版项目备注');
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '推荐原因'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '项目备注'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '联系状态'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '回复状态'), false);
});

test('campaign KOL push updates Feishu notes from the latest project notes', async () => {
  const { response, calls } = await runCampaignKolPush([buildCampaignKolRow({
    feishu_record_id: 'rec_existing',
    project_status: 'pending_shipping',
    project_notes: '修改后的项目备注'
  })]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.failed_count, 0, JSON.stringify(response.payload.data.results));

  const fields = pushedFields(calls);
  assert.equal(fields['备注'], '修改后的项目备注');
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '推荐原因'), false);
});

test('campaign KOL push translates every project status to Chinese', async () => {
  const statuses = {
    pending_shipping: '待发货',
    shipped: '已发货',
    delivered: '已签收',
    content_preparation: '内容准备中',
    pending_publish: '待上线',
    published: '已上线',
    cancelled: '已取消'
  };
  const rows = Object.keys(statuses).map((project_status, index) => buildCampaignKolRow({
    id: 100 + index,
    project_status
  }));
  const { response, calls } = await runCampaignKolPush(rows);
  assert.equal(response.payload.data.failed_count, 0, JSON.stringify(response.payload.data.results));

  Object.values(statuses).forEach((label, index) => {
    assert.equal(pushedFields(calls, index)['项目状态'], label);
  });
});

test('campaign KOL push omits empty hyperlink and number fields from the payload', async () => {
  const { response, calls } = await runCampaignKolPush([buildCampaignKolRow({
    id: 8,
    project_status: 'pending_shipping',
    youtube_url: '',
    youtube_followers: '',
    instagram_url: null,
    instagram_followers: '',
    tiktok_url: undefined,
    tiktok_followers: null,
    quoted_price: '',
    exchange_rate: null,
    price_rmb: ''
  })]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.failed_count, 0, JSON.stringify(response.payload.data.results));

  const fields = pushedFields(calls);
  for (const name of ['粉丝数', '总预计成本', '近30天中位曝光', '预计合作曝光', '预估CPM']) {
    assert.equal(Object.prototype.hasOwnProperty.call(fields, name), false, `${name} should be omitted`);
  }
  assert.equal(fields['项目状态'], '待发货');
  assert.equal(fields['达人名称'], 'Alice');
});

test('campaign KOL push omits non-numeric values instead of sending NaN', async () => {
  const { response, calls } = await runCampaignKolPush([buildCampaignKolRow({
    id: 9,
    project_status: 'pending_shipping',
    youtube_followers: '1.2万',
    quoted_price: '待议'
  })]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.failed_count, 0, JSON.stringify(response.payload.data.results));

  const fields = pushedFields(calls);
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '粉丝数'), false);
  assert.equal(fields['KOL合作费'], 1000);
});

test('campaign KOL push recreates a record when its saved record id belongs to an old table', async () => {
  const { response, calls, writes } = await runCampaignKolPush([
    buildCampaignKolRow({ feishu_record_id: 'rec_from_old_table', project_status: 'pending_shipping' })
  ], {
    recordHandler: async (url, options) => {
      if (options.method === 'PUT') {
        return { ok: true, text: async () => JSON.stringify({ code: 1254043, msg: 'RecordIdNotFound' }) };
      }
      return { ok: true, text: async () => JSON.stringify({ code: 0, data: { record: { record_id: 'rec_recreated' } } }) };
    }
  });

  assert.equal(response.payload.data.failed_count, 0, JSON.stringify(response.payload.data.results));
  const recordCalls = calls.filter((call) => call.url.includes('/tables/tbl_campaign_kols/records'));
  assert.deepEqual(recordCalls.map((call) => call.options.method), ['PUT', 'POST']);
  assert.ok(writes.some((write) => write.params[0] === 'rec_recreated' && write.params[1] === 'synced'));
});

function kolMasterRecord(recordId, fields) {
  return { record_id: recordId, fields };
}

async function runKolMasterPull({ customers = [], pages = [], configRow = feishuConfigRow, failOnInsert = false } = {}) {
  const calls = [];
  const writes = [];
  const originalGet = dbOperations.get;
  const originalQuery = dbOperations.query;
  const originalRun = dbOperations.run;
  const originalFetch = global.fetch;

  dbOperations.get = async () => configRow;
  dbOperations.query = async () => customers;
  dbOperations.run = async (sql, params = []) => {
    const text = String(sql);
    if (failOnInsert && text.startsWith('INSERT INTO customers') && params.includes('dup@example.com')) {
      throw new Error('UNIQUE constraint failed: customers.email');
    }
    writes.push({ sql: text, params });
    return { id: 100 + writes.length, changes: 1 };
  };
  let pageIndex = 0;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/tenant_access_token/')) {
      return { ok: true, text: async () => JSON.stringify({ code: 0, tenant_access_token: 'tenant-token' }) };
    }
    const page = pages[Math.min(pageIndex, pages.length - 1)];
    pageIndex += 1;
    return { ok: true, text: async () => JSON.stringify({ code: 0, data: page }) };
  };

  try {
    const handler = findHandler(require('./sync'), 'post', '/feishu/pull');
    const response = await callHandler(handler, { body: {} });
    return { response, calls, writes };
  } finally {
    dbOperations.get = originalGet;
    dbOperations.query = originalQuery;
    dbOperations.run = originalRun;
    global.fetch = originalFetch;
  }
}

test('KOL master pull pages through records, updates matches, creates new and skips nameless', async () => {
  const existing = { id: 11, feishu_record_id: null, creator_id: 'alice01', name: 'Old Alice', platform: 'TikTok', cooperation_status: 'do_not_contact' };
  const pages = [
    {
      has_more: true,
      page_token: 'p2',
      items: [
        kolMasterRecord('rec_updated', {
          'KOL名称': 'Alice',
          '平台': 'YouTube',
          creator_id: 'alice01',
          'YouTube粉丝量': 12300,
          'YouTube主页': { link: 'https://youtube.com/@alice', text: 'https://youtube.com/@alice' }
        })
      ]
    },
    {
      has_more: false,
      items: [
        kolMasterRecord('rec_created', { 'KOL名称': 'Bob', '平台': 'Instagram', Email: 'bob@example.com' }),
        kolMasterRecord('rec_nameless', { '平台': 'YouTube' })
      ]
    }
  ];

  const { response, calls, writes } = await runKolMasterPull({ customers: [existing], pages });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload.data, { fetched: 3, created: 1, updated: 1, skipped: 1, failed: 0, errors: [] });

  const listCalls = calls.filter((call) => call.url.includes('/tables/tbl_kol_master/records'));
  assert.equal(listCalls.length, 2);
  assert.ok(listCalls[0].url.includes('page_size=100'));
  assert.ok(listCalls[1].url.includes('page_token=p2'));
  assert.equal(listCalls[0].options.headers.Authorization, 'Bearer tenant-token');

  const update = writes.find((write) => write.sql.startsWith('UPDATE customers'));
  assert.ok(update, 'expected an UPDATE for the matched customer');
  assert.equal(update.params.at(-1), 11);
  assert.ok(update.sql.includes('feishu_record_id = ?'));
  assert.ok(update.sql.includes("sync_status = 'synced'"));
  assert.ok(!update.sql.includes('cooperation_status'), 'update must not touch unmapped columns');
  assert.ok(update.params.includes('rec_updated'));
  assert.ok(update.params.includes('Alice'));
  assert.ok(update.params.includes('12300'));
  assert.ok(update.params.includes('https://youtube.com/@alice'));

  const insert = writes.find((write) => write.sql.startsWith('INSERT INTO customers'));
  assert.ok(insert, 'expected an INSERT for the new record');
  assert.ok(insert.sql.includes('feishu_record_id'));
  assert.ok(insert.sql.includes('sync_status'));
  assert.ok(insert.params.includes('rec_created'));
  assert.ok(insert.params.includes('synced'));
  assert.ok(insert.params.includes('Bob'));
});

test('KOL master pull records per-record failures without aborting the batch', async () => {
  const pages = [{
    has_more: false,
    items: [
      kolMasterRecord('rec_dup', { 'KOL名称': 'Dup', Email: 'dup@example.com' }),
      kolMasterRecord('rec_ok', { 'KOL名称': 'Fine' })
    ]
  }];

  const { response, writes } = await runKolMasterPull({ customers: [], pages, failOnInsert: true });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.failed, 1);
  assert.equal(response.payload.data.created, 1);
  assert.equal(response.payload.data.errors.length, 1);
  assert.equal(response.payload.data.errors[0].record_id, 'rec_dup');
  assert.ok(response.payload.data.errors[0].error.includes('UNIQUE'));
  assert.ok(writes.some((write) => write.sql.startsWith('INSERT INTO customers') && write.params.includes('rec_ok')));
});

test('KOL master pull rejects when Feishu is not configured', async () => {
  const { response } = await runKolMasterPull({ configRow: null });
  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.success, false);
  assert.ok(response.payload.error.includes('App ID'));
  assert.ok(response.payload.error.includes('KOL Master Table ID'));
});

test('KOL master pull update keeps local values when Feishu fields are empty', async () => {
  const existing = {
    id: 21,
    feishu_record_id: null,
    creator_id: 'alice01',
    name: 'Alice',
    platform: 'YouTube',
    email: 'keep@example.com',
    notes: '本地合作备注',
    country_region: 'UK'
  };
  const pages = [{
    has_more: false,
    items: [
      kolMasterRecord('rec_alice', {
        'KOL名称': 'Alice',
        '平台': 'YouTube',
        creator_id: 'alice01',
        '国家地区': 'US'
      })
    ]
  }];

  const { response, writes } = await runKolMasterPull({ customers: [existing], pages });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.updated, 1);

  const update = writes.find((write) => write.sql.startsWith('UPDATE customers'));
  assert.ok(update, 'expected an UPDATE for the matched customer');
  assert.ok(!update.sql.includes('email = ?'), 'empty Feishu Email must not overwrite local email');
  assert.ok(!update.sql.includes('notes = ?'), 'empty Feishu notes must not overwrite local notes');
  assert.ok(update.sql.includes('country_region = ?'), 'non-empty Feishu fields still update');
  assert.ok(update.params.includes('US'));
  assert.ok(!update.params.includes(null), 'no column is written as null');
  assert.ok(update.params.includes('rec_alice'));
  assert.equal(update.params.at(-1), 21);
});

const poolFeishuConfigRow = {
  provider: 'cloud.feishu_bitable',
  api_key: 'feishu-secret',
  base_url: 'https://open.feishu.cn',
  extra_config: JSON.stringify({
    app_id: 'cli_test',
    app_token: 'base-token',
    kol_table_id: 'tbl_kol_master',
    campaign_subtable_map: { 3: 'tbl_pool_3' },
    campaign_tracking_map: { 3: 'tbl_execution' }
  })
};

function recordCallsTo(calls, tableId) {
  return calls.filter((call) => call.url.includes(`/tables/${tableId}/records`));
}

test('candidate pool push writes only 外联状态 and omits 状态/项目状态/logistics fields', async () => {
  const { response, calls } = await runCampaignKolPush(
    [buildCampaignKolRow({ project_status: 'pending_confirmation', outreach_status: 'contacted' })],
    { configRow: poolFeishuConfigRow }
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.failed_count, 0, JSON.stringify(response.payload.data.results));

  const poolCalls = recordCallsTo(calls, 'tbl_pool_3');
  assert.equal(poolCalls.length, 1);
  const fields = JSON.parse(poolCalls[0].options.body).fields;
  assert.equal(fields['外联状态'], '已联系');
  for (const name of ['状态', '项目状态', '发货日期', '物流单号', '交付内容', '预计上线时间', '收货地址']) {
    assert.equal(Object.prototype.hasOwnProperty.call(fields, name), false, `${name} should be omitted`);
  }
  assert.equal(fields['达人名称'], 'Alice');
  assert.equal(recordCallsTo(calls, 'tbl_execution').length, 0);
});

test('execution-stage rows push to the tracking table and mark the old pool record confirmed', async () => {
  const { response, calls } = await runCampaignKolPush(
    [buildCampaignKolRow({
      project_status: 'shipped',
      feishu_record_id: 'rec_pool_1',
      shipping_date: '2026-07-20',
      tracking_number: 'SF123456'
    })],
    { configRow: poolFeishuConfigRow }
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.failed_count, 0, JSON.stringify(response.payload.data.results));

  const trackingCalls = recordCallsTo(calls, 'tbl_execution');
  assert.equal(trackingCalls.length, 1);
  const fields = JSON.parse(trackingCalls[0].options.body).fields;
  assert.equal(fields['项目状态'], '已发货');
  assert.equal(fields['物流单号'], 'SF123456');
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '状态'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '外联状态'), false, 'tracking table never gets 外联状态');

  const poolCalls = recordCallsTo(calls, 'tbl_pool_3');
  assert.equal(poolCalls.length, 1);
  assert.equal(poolCalls[0].options.method, 'PUT');
  assert.ok(poolCalls[0].url.includes('/records/rec_pool_1'));
  assert.deepEqual(JSON.parse(poolCalls[0].options.body).fields, { 外联状态: '已确认' });
});

test('execution-stage rows fail with a clear error when the campaign has no tracking table mapping', async () => {
  const configRow = {
    ...poolFeishuConfigRow,
    extra_config: JSON.stringify({
      app_id: 'cli_test',
      app_token: 'base-token',
      kol_table_id: 'tbl_kol_master',
      campaign_subtable_map: { 3: 'tbl_pool_3' }
    })
  };
  const { response } = await runCampaignKolPush(
    [buildCampaignKolRow({ project_status: 'shipped' })],
    { configRow }
  );
  assert.equal(response.payload.data.failed_count, 1);
  assert.ok(response.payload.data.results[0].error.includes('尚未配置飞书项目跟进表'));
});

test('candidatePoolKolFields maps outreach statuses incl. legacy, never writes 状态/项目状态', () => {
  const { candidatePoolKolFields } = require('./sync');
  const base = { kol_name_snapshot: 'Alice', cooperation_platforms: '[]' };
  const expected = {
    not_contacted: '待联系', contacted: '已联系', waiting_reply: '待回复', replied: '待回复',
    negotiating: '沟通中', interested: '有意向', confirmed: '已确认', rejected: '已终止', terminated: '已终止'
  };
  for (const [status, label] of Object.entries(expected)) {
    assert.equal(candidatePoolKolFields({ ...base, outreach_status: status })['外联状态'], label, `outreach ${status}`);
  }
  const fields = candidatePoolKolFields({ ...base, project_status: 'pending_confirmation', outreach_status: 'contacted' });
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '状态'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '项目状态'), false);
});

test('candidatePoolKolFields includes follow-up note; campaignKolFields writes only 项目状态', () => {
  const { candidatePoolKolFields, campaignKolFields } = require('./sync');
  const pool = candidatePoolKolFields({ kol_name_snapshot: 'Alice', last_reply_summary: '询问寄送', cooperation_platforms: '[]' });
  assert.equal(pool['跟进记录'], '询问寄送');
  const tracking = campaignKolFields({ kol_name_snapshot: 'Alice', outreach_status: 'contacted', project_status: 'pending_shipping', cooperation_platforms: '[]' });
  assert.equal(tracking['项目状态'], '待发货');
  assert.equal(Object.prototype.hasOwnProperty.call(tracking, '外联状态'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(tracking, '状态'), false);
});

test('candidate pool schema has only 外联状态 with the seven options; tracking schema has only 项目状态', () => {
  const { CANDIDATE_POOL_FIELD_SCHEMA, PROJECT_TRACKING_FIELD_SCHEMA } = require('./sync');
  const followUp = CANDIDATE_POOL_FIELD_SCHEMA.find((field) => field.field_name === '跟进记录');
  assert.ok(followUp, 'candidate pool schema missing 跟进记录');
  assert.ok(!CANDIDATE_POOL_FIELD_SCHEMA.some((field) => field.field_name === '状态'), 'pool schema must not declare 状态');
  assert.ok(!CANDIDATE_POOL_FIELD_SCHEMA.some((field) => field.field_name === '项目状态'), 'pool schema must not declare 项目状态');
  const outreach = CANDIDATE_POOL_FIELD_SCHEMA.find((field) => field.field_name === '外联状态');
  assert.ok(outreach, 'pool schema missing 外联状态');
  assert.deepEqual(
    (outreach.property?.options || []).map((option) => option.name),
    ['待联系', '已联系', '待回复', '沟通中', '有意向', '已确认', '已终止']
  );
  assert.ok(!PROJECT_TRACKING_FIELD_SCHEMA.some((field) => field.field_name === '外联状态'), 'tracking schema must not declare 外联状态');
  assert.ok(!PROJECT_TRACKING_FIELD_SCHEMA.some((field) => field.field_name === '状态'), 'tracking schema must not declare 状态');
  assert.ok(PROJECT_TRACKING_FIELD_SCHEMA.some((field) => field.field_name === '项目状态'), 'tracking schema missing 项目状态');
});

test('candidate pool field initializer never recreates 状态 or 项目状态 columns', async () => {
  const syncRoute = require('./sync');
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (!options.method) {
      return { ok: true, text: async () => JSON.stringify({ code: 0, data: { items: [] } }) };
    }
    return { ok: true, text: async () => JSON.stringify({ code: 0, data: { field: { field_id: 'fld_new' } } }) };
  };
  try {
    await syncRoute.ensureCandidatePoolFields({ base_url: 'https://open.feishu.cn', app_token: 'base' }, 'token', 'tbl_pool');
    const createdNames = calls.filter((call) => call.options.method === 'POST').map((call) => JSON.parse(call.options.body).field_name);
    assert.ok(createdNames.includes('外联状态'), '外联状态 is ensured');
    assert.ok(!createdNames.includes('状态'), '状态 must never be recreated');
    assert.ok(!createdNames.includes('项目状态'), '项目状态 must never be recreated');
  } finally {
    global.fetch = originalFetch;
  }
});

const stageConfig = {
  campaign_subtable_map: { 3: 'tbl_pool_3' },
  campaign_tracking_map: { 3: 'tbl_execution' }
};

test('pool outreach mark failure becomes a warning without failing the tracking push', async () => {
  const { response } = await runCampaignKolPush(
    [buildCampaignKolRow({
      pipeline_stage: 'confirmed',
      project_status: 'pending_shipping',
      candidate_feishu_record_id: 'rec_candidate_1',
      tracking_feishu_record_id: null
    })],
    {
      configRow: poolFeishuConfigRow,
      recordHandler: async (url, options) => {
        if (options.method === 'PUT' && url.includes('/tables/tbl_pool_3/records/rec_candidate_1')) {
          return { ok: true, text: async () => JSON.stringify({ code: 1254001, msg: 'BadRequest' }) };
        }
        return { ok: true, text: async () => JSON.stringify({ code: 0, data: { record: { record_id: 'rec_created' } } }) };
      }
    }
  );
  assert.equal(response.payload.data.failed_count, 0, JSON.stringify(response.payload.data.results));
  assert.equal(response.payload.data.results[0].success, true);
  assert.ok(response.payload.data.results[0].warning.includes('候选池回写失败'));
});

test('campaignKolTargetTableId routes by pipeline_stage, not by legacy project_status', () => {
  const { campaignKolTargetTableId } = require('./sync');
  // Candidate-stage rows must stay in the pool even when an old execution-like
  // project_status survived from before the pipeline split.
  assert.equal(campaignKolTargetTableId(stageConfig, {
    campaign_id: 3, pipeline_stage: 'candidate', project_status: 'shipped'
  }), 'tbl_pool_3');
  assert.equal(campaignKolTargetTableId(stageConfig, {
    campaign_id: 3, pipeline_stage: 'candidate', project_status: 'published'
  }), 'tbl_pool_3');
  // Confirmed rows always go to the tracking table, whatever project_status says.
  assert.equal(campaignKolTargetTableId(stageConfig, {
    campaign_id: 3, pipeline_stage: 'confirmed', project_status: 'pending_confirmation'
  }), 'tbl_execution');
  assert.equal(campaignKolTargetTableId(stageConfig, {
    campaign_id: 3, pipeline_stage: 'confirmed', project_status: 'pending_shipping'
  }), 'tbl_execution');
  // Rows without pipeline_stage keep the legacy execution-status fallback.
  assert.equal(campaignKolTargetTableId(stageConfig, {
    campaign_id: 3, project_status: 'shipped'
  }), 'tbl_execution');
  assert.equal(campaignKolTargetTableId(stageConfig, {
    campaign_id: 3, project_status: 'pending_confirmation'
  }), 'tbl_pool_3');
});

test('candidate-stage row with an execution-looking status still pushes to the pool table', async () => {
  const { response, calls } = await runCampaignKolPush(
    [buildCampaignKolRow({ pipeline_stage: 'candidate', project_status: 'shipped' })],
    { configRow: poolFeishuConfigRow }
  );
  assert.equal(response.payload.data.failed_count, 0, JSON.stringify(response.payload.data.results));
  assert.equal(recordCallsTo(calls, 'tbl_pool_3').length, 1);
  assert.equal(recordCallsTo(calls, 'tbl_execution').length, 0);
});

test('confirmed push keeps candidate and tracking record ids in separate columns', async () => {
  const { response, calls, writes } = await runCampaignKolPush(
    [buildCampaignKolRow({
      pipeline_stage: 'confirmed',
      project_status: 'pending_shipping',
      feishu_record_id: 'rec_legacy',
      candidate_feishu_record_id: 'rec_candidate_1',
      tracking_feishu_record_id: null
    })],
    { configRow: poolFeishuConfigRow }
  );
  assert.equal(response.payload.data.failed_count, 0, JSON.stringify(response.payload.data.results));

  // A new record is created in the tracking table, distinct from the pool record.
  const trackingCalls = recordCallsTo(calls, 'tbl_execution');
  assert.equal(trackingCalls.length, 1);
  assert.equal(trackingCalls[0].options.method, 'POST');
  const trackingRecordId = response.payload.data.results[0].record_id;
  assert.ok(trackingRecordId);
  assert.notEqual(trackingRecordId, 'rec_candidate_1');

  // The old pool record is marked via candidate_feishu_record_id, not the legacy id.
  const poolCalls = recordCallsTo(calls, 'tbl_pool_3');
  assert.equal(poolCalls.length, 1);
  assert.equal(poolCalls[0].options.method, 'PUT');
  assert.ok(poolCalls[0].url.includes('/records/rec_candidate_1'));
  assert.deepEqual(JSON.parse(poolCalls[0].options.body).fields, { 外联状态: '已确认' });

  // The tracking write must not overwrite candidate_feishu_record_id.
  const trackingWrite = writes.find((write) => write.sql.includes('tracking_feishu_record_id = ?'));
  assert.ok(trackingWrite, 'expected an UPDATE writing tracking_feishu_record_id');
  assert.ok(!trackingWrite.sql.includes('candidate_feishu_record_id'),
    'tracking sync must not overwrite candidate_feishu_record_id');
  assert.equal(trackingWrite.params[0], trackingRecordId);
});

test('repeat confirmed sync updates the tracking record via tracking_feishu_record_id', async () => {
  const { response, calls } = await runCampaignKolPush(
    [buildCampaignKolRow({
      pipeline_stage: 'confirmed',
      project_status: 'shipped',
      feishu_record_id: 'rec_legacy',
      candidate_feishu_record_id: 'rec_candidate_1',
      tracking_feishu_record_id: 'rec_tracking_1'
    })],
    {
      configRow: poolFeishuConfigRow,
      recordHandler: async (url, options) => {
        if (options.method === 'PUT' && url.includes('/records/rec_tracking_1')) {
          return { ok: true, text: async () => JSON.stringify({ code: 0, data: { record: { record_id: 'rec_tracking_1' } } }) };
        }
        return { ok: true, text: async () => JSON.stringify({ code: 0, data: { record: { record_id: 'rec_created' } } }) };
      }
    }
  );
  assert.equal(response.payload.data.failed_count, 0, JSON.stringify(response.payload.data.results));

  const trackingCalls = recordCallsTo(calls, 'tbl_execution');
  assert.equal(trackingCalls.length, 1);
  assert.equal(trackingCalls[0].options.method, 'PUT');
  assert.ok(trackingCalls[0].url.includes('/records/rec_tracking_1'));
  assert.equal(response.payload.data.results[0].record_id, 'rec_tracking_1');
});

test('historical cooperation rows are never pushed to the candidate pool', async () => {
  const { response, calls } = await runCampaignKolPush(
    [buildCampaignKolRow({ pipeline_stage: 'historical', project_status: 'published' })],
    { configRow: poolFeishuConfigRow }
  );
  assert.equal(response.payload.data.failed_count, 1);
  assert.ok(response.payload.data.results[0].error.includes('历史合作记录不同步飞书候选池'));
  assert.equal(recordCallsTo(calls, 'tbl_pool_3').length, 0);
  assert.equal(recordCallsTo(calls, 'tbl_execution').length, 0);
});

test('all active projects share one unified candidate pool table', async () => {
  const unifiedConfigRow = {
    ...poolFeishuConfigRow,
    extra_config: JSON.stringify({
      app_id: 'cli_test',
      app_token: 'base-token',
      kol_table_id: 'tbl_kol_master',
      campaign_subtable_map: { 2: 'tblhk2nDkERA6jM4', 3: 'tblhk2nDkERA6jM4', 59: 'tblhk2nDkERA6jM4' },
      campaign_tracking_map: { 2: 'tbl_execution' }
    })
  };
  const { campaignKolTargetTableId } = require('./sync');
  const config = {
    campaign_subtable_map: { 2: 'tblhk2nDkERA6jM4', 3: 'tblhk2nDkERA6jM4', 59: 'tblhk2nDkERA6jM4' },
    campaign_tracking_map: {}
  };
  for (const campaignId of [2, 3, 59]) {
    assert.equal(
      campaignKolTargetTableId(config, { campaign_id: campaignId, pipeline_stage: 'candidate', project_status: 'pending_confirmation' }),
      'tblhk2nDkERA6jM4'
    );
  }

  // TSA-0512（campaign 59）候选写入同一张表，合作SKU 来自正式产品关系
  const { response, calls } = await runCampaignKolPush(
    [buildCampaignKolRow({ campaign_id: 59, pipeline_stage: 'candidate', project_status: 'pending_confirmation', product_sku: 'TSA-0512' })],
    { configRow: unifiedConfigRow }
  );
  assert.equal(response.payload.data.failed_count, 0, JSON.stringify(response.payload.data.results));
  const poolCalls = calls.filter((call) => call.url.includes('/tables/tblhk2nDkERA6jM4/records'));
  assert.equal(poolCalls.length, 1);
  assert.equal(JSON.parse(poolCalls[0].options.body).fields['合作SKU'], 'TSA-0512');
});
