// 临时脚本：从 shell 直接调 maton YouTube gateway 搜索视频（绕过服务器进程的 fetch 故障）
const mysql = require('../server/node_modules/mysql2/promise');

const query = process.argv[2];
if (!query) { console.error('usage: node _tmp_maton_search.js QUERY'); process.exit(1); }

(async () => {
  const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'kol_user', password: 'kol_password', database: 'kol_campaign_os' });
  const [rows] = await conn.query("SELECT api_key, base_url, extra_config FROM api_settings WHERE provider='youtube.maton_gateway'");
  await conn.end();
  const s = rows[0] || {};
  const base = (s.base_url || 'https://api.maton.ai').replace(/\/$/, '');
  const extra = JSON.parse(s.extra_config || '{}');
  const headers = { 'Content-Type': 'application/json' };
  if (s.api_key) headers.Authorization = 'Bearer ' + s.api_key;
  if (extra.connection_id) headers['Maton-Connection'] = extra.connection_id;

  const url = `${base}/youtube/youtube/v3/search?part=snippet&type=video&maxResults=10&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers });
  const data = await res.json();
  if (!res.ok) { console.error('HTTP', res.status, JSON.stringify(data).slice(0, 400)); process.exit(1); }
  for (const item of data.items || []) {
    const sn = item.snippet || {};
    console.log(JSON.stringify({
      videoId: item.id?.videoId,
      title: sn.title,
      channel: sn.channelTitle,
      channelId: sn.channelId,
      publishedAt: sn.publishedAt
    }));
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
