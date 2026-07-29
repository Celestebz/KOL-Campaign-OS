// 用 uploads 播放列表核验（绕开 search 配额）：针对上一轮 api_error 的频道
const fs = require('fs');
const path = require('path');
const mysql = require('../server/node_modules/mysql2/promise');

const ROOT = path.resolve(__dirname, '..');
const MIN_MEDIAN = 15353;
const PRIORITY_MEDIAN = 19191;
const LONG_VIDEO_SEC = 181;

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function parseDur(iso) {
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function makeYt() {
  const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'kol_user', password: 'kol_password', database: 'kol_campaign_os' });
  const [rows] = await conn.query("SELECT api_key, base_url, extra_config FROM api_settings WHERE provider='youtube.maton_gateway'");
  await conn.end();
  const s = rows[0] || {};
  const base = (s.base_url || 'https://api.maton.ai').replace(/\/$/, '');
  const extra = JSON.parse(s.extra_config || '{}');
  const headers = { 'Content-Type': 'application/json' };
  if (s.api_key) headers.Authorization = 'Bearer ' + s.api_key;
  if (extra.connection_id) headers['Maton-Connection'] = extra.connection_id;
  return async (p, params) => {
    const res = await fetch(`${base}/youtube/youtube/v3/${p}?${params}`, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(`${p} HTTP ${res.status}: ${JSON.stringify(data).slice(0, 150)}`);
    return data;
  };
}

async function verifyChannel(yt, rec) {
  const out = { ...rec, ok: false };
  const ch = await yt('channels', `part=snippet,statistics&id=${rec.channelId}`);
  const c = ch.items?.[0];
  if (!c) { out.reject = 'channel_not_found'; return out; }
  out.country = c.snippet?.country || '';
  out.handle = c.snippet?.customUrl || '';
  out.subscribers = Number(c.statistics?.subscriberCount || 0);
  out.channel_description = (c.snippet?.description || '').slice(0, 500);
  const emailMatch = (c.snippet?.description || '').match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  out.email_hint = emailMatch ? emailMatch[0] : '';
  await sleep(120);

  const uploadsId = 'UU' + rec.channelId.slice(2);
  const pl = await yt('playlistItems', `part=contentDetails&playlistId=${uploadsId}&maxResults=25`);
  const ids = (pl.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
  if (!ids.length) { out.reject = 'no_videos'; return out; }
  await sleep(120);

  const vids = await yt('videos', `part=statistics,contentDetails,snippet&id=${ids.join(',')}`);
  const list = (vids.items || []).map(v => ({
    id: v.id, title: v.snippet?.title, publishedAt: v.snippet?.publishedAt,
    views: Number(v.statistics?.viewCount || 0), dur: parseDur(v.contentDetails?.duration)
  }));
  out.last_published = list.map(v => v.publishedAt).sort().pop();
  const cutoff = Date.now() - 90 * 86400000;
  out.active_90d = new Date(out.last_published).getTime() >= cutoff;
  const longs = list.filter(v => v.dur >= LONG_VIDEO_SEC).slice(0, 10);
  out.long_video_count = longs.length;
  out.median_views = median(longs.map(v => v.views));
  out.recent_long_videos = longs.map(v => `${v.views}|${v.publishedAt?.slice(0, 10)}|${(v.title || '').slice(0, 60)}`);
  if (!out.active_90d) out.reject = 'inactive_90d';
  else if (longs.length < 3) out.reject = 'too_few_long_videos';
  else if (out.median_views == null || out.median_views < MIN_MEDIAN) out.reject = `median_below_${MIN_MEDIAN}`;
  else { out.ok = true; out.priority = out.median_views >= PRIORITY_MEDIAN ? 'T1' : 'T2'; }
  return out;
}

(async () => {
  const prev = JSON.parse(fs.readFileSync(path.join(ROOT, 'outputs', 'channel_verification_round2.json'), 'utf8'));
  const pending = prev.filter(r => r.reject === 'api_error');
  const done = prev.filter(r => r.reject !== 'api_error');
  const yt = await makeYt();
  for (const rec of pending) {
    let out;
    try { out = await verifyChannel(yt, rec); }
    catch (e) { out = { ...rec, ok: false, reject: 'api_error', error: e.message }; }
    done.push(out);
    console.error(`${out.ok ? 'PASS' : 'FAIL'} ${rec.channel} | med=${out.median_views ?? '-'} subs=${out.subscribers ?? '-'} country=${out.country || '?'} ${out.reject || out.priority}`);
    await sleep(150);
  }
  fs.writeFileSync(path.join(ROOT, 'outputs', 'channel_verification_round2.json'), JSON.stringify(done, null, 1));
  console.error(`\ntotal=${done.length} passed=${done.filter(r => r.ok).length}`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
