const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const { dbOperations, models } = require('../database');
const { normalizeVideoUrl } = require('../utils/videoUrlNormalizer');

const router = express.Router();

const SYSTEM_SELECTION_KEY = 'system.provider_selection';

const DEFAULT_SELECTION = {
  platforms: {
    youtube: { primary: 'google_official', fallbacks: [] },
    instagram: { primary: 'scrapecreators', fallbacks: [] },
    tiktok: { primary: 'scrapecreators', fallbacks: [] }
  },
  aiModels: { active: 'deepseek' },
  fallbackStrategy: {
    enableFallback: false,
    saveFailureReasons: true,
    saveRawResponses: true,
    allowAiToolCalls: false
  }
};

const PROVIDER_LABELS = {
  google_official: 'Google Official',
  scrapecreators: 'ScrapeCreators',
  brightdata: 'Bright Data',
  apify: 'Apify',
  maton_gateway: 'Maton Gateway',
  custom: 'Custom',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  custom_openai_compatible: 'Custom OpenAI-Compatible',
  custom_http_api: 'Custom HTTP API'
};

const EXPORT_HEADERS = [
  '视频ID', '产品/活动', '平台', 'KOL', '标题', '作者', '原始链接', '平台视频ID', '状态', '抓取状态', 'AI状态',
  '分析时间', '发布时间', '合作价格', '备注', '最近抓取时间', '内容类型', '主要曝光数', '曝光口径', '数据完整性',
  '播放数', '点赞数', '评论数', '收藏数', '分享数',
  'AI评分', 'AI摘要', 'AI情绪-正向', 'AI情绪-中性', 'AI情绪-负向', 'AI购买意向数量', 'AI购买意向关键词',
  'AI品牌提及', 'AI风险点', 'AI产品反馈', 'AI合作建议', 'AI内容优化建议', 'AI完整报告', 'AI最终提示词',
  'AI报告时间', '创建时间'
];

const IMPORT_HEADER_MAP = {
  视频链接: 'source_url',
  链接: 'source_url',
  URL: 'source_url',
  url: 'source_url',
  source_url: 'source_url',
  原始链接: 'source_url',
  '所属产品/活动': 'campaign_name',
  产品: 'campaign_name',
  活动: 'campaign_name',
  产品活动: 'campaign_name',
  Campaign: 'campaign_name',
  campaign: 'campaign_name',
  'KOL 名称': 'kol_name',
  KOL: 'kol_name',
  kol_name: 'kol_name',
  合作价格: 'cooperation_price',
  报价: 'cooperation_price',
  cooperation_price: 'cooperation_price',
  备注: 'notes',
  notes: 'notes'
};

const getDataDir = () => {
  if (process.pkg) return path.join(path.dirname(process.execPath), 'data');
  return path.join(__dirname, '..', '..', 'data');
};

const uploadsDir = path.join(getDataDir(), 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  })
});

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function compact(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.filter(Boolean).join('；');
  if (typeof value === 'object') return Object.entries(value).map(([key, val]) => `${key}: ${val}`).join('；');
  return String(value);
}

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

const EXCEL_CELL_LIMIT = 32767;
const EXCEL_TRUNCATION_MARK = '\n\n[Truncated for Excel export]';

function toExcelSafeValue(value) {
  if (typeof value !== 'string') return value;
  if (value.length <= EXCEL_CELL_LIMIT) return value;
  return `${value.slice(0, EXCEL_CELL_LIMIT - EXCEL_TRUNCATION_MARK.length)}${EXCEL_TRUNCATION_MARK}`;
}

function toExcelSafeRows(rows) {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, toExcelSafeValue(value)])
  ));
}

function parseLinksFromText(text = '') {
  return text
    .split(/\r?\n|,|，/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function detectPlatform(url) {
  const lower = url.toLowerCase();
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube';
  if (lower.includes('instagram.com')) return 'instagram';
  if (lower.includes('tiktok.com')) return 'tiktok';
  return 'unknown';
}

function parseYouTubeVideoId(url) {
  const patterns = [
    /youtube\.com\/watch\?[^#]*v=([^&#]+)/i,
    /youtube\.com\/shorts\/([^?&#/]+)/i,
    /youtu\.be\/([^?&#/]+)/i
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function normalizeCount(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function detectYouTubeContentType(url = '') {
  return url.toLowerCase().includes('/shorts/') ? 'short' : 'video';
}

function detectInstagramContentType(post = {}, url = '') {
  const rawType = String(firstDefined(
    post.product_type,
    post.media_type,
    post.mediaType,
    post.type,
    post.__typename,
    post.media_product_type,
    ''
  )).toLowerCase();
  const lowerUrl = String(url || '').toLowerCase();

  if (rawType.includes('reel') || lowerUrl.includes('/reel/')) return 'reel';
  if (rawType.includes('clips') || rawType.includes('clip')) return 'reel';
  if (rawType.includes('carousel') || rawType.includes('album') || Array.isArray(post.carousel_media) || Array.isArray(post.children)) return 'carousel';
  if (rawType.includes('video')) return 'video';
  if (post.is_video === true || post.video_url || post.video_view_count !== undefined || post.video_play_count !== undefined) {
    return lowerUrl.includes('/reel/') || rawType.includes('clips') ? 'reel' : 'video';
  }
  if (rawType.includes('image') || rawType.includes('photo')) return 'image';
  return lowerUrl.includes('/reel/') ? 'reel' : 'unknown';
}

function unwrapScrapeCreatorsPost(data = {}) {
  return firstDefined(
    data.response?.aweme_detail,
    data.aweme_detail,
    data.data?.response?.aweme_detail,
    data.data?.aweme_detail,
    data.data?.xdt_shortcode_media,
    data.data?.shortcode_media,
    data.data?.media,
    data.data?.post,
    data.post,
    data.video,
    data.data,
    data
  );
}

function getEdgeCount(edge) {
  return normalizeCount(edge?.count);
}

function getInstagramCaption(post = {}) {
  return firstDefined(
    post.caption,
    post.title,
    post.edge_media_to_caption?.edges?.[0]?.node?.text,
    post.accessibility_caption
  );
}

function normalizeTimestamp(value) {
  if (!value) return '';
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric > 100000000000 ? numeric : numeric * 1000;
    return new Date(milliseconds).toISOString();
  }
  return value;
}

function getInstagramComments(post = {}, data = {}) {
  const direct = post.comments || data.comments || data.data?.comments || [];
  if (Array.isArray(direct) && direct.length) return direct;

  const edges = firstDefined(
    post.edge_media_to_parent_comment?.edges,
    post.edge_media_to_comment?.edges,
    post.edge_media_preview_comment?.edges,
    []
  );

  return Array.isArray(edges) ? edges.map((edge) => edge.node || edge) : [];
}

function buildExposure(platform, contentType, metrics = {}) {
  const playCount = normalizeCount(metrics.play_count);

  if (platform === 'youtube') {
    return {
      primary_exposure_count: playCount,
      exposure_metric_type: 'YouTube viewCount',
      data_quality_note: playCount === null ? '缺少公开视频数' : '完整'
    };
  }

  if (platform === 'tiktok') {
    return {
      primary_exposure_count: playCount,
      exposure_metric_type: 'TikTok play_count',
      data_quality_note: playCount === null ? '缺少公开视频数' : '完整'
    };
  }

  if (platform === 'instagram') {
    if (playCount !== null) {
      const metricType = contentType === 'reel'
        ? 'Instagram Reel play_count'
        : 'Instagram video_view_count';
      return {
        primary_exposure_count: playCount,
        exposure_metric_type: metricType,
        data_quality_note: '完整'
      };
    }

    const label = contentType === 'carousel' ? '多图帖' : contentType === 'image' ? '图片帖' : '该内容';
    return {
      primary_exposure_count: null,
      exposure_metric_type: `Instagram ${label}无公开播放/浏览数`,
      data_quality_note: '缺少曝光数'
    };
  }

  return {
    primary_exposure_count: playCount,
    exposure_metric_type: playCount === null ? 'unavailable' : 'play_count',
    data_quality_note: playCount === null ? '缺少曝光数' : '完整'
  };
}

function providerKey(scope, provider) {
  return `${scope}.${provider}`;
}

function mergeSelection(saved) {
  return {
    platforms: {
      youtube: { ...DEFAULT_SELECTION.platforms.youtube, ...(saved.platforms?.youtube || {}) },
      instagram: { ...DEFAULT_SELECTION.platforms.instagram, ...(saved.platforms?.instagram || {}) },
      tiktok: { ...DEFAULT_SELECTION.platforms.tiktok, ...(saved.platforms?.tiktok || {}) }
    },
    aiModels: { ...DEFAULT_SELECTION.aiModels, ...(saved.aiModels || {}) },
    fallbackStrategy: { ...DEFAULT_SELECTION.fallbackStrategy, ...(saved.fallbackStrategy || {}) }
  };
}

async function getSelection() {
  const row = await dbOperations.get('SELECT extra_config FROM api_settings WHERE provider = ?', [SYSTEM_SELECTION_KEY]);
  return mergeSelection(parseJson(row?.extra_config, {}));
}

async function getSetting(key, legacyKeys = []) {
  const direct = await dbOperations.get('SELECT * FROM api_settings WHERE provider = ?', [key]);
  if (direct?.api_key || direct?.base_url || direct?.model || direct?.extra_config) return direct;

  for (const legacyKey of legacyKeys) {
    const legacy = await dbOperations.get('SELECT * FROM api_settings WHERE provider = ?', [legacyKey]);
    if (legacy?.api_key || legacy?.base_url || legacy?.model || legacy?.extra_config) return legacy;
  }

  return direct || null;
}

function legacyKeysFor(scope, provider) {
  if (scope === 'youtube' && provider === 'google_official') return ['youtube'];
  if (provider === 'scrapecreators') return ['scrapecreators'];
  if (provider === 'brightdata') return ['brightdata'];
  if (provider === 'apify') return ['apify'];
  if (scope === 'ai' && provider === 'deepseek') return ['ai'];
  return [];
}

function hasProviderConfig(setting) {
  return Boolean(setting?.api_key || setting?.base_url || setting?.model);
}

async function fetchJson(url, options = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('当前 Node.js 版本不支持 fetch，请升级到 Node.js 18+');
  }

  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `HTTP ${response.status}`);
  }

  return data;
}

async function fetchFirstJson(candidates, options = {}) {
  const errors = [];
  for (const url of candidates) {
    try {
      const data = await fetchJson(url, options);
      return { data, url };
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(errors.join('；'));
}

async function fetchYouTubeGoogle(url, setting) {
  if (!setting?.api_key) throw new Error('Google Official YouTube API Key 未配置');

  const videoId = parseYouTubeVideoId(url);
  if (!videoId) throw new Error('无法识别 YouTube 视频 ID');

  const apiKey = encodeURIComponent(setting.api_key);
  const videoApi = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${encodeURIComponent(videoId)}&key=${apiKey}`;
  const videoData = await fetchJson(videoApi);
  const item = videoData.items?.[0];
  if (!item) throw new Error('YouTube 未返回该视频数据');

  const commentsApi = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(videoId)}&maxResults=100&order=relevance&textFormat=plainText&key=${apiKey}`;
  const comments = await fetchYouTubeComments(commentsApi);
  return normalizeYouTubeItem(item, videoId, comments, url);
}

function matonHeaders(setting) {
  const extra = parseJson(setting?.extra_config, {});
  const headers = { Authorization: `Bearer ${setting.api_key}` };
  if (extra.connection_id) headers['Maton-Connection'] = extra.connection_id;
  return headers;
}

async function fetchYouTubeMaton(url, setting) {
  if (!setting?.api_key) throw new Error('Maton Gateway API Key 未配置');

  const videoId = parseYouTubeVideoId(url);
  if (!videoId) throw new Error('无法识别 YouTube 视频 ID');

  const baseUrl = (setting.base_url || 'https://api.maton.ai').replace(/\/$/, '');
  const videoApi = `${baseUrl}/youtube/youtube/v3/videos?part=snippet,statistics&id=${encodeURIComponent(videoId)}`;
  const videoData = await fetchJson(videoApi, { headers: matonHeaders(setting) });
  const item = videoData.items?.[0];
  if (!item) throw new Error('Maton Gateway 未返回该 YouTube 视频数据');

  const commentsApi = `${baseUrl}/youtube/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(videoId)}&maxResults=100&order=relevance&textFormat=plainText`;
  const comments = await fetchYouTubeComments(commentsApi, { headers: matonHeaders(setting) });
  return normalizeYouTubeItem(item, videoId, comments, url);
}

async function fetchYouTubeComments(url, options = {}) {
  try {
    const commentData = await fetchJson(url, options);
    return (commentData.items || []).map((row) => {
      const top = row.snippet?.topLevelComment?.snippet || {};
      return {
        id: row.id,
        parent_id: null,
        user_name: top.authorDisplayName || '',
        content: top.textDisplay || top.textOriginal || '',
        like_count: normalizeCount(top.likeCount),
        commented_at: top.publishedAt || '',
        raw: row
      };
    });
  } catch (error) {
    return [];
  }
}

function normalizeYouTubeItem(item, videoId, comments, url = '') {
  const snippet = item.snippet || {};
  const stats = item.statistics || {};
  const metrics = {
    play_count: normalizeCount(stats.viewCount),
    like_count: normalizeCount(stats.likeCount),
    comment_count: normalizeCount(stats.commentCount),
    collect_count: 0,
    share_count: null
  };
  const contentType = detectYouTubeContentType(url);
  return {
    platform: 'youtube',
    platform_video_id: videoId,
    kol_name: snippet.channelTitle || '',
    title: snippet.title || '',
    author_name: snippet.channelTitle || '',
    content_type: contentType,
    published_at: snippet.publishedAt || '',
    metrics,
    exposure: buildExposure('youtube', contentType, metrics),
    comments,
    raw: item
  };
}

async function fetchScrapeCreators(platform, url, setting) {
  if (!setting?.api_key) throw new Error('ScrapeCreators API Key 未配置');

  const baseUrl = (setting.base_url || 'https://api.scrapecreators.com').replace(/\/$/, '');
  const endpoints = platform === 'instagram'
    ? ['/v1/instagram/post']
    : ['/v2/tiktok/video', '/v1/tiktok/video'];
  const headers = {
    'x-api-key': setting.api_key,
    Authorization: `Bearer ${setting.api_key}`
  };
  const result = await fetchFirstJson(endpoints.map((endpoint) => `${baseUrl}${endpoint}?url=${encodeURIComponent(url)}`), {
    headers: {
      ...headers
    }
  });
  const data = result.data;

  const post = unwrapScrapeCreatorsPost(data);
  const owner = post.owner || post.author || post.user || {};
  const metrics = post.metrics || post.statistics || post.stats || {};
  const normalizedMetrics = {
    play_count: normalizeCount(firstDefined(metrics.play_count, metrics.view_count, metrics.video_play_count, metrics.video_view_count, post.play_count, post.view_count, post.video_play_count, post.video_view_count, post.views)),
    like_count: normalizeCount(firstDefined(metrics.like_count, metrics.digg_count, post.like_count, post.likes, post.digg_count, getEdgeCount(post.edge_media_preview_like), getEdgeCount(post.edge_liked_by))),
    comment_count: normalizeCount(firstDefined(metrics.comment_count, post.comment_count, post.comments_count, getEdgeCount(post.edge_media_to_parent_comment), getEdgeCount(post.edge_media_to_comment), getEdgeCount(post.edge_media_preview_comment))),
    collect_count: normalizeCount(firstDefined(metrics.collect_count, metrics.save_count, post.collect_count, post.save_count, post.favorites)),
    share_count: normalizeCount(firstDefined(metrics.share_count, post.share_count, post.shares))
  };
  const contentType = platform === 'instagram' ? detectInstagramContentType(post, url) : 'video';
  const rawComments = platform === 'instagram' ? getInstagramComments(post, data) : (post.comments || data.comments || []);
  const comments = Array.isArray(rawComments) ? rawComments.slice(0, 100).map((comment) => ({
    id: firstDefined(comment.id, comment.comment_id, comment.pk),
    parent_id: firstDefined(comment.parent_id, comment.parentCommentId),
    user_name: firstDefined(comment.user_name, comment.username, comment.author?.username, comment.user?.username, comment.owner?.username),
    content: firstDefined(comment.content, comment.text, comment.comment),
    like_count: normalizeCount(firstDefined(comment.like_count, comment.likes, comment.digg_count, getEdgeCount(comment.edge_liked_by))),
    commented_at: normalizeTimestamp(firstDefined(comment.created_at, comment.createdAt, comment.timestamp)),
    raw: comment
  })) : [];

  return {
    platform,
    platform_video_id: String(firstDefined(post.shortcode, post.code, post.aweme_id, post.id, post.video_id, '')),
    kol_name: firstDefined(owner.username, owner.unique_id, owner.full_name, owner.nickname, post.username, post.author_name, ''),
    title: firstDefined(getInstagramCaption(post), post.description, post.desc, ''),
    author_name: firstDefined(owner.username, owner.unique_id, owner.full_name, owner.nickname, post.username, post.author_name, ''),
    content_type: contentType,
    published_at: normalizeTimestamp(firstDefined(post.taken_at_timestamp, post.taken_at, post.created_at, post.create_time, post.published_at, '')),
    metrics: normalizedMetrics,
    exposure: buildExposure(platform, contentType, normalizedMetrics),
    comments,
    raw: { endpoint: result.url, response: data }
  };
}

async function fetchWithProvider(platform, provider, url, setting) {
  if (platform === 'youtube' && provider === 'google_official') return fetchYouTubeGoogle(url, setting);
  if (platform === 'youtube' && provider === 'maton_gateway') return fetchYouTubeMaton(url, setting);
  if ((platform === 'instagram' || platform === 'tiktok') && provider === 'scrapecreators') {
    return fetchScrapeCreators(platform, url, setting);
  }

  throw new Error(`${PROVIDER_LABELS[provider] || provider} 当前仅预留，尚未接入数据 adapter`);
}

function buildMockVideoData(url) {
  const platform = detectPlatform(url);
  const videoId = String(url).split(/[?=&/]/).pop() || 'mock';
  return {
    platform,
    platform_video_id: videoId,
    kol_name: 'Mock Creator',
    title: 'Mock Video Title',
    author_name: 'Mock Creator',
    content_type: 'video',
    published_at: new Date().toISOString(),
    metrics: {
      play_count: 100000,
      like_count: 5000,
      comment_count: 300,
      collect_count: 200,
      share_count: 150
    },
    exposure: {
      primary_exposure_count: 100000,
      exposure_metric_type: 'views',
      data_quality_note: 'mock'
    },
    comments: [],
    raw: { mock: true, url },
    provider: 'mock',
    attempts: [{ provider: 'mock', ok: true }]
  };
}

async function fetchVideoData(url) {
  const platform = detectPlatform(url);
  if (!['youtube', 'instagram', 'tiktok'].includes(platform)) {
    throw new Error('暂不支持该平台链接');
  }

  if (process.env.NODE_ENV === 'test') {
    return buildMockVideoData(url);
  }

  const selection = await getSelection();
  const platformSelection = selection.platforms[platform] || DEFAULT_SELECTION.platforms[platform];
  const order = [platformSelection.primary];
  if (selection.fallbackStrategy.enableFallback) order.push(...(platformSelection.fallbacks || []));
  const providers = [...new Set(order.filter(Boolean))];
  const attempts = [];

  for (const provider of providers) {
    const key = providerKey(platform, provider);
    const setting = await getSetting(key, legacyKeysFor(platform, provider));

    if (!hasProviderConfig(setting)) {
      attempts.push({ provider, ok: false, error: `${PROVIDER_LABELS[provider] || provider} 未配置` });
      continue;
    }

    try {
      const result = await fetchWithProvider(platform, provider, url, setting);
      return { ...result, provider, attempts: [...attempts, { provider, ok: true }] };
    } catch (error) {
      attempts.push({ provider, ok: false, error: error.message });
      if (!selection.fallbackStrategy.enableFallback) break;
    }
  }

  const message = attempts.map((item) => `${PROVIDER_LABELS[item.provider] || item.provider}: ${item.error}`).join('；');
  throw new Error(message || `没有可用的数据源 Provider（当前 ${platform} 主数据源：${platformSelection.primary}）`);
}

function buildAnalysisPrompt(video, snapshot, comments, promptTemplate, campaign) {
  const commentsForPrompt = comments.slice(0, 100).map((comment) => ({
    comment_id: comment.platform_comment_id,
    parent_comment_id: comment.parent_comment_id,
    user_name: comment.user_name,
    content: comment.content,
    like_count: comment.like_count,
    commented_at: comment.commented_at
  }));

  const payload = {
    task: promptTemplate?.user_prompt || 'Analyze this KOL campaign video.',
    keyword_settings: {
      brand_keywords: (campaign?.brand_keywords || promptTemplate?.brand_keywords || '').split(/[,，\n]/).map((v) => v.trim()).filter(Boolean),
      purchase_keywords: (campaign?.purchase_keywords || promptTemplate?.purchase_keywords || '').split(/[,，\n]/).map((v) => v.trim()).filter(Boolean),
      negative_keywords: (campaign?.negative_keywords || promptTemplate?.negative_keywords || '').split(/[,，\n]/).map((v) => v.trim()).filter(Boolean)
    },
    video: {
      platform: video.platform,
      product: campaign?.product || campaign?.name || '',
      campaign: campaign?.name || '',
      url: video.source_url,
      title: video.title,
      author_name: video.author_name,
      published_at: video.published_at,
      metrics: {
        play_count: snapshot?.play_count,
        like_count: snapshot?.like_count,
        comment_count: snapshot?.comment_count,
        collect_count: snapshot?.collect_count,
        share_count: snapshot?.share_count
      },
      comment_total_in_database: comments.length,
      comment_total_provided_to_ai: commentsForPrompt.length,
      comments: commentsForPrompt
    },
    required_json_schema: {
      score: '0-100 integer',
      summary: 'one sentence',
      sentiment: { positive: 0, neutral: 0, negative: 0 },
      purchase_intent: { count: 0, keywords: [] },
      brand_mentions: {},
      risks: [],
      product_feedback: [],
      cooperation_advice: '',
      content_suggestions: []
    }
  };

  return JSON.stringify(payload, null, 2);
}

function parseAiContent(content) {
  try {
    return JSON.parse(String(content || '{}').replace(/^```json\s*/i, '').replace(/```$/i, '').trim());
  } catch (error) {
    return { summary: content || '', score: null };
  }
}

function splitKeywordText(value) {
  return String(value || '')
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildAnalysisPromptV2(video, snapshot, comments, promptTemplate, campaign) {
  const commentsForPrompt = comments.slice(0, 100).map((comment) => ({
    comment_id: comment.platform_comment_id,
    parent_comment_id: comment.parent_comment_id,
    user_name: comment.user_name,
    content: comment.content,
    like_count: comment.like_count,
    commented_at: comment.commented_at
  }));

  const brandKeywords = splitKeywordText(campaign?.brand_keywords || promptTemplate?.brand_keywords);
  const purchaseKeywords = splitKeywordText(campaign?.purchase_keywords || promptTemplate?.purchase_keywords);
  const negativeKeywords = splitKeywordText(campaign?.negative_keywords || promptTemplate?.negative_keywords);

  const payload = {
    task: promptTemplate?.user_prompt || 'Analyze this video for KOL marketing value and return structured JSON.',
    analysis_rules: [
      'Return JSON only. Do not return Markdown, explanations, or chain-of-thought.',
      'Do not assume a fixed brand. Use target_context when provided; otherwise infer the relevant product category and brands from the video title, metadata, and comments.',
      'If brand keywords are provided, evaluate brand exposure and campaign fit against those keywords.',
      'If brand keywords are empty, do not mark the video as irrelevant only because a target brand is missing; evaluate the creator/content/category value generically.',
      'Do not state that an account is a competitor, partner, distributor, official account, affiliate, or paid collaborator unless the provided title, profile data, comments, notes, or target_context explicitly proves it.',
      'If the brand relationship is unclear, describe it as a relationship hypothesis or verification item. Example: "发布者疑似品牌/渠道型账号，非独立 KOL；其与目标品牌的商业关系需确认。若为竞品，则存在品牌冲突；若为渠道方，则应按渠道内容评估。" Do not write uncertain relationship assumptions as facts.',
      'Fill every field in required_json_schema. Use empty arrays, empty strings, or 0 when evidence is missing.',
      'Score should reflect creator/content fit, engagement quality, audience feedback, purchase intent, brand/category relevance, and collaboration risk.'
    ],
    target_context: {
      campaign_name: campaign?.name || '',
      brand: campaign?.brand || '',
      product_or_category: campaign?.product || campaign?.name || '',
      notes: video.notes || '',
      cooperation_price: video.cooperation_price || ''
    },
    keyword_settings: {
      brand_keywords: brandKeywords,
      purchase_keywords: purchaseKeywords,
      negative_keywords: negativeKeywords
    },
    video: {
      platform: video.platform,
      content_type: video.content_type || 'unknown',
      url: video.source_url,
      title: video.title,
      author_name: video.author_name,
      published_at: video.published_at,
      exposure: {
        primary_exposure_count: snapshot?.primary_exposure_count,
        exposure_metric_type: snapshot?.exposure_metric_type,
        data_quality_note: snapshot?.data_quality_note,
        note: 'For Instagram image/carousel posts, public play/view count may be unavailable. Do not judge performance as poor only because exposure is missing; use engagement and comment quality instead.'
      },
      metrics: {
        play_count: snapshot?.play_count,
        like_count: snapshot?.like_count,
        comment_count: snapshot?.comment_count,
        collect_count: snapshot?.collect_count,
        share_count: snapshot?.share_count
      },
      comment_total_in_database: comments.length,
      comment_total_provided_to_ai: commentsForPrompt.length,
      comments: commentsForPrompt
    },
    required_json_schema: {
      score: '0-100 integer. Use 0 only when the content is clearly irrelevant or unusable for the target context.',
      summary: '1-2 concise Chinese sentences with the main marketing conclusion',
      sentiment: { positive: 0, neutral: 0, negative: 0 },
      purchase_intent: { count: 0, keywords: [] },
      brand_mentions: 'string or object. Include counts for target keywords if provided; otherwise list notable brands/categories mentioned.',
      risks: 'array. Write external brand/channel/competitor relationship issues as hypotheses when not explicitly proven, not as facts.',
      product_feedback: [],
      cooperation_advice: '',
      content_suggestions: [],
      full_report: 'short Chinese paragraph summarizing fit, audience feedback, risks, and next action'
    }
  };

  return JSON.stringify(payload, null, 2);
}

function parseAiContentRobust(content) {
  const raw = String(content || '').trim();
  const candidates = [];
  const withoutFences = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  candidates.push(withoutFences);
  candidates.push(withoutFences.replace(/<think>[\s\S]*?<\/think>/gi, '').trim());

  for (const candidate of [...candidates]) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) candidates.push(candidate.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch (error) {
      // Try the next extraction strategy.
    }
  }

  return { summary: raw || '', full_report: raw || '', score: null };
}

function getNestedValue(source, path, fallback = undefined) {
  return path.split('.').reduce((value, key) => (
    value && value[key] !== undefined ? value[key] : undefined
  ), source) ?? fallback;
}

function normalizeAiResult(result = {}) {
  return {
    score: normalizeCount(result.score),
    summary: clean(result.summary || result.ai_summary || result.conclusion || ''),
    sentiment: {
      positive: normalizeCount(getNestedValue(result, 'sentiment.positive', result.sentiment_positive)) || 0,
      neutral: normalizeCount(getNestedValue(result, 'sentiment.neutral', result.sentiment_neutral)) || 0,
      negative: normalizeCount(getNestedValue(result, 'sentiment.negative', result.sentiment_negative)) || 0
    },
    purchase_intent: {
      count: normalizeCount(getNestedValue(result, 'purchase_intent.count', result.purchase_intent_count)) || 0,
      keywords: getNestedValue(result, 'purchase_intent.keywords', result.purchase_intent_keywords || [])
    },
    brand_mentions: result.brand_mentions || result.brand_exposure || '',
    risks: result.risks || result.risk_points || [],
    product_feedback: result.product_feedback || result.feedback || [],
    cooperation_advice: clean(result.cooperation_advice || result.collaboration_advice || result.next_action || ''),
    content_suggestions: result.content_suggestions || result.optimization_suggestions || [],
    full_report: clean(result.full_report || result.report || result.summary || '')
  };
}

async function callOpenAiCompatible(setting, provider, systemPrompt, finalPrompt) {
  if (!setting?.api_key) throw new Error(`${PROVIDER_LABELS[provider] || provider} API Key 未配置`);

  const defaultBaseUrl = provider === 'openai'
    ? 'https://api.openai.com/v1'
    : provider === 'deepseek'
      ? 'https://api.deepseek.com'
      : '';
  const baseUrl = (setting.base_url || defaultBaseUrl).replace(/\/$/, '');
  if (!baseUrl) throw new Error(`${PROVIDER_LABELS[provider] || provider} Base URL 未配置`);

  const model = setting.model || (provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini');
  const data = await fetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${setting.api_key}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: finalPrompt }
      ],
      temperature: 0.2
    })
  });

  const content = data.choices?.[0]?.message?.content || '{}';
  return { parsed: parseAiContentRobust(content), raw: data, model };
}

async function callMiniMax(setting, systemPrompt, finalPrompt) {
  if (!setting?.api_key) throw new Error('MiniMax API Key 未配置');

  const configuredBase = (setting.base_url || 'https://api.minimaxi.com').replace(/\/$/, '');
  const model = setting.model || 'MiniMax-M3';

  if (/\/v1$/i.test(configuredBase) || /minimax-m3/i.test(model)) {
    const data = await fetchJson(`${configuredBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${setting.api_key}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: finalPrompt }
        ],
        temperature: 0.2
      })
    });

    const content = data.choices?.[0]?.message?.content || '{}';
    return { parsed: parseAiContentRobust(content), raw: data, model };
  }

  const legacyBase = configuredBase.replace(/\/v1$/i, '');
  const endpoint = legacyBase.includes('chatcompletion')
    ? legacyBase
    : `${legacyBase}/v1/text/chatcompletion_v2`;

  const data = await fetchJson(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${setting.api_key}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { sender_type: 'BOT', text: systemPrompt },
        { sender_type: 'USER', text: finalPrompt }
      ],
      temperature: 0.2
    })
  });

  const content = firstDefined(
    data.reply,
    data.output_text,
    data.choices?.[0]?.message?.content,
    data.data?.reply,
    JSON.stringify(data)
  );
  return { parsed: parseAiContentRobust(content), raw: data, model };
}

async function runAiAnalysis(video, snapshot, comments) {
  const selection = await getSelection();
  const provider = selection.aiModels.active || 'deepseek';

  if (provider === 'custom_http_api') {
    throw new Error('Custom HTTP API 当前仅预留，暂不可用于分析');
  }

  const setting = await getSetting(providerKey('ai', provider), legacyKeysFor('ai', provider));
  const promptTemplate = await dbOperations.get('SELECT * FROM prompt_templates WHERE is_default = 1 ORDER BY id LIMIT 1');
  const campaignVideo = await dbOperations.get(
    'SELECT campaign_id FROM campaign_videos WHERE video_source_id = ? ORDER BY created_at DESC LIMIT 1',
    [video.id]
  );
  const campaign = campaignVideo
    ? await dbOperations.get('SELECT * FROM campaigns WHERE id = ?', [campaignVideo.campaign_id])
    : await dbOperations.get('SELECT * FROM campaigns WHERE id = 1');
  const finalPrompt = buildAnalysisPromptV2(video, snapshot, comments, promptTemplate, campaign);
  const systemPrompt = promptTemplate?.system_prompt || 'You are a KOL marketing analyst. Return valid JSON only. Do not include Markdown or chain-of-thought.';

  if (provider === 'minimax') {
    const result = await callMiniMax(setting, systemPrompt, finalPrompt);
    return { ...result, finalPrompt };
  }

  if (['openai', 'deepseek', 'custom_openai_compatible'].includes(provider)) {
    const result = await callOpenAiCompatible(setting, provider, systemPrompt, finalPrompt);
    return { ...result, finalPrompt };
  }

  throw new Error(`${PROVIDER_LABELS[provider] || provider} 当前暂不可用于 AI 分析`);
}

async function getOrCreateCampaignId({ campaign_id, campaign_name }) {
  if (campaign_id) return campaign_id;
  const name = clean(campaign_name);
  if (!name) return 1;
  const existing = await dbOperations.get('SELECT id FROM campaigns WHERE name = ?', [name]);
  if (existing) return existing.id;
  const result = await dbOperations.run('INSERT INTO campaigns (name, product) VALUES (?, ?)', [name, name]);
  return result.id;
}

async function upsertVideoSource(input) {
  const sourceUrl = clean(input.source_url || input.url);
  if (!sourceUrl) throw new Error('视频链接为必填字段');

  const campaignId = await getOrCreateCampaignId(input);
  const normalized = normalizeVideoUrl(sourceUrl);

  // Look up by canonical URL hash for global deduplication.
  let video = await dbOperations.get(
    'SELECT * FROM video_sources WHERE canonical_url_hash = ?',
    [normalized.canonicalUrlHash]
  );

  if (video) {
    // Update mutable fields.
    await dbOperations.run(
      `UPDATE video_sources SET
        platform = COALESCE(NULLIF(?, ''), platform),
        platform_video_id = COALESCE(NULLIF(?, ''), platform_video_id),
        source_url = COALESCE(NULLIF(?, ''), source_url),
        canonical_url = COALESCE(NULLIF(?, ''), canonical_url),
        title = COALESCE(NULLIF(?, ''), title),
        kol_name = COALESCE(NULLIF(?, ''), kol_name),
        author_name = COALESCE(NULLIF(?, ''), author_name),
        cooperation_price = COALESCE(NULLIF(?, ''), cooperation_price),
        notes = COALESCE(NULLIF(?, ''), notes),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        normalized.platform,
        normalized.platformVideoId,
        sourceUrl,
        normalized.canonicalUrl,
        clean(input.title),
        clean(input.kol_name),
        clean(input.author_name),
        clean(input.cooperation_price),
        clean(input.notes),
        video.id
      ]
    );
  } else {
    const result = await dbOperations.run(
      `INSERT INTO video_sources
       (platform, platform_video_id, source_url, canonical_url, canonical_url_hash,
        title, kol_name, author_name, cooperation_price, notes, status, crawl_status, analysis_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalized.platform,
        normalized.platformVideoId,
        sourceUrl,
        normalized.canonicalUrl,
        normalized.canonicalUrlHash,
        clean(input.title),
        clean(input.kol_name),
        clean(input.author_name),
        clean(input.cooperation_price),
        clean(input.notes),
        'pending',
        'pending',
        'not_analyzed'
      ]
    );
    video = await dbOperations.get('SELECT * FROM video_sources WHERE id = ?', [result.id]);
  }

  // Ensure the video is linked to the requested campaign.
  await dbOperations.run(
    `INSERT INTO campaign_videos (campaign_id, video_source_id, added_reason)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`,
    [campaignId, video.id, input.added_reason || 'manual']
  );

  return video;
}

async function crawlVideo(videoId, jobItemId) {
  const video = await dbOperations.get('SELECT * FROM video_sources WHERE id = ?', [videoId]);
  await dbOperations.run(
    `UPDATE video_sources SET status = ?, crawl_status = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ['crawling', 'crawling', videoId]
  );

  const crawlUrl = video.canonical_url || video.source_url;
  const fetched = await fetchVideoData(crawlUrl);
  await dbOperations.run(
    `UPDATE video_sources SET platform = ?, platform_video_id = ?, kol_name = COALESCE(NULLIF(?, ''), kol_name),
     title = ?, author_name = ?, content_type = ?, published_at = ?, status = ?, crawl_status = ?, error_message = NULL,
     last_crawled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [
      fetched.platform,
      fetched.platform_video_id,
      fetched.kol_name,
      fetched.title,
      fetched.author_name,
      fetched.content_type || 'unknown',
      fetched.published_at,
      'crawled',
      'success',
      videoId
    ]
  );

  const rawData = {
    provider: fetched.provider,
    provider_attempts: fetched.attempts || [],
    data: fetched.raw
  };
  const snapshotResult = await dbOperations.run(
    `INSERT INTO video_snapshots
     (video_source_id, play_count, like_count, comment_count, collect_count, share_count,
      primary_exposure_count, exposure_metric_type, data_quality_note, raw_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      videoId,
      fetched.metrics.play_count,
      fetched.metrics.like_count,
      fetched.metrics.comment_count,
      fetched.metrics.collect_count,
      fetched.metrics.share_count,
      fetched.exposure?.primary_exposure_count ?? null,
      fetched.exposure?.exposure_metric_type || '',
      fetched.exposure?.data_quality_note || '',
      JSON.stringify(rawData)
    ]
  );
  await dbOperations.run(
    'UPDATE video_sources SET latest_snapshot_id = ? WHERE id = ?',
    [snapshotResult.id, videoId]
  );

  await dbOperations.run('DELETE FROM video_comments WHERE video_source_id = ?', [videoId]);
  for (const comment of fetched.comments || []) {
    await dbOperations.run(
      `INSERT INTO video_comments (video_source_id, platform_comment_id, parent_comment_id, user_name, content, like_count, commented_at, raw_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [videoId, comment.id || null, comment.parent_id || null, comment.user_name || '', comment.content || '', comment.like_count || 0, comment.commented_at || '', JSON.stringify(comment.raw || comment)]
    );
  }

  if (jobItemId) {
    await dbOperations.run('UPDATE analysis_job_items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['success', jobItemId]);
  }
}

async function analyzeVideo(videoId, jobItemId) {
  const video = await dbOperations.get('SELECT * FROM video_sources WHERE id = ?', [videoId]);
  if (!video || video.crawl_status !== 'success') {
    throw new Error('请先抓取视频数据，再进行 AI 分析');
  }

  await dbOperations.run(
    `UPDATE video_sources SET status = ?, analysis_status = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ['analyzing', 'analyzing', videoId]
  );

  const snapshot = await dbOperations.get('SELECT * FROM video_snapshots WHERE video_source_id = ? ORDER BY snapshot_at DESC LIMIT 1', [videoId]);
  const comments = await dbOperations.query('SELECT * FROM video_comments WHERE video_source_id = ? ORDER BY like_count DESC LIMIT 100', [videoId]);
  const ai = await runAiAnalysis(video, snapshot, comments);
  const result = normalizeAiResult(ai.parsed || {});
  await dbOperations.run(
    `INSERT INTO video_ai_analysis_results
     (video_source_id, analysis_type, score, summary, sentiment_positive, sentiment_neutral, sentiment_negative, purchase_intent_count,
      purchase_intent_keywords, brand_mentions, risks, product_feedback, cooperation_advice, content_suggestions,
      full_report, final_prompt, raw_result, model_name, status)
     VALUES (?, 'video_module', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      videoId,
      result.score,
      result.summary || '',
      normalizeCount(result.sentiment?.positive) || 0,
      normalizeCount(result.sentiment?.neutral) || 0,
      normalizeCount(result.sentiment?.negative) || 0,
      normalizeCount(result.purchase_intent?.count) || 0,
      compact(result.purchase_intent?.keywords),
      compact(result.brand_mentions),
      compact(result.risks),
      compact(result.product_feedback),
      result.cooperation_advice || '',
      compact(result.content_suggestions),
      result.full_report || result.summary || '',
      ai.finalPrompt,
      JSON.stringify(ai.raw),
      ai.model,
      'success'
    ]
  );
  await dbOperations.run('UPDATE video_sources SET status = ?, analysis_status = ? WHERE id = ?', ['success', 'success', videoId]);
  if (jobItemId) {
    await dbOperations.run('UPDATE analysis_job_items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['success', jobItemId]);
  }
}

async function runJob(jobId, mode) {
  const items = await dbOperations.query('SELECT * FROM analysis_job_items WHERE job_id = ?', [jobId]);
  let success = 0;
  let failed = 0;
  const errors = [];

  await dbOperations.run('UPDATE analysis_jobs SET status = ?, started_at = CURRENT_TIMESTAMP WHERE id = ?', ['running', jobId]);

  for (const item of items) {
    try {
      if (mode === 'crawl') await crawlVideo(item.video_source_id, item.id);
      else await analyzeVideo(item.video_source_id, item.id);
      success += 1;
    } catch (error) {
      failed += 1;
      errors.push({ url: item.source_url, error: error.message });
      const videoStatus = mode === 'crawl' ? ['failed', 'failed'] : ['analysis_failed', 'analysis_failed'];
      const statusColumn = mode === 'crawl' ? 'crawl_status' : 'analysis_status';
      await dbOperations.run(
        `UPDATE video_sources SET status = ?, ${statusColumn} = ?, error_message = ? WHERE id = ?`,
        [videoStatus[0], videoStatus[1], error.message, item.video_source_id]
      );
      await dbOperations.run('UPDATE analysis_job_items SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['failed', error.message, item.id]);
    }
  }

  const status = failed === 0 ? 'success' : (success > 0 ? 'partial_failed' : 'failed');
  await dbOperations.run(
    'UPDATE analysis_jobs SET status = ?, success_count = ?, failed_count = ?, error_detail = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?',
    [status, success, failed, JSON.stringify(errors), jobId]
  );
}

async function createJob(videoIds, mode) {
  const targets = videoIds.length
    ? await dbOperations.query(`SELECT * FROM video_sources WHERE id IN (${videoIds.map(() => '?').join(',')})`, videoIds)
    : mode === 'crawl'
      ? await dbOperations.query('SELECT * FROM video_sources WHERE crawl_status IN (?, ?)', ['pending', 'failed'])
      : await dbOperations.query('SELECT * FROM video_sources WHERE crawl_status = ? AND analysis_status IN (?, ?)', ['success', 'not_analyzed', 'analysis_failed']);

  if (!targets.length) throw new Error(mode === 'crawl' ? '没有可抓取的视频' : '没有可分析的视频');

  const job = await dbOperations.run('INSERT INTO analysis_jobs (status, total_count) VALUES (?, ?)', ['pending', targets.length]);
  for (const video of targets) {
    await dbOperations.run(
      'INSERT INTO analysis_job_items (job_id, video_source_id, source_url, status) VALUES (?, ?, ?, ?)',
      [job.id, video.id, video.source_url, 'pending']
    );
  }

  setImmediate(() => runJob(job.id, mode).catch((error) => {
    dbOperations.run('UPDATE analysis_jobs SET status = ?, error_detail = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?', ['failed', error.message, job.id]);
  }));

  return { job_id: job.id, total: targets.length };
}

function buildVideoListSql(filters = {}) {
  const { campaign_id, platform, crawl_status, analysis_status, search, ids } = filters;
  let sql = `
    SELECT vs.*, c.name as campaign_name, c.product as campaign_product,
      snap.play_count, snap.like_count, snap.comment_count, snap.collect_count, snap.share_count,
      snap.primary_exposure_count, snap.exposure_metric_type, snap.data_quality_note, snap.snapshot_at,
      ai.score, ai.summary, ai.sentiment_positive, ai.sentiment_neutral, ai.sentiment_negative,
      ai.purchase_intent_count, ai.purchase_intent_keywords, ai.brand_mentions, ai.risks, ai.product_feedback,
      ai.cooperation_advice, ai.content_suggestions, ai.full_report, ai.final_prompt, ai.created_at as ai_created_at,
      ai.score as ai_score, ai.summary as ai_summary
    FROM video_sources vs
    LEFT JOIN campaign_videos cv ON cv.video_source_id = vs.id
    LEFT JOIN campaigns c ON c.id = cv.campaign_id
    LEFT JOIN video_snapshots snap ON snap.id = (
      SELECT id FROM video_snapshots WHERE video_source_id = vs.id ORDER BY snapshot_at DESC LIMIT 1
    )
    LEFT JOIN video_ai_analysis_results ai ON ai.id = (
      SELECT id FROM video_ai_analysis_results WHERE video_source_id = vs.id AND analysis_type = 'video_module' ORDER BY created_at DESC LIMIT 1
    )
    WHERE 1=1
  `;
  const params = [];

  if (ids?.length) {
    sql += ` AND vs.id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }
  if (campaign_id) {
    sql += ' AND cv.campaign_id = ?';
    params.push(campaign_id);
  }
  if (platform) {
    sql += ' AND vs.platform = ?';
    params.push(platform);
  }
  if (crawl_status) {
    sql += ' AND vs.crawl_status = ?';
    params.push(crawl_status);
  }
  if (analysis_status) {
    sql += ' AND vs.analysis_status = ?';
    params.push(analysis_status);
  }
  if (search) {
    sql += ` AND (
      vs.title LIKE ? OR vs.kol_name LIKE ? OR vs.author_name LIKE ? OR vs.source_url LIKE ? OR vs.platform_video_id LIKE ?
    )`;
    const term = `%${search}%`;
    params.push(term, term, term, term, term);
  }

  sql += ' ORDER BY vs.created_at DESC';
  return { sql, params };
}

function rowsToSheetRows(rows) {
  return rows.map((row) => ({
    视频ID: row.id,
    '产品/活动': row.campaign_name || '',
    平台: row.platform || '',
    KOL: row.kol_name || row.author_name || '',
    标题: row.title || '',
    作者: row.author_name || '',
    原始链接: row.source_url || '',
    平台视频ID: row.platform_video_id || '',
    状态: row.status || '',
    抓取状态: row.crawl_status || '',
    AI状态: row.analysis_status || '',
    分析时间: row.ai_created_at || '',
    发布时间: row.published_at || '',
    合作价格: row.cooperation_price || '',
    备注: row.notes || '',
    最近抓取时间: row.last_crawled_at || '',
    内容类型: row.content_type || '',
    主要曝光数: row.primary_exposure_count ?? '',
    曝光口径: row.exposure_metric_type || '',
    数据完整性: row.data_quality_note || '',
    播放数: row.play_count ?? '',
    点赞数: row.like_count ?? '',
    评论数: row.comment_count ?? '',
    收藏数: row.collect_count ?? '',
    分享数: row.share_count ?? '',
    AI评分: row.score ?? '',
    AI摘要: row.summary || '',
    'AI情绪-正向': row.sentiment_positive ?? '',
    'AI情绪-中性': row.sentiment_neutral ?? '',
    'AI情绪-负向': row.sentiment_negative ?? '',
    AI购买意向数量: row.purchase_intent_count ?? '',
    AI购买意向关键词: row.purchase_intent_keywords || '',
    AI品牌提及: row.brand_mentions || '',
    AI风险点: row.risks || '',
    AI产品反馈: row.product_feedback || '',
    AI合作建议: row.cooperation_advice || '',
    AI内容优化建议: row.content_suggestions || '',
    AI完整报告: row.full_report || row.summary || '',
    AI最终提示词: row.final_prompt || '',
    AI报告时间: row.ai_created_at || '',
    创建时间: row.created_at || ''
  }));
}

function sendVideoWorkbook(res, rows, filename) {
  const worksheet = xlsx.utils.json_to_sheet(toExcelSafeRows(rowsToSheetRows(rows)), { header: EXPORT_HEADERS });
  worksheet['!cols'] = EXPORT_HEADERS.map((header) => ({ wch: header.includes('AI') || header.includes('标题') ? 28 : 16 }));
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, '视频分析');
  const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.send(buffer);
}

function mapImportRow(row) {
  const mapped = {};
  Object.entries(row).forEach(([key, value]) => {
    const normalized = clean(key).replace(/\s+/g, '');
    const direct = IMPORT_HEADER_MAP[key] || IMPORT_HEADER_MAP[clean(key)] || IMPORT_HEADER_MAP[normalized];
    if (direct) mapped[direct] = clean(value);
  });

  if (!mapped.source_url) {
    const values = Object.values(row).map(clean);
    mapped.source_url = values.find((value) => /^https?:\/\//i.test(value)) || '';
  }

  return mapped;
}

router.post('/', async (req, res) => {
  try {
    const video = await upsertVideoSource(req.body);
    res.json({ success: true, data: video, message: '视频链接已保存' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '请选择 Excel/CSV 文件' });
    }

    const workbook = xlsx.readFile(req.file.path);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(worksheet, { defval: '' });
    fs.unlinkSync(req.file.path);

    let imported = 0;
    let updated = 0;
    const errors = [];

    for (const [index, row] of rows.entries()) {
      const mapped = mapImportRow(row);
      try {
        let before = null;
        if (mapped.source_url) {
          const normalized = normalizeVideoUrl(mapped.source_url);
          before = await dbOperations.get('SELECT id FROM video_sources WHERE canonical_url_hash = ?', [normalized.canonicalUrlHash]);
        }
        await upsertVideoSource(mapped);
        if (before) updated += 1;
        else imported += 1;
      } catch (error) {
        errors.push(`第 ${index + 2} 行：${error.message}`);
      }
    }

    res.json({ success: true, data: { count: imported + updated, imported, updated, errors }, message: `导入完成：新增 ${imported} 条，更新 ${updated} 条，失败 ${errors.length} 条` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/crawl', async (req, res) => {
  try {
    const result = await createJob(req.body.videoIds || [], 'crawl');
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/analyze', async (req, res) => {
  try {
    const ids = req.body.videoIds || [];
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const notReady = await dbOperations.query(`SELECT id FROM video_sources WHERE id IN (${placeholders}) AND crawl_status != ?`, [...ids, 'success']);
      if (notReady.length) {
        return res.status(400).json({ success: false, error: '选中的视频里有未抓取数据的记录，请先抓取' });
      }
    }
    const result = await createJob(ids, 'analyze');
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { sql, params } = buildVideoListSql(req.query);
    const videos = await dbOperations.query(sql, params);
    res.json({ success: true, data: videos });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/export', async (req, res) => {
  try {
    const ids = clean(req.query.ids)
      ? clean(req.query.ids).split(',').map((id) => Number(id)).filter(Boolean)
      : [];
    const { sql, params } = buildVideoListSql({ ...req.query, ids });
    const rows = await dbOperations.query(sql, params);
    sendVideoWorkbook(res, rows, 'video_analysis_export.xlsx');
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const campaignId = req.body.campaign_id ? await getOrCreateCampaignId(req.body) : null;
    await dbOperations.run(
      `UPDATE video_sources SET kol_name = ?, cooperation_price = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [clean(req.body.kol_name), clean(req.body.cooperation_price), clean(req.body.notes), req.params.id]
    );
    if (campaignId) {
      await dbOperations.run(
        `INSERT INTO campaign_videos (campaign_id, video_source_id, added_reason) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`,
        [campaignId, req.params.id, req.body.added_reason || 'manual']
      );
    }
    const video = await dbOperations.get('SELECT * FROM video_sources WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: video, message: '视频信息已更新' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.delete('/batch', async (req, res) => {
  try {
    const ids = req.body.videoIds || [];
    if (!ids.length) return res.status(400).json({ success: false, error: '请选择要删除的视频' });
    const placeholders = ids.map(() => '?').join(',');
    await dbOperations.run(`DELETE FROM video_ai_analysis_results WHERE video_source_id IN (${placeholders})`, ids);
    await dbOperations.run(`DELETE FROM video_comments WHERE video_source_id IN (${placeholders})`, ids);
    await dbOperations.run(`DELETE FROM video_snapshots WHERE video_source_id IN (${placeholders})`, ids);
    await dbOperations.run(`DELETE FROM analysis_job_items WHERE video_source_id IN (${placeholders})`, ids);
    await dbOperations.run(`DELETE FROM video_sources WHERE id IN (${placeholders})`, ids);
    res.json({ success: true, message: `已删除 ${ids.length} 条视频` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await dbOperations.run('DELETE FROM video_ai_analysis_results WHERE video_source_id = ?', [id]);
    await dbOperations.run('DELETE FROM video_comments WHERE video_source_id = ?', [id]);
    await dbOperations.run('DELETE FROM video_snapshots WHERE video_source_id = ?', [id]);
    await dbOperations.run('DELETE FROM analysis_job_items WHERE video_source_id = ?', [id]);
    await dbOperations.run('DELETE FROM video_sources WHERE id = ?', [id]);
    res.json({ success: true, message: '视频已删除' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/jobs/:id', async (req, res) => {
  try {
    const job = await dbOperations.get('SELECT * FROM analysis_jobs WHERE id = ?', [req.params.id]);
    const items = await dbOperations.query(`
      SELECT aji.*, vs.platform, vs.title, vs.kol_name
      FROM analysis_job_items aji
      LEFT JOIN video_sources vs ON vs.id = aji.video_source_id
      WHERE aji.job_id = ?
      ORDER BY aji.id
    `, [req.params.id]);
    res.json({ success: true, data: { job, items } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/jobs/:id/export', async (req, res) => {
  try {
    const rows = await dbOperations.query(`
      SELECT vs.*, c.name as campaign_name,
        snap.play_count, snap.like_count, snap.comment_count, snap.collect_count, snap.share_count,
        snap.primary_exposure_count, snap.exposure_metric_type, snap.data_quality_note, snap.snapshot_at,
        ai.score, ai.summary, ai.sentiment_positive, ai.sentiment_neutral, ai.sentiment_negative,
        ai.purchase_intent_count, ai.purchase_intent_keywords, ai.brand_mentions, ai.risks, ai.product_feedback,
        ai.cooperation_advice, ai.content_suggestions, ai.full_report, ai.final_prompt, ai.created_at as ai_created_at
      FROM analysis_job_items item
      JOIN video_sources vs ON vs.id = item.video_source_id
      LEFT JOIN campaign_videos cv ON cv.video_source_id = vs.id
      LEFT JOIN campaigns c ON c.id = cv.campaign_id
      LEFT JOIN video_snapshots snap ON snap.id = (
        SELECT id FROM video_snapshots WHERE video_source_id = vs.id ORDER BY snapshot_at DESC LIMIT 1
      )
      LEFT JOIN video_ai_analysis_results ai ON ai.id = (
        SELECT id FROM video_ai_analysis_results WHERE video_source_id = vs.id AND analysis_type = 'video_module' ORDER BY created_at DESC LIMIT 1
      )
      WHERE item.job_id = ?
      ORDER BY item.id
    `, [req.params.id]);

    sendVideoWorkbook(res, rows, `video_analysis_job_${req.params.id}.xlsx`);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
module.exports.crawlVideo = crawlVideo;
