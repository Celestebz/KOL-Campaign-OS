// Maton 多查询视频收集：近 90 天发布、按频道去重、排除历史库与品牌/经销商官方频道
const fs = require('fs');
const path = require('path');
const mysql = require('../server/node_modules/mysql2/promise');

const ROOT = path.resolve(__dirname, '..');
const PUBLISHED_AFTER = '2026-04-30T00:00:00Z'; // 近90天（当前 2026-07-29）

const QUERIES = [
  'PTO finish mower review',
  '3 point finish mower tractor',
  'pull behind finish mower',
  'finish mower vs bush hog',
  'grooming mower acreage',
  'mowing 5 acres tractor',
  'best finish mower for tractor',
  'tow behind mower ATV review',
  'finish mower tall grass test',
  'tractor mowing large lawn',
  'CountyLine finish mower review',
  'rear discharge finish mower'
];

// 品牌官方/经销商/制造商频道特征（非独立创作者）
const BRAND_PATTERNS = [
  'john deere','johndeere','kubota','mahindra','kioti','bobcat','toro','exmark','scag','hustler',
  'mechmaxx','titan attachments','king kutter','countyline','agri supply','agzaga','messick',
  'stec equipment','western equipment','harbor freight','tractor supply','branson','tym tractor',
  'yanmar','new holland','case ih','massey ferguson','deutz','claas','fendt','ventrac','stihl',
  'greenworks','ryobi','craftsman','husqvarna','ariens','gravely','woods equipment','bush hog',
  'land pride','rhino ag','tarter','speeco','bilt hard','bad boy mowers','spartan mowers',
  'ferris mowers','wright mfg','snapper','simplicity','cub cadet','troy-bilt','ego power',
  'dewalt','milwaukee','makita','generac','champion power','briggs','honda power','kawasaki'
];

function normName(n) { return String(n || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, ''); }

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

  const seenChannels = new Set(); // 本批内按 channelId/name 去重
  const kept = [], dropped = { excluded_history: [], excluded_brand: [], dup_batch: [] };

  for (const q of QUERIES) {
    const url = `${base}/youtube/youtube/v3/search?part=snippet&type=video&maxResults=10&order=relevance&publishedAfter=${encodeURIComponent(PUBLISHED_AFTER)}&q=${encodeURIComponent(q)}`;
    let data;
    try {
      const res = await fetch(url, { headers });
      data = await res.json();
      if (!res.ok) { console.error(`query "${q}" HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`); continue; }
    } catch (e) { console.error(`query "${q}" ERR ${e.message}`); continue; }

    for (const item of data.items || []) {
      const sn = item.snippet || {};
      const rec = {
        videoId: item.id?.videoId,
        title: sn.title,
        channel: sn.channelTitle,
        channelId: sn.channelId,
        publishedAt: sn.publishedAt,
        description: (sn.description || '').slice(0, 300),
        source_query: q
      };
      const nn = normName(rec.channel);
      const isBrand = BRAND_PATTERNS.some(p => nn.includes(p.replace(/[^a-z0-9]/g, '')));
      const inHistory = exCids.has(rec.channelId) || exNames.has(nn) || exHandles.has(nn);
      const batchKey = rec.channelId || nn;
      if (isBrand) { dropped.excluded_brand.push(rec.channel); continue; }
      if (inHistory) { dropped.excluded_history.push(rec.channel); continue; }
      if (seenChannels.has(batchKey)) { dropped.dup_batch.push(rec.channel); continue; }
      seenChannels.add(batchKey);
      kept.push(rec);
    }
  }

  fs.writeFileSync(path.join(ROOT, 'outputs', 'maton_evidence_round2.json'), JSON.stringify({ kept, dropped }, null, 1));
  console.error(`kept=${kept.length} | history=${dropped.excluded_history.length} | brand=${dropped.excluded_brand.length} | batchDup=${dropped.dup_batch.length}`);
  kept.forEach((r, i) => console.error(`${String(i + 1).padStart(2)}. ${r.channel} | ${r.publishedAt?.slice(0, 10)} | ${r.title?.slice(0, 80)}`));
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
