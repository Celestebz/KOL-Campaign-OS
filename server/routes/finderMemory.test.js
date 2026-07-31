const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.DB_DIALECT = 'sqlite';
process.env.DB_STORAGE = path.resolve(__dirname, 'tmp-finder-memory.test.sqlite');

const { initDatabase, sequelize, dbOperations } = require('../database');
const finderTasks = require('./finderTasks');

test('Finder reuses unprocessed creator memory before requesting another search page', async () => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_STORAGE + suffix, { force: true });
  await initDatabase();
  let searchRequests = 0;
  const gateway = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/youtube/youtube/v3/search')) {
        searchRequests += 1;
        res.end(JSON.stringify({
          nextPageToken: 'page-two',
          items: ['First', 'Second'].map((name) => ({
            id: { videoId: `${name.toLowerCase()}Video` },
            snippet: {
              channelId: `UC${name}Memory123456789`,
              channelTitle: `${name} Creator`,
              title: `${name} tractor test`
            }
          }))
        }));
        return;
      }
      if (req.url.startsWith('/youtube/youtube/v3/channels')) {
        const requestUrl = new URL(req.url, 'http://127.0.0.1');
        const ids = requestUrl.searchParams.get('id').split(',');
        res.end(JSON.stringify({
          items: ids.map((id) => ({
            id,
            snippet: { title: id.includes('First') ? 'First Creator' : 'Second Creator', country: 'US' },
            statistics: { subscriberCount: '10000' },
            contentDetails: { relatedPlaylists: { uploads: id.replace(/^UC/, 'UU') } }
          }))
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'unexpected endpoint' } }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });

  const request = {
    search_source: 'maton_agent',
    target_platform: 'youtube',
    limit: 1,
    discovery: { keywords: 'tractor field mowing' },
    campaign: { name: 'Mower', target_market: 'United States' },
    strategy: { finder_handoff: {}, persona_config: {} }
  };
  const setting = { api_key: 'token' };
  const baseUrl = `http://127.0.0.1:${gateway.port}`;
  try {
    const first = await finderTasks.youtubeMatonGatewayAdapter(request, setting, baseUrl);
    assert.equal(first.candidates[0].kol_name, 'First Creator');
    assert.equal(searchRequests, 1);

    const second = await finderTasks.youtubeMatonGatewayAdapter(request, setting, baseUrl);
    assert.equal(second.candidates[0].kol_name, 'Second Creator');
    assert.equal(searchRequests, 1, 'second run must consume remembered creators before search');

    const cursor = await dbOperations.get('SELECT next_page_token FROM finder_query_cursors LIMIT 1');
    assert.equal(cursor.next_page_token, 'page-two');
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
    await sequelize.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_STORAGE + suffix, { force: true });
  }
});
