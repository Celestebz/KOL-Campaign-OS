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
    assert.equal(data.externalAgent.api_token, '••••••••');
    assert.equal(Object.prototype.hasOwnProperty.call(data, 'agents'), false);
    assert.equal(JSON.stringify(data).includes('browseract'), false);
    assert.equal(JSON.stringify(data).includes('youtube-secret'), false);
    assert.equal(JSON.stringify(data).includes('agent-token'), false);
  } finally {
    dbOperations.query = originalQuery;
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
              base_url: 'https://open.feishu.cn'
            }
          },
          externalAgent: { enabled: true, api_token: '••••••••' },
          fallbackStrategy: {}
        }
      }
    });

    assert.equal(response.statusCode, 200);
    const youtubeWrite = writes.find((item) => item.params[0] === 'youtube.google_official');
    const feishuWrite = writes.find((item) => item.params[0] === 'cloud.feishu_bitable');
    const agentWrite = writes.find((item) => item.params[0] === 'agent.external_api');

    assert.equal(youtubeWrite.params[1], 'youtube-secret');
    assert.equal(feishuWrite.params[1], 'feishu-secret');
    assert.equal(JSON.parse(feishuWrite.params[3]).app_token, 'base-token');
    assert.equal(agentWrite.params[1], 'agent-token');
    assert.equal(
      writes.some((item) => String(item.params[0] || '').startsWith('agent.') && item.params[0] !== 'agent.external_api'),
      false
    );
  } finally {
    dbOperations.get = originalGet;
    dbOperations.run = originalRun;
  }
});
