const { getSetting, providerKey, legacyKeysFor } = require('./aiClient');

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeTikTokHandle(input) {
  const value = String(input || '').trim().replace(/\\/g, '');
  if (!value) throw Object.assign(new Error('profile_url or handle is required'), { statusCode: 400 });
  let handle = value;
  try {
    const url = new URL(value.startsWith('http') ? value : `https://${value}`);
    const match = url.pathname.match(/\/@([^/?#]+)/);
    if (match) handle = match[1];
  } catch (_) {}
  handle = handle.replace(/^@/, '').split(/[/?#]/)[0].trim();
  if (!/^[A-Za-z0-9._]{2,64}$/.test(handle)) {
    throw Object.assign(new Error('Invalid TikTok profile URL or handle'), { statusCode: 400 });
  }
  return handle;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function fetchJson(url, apiKey, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetchImpl(url, { headers: { 'x-api-key': apiKey }, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`ScrapeCreators HTTP ${response.status}: ${body.message || body.error || 'request failed'}`), { statusCode: 502 });
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function getTikTokSetting() {
  return getSetting(providerKey('tiktok', 'scrapecreators'), legacyKeysFor('tiktok', 'scrapecreators'));
}

async function getTikTokMedianExposure(input, options = {}) {
  const handle = normalizeTikTokHandle(input);
  const nowMs = options.nowMs ?? Date.now();
  const cutoffSeconds = Math.floor((nowMs - 30 * DAY_MS) / 1000);
  const nowSeconds = Math.floor(nowMs / 1000);
  const setting = options.setting || await getTikTokSetting();
  if (!setting?.api_key) throw Object.assign(new Error('TikTok ScrapeCreators API is not configured'), { statusCode: 503 });
  const baseUrl = String(setting.base_url || 'https://api.scrapecreators.com').replace(/\/$/, '').replace(/\/v1$/, '');
  const seen = new Map();
  let cursor;

  for (let page = 0; page < 15; page += 1) {
    const url = new URL(`${baseUrl}/v3/tiktok/profile/videos`);
    url.searchParams.set('handle', handle);
    if (cursor !== undefined) url.searchParams.set('max_cursor', cursor);
    const data = await fetchJson(url.toString(), setting.api_key, options.fetchImpl);
    const videos = Array.isArray(data.aweme_list) ? data.aweme_list : [];
    for (const video of videos) if (video.aweme_id) seen.set(String(video.aweme_id), video);
    const inWindow = videos.some((video) => Number(video.create_time) >= cutoffSeconds);
    if (!videos.length || !data.has_more || (page > 0 && !inWindow) || !data.max_cursor || data.max_cursor === cursor) break;
    cursor = data.max_cursor;
  }

  const videos = [...seen.values()]
    .filter((video) => Number(video.create_time) >= cutoffSeconds && Number(video.create_time) <= nowSeconds + 86400)
    .map((video) => ({
      video_id: String(video.aweme_id),
      published_at: new Date(Number(video.create_time) * 1000).toISOString(),
      views: Number(video.statistics?.play_count || 0)
    }))
    .sort((a, b) => b.published_at.localeCompare(a.published_at));
  const views = videos.map((video) => video.views);

  return {
    platform: 'tiktok',
    handle,
    profile_url: `https://www.tiktok.com/@${handle}`,
    window_start: new Date(nowMs - 30 * DAY_MS).toISOString(),
    window_end: new Date(nowMs).toISOString(),
    posts_30d: videos.length,
    median_views_30d: median(views),
    average_views_30d: views.length ? Math.round(views.reduce((sum, value) => sum + value, 0) / views.length) : null,
    videos
  };
}

module.exports = { normalizeTikTokHandle, median, getTikTokMedianExposure };
