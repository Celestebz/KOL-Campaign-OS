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

function callHandler(handler, { body = {}, user, query = {} } = {}) {
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
    Promise.resolve(handler({ body, user, query }, response, reject)).catch(reject);
  });
}

test('Bright Data dataset listing uses the selected platform and prefers its credentials', async () => {
  const bd = require('../services/brightdataClient');
  const originalQuery = dbOperations.query;
  const originalList = bd.listDatasets;
  try {
    const handler = findHandler(require('./settings'), 'get', '/brightdata/datasets');
    for (const platform of ['instagram', 'tiktok']) {
      dbOperations.query = async (sql, params) => {
        assert.deepEqual(params.slice(1), [`${platform}.brightdata`, `${platform}.brightdata`, 'brightdata']);
        return [
          { provider: 'brightdata', api_key: 'legacy-token' },
          { provider: `${platform}.brightdata`, api_key: 'platform-token' }
        ];
      };
      bd.listDatasets = async (config) => {
        assert.equal(config.api_key, 'platform-token');
        return [{ dataset_id: 'gd_demo', name: 'Demo' }];
      };
      const response = await callHandler(handler, { query: { platform } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.payload.data.source, `${platform}.brightdata`);
      assert.equal(response.payload.data.datasets[0].id, 'gd_demo');
      assert.equal(JSON.stringify(response.payload).includes('platform-token'), false);
    }
    dbOperations.query = async () => { throw new Error('Invalid platform must not query settings'); };
    const invalid = await callHandler(handler, { query: { platform: 'youtube' } });
    assert.equal(invalid.statusCode, 400);
  } finally {
    dbOperations.query = originalQuery;
    bd.listDatasets = originalList;
  }
});

test('GET /api/settings masks stored secrets', async () => {
  const originalQuery = dbOperations.query;
  dbOperations.query = async () => [
    { provider: 'youtube.google_official', api_key: 'youtube-secret', base_url: '', model: '', extra_config: '{}', updated_at: '' },
    { provider: 'ai.deepseek', api_key: 'deepseek-secret', base_url: 'https://api.deepseek.com', model: 'deepseek-chat', extra_config: '{}', updated_at: '' },
    { provider: 'cloud.feishu_bitable', api_key: 'feishu-secret', base_url: 'https://open.feishu.cn', model: '', extra_config: JSON.stringify({ app_token: 'base-token' }), updated_at: '' },
    { provider: 'agent.external_api', api_key: 'agent-token', base_url: '', model: '', extra_config: JSON.stringify({ enabled: true }), updated_at: '' }
  ];

  try {
    const handler = findHandler(require('./settings'), 'get', '/');
    const response = await callHandler(handler);
    assert.equal(response.statusCode, 200);

    const data = response.payload.data;
    assert.equal(data.platforms.youtube.providers.google_official.api_key, '••••••••');
    assert.equal(data.aiModels.providers.deepseek.api_key, '••••••••');
    assert.equal(data.cloudStorage.feishu.app_secret, '••••••••');
    assert.equal(data.cloudStorage.feishu.app_token, '••••••••');
    assert.equal(data.cloudStorage.feishu.sync_kol_master, true);
    assert.equal(data.externalAgent.api_token, '••••••••');
    assert.equal(Object.prototype.hasOwnProperty.call(data, 'agents'), false);
    assert.equal(JSON.stringify(data).includes('browseract'), false);
    assert.equal(JSON.stringify(data).includes('youtube-secret'), false);
    assert.equal(JSON.stringify(data).includes('agent-token'), false);
  } finally {
    dbOperations.query = originalQuery;
  }
});

test('POST /api/settings preserves existing secrets for alternative mask forms', async () => {
  const originalGet = dbOperations.get;
  const originalRun = dbOperations.run;
  const writes = [];

  dbOperations.get = async (sql, params = []) => {
    const provider = params[0];
    if (provider === 'youtube.google_official') return { api_key: 'youtube-secret', extra_config: '{}' };
    if (provider === 'agent.external_api') return { api_key: 'agent-token', extra_config: '{}' };
    return null;
  };
  dbOperations.run = async (sql, params = []) => {
    writes.push({ sql: String(sql), params });
    return { id: 1 };
  };

  try {
    const handler = findHandler(require('./settings'), 'post', '/');
    const response = await callHandler(handler, {
      body: {
        settings: {
          platforms: {
            youtube: {
              primary: 'google_official',
              fallbacks: [],
              providers: {
                google_official: { api_key: '********', base_url: '', model: '' }
              }
            },
            instagram: { primary: 'scrapecreators', fallbacks: [], providers: {} },
            tiktok: { primary: 'scrapecreators', fallbacks: [], providers: {} }
          },
          aiModels: { active: 'deepseek', providers: {} },
          externalAgent: { enabled: true, api_token: 'â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢' },
          fallbackStrategy: {}
        }
      }
    });

    assert.equal(response.statusCode, 200);
    const youtubeWrite = writes.find((item) => item.params[1] === 'youtube.google_official');
    const agentWrite = writes.find((item) => item.params[1] === 'agent.external_api');
    assert.equal(youtubeWrite.params[2], 'youtube-secret');
    assert.equal(agentWrite.params[2], 'agent-token');
  } finally {
    dbOperations.get = originalGet;
    dbOperations.run = originalRun;
  }
});

test('GET /api/settings/health/config ignores rows that only have extra_config', async () => {
  const originalGet = dbOperations.get;

  dbOperations.get = async (sql, params = []) => {
    const provider = params[0];
    if (provider === 'system.provider_selection') {
      return {
        extra_config: JSON.stringify({
          aiModels: { active: 'deepseek' },
          platforms: {
            youtube: { primary: 'google_official', fallbacks: [] },
            instagram: { primary: 'scrapecreators', fallbacks: [] },
            tiktok: { primary: 'scrapecreators', fallbacks: [] }
          }
        })
      };
    }
    if (provider === 'agent.external_api') return { api_key: '', base_url: '', model: '', extra_config: '{"enabled":false,"notes":""}' };
    if (provider === 'cloud.feishu_bitable') return { api_key: '', base_url: '', model: '', extra_config: '{}' };
    return { api_key: '', base_url: '', model: '', extra_config: '{"auth_header_name":"","auth_scheme":"","connection_id":"","custom_provider_name":"","notes":""}' };
  };

  try {
    const handler = findHandler(require('./settings'), 'get', '/health/config');
    const response = await callHandler(handler);
    assert.equal(response.statusCode, 200);

    const { ready, checks } = response.payload.data;
    assert.equal(checks.ai.configured, false);
    assert.equal(checks.platforms.youtube.configured, false);
    assert.equal(checks.platforms.instagram.configured, false);
    assert.equal(checks.platforms.tiktok.configured, false);
    assert.equal(ready, false);
  } finally {
    dbOperations.get = originalGet;
  }
});

test('GET /api/settings/health/config does not treat masked secrets as valid keys', async () => {
  const originalGet = dbOperations.get;

  dbOperations.get = async (sql, params = []) => {
    const provider = params[0];
    if (provider === 'system.provider_selection') {
      return {
        extra_config: JSON.stringify({
          aiModels: { active: 'deepseek' },
          platforms: {
            youtube: { primary: 'google_official', fallbacks: [] },
            instagram: { primary: 'scrapecreators', fallbacks: [] },
            tiktok: { primary: 'scrapecreators', fallbacks: [] }
          }
        })
      };
    }
    if (provider === 'ai.deepseek') {
      return { api_key: '••••••••', base_url: 'https://api.deepseek.com', model: 'deepseek-chat', extra_config: '{}' };
    }
    if (provider === 'agent.external_api') {
      return { api_key: '••••••••', base_url: '', model: '', extra_config: '{"enabled":true}' };
    }
    if (provider === 'cloud.feishu_bitable') {
      return { api_key: '••••••••', base_url: 'https://open.feishu.cn', model: '', extra_config: '{"app_token":"••••••••"}' };
    }
    return null;
  };

  try {
    const handler = findHandler(require('./settings'), 'get', '/health/config');
    const response = await callHandler(handler);
    assert.equal(response.statusCode, 200);

    const { checks } = response.payload.data;
    assert.equal(checks.ai.configured, false);
    assert.ok(checks.ai.missing.includes('api_key'));
    assert.equal(checks.external_agent.token_configured, false);
    assert.ok(checks.external_agent.missing.includes('token'));
    assert.equal(checks.feishu.configured, false);
  } finally {
    dbOperations.get = originalGet;
  }
});

test('POST /api/settings preserves existing secrets when masked values are submitted', async () => {
  const originalGet = dbOperations.get;
  const originalRun = dbOperations.run;
  const writes = [];

  dbOperations.get = async (sql, params = []) => {
    const provider = params[0];
    if (provider === 'youtube.google_official') return { api_key: 'youtube-secret', extra_config: '{}' };
    if (provider === 'cloud.feishu_bitable') return { api_key: 'feishu-secret', extra_config: JSON.stringify({ app_token: 'base-token' }) };
    if (provider === 'agent.external_api') return { api_key: 'agent-token', extra_config: JSON.stringify({ enabled: true }) };
    return null;
  };
  dbOperations.run = async (sql, params = []) => {
    writes.push({ sql: String(sql), params });
    return { id: 1 };
  };

  try {
    const handler = findHandler(require('./settings'), 'post', '/');
    const response = await callHandler(handler, {
      body: {
        settings: {
          platforms: {
            youtube: {
              primary: 'google_official',
              fallbacks: [],
              providers: {
                google_official: { api_key: '••••••••', base_url: '', model: '' }
              }
            },
            instagram: { primary: 'scrapecreators', fallbacks: [], providers: {} },
            tiktok: { primary: 'scrapecreators', fallbacks: [], providers: {} }
          },
          aiModels: { active: 'deepseek', providers: {} },
          agents: {
            active: 'maton_gateway',
            providers: {
              browseract: { api_key: 'browseract-secret', base_url: 'https://browseract.example' }
            }
          },
          cloudStorage: {
            feishu: {
              app_secret: '••••••••',
              app_token: '••••••••',
              sync_kol_master: false,
              base_url: 'https://open.feishu.cn',
              campaign_tracking_map: '{"3":"tbl_track_3"}'
            }
          },
          externalAgent: { enabled: true, api_token: '••••••••' },
          fallbackStrategy: {}
        }
      }
    });

    assert.equal(response.statusCode, 200);
    const youtubeWrite = writes.find((item) => item.params[1] === 'youtube.google_official');
    const feishuWrite = writes.find((item) => item.params[1] === 'cloud.feishu_bitable');
    const agentWrite = writes.find((item) => item.params[1] === 'agent.external_api');

    assert.equal(youtubeWrite.params[2], 'youtube-secret');
    assert.equal(feishuWrite.params[2], 'feishu-secret');
    assert.equal(JSON.parse(feishuWrite.params[4]).app_token, 'base-token');
    assert.equal(JSON.parse(feishuWrite.params[4]).sync_kol_master, false);
    assert.equal(JSON.parse(feishuWrite.params[4]).campaign_tracking_map, '{"3":"tbl_track_3"}');
    assert.equal(JSON.parse(feishuWrite.params[4]).campaign_kol_table_id, undefined);
    assert.equal(agentWrite.params[2], 'agent-token');
    assert.equal(
      writes.some((item) => String(item.params[1] || '').startsWith('agent.') && item.params[1] !== 'agent.external_api'),
      false
    );
  } finally {
    dbOperations.get = originalGet;
    dbOperations.run = originalRun;
  }
});
