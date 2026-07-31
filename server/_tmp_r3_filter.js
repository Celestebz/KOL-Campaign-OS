// Round 3: classify 127 mid-tier KOLs (5000-10000) for product fit
const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '_tmp_r3_search.json'), 'utf8'));
const items = data.items;

const STRONG_FIT = [
  /\bfarm/i, /\branches?\b/i, /\bhomestead/i, /\btractors?\b/i, /\btillage/i,
  /\bmowers?\b/i, /\bbush\s?hog/i, /\bflail/i,
  /\bfinish\s?(mow|cut)/i,
  /\brotary\s?cut/i, /\bpasture/i, /\bbales?\b/i,
  /\blivestock/i, /\bcattle/i, /\bcow/i, /\bhorse/i, /\backstage/i,
  /\bacreage/i, /\brural\b/i, /\bagri/i,
  /\bgrain/i, /\bharvest/i, /\bsowing?\b/i,
  /\bplant(ed|ing)?\b/i,
  /\bfenc(e|ing)\b/i, /\bbarn/i,
  /\boutdoor/i,
  /\blandscape/i, /\bgarden/i,
  /\bsmall\s?engine/i, /\bequipment\b/i,
  /\bproperty\b/i,
  /\bsoil\b/i, /\bsoils\b/i,
  /\boff[\s-]?grid/i,
  /\bcabin/i,
  /\bwoods\b/i,
];

const STRONG_REJECT = [
  /\bgolf/i, /\bfifa/i, /\bgaming/i, /\besport/i, /\bgame\s?play/i, /\bfortnite/i,
  /\bminecraft/i, /\bleague\s?of\s?legends/i, /\bmoba/i, /\bvalorant/i, /\banime/i,
  /\bkpop/i, /\bjpop/i, /\bpop\s?music/i, /\bmakeup/i, /\bbeauty/i, /\bfashion/i,
];

const AUTO_TERMS = [
  /\bgarage/i, /\bdrift/i, /\brac(ing|er)/i, /\bjdm/i, /\bmuscle/i, /\bdriv/i,
  /\btire/i, /\bengine\s?swap/i, /\bmechanic/i, /\bauto\b/i, /\bcar\b/i,
];

function classify(name) {
  const n = name || '';
  for (const re of STRONG_REJECT) if (re.test(n)) return 'reject';
  for (const re of STRONG_FIT) if (re.test(n)) return 'fit';
  for (const re of AUTO_TERMS) if (re.test(n)) return 'maybe_auto';
  return 'unknown';
}

const buckets = { fit: [], maybe_auto: [], unknown: [], reject: [] };
for (const it of items) {
  const f = classify(it.name);
  it._fit = f;
  buckets[f].push(it);
}
for (const k of Object.keys(buckets)) {
  buckets[k].sort((a, b) => (b.youtube_avg_views_30d || 0) - (a.youtube_avg_views_30d || 0));
}

console.log('=== TOTALS ===');
console.log(JSON.stringify({
  fetched: data.fetched,
  in_range: data.in_range,
  fit: buckets.fit.length,
  maybe_auto: buckets.maybe_auto.length,
  unknown: buckets.unknown.length,
  reject: buckets.reject.length,
}, null, 2));

console.log('\n=== FIT (all, sorted by avg desc) ===');
console.log(buckets.fit.map((x) => `${x.customer_id}\t${x.name}\t${x.youtube_avg_views_30d}\t${x.youtube_median_views_30d}`).join('\n'));

console.log('\n=== UNKNOWN (top 40 by avg) ===');
console.log(buckets.unknown.slice(0, 40).map((x) => `${x.customer_id}\t${x.name}\t${x.youtube_avg_views_30d}\t${x.youtube_median_views_30d}`).join('\n'));

fs.writeFileSync(path.join(__dirname, '_tmp_r3_classified.json'), JSON.stringify(buckets, null, 2));
