const { getSetting, providerKey, legacyKeysFor } = require('./aiClient');

function detectPlatform(url) {
  const lower = String(url).toLowerCase();
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube';
  if (lower.includes('instagram.com')) return 'instagram';
  if (lower.includes('tiktok.com')) return 'tiktok';
  return 'unknown';
}

function dig(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[key] !== undefined) return obj[key];
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = dig(v, key);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

function findFirst(obj, keys) {
  for (const k of keys) {
    const v = dig(obj, k);
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

function normalizeCount(v) {
  if (v && typeof v === 'object' && 'count' in v) return Number(v.count) || 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeDate(v) {
  if (!v) return '';
  if (typeof v === 'number' && v > 1e8) return new Date(v * 1000).toISOString().slice(0, 10);
  const s = String(v);
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s.slice(0, 10);
}

async function getScrapeCreatorsSetting() {
  for (const scope of ['instagram', 'tiktok', 'youtube']) {
    const s = await getSetting(providerKey(scope, 'scrapecreators'), legacyKeysFor(scope, 'scrapecreators'));
    if (s?.api_key) return s;
  }
  return null;
}

const ENDPOINTS = {
  instagram: ['/v1/instagram/post'],
  tiktok: ['/v2/tiktok/video', '/v1/tiktok/video'],
  youtube: ['/v1/youtube/video']
};

const FIELD_MAP = {
  play_count: ['video_play_count', 'play_count', 'playCount', 'view_count', 'video_view_count', 'videoViewCount', 'viewCountInt', 'views', 'viewCount'],
  like_count: ['edge_media_preview_like', 'edge_liked_by', 'like_count', 'likeCount', 'likes', 'digg_count', 'diggCount', 'likeCountInt'],
  comment_count: ['comment_count', 'commentCount', 'comments_count', 'commentCountInt'],
  published_at: ['taken_at_timestamp', 'taken_at', 'create_time', 'createTime', 'created_at', 'createdAt', 'publishDate', 'publishedTime', 'published_at']
};

async function fetchContentStats(url) {
  const platform = detectPlatform(url);
  if (!['instagram', 'tiktok', 'youtube'].includes(platform)) {
    throw new Error(`不支持的链接平台：${platform || '未知'}`);
  }

  const setting = await getScrapeCreatorsSetting();
  if (!setting?.api_key) throw new Error('ScrapeCreators API Key 未配置');

  const baseUrl = (setting.base_url || 'https://api.scrapecreators.com').replace(/\/+$/, '').replace(/\/v1$/, '');
  const headers = { 'x-api-key': setting.api_key, Authorization: `Bearer ${setting.api_key}` };

  const endpoints = ENDPOINTS[platform];
  let data = null;
  let lastError = null;

  for (const ep of endpoints) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(`${baseUrl}${ep}?url=${encodeURIComponent(url)}`, { headers, signal: ctrl.signal });
      const json = await res.json().catch(() => ({}));
      if (res.status === 402) throw Object.assign(new Error('ScrapeCreators 额度耗尽（402），请充值后重试'), { noRetry: true });
      if (res.status === 401) throw Object.assign(new Error('ScrapeCreators API Key 无效（401）'), { noRetry: true });
      if (!res.ok) {
        lastError = new Error(`ScrapeCreators HTTP ${res.status}${json.message || json.error ? `: ${json.message || json.error}` : ''}`);
        continue;
      }
      data = json;
      break;
    } catch (error) {
      if (error.noRetry) throw error;
      lastError = error.name === 'AbortError' ? new Error('ScrapeCreators 请求超时（30s）') : error;
    } finally {
      clearTimeout(timer);
    }
  }

  if (!data) throw lastError || new Error('ScrapeCreators 请求失败');

  const media = data?.data?.xdt_shortcode_media || data?.data || data || {};

  return {
    platform,
    published_at: normalizeDate(findFirst(media, FIELD_MAP.published_at)),
    play_count: normalizeCount(findFirst(media, FIELD_MAP.play_count)),
    like_count: normalizeCount(findFirst(media, FIELD_MAP.like_count)),
    comment_count: normalizeCount(findFirst(media, FIELD_MAP.comment_count))
  };
}

module.exports = { detectPlatform, fetchContentStats };
