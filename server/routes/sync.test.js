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
    campaign_kol_table_id: 'tbl_campaign_kols',
    campaign_subtable_map: { 3: 'tbl_campaign_kols' }
  })
};

function buildCampaignKolRow(overrides = {}) {
  return {
    id: 7,
    campaign_id: 3,
    customer_id: 11,
    raw_candidate_id: 21,
    feishu_record_id: null,
    status: 'candidate',
    quoted_price: '150.5',
    exchange_rate: '9.1',
    price_rmb: '1369.55',
    owner: 'Celeste',
    notes: '重点推荐',
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

async function runCampaignKolPush(rows, { recordHandler } = {}) {
  const calls = [];
  const writes = [];
  const originalGet = dbOperations.get;
  const originalQuery = dbOperations.query;
  const originalRun = dbOperations.run;
  const originalFetch = global.fetch;

  dbOperations.get = async () => feishuConfigRow;
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

test('campaign KOL push sends hyperlinks as link/text objects and numbers as numbers', async () => {
  const { response, calls } = await runCampaignKolPush([buildCampaignKolRow()]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.failed_count, 0, JSON.stringify(response.payload.data.results));

  const fields = pushedFields(calls);
  assert.deepEqual(fields['YouTube主页'], {
    link: 'https://youtube.com/@alice',
    text: 'https://youtube.com/@alice'
  });
  assert.deepEqual(fields['Instagram主页'], {
    link: 'https://instagram.com/alice',
    text: 'https://instagram.com/alice'
  });
  assert.equal(fields['YouTube粉丝量'], 12300);
  assert.equal(fields['Instagram粉丝量'], 8900);
  assert.equal(fields['项目报价'], 150.5);
  assert.equal(fields['汇率'], 9.1);
  assert.equal(fields['价格RMB'], 1369.55);
  assert.equal(fields['项目状态'], 'candidate');
  assert.equal(typeof fields['项目状态'], 'string');
  assert.equal(fields['KOL名称'], 'Alice');
  assert.equal(fields['Email'], 'alice@example.com');
});

test('campaign KOL push omits empty hyperlink and number fields from the payload', async () => {
  const { response, calls } = await runCampaignKolPush([buildCampaignKolRow({
    id: 8,
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
  for (const name of [
    'YouTube主页', 'Instagram主页', 'TikTok主页',
    'YouTube粉丝量', 'Instagram粉丝量', 'TikTok粉丝量',
    '项目报价', '汇率', '价格RMB'
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(fields, name), false, `${name} should be omitted`);
  }
  assert.equal(fields['项目状态'], 'candidate');
  assert.equal(fields['KOL名称'], 'Alice');
});

test('campaign KOL push omits non-numeric values instead of sending NaN', async () => {
  const { response, calls } = await runCampaignKolPush([buildCampaignKolRow({
    id: 9,
    youtube_followers: '1.2万',
    quoted_price: '待议'
  })]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.failed_count, 0, JSON.stringify(response.payload.data.results));

  const fields = pushedFields(calls);
  assert.equal(Object.prototype.hasOwnProperty.call(fields, 'YouTube粉丝量'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fields, '项目报价'), false);
  assert.equal(fields['Instagram粉丝量'], 8900);
  assert.equal(fields['汇率'], 9.1);
});

test('campaign KOL push recreates a record when its saved record id belongs to an old table', async () => {
  const { response, calls, writes } = await runCampaignKolPush([
    buildCampaignKolRow({ feishu_record_id: 'rec_from_old_table' })
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
