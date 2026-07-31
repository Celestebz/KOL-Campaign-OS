// Round 3: fetch all KOLs with avg/median 30d >= 5000, then filter to 5000-10000 range
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:5001';
const TOKEN = 'Agent API Token';
const CAMPAIGN_ID = 2;
const PAGE_SIZE = 100;
const OUT = path.join(__dirname, '_tmp_r3_search.json');

async function fetchPage(page) {
  const url = `${BASE}/api/agent/campaigns/${CAMPAIGN_ID}/kol-master/search?` +
    `min_avg_views_30d=5000&min_median_views_30d=5000` +
    `&metric_mode=any&exclude_in_campaign=true&page=${page}&page_size=${PAGE_SIZE}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}: ${await res.text()}`);
  return res.json();
}

(async () => {
  const all = [];
  let page = 1;
  let total = 0;
  while (true) {
    const j = await fetchPage(page);
    if (page === 1) total = j.data.total;
    const items = j.data.items || [];
    all.push(...items);
    if (all.length >= total || items.length === 0) break;
    page += 1;
  }
  // client-side filter: avg or median in [5000, 10000]
  const filtered = all.filter((x) => {
    const a = x.youtube_avg_views_30d || 0;
    const m = x.youtube_median_views_30d || 0;
    return (a >= 5000 && a <= 10000) || (m >= 5000 && m <= 10000);
  });
  fs.writeFileSync(OUT, JSON.stringify({ total_api: total, fetched: all.length, in_range: filtered.length, items: filtered }, null, 2));
  console.error(`api total=${total} fetched=${all.length} in_range=${filtered.length}`);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
