const { getSetting, providerKey, legacyKeysFor } = require('./aiClient');

// Bright Data Web Scraper API（datasets/v3）客户端。
// 文档：https://docs.brightdata.com/products/scrapers/overview
// - 同步采集：POST /datasets/v3/scrape?dataset_id=...&format=json&include_errors=true
//   最多 20 条输入，服务端最多等待约 1 分钟；超时返回 snapshot envelope，需要轮询。
// - 异步发现：POST /datasets/v3/trigger?dataset_id=...&type=discover_new&discover_by=keyword
// - 轮询：GET /datasets/v3/progress/{snapshot_id}；取数：GET /datasets/v3/snapshot/{snapshot_id}
// 鉴权：Authorization: Bearer {token}（控制台 Settings → API Tokens 生成）。

const DEFAULT_BASE_URL = 'https://api.brightdata.com';

// 官方文档已公开的数据集 ID；空字符串表示官方未公开固定 ID（discover 类），
// 需在设置页「数据集 ID 覆盖」里填入账号实际开通的数据集 ID。
const DEFAULT_DATASETS = {
  instagram_profile: 'gd_l1vikfch901nx3by4',
  instagram_post: 'gd_lk5ns7kz21pck8jpis',
  instagram_reel: 'gd_lyclm20il4r5helnj',
  instagram_reels_from_profile: '',
  instagram_search: '',
  tiktok_profile: 'gd_l1villgoiiidt09ci',
  tiktok_post: '',
  tiktok_videos_from_profile: '',
  tiktok_search: ''
};

const DATASET_LABELS = {
  instagram_profile: 'Instagram 资料（按 URL）',
  instagram_post: 'Instagram 帖子（按 URL）',
  instagram_reel: 'Instagram Reel（按 URL）',
  instagram_reels_from_profile: 'Instagram 主页全部 Reels（discover）',
  instagram_search: 'Instagram 关键词搜索（discover）',
  tiktok_profile: 'TikTok 资料（按 URL）',
  tiktok_post: 'TikTok 视频（按 URL）',
  tiktok_videos_from_profile: 'TikTok 主页全部视频（discover）',
  tiktok_search: 'TikTok 关键词搜索（discover）'
};

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function baseUrlOf(row) {
  return clean(row?.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function datasetIdsOf(row) {
  const extra = parseJson(row?.extra_config, {});
  return { ...DEFAULT_DATASETS, ...parseJson(extra.dataset_ids, {}) };
}

async function getBrightDataSetting(platform) {
  const row = await getSetting(providerKey(platform, 'brightdata'), legacyKeysFor(platform, 'brightdata'));
  if (!row?.api_key) {
    throw new Error('Bright Data API Token 未配置（设置 → 平台数据源 → ' + platform + ' → Bright Data）');
  }
  return { api_key: row.api_key, base_url: baseUrlOf(row), dataset_ids: datasetIdsOf(row), raw: row };
}

function configFromSettingRow(row) {
  if (!row?.api_key) throw new Error('Bright Data API Token 未配置');
  return { api_key: row.api_key, base_url: baseUrlOf(row), dataset_ids: datasetIdsOf(row) };
}

function resolveDatasetId(config, key) {
  const id = clean(config.dataset_ids?.[key]);
  if (!id) {
    throw new Error(
      'Bright Data 数据集未配置：' + (DATASET_LABELS[key] || key)
      + '。请在 Bright Data 控制台启用对应爬虫后，把 dataset_id 填入设置 → 平台数据源 → Bright Data 的「数据集 ID 覆盖」'
    );
  }
  return id;
}

async function bdFetch(url, config, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + config.api_key,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        data = parseNdjson(text);
      }
    }
    if (!response.ok) {
      const message = data?.error?.message || data?.message || ('HTTP ' + response.status);
      const error = new Error('Bright Data HTTP ' + response.status + ': ' + message);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Bright Data snapshot 接口在 format=json 下偶尔返回 NDJSON，做兼容解析。
function parseNdjson(text) {
  const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean);
  const records = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      return { raw: line };
    }
  });
  return Array.isArray(records) && records.length === 1 ? records[0] : records;
}

// 同步 /scrape 在任务未完成时返回 [{ snapshot_id, status }] 形式的信封。
function snapshotEnvelopeOf(data) {
  if (!Array.isArray(data) || !data.length) return null;
  const looksLikeEnvelope = data.every((item) => item && typeof item === 'object' && clean(item.snapshot_id));
  const hasRecordFields = data.some((item) => clean(item.url) || clean(item.post_id) || clean(item.account) || clean(item.username));
  return looksLikeEnvelope && !hasRecordFields ? data : null;
}

function isFailedRecord(record) {
  if (!record || typeof record !== 'object') return false;
  return record.status === 'failed' || Boolean(record.error);
}

async function pollSnapshot(config, snapshotId, { maxWaitMs = 600000, pollIntervalMs = 5000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  let lastStatus = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const progressUrl = config.base_url + '/datasets/v3/progress/' + encodeURIComponent(snapshotId);
    const progress = await bdFetch(progressUrl, config, {}, 30000);
    lastStatus = clean(progress?.status || progress?.state);
    if (lastStatus === 'ready' || lastStatus === 'completed') break;
    if (lastStatus === 'failed') {
      const detail = progress?.error || progress;
      throw new Error('Bright Data 采集任务失败（snapshot ' + snapshotId + '）：' + JSON.stringify(detail).slice(0, 300));
    }
    if (Date.now() > deadline) {
      throw new Error('Bright Data 采集超时（snapshot ' + snapshotId + '，状态 ' + (lastStatus || 'running') + '）');
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  const snapshotUrl = config.base_url + '/datasets/v3/snapshot/' + encodeURIComponent(snapshotId) + '?format=json';
  const records = await bdFetch(snapshotUrl, config, {}, 120000);
  return Array.isArray(records) ? records : [records].filter(Boolean);
}

async function collectSnapshotPayload(config, data, pollOptions) {
  const envelope = snapshotEnvelopeOf(data);
  if (!envelope) return Array.isArray(data) ? data : [data].filter(Boolean);
  const snapshotId = clean(envelope[0]?.snapshot_id);
  if (!snapshotId) return [];
  return pollSnapshot(config, snapshotId, pollOptions);
}

function splitRecords(records) {
  const ok = (records || []).filter((record) => !isFailedRecord(record));
  const failed = (records || []).filter(isFailedRecord);
  return { ok, failed };
}

// 同步采集：按 URL 类数据集（<=20 条输入）。
async function scrapeDataset(config, datasetKey, inputs, options = {}) {
  const datasetId = resolveDatasetId(config, datasetKey);
  const url = config.base_url + '/datasets/v3/scrape?dataset_id=' + encodeURIComponent(datasetId)
    + '&format=json&include_errors=true&notify=false';
  const data = await bdFetch(url, config, { method: 'POST', body: JSON.stringify({ input: inputs }) });
  const records = await collectSnapshotPayload(config, data, options);
  const { ok, failed } = splitRecords(records);
  if (!ok.length && failed.length) {
    throw new Error('Bright Data 采集失败：' + JSON.stringify(failed[0]?.error || failed[0]).slice(0, 300));
  }
  return ok;
}

// 异步发现：关键词/主页类 discover 数据集（type=discover_new）。
async function discoverDataset(config, datasetKey, inputs, options = {}) {
  const datasetId = resolveDatasetId(config, datasetKey);
  const url = config.base_url + '/datasets/v3/trigger?dataset_id=' + encodeURIComponent(datasetId)
    + '&type=discover_new&discover_by=keyword&format=json&include_errors=true';
  const data = await bdFetch(url, config, { method: 'POST', body: JSON.stringify({ input: inputs }) });
  const records = await collectSnapshotPayload(config, data, options);
  const { ok, failed } = splitRecords(records);
  if (!ok.length && failed.length) {
    throw new Error('Bright Data 发现任务失败：' + JSON.stringify(failed[0]?.error || failed[0]).slice(0, 300));
  }
  return ok;
}

// 列出账号下可用的数据集（连接测试 + 查 discover 类 dataset_id）。
async function listDatasets(config) {
  const data = await bdFetch(config.base_url + '/datasets/list', config, {}, 30000);
  return Array.isArray(data) ? data : [data].filter(Boolean);
}

// ---------- 归一化 ----------

function instagramProfileUrl(handleOrUrl) {
  const text = clean(handleOrUrl);
  if (/^https?:\/\//i.test(text)) return text;
  return 'https://www.instagram.com/' + text.replace(/^@/, '') + '/';
}

function tiktokProfileUrl(handleOrUrl) {
  const text = clean(handleOrUrl);
  if (/^https?:\/\//i.test(text)) return text;
  return 'https://www.tiktok.com/@' + text.replace(/^@/, '');
}

function normalizeInstagramProfile(record = {}) {
  return {
    username: clean(record.account || record.username),
    followers: optionalNumber(record.followers ?? record.follower_count),
    postsCount: optionalNumber(record.posts_count),
    bio: clean(record.bio || record.description),
    email: clean(record.public_email || record.email || ''),
    isVerified: Boolean(record.is_verified),
    isBusiness: Boolean(record.is_business_account),
    profileUrl: clean(record.url || record.profile_url),
    raw: record
  };
}

function normalizeInstagramMedia(record = {}, handle = '') {
  const url = clean(record.url);
  const shortcode = clean(record.shortcode || (url ? url.split('/').filter(Boolean).pop() : '') || record.post_id || record.content_id);
  return {
    id: shortcode,
    title: clean(record.description),
    url,
    publishedAt: clean(record.date_posted) || null,
    views: optionalNumber(record.video_play_count ?? record.video_view_count ?? record.views),
    likes: number(record.likes),
    comments: number(record.num_comments),
    handle
  };
}

function normalizeTikTokProfile(record = {}) {
  return {
    username: clean(record.username || record.name || record.account || record.nickname),
    followers: optionalNumber(record.followers ?? record.follower_count ?? record.fans),
    bio: clean(record.bio || record.description),
    videosCount: optionalNumber(record.videos ?? record.videos_count ?? record.videos_num),
    profileUrl: clean(record.url || record.profile_url),
    raw: record
  };
}

function normalizeTikTokMedia(record = {}, handle = '') {
  const url = clean(record.url);
  const id = clean(record.post_id || record.aweme_id || record.id || (url ? url.split('/').filter(Boolean).pop() : ''));
  const stats = record.statistics || record.stats || {};
  return {
    id,
    title: clean(record.description || record.desc || record.title),
    url,
    publishedAt: clean(record.date_posted || record.create_time) || null,
    views: optionalNumber(record.video_play_count ?? record.play_count ?? record.playCount ?? stats.play_count ?? stats.playCount),
    likes: number(record.likes ?? record.digg_count ?? stats.digg_count),
    comments: number(record.num_comments ?? record.comment_count ?? stats.comment_count),
    handle
  };
}

// ---------- 高层能力 ----------

async function fetchInstagramProfile(config, handleOrUrl) {
  const records = await scrapeDataset(config, 'instagram_profile', [{ url: instagramProfileUrl(handleOrUrl) }]);
  if (!records.length) throw new Error('Bright Data 未返回该 Instagram 主页资料');
  return normalizeInstagramProfile(records[0]);
}

async function fetchTikTokProfile(config, handleOrUrl) {
  const records = await scrapeDataset(config, 'tiktok_profile', [{ url: tiktokProfileUrl(handleOrUrl) }]);
  if (!records.length) throw new Error('Bright Data 未返回该 TikTok 主页资料');
  return normalizeTikTokProfile(records[0]);
}

// 主页近况视频列表（discover 类数据集，需在设置中填 dataset_id）。
async function fetchInstagramProfileVideos(config, handleOrUrl, limit = 10) {
  const profileUrl = instagramProfileUrl(handleOrUrl);
  const [videos, profile] = await Promise.all([
    discoverDataset(config, 'instagram_reels_from_profile', [{ url: profileUrl }]),
    fetchInstagramProfile(config, profileUrl).catch(() => null)
  ]);
  const handle = clean((profile?.username) || profileUrl.split('/').filter(Boolean).pop());
  return {
    videos: (videos || []).map((record) => normalizeInstagramMedia(record, handle)).filter((video) => video.id),
    followers: profile?.followers ?? null
  };
}

async function fetchTikTokProfileVideos(config, handleOrUrl, limit = 10) {
  const profileUrl = tiktokProfileUrl(handleOrUrl);
  const [videos, profile] = await Promise.all([
    discoverDataset(config, 'tiktok_videos_from_profile', [{ url: profileUrl }]),
    fetchTikTokProfile(config, profileUrl).catch(() => null)
  ]);
  const handle = clean((profile?.username) || profileUrl.split('/').filter(Boolean).pop().replace(/^@/, ''));
  return {
    videos: (videos || []).map((record) => normalizeTikTokMedia(record, handle)).filter((video) => video.id),
    followers: profile?.followers ?? null
  };
}

// 关键词搜索（帖子/Reels 记录，含作者信息，用于达人寻找）。
// 返回归一化记录并保留 raw 原始字段（含 user_posted / followers 等作者信息）。
async function searchInstagramKeyword(config, keyword, { numOfPosts = 100 } = {}) {
  const records = await discoverDataset(config, 'instagram_search', [{
    keyword: clean(keyword),
    num_of_posts: Math.max(1, Number(numOfPosts) || 100)
  }], { maxWaitMs: 900000 });
  return (records || []).map((record) => ({ ...normalizeInstagramMedia(record), raw: record }));
}

async function searchTikTokKeyword(config, keyword, { numOfPosts = 100 } = {}) {
  const records = await discoverDataset(config, 'tiktok_search', [{
    keyword: clean(keyword),
    num_of_posts: Math.max(1, Number(numOfPosts) || 100)
  }], { maxWaitMs: 900000 });
  return (records || []).map((record) => ({ ...normalizeTikTokMedia(record), raw: record }));
}

// 单条内容按 URL 采集（视频分析用）。
async function fetchInstagramMediaByUrl(config, url) {
  const text = clean(url);
  const isReel = /instagram\.com\/(reel|reels)\//i.test(text);
  const records = await scrapeDataset(config, isReel ? 'instagram_reel' : 'instagram_post', [{ url: text }]);
  const media = (records || []).map((record) => ({ ...normalizeInstagramMedia(record), raw: record })).filter((item) => item.id);
  if (!media.length) throw new Error('Bright Data 未返回该 Instagram 内容数据');
  return media[0];
}

async function fetchTikTokMediaByUrl(config, url) {
  const records = await scrapeDataset(config, 'tiktok_post', [{ url: clean(url) }]);
  const media = (records || []).map((record) => ({ ...normalizeTikTokMedia(record), raw: record })).filter((item) => item.id);
  if (!media.length) throw new Error('Bright Data 未返回该 TikTok 视频数据');
  return media[0];
}

module.exports = {
  DEFAULT_DATASETS,
  DATASET_LABELS,
  clean,
  optionalNumber,
  parseNdjson,
  snapshotEnvelopeOf,
  isFailedRecord,
  getBrightDataSetting,
  configFromSettingRow,
  resolveDatasetId,
  scrapeDataset,
  discoverDataset,
  pollSnapshot,
  listDatasets,
  instagramProfileUrl,
  tiktokProfileUrl,
  normalizeInstagramProfile,
  normalizeInstagramMedia,
  normalizeTikTokProfile,
  normalizeTikTokMedia,
  fetchInstagramProfile,
  fetchTikTokProfile,
  fetchInstagramProfileVideos,
  fetchTikTokProfileVideos,
  searchInstagramKeyword,
  searchTikTokKeyword,
  fetchInstagramMediaByUrl,
  fetchTikTokMediaByUrl
};
