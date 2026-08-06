const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchScJson } = require('./scrapecreatorsYoutube');

const SETTING = { api_key: 'k', base_url: 'https://api.scrapecreators.com' };

function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

test('未配置 key 时直接报错', async () => {
  await assert.rejects(() => fetchScJson('https://x.test/v1/youtube/search', null), /未配置/);
});

test('402 报额度耗尽且不重试', async () => {
  let calls = 0;
  const restore = stubFetch(async () => { calls += 1; return { status: 402, json: async () => ({}) }; });
  await assert.rejects(() => fetchScJson('https://x.test/v1/youtube/search', SETTING), /额度耗尽/);
  assert.equal(calls, 1);
  restore();
});

test('401 报 key 无效且不重试', async () => {
  let calls = 0;
  const restore = stubFetch(async () => { calls += 1; return { status: 401, json: async () => ({}) }; });
  await assert.rejects(() => fetchScJson('https://x.test/v1/youtube/search', SETTING), /无效|未配置/);
  assert.equal(calls, 1);
  restore();
});

test('500 重试 2 次后抛出 HTTP 错误', async () => {
  let calls = 0;
  const restore = stubFetch(async () => { calls += 1; return { status: 500, json: async () => ({ message: 'boom' }) }; });
  await assert.rejects(() => fetchScJson('https://x.test/v1/youtube/search', SETTING), /HTTP 500/);
  assert.equal(calls, 3);
  restore();
});

test('首次 500 后 200 成功返回', async () => {
  let calls = 0;
  const restore = stubFetch(async () => {
    calls += 1;
    return calls === 1
      ? { status: 500, json: async () => ({}) }
      : { status: 200, json: async () => ({ success: true }) };
  });
  const data = await fetchScJson('https://x.test/v1/youtube/search', SETTING);
  assert.equal(data.success, true);
  assert.equal(calls, 2);
  restore();
});
