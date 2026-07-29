// 提名频道 handle 批量核验：先查排除集，再用 Maton channels/playlistItems/videos 验证真实数据
const fs = require('fs');
const path = require('path');
const mysql = require('../server/node_modules/mysql2/promise');

const ROOT = path.resolve(__dirname, '..');
const MIN_MEDIAN = 15353;
const PRIORITY_MEDIAN = 19191;
const LONG_VIDEO_SEC = 181;

// 提名的美国农场/Homestead/拖拉机/草坪频道 handle（存在性与数据全部由 API 验证）
const HANDLES = [
  'goldshawfarm', 'armsfamilyhomestead', 'keepingitdutch', 'ridgelife', 'thehollarhomestead',
  'livingtraditionshomestead', 'sowtheland', 'appalachiashomestead', 'whitehouseonthehill',
  'lumnahacres', 'wildwonderfuloffgrid', 'ourwyominglife', 'fastag', 'petersonfarmbros',
  'onelonleyfarmer', 'outdoorswiththemorgans', 'coppercreekcuts', 'lawncarelife',
  'ryanknorrlawncare', 'thelawncarenut', 'pestlawnginja', 'bladesofgrasslawncare',
  'stoneyridgefarmer', 'thefitfarmer', 'homesteadhow', 'wranglerstar', 'purelivingforlife',
  'keithkalfas', 'brianslawncare', 'bblawncarekc', 'klingenbergfarms', 'coghillfarm',
  'honeyacreshomestead', 'thedriftlesshomestead', 'wholesomerootshomestead', 'freedomhomestead',
  'simplegroundfarm', 'turkeyhillhomestead', 'thekneadyhomesteader', 'homesteadingfamily'
];

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
function normName(n) { return String(n || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, ''); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const excl = JSON.parse(fs.readFileSync(path.join(ROOT, 'outputs', 'exclusion_set.json'), 'utf8'));
  const exNames = new Set(excl.names), exHandles = new Set(excl.handles), exCids = new Set(excl.channelIds);

  const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'kol_user', password: 'kol_password', database: 'kol_campaign_os' });
  const [rows] = await conn.query("SELECT api_key, base_url, extra_config FROM api_settings WHERE provider='youtube.maton_gateway'");
  await conn.end();
  const s = rows[0] || {};
  const base = (s.base_url || 'https://api.maton.ai').replace(/\/$/, '');
  const extra = JSON.parse(s.extra_config || '{}');
  const headers = { 'Content-Type': 'application/json' };
  if (s.api_key) headers.Authorization = 'Bearer ' + s.api_key;
  if (extra.connection_id) headers['Maton-Connection'] = extra.connection_id;
  const yt = async (p, params) => {
    const res = await fetch(`${base}/youtube/youtube/v3/${p}?${params}`, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(`${p} HTTP ${res.status}: ${JSON.stringify(data).slice(0, 120)}`);
    return data;
  };

  const results = [];
  for (const handle of HANDLES) {
    if (exHandles.has(handle.toLowerCase())) {
      console.error(`SKIP ${handle} (in exclusion)`);
      results.push({ handle, reject: 'in_exclusion_set' });
      continue;
    }
    const out = { handle, ok: false };
    try {
      const ch = await yt('channels', `part=snippet,statistics&forHandle=${encodeURIComponent('@' + handle)}`);
      const c = ch.items?.[0];
      if (!c) { out.reject = 'not_found'; results.push(out); console.error(`MISS ${handle}`); await sleep(120); continue; }
      out.channelId = c.id;
      out.channel = c.snippet?.title;
      out.country = c.snippet?.country || '';
      out.subscribers = Number(c.statistics?.subscriberCount || 0);
      out.channel_description = (c.snippet?.description || '').slice(0, 400);
      const emailMatch = (c.snippet?.description || '').match(/[\w.+-]+@[\w-]+\.[\w.]+/);
      out.email_hint = emailMatch ? emailMatch[0] : '';
      if (exCids.has(c.id) || exNames.has(normName(out.channel))) {
        out.reject = 'in_exclusion_set';
        results.push(out); console.error(`SKIP ${out.channel} (in exclusion by id/name)`);
        await sleep(120); continue;
      }
      await sleep(120);

      const uploadsId = 'UU' + c.id.slice(2);
      const pl = await yt('playlistItems', `part=contentDetails&playlistId=${uploadsId}&maxResults=25`);
      const ids = (pl.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
      if (!ids.length) { out.reject = 'no_videos'; results.push(out); continue; }
      await sleep(120);

      const vids = await yt('videos', `part=statistics,contentDetails,snippet&id=${ids.join(',')}`);
      const list = (vids.items || []).map(v => ({
        id: v.id, title: v.snippet?.title, publishedAt: v.snippet?.publishedAt,
        views: Number(v.statistics?.viewCount || 0), dur: parseDur(v.contentDetails?.duration)
      }));
      out.last_published = list.map(v => v.publishedAt).sort().pop();
      out.active_90d = new Date(out.last_published).getTime() >= Date.now() - 90 * 86400000;
      const longs = list.filter(v => v.dur >= LONG_VIDEO_SEC).slice(0, 10);
      out.long_video_count = longs.length;
      out.median_views = median(longs.map(v => v.views));
      out.recent_long_videos = longs.map(v => `${v.views}|${v.publishedAt?.slice(0, 10)}|${(v.title || '').slice(0, 60)}`);
      if (!out.active_90d) out.reject = 'inactive_90d';
      else if (longs.length < 3) out.reject = 'too_few_long_videos';
      else if (out.median_views == null || out.median_views < MIN_MEDIAN) out.reject = `median_below_${MIN_MEDIAN}`;
      else { out.ok = true; out.priority = out.median_views >= PRIORITY_MEDIAN ? 'T1' : 'T2'; }
    } catch (e) { out.reject = 'api_error'; out.error = e.message; }
    results.push(out);
    console.error(`${out.ok ? 'PASS' : 'FAIL'} ${out.channel || handle} | med=${out.median_views ?? '-'} subs=${out.subscribers ?? '-'} country=${out.country || '?'} ${out.reject || out.priority}`);
    await sleep(150);
  }

  fs.writeFileSync(path.join(ROOT, 'outputs', 'channel_verification_round3.json'), JSON.stringify(results, null, 1));
  console.error(`\ntotal=${results.length} passed=${results.filter(r => r.ok).length}`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
