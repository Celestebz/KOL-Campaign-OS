const test = require('node:test');
const assert = require('node:assert/strict');
const aiClient = require('./aiClient');

test('callAi uses Anthropic messages API for MiniMax Token Plan', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      text: async () => JSON.stringify({
        content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '{"summary":"正常","intent":"other"}' }]
      })
    };
  };
  try {
    const result = await aiClient.callAi({
      api_key: 'token-plan-key',
      base_url: 'https://api.minimaxi.com/anthropic',
      model: 'MiniMax-M3',
      extra_config: JSON.stringify({ api_protocol: 'anthropic_token_plan' })
    }, 'minimax', 'system', 'user');
    assert.equal(request.url, 'https://api.minimaxi.com/anthropic/v1/messages');
    assert.equal(request.options.headers['x-api-key'], 'token-plan-key');
    assert.equal(request.options.headers.Authorization, undefined);
    assert.equal(JSON.parse(request.options.body).model, 'MiniMax-M3');
    assert.equal(result.parsed.summary, '正常');
  } finally {
    global.fetch = originalFetch;
  }
});
