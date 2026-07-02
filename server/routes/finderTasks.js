const express = require('express');
const { dbOperations } = require('../database');

const router = express.Router();

const SYSTEM_SELECTION_KEY = 'system.provider_selection';

const DEFAULT_SEARCH_CYCLES = [
  { cycle: 'C1', name: 'Competitor Reviews', priority: 1, keywords: '', search_sources: ['maton_agent', 'google_web', 'youtube_search'], target_platforms: ['youtube'], platforms: 'youtube', target_count: 10, exclusions: '', purpose: '' },
  { cycle: 'C2', name: 'Category Search', priority: 2, keywords: '', search_sources: ['maton_agent', 'google_web', 'youtube_search'], target_platforms: ['youtube'], platforms: 'youtube', target_count: 10, exclusions: '', purpose: '' },
  { cycle: 'C3', name: 'Use-case Search', priority: 3, keywords: '', search_sources: ['maton_agent', 'google_web', 'youtube_search'], target_platforms: ['youtube'], platforms: 'youtube', target_count: 10, exclusions: '', purpose: '' },
  { cycle: 'C4', name: 'Feature / Technical Search', priority: 4, keywords: '', search_sources: ['maton_agent', 'google_web', 'youtube_search'], target_platforms: ['youtube'], platforms: 'youtube', target_count: 10, exclusions: '', purpose: '' },
  { cycle: 'C5', name: 'Community / Audience Search', priority: 5, keywords: '', search_sources: ['maton_agent', 'google_web'], target_platforms: ['youtube'], platforms: 'youtube', target_count: 10, exclusions: '', purpose: '' },
  { cycle: 'C6', name: 'Platform Native Search', priority: 6, keywords: '', search_sources: ['youtube_search', 'instagram_search', 'tiktok_search'], target_platforms: ['youtube', 'instagram', 'tiktok'], platforms: 'youtube, instagram, tiktok', target_count: 10, exclusions: '', purpose: '' },
  { cycle: 'C7', name: 'Spider-web Expansion', priority: 7, keywords: '', search_sources: ['maton_agent', 'google_web', 'youtube_search'], target_platforms: ['youtube'], platforms: 'youtube', target_count: 10, exclusions: '', purpose: '' }
];

const PROVIDER_LABELS = {
  maton_agent: 'Maton Agent',
  google_web: 'Google Web',
  youtube_search: 'YouTube Search',
  instagram_search: 'Instagram Search',
  tiktok_search: 'TikTok Search',
  google_official: 'Google Official',
  scrapecreators: 'ScrapeCreators'
};

const SEARCH_SOURCES = ['maton_agent', 'google_web', 'youtube_search', 'instagram_search', 'tiktok_search'];
const TARGET_PLATFORMS = ['youtube', 'instagram', 'tiktok'];
const LEGAL_SOURCE_TARGETS = {
  maton_agent: TARGET_PLATFORMS,
  google_web: TARGET_PLATFORMS,
  youtube_search: ['youtube'],
  instagram_search: ['instagram'],
  tiktok_search: ['tiktok']
};

const cancelledTasks = new Set();

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
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

function parseList(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return clean(value).split(/[,，\n;]/).map(clean).filter(Boolean);
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function providerKey(scope, provider) {
  return `${scope}.${provider}`;
}

function legacyKeysFor(scope, provider) {
  if (scope === 'youtube' && provider === 'google_official') return ['youtube'];
  if (scope === 'agent' && provider === 'maton_gateway') return ['youtube.maton_gateway', 'maton_gateway'];
  if (provider === 'scrapecreators') return ['scrapecreators'];
  if (provider === 'maton_gateway') return ['maton_gateway'];
  if (scope === 'ai' && provider === 'deepseek') return ['ai'];
  return [];
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

async function getSelection() {
  const row = await dbOperations.get('SELECT extra_config FROM api_settings WHERE provider = ?', [SYSTEM_SELECTION_KEY]);
  return parseJson(row?.extra_config, {});
}

async function fetchJson(url, options = {}) {
  if (typeof fetch !== 'function') throw new Error('Node.js 18+ is required');
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `HTTP ${response.status}`);
  }
  return data;
}

async function fetchFirstJson(urls, options = {}) {
  const errors = [];
  for (const url of urls) {
    try {
      return { data: await fetchJson(url, options), url };
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(errors.join('；'));
}

function buildUrl(baseUrl, path, params = {}) {
  const normalizedBase = (baseUrl || '').replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  });
  const queryString = query.toString();
  return `${normalizedBase}${normalizedPath}${queryString ? `?${queryString}` : ''}`;
}

async function getReadyStrategy(strategyId) {
  const row = await dbOperations.get(`
    SELECT ks.*, c.name as campaign_name, c.brand as campaign_brand, c.product as campaign_product
    FROM kol_strategies ks
    LEFT JOIN campaigns c ON c.id = ks.campaign_id
    WHERE ks.id = ?
  `, [strategyId]);
  if (!row) throw new Error('Strategy not found');
  if (row.status !== 'ready') throw new Error('Only published Strategy can start Finder');
  return {
    ...row,
    secondary_platforms: parseJson(row.secondary_platforms, []),
    product_context: parseJson(row.product_context, {}),
    persona_config: parseJson(row.persona_config, {}),
    search_strategy: parseJson(row.search_strategy, DEFAULT_SEARCH_CYCLES),
    scoring_weights: parseJson(row.scoring_weights, {}),
    finder_handoff: parseJson(row.finder_handoff, {})
  };
}

function targetPlatformsForCycle(cycle, strategy, requestedTargets = []) {
  const cycleTargets = parseList(cycle.target_platforms);
  const cyclePlatforms = parseList(cycle.platforms);
  const handoffPlatforms = parseList(strategy.finder_handoff?.required_platforms);
  const strategyPlatforms = [strategy.primary_platform, ...(strategy.secondary_platforms || [])].map(clean).filter(Boolean);
  return [...new Set((requestedTargets.length ? requestedTargets : cycleTargets.length ? cycleTargets : cyclePlatforms.length ? cyclePlatforms : handoffPlatforms.length ? handoffPlatforms : strategyPlatforms).filter((p) => TARGET_PLATFORMS.includes(p)))];
}

function searchSourcesForCycle(cycle, requestedSources = []) {
  const cycleSources = parseList(cycle.search_sources);
  return [...new Set((requestedSources.length ? requestedSources : cycleSources.length ? cycleSources : ['maton_agent', 'google_web', 'youtube_search']).filter((source) => SEARCH_SOURCES.includes(source)))];
}

function sourceTargetPairs(cycle, strategy, requestedSources = [], requestedTargets = []) {
  const sources = searchSourcesForCycle(cycle, requestedSources);
  const targets = targetPlatformsForCycle(cycle, strategy, requestedTargets);
  const pairs = [];
  for (const source of sources) {
    for (const target of targets) {
      if ((LEGAL_SOURCE_TARGETS[source] || []).includes(target)) {
        pairs.push({ searchSource: source, targetPlatform: target });
      }
    }
  }
  return pairs;
}

function keywordString(cycle, strategy) {
  const pieces = [
    cycle.keywords,
    strategy.finder_handoff?.required_keywords,
    cycle.name,
    strategy.product || strategy.campaign_product || '',
    strategy.category || ''
  ];
  return [...new Set(pieces.flatMap(parseList))].filter(Boolean).slice(0, 12).join(', ');
}

function keywordQueries(request) {
  const queries = parseList(request.cycle.keywords || request.campaign.product || request.campaign.name);
  const fallback = clean(request.campaign.product || request.campaign.name || request.cycle.name);
  return [...new Set((queries.length ? queries : [fallback]).filter(Boolean))].slice(0, 8);
}

function buildCycleRequest(strategy, cycle, searchSource, targetPlatform, limit) {
  return {
    campaign: {
      id: strategy.campaign_id,
      name: strategy.campaign_name,
      brand: strategy.brand || strategy.campaign_brand || '',
      product: strategy.product || strategy.campaign_product || '',
      category: strategy.category || '',
      target_market: strategy.target_market || '',
      language: strategy.language || '',
      goal: strategy.campaign_goal || ''
    },
    strategy: {
      id: strategy.id,
      name: strategy.name,
      product_context: strategy.product_context,
      persona_config: strategy.persona_config,
      scoring_weights: strategy.scoring_weights,
      finder_handoff: strategy.finder_handoff
    },
    cycle: {
      cycle: cycle.cycle,
      name: cycle.name,
      purpose: cycle.purpose || '',
      keywords: keywordString(cycle, strategy),
      exclusions: clean(cycle.exclusions || strategy.finder_handoff?.exclusion_keywords || ''),
      target_count: limit
    },
    search_source: searchSource,
    target_platform: targetPlatform,
    platform: targetPlatform,
    limit,
    response_schema: {
      candidates: [{
        platform: 'youtube | instagram | tiktok',
        kol_name: 'Creator name',
        profile_url: 'Creator profile URL',
        followers: 'Follower count if available',
        avg_views: 'Average views if available',
        email: 'Public email if available',
        country_region: 'Country or region if available',
        matched_keywords: 'Matched keywords',
        matched_persona: 'Persona match',
        representative_video_url: 'Best evidence video URL',
        representative_video_title: 'Best evidence video title',
        ai_score: 0,
        reason: 'Short approval reason',
        scoring_breakdown: {},
        raw_data: {}
      }]
    }
  };
}

function matonHeaders(setting) {
  const extra = parseJson(setting?.extra_config, {});
  const headers = { 'Content-Type': 'application/json' };
  if (setting?.api_key) headers.Authorization = `Bearer ${setting.api_key}`;
  if (extra.connection_id) headers['Maton-Connection'] = extra.connection_id;
  return headers;
}

function extractCandidateArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.candidates)) return data.candidates;
  if (Array.isArray(data?.data?.candidates)) return data.data.candidates;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data?.results)) return data.data.results;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

async function matonFinderAdapter(request) {
  const setting = await getSetting(providerKey('agent', 'maton_gateway'), legacyKeysFor('agent', 'maton_gateway'));
  if (!setting?.api_key && !setting?.base_url) throw new Error('Maton Gateway 未配置');
  const baseUrl = (setting.base_url || 'https://api.maton.ai').replace(/\/$/, '');
  if (request.target_platform === 'youtube') {
    return youtubeMatonGatewayAdapter(request, setting, baseUrl);
  }
  throw new Error('Maton API Gateway 不是通用 KOL Finder Agent。当前仅已适配 YouTube Gateway；Instagram/TikTok 请先用 ScrapeCreators，网页搜索后续接 Brave Search/Tavily/Exa。');
}

async function youtubeMatonGatewayAdapter(request, setting, baseUrl) {
  const maxResults = Math.max(1, Math.min(Number(request.limit || 10), 50));
  const candidates = [];
  let lastEndpoint = '';
  for (const query of keywordQueries(request)) {
    const remaining = maxResults - candidates.length;
    if (remaining <= 0) break;
    const searchUrl = buildUrl(baseUrl, '/youtube/youtube/v3/search', {
      part: 'snippet',
      type: 'video',
      maxResults: Math.min(remaining, 10),
      q: query
    });
    lastEndpoint = searchUrl;
    const searchData = await fetchJson(searchUrl, { headers: matonHeaders(setting) });
    const items = searchData.items || [];
    const channelIds = [...new Set(items.map((item) => item.snippet?.channelId).filter(Boolean))];
    let channels = {};
    if (channelIds.length) {
      const channelEndpoint = buildUrl(baseUrl, '/youtube/youtube/v3/channels', {
        part: 'snippet,statistics',
        id: channelIds.join(',')
      });
      lastEndpoint = channelEndpoint;
      const channelData = await fetchJson(channelEndpoint, { headers: matonHeaders(setting) });
      channels = Object.fromEntries((channelData.items || []).map((item) => [item.id, item]));
    }
    candidates.push(...youtubeItemsToCandidates(items, channels, { ...request, cycle: { ...request.cycle, keywords: query } }, `Matched Maton YouTube Gateway search: ${query}`));
  }
  if (!candidates.length) throw new Error('Maton 已连通，但 YouTube Search 返回 0 条候选；建议先用更短关键词测试，例如单个竞品名 + review。');
  return { provider: 'maton_youtube_gateway', endpoint: lastEndpoint, candidates };
}

async function youtubeSearchAdapter(request) {
  const setting = await getSetting(providerKey('youtube', 'google_official'), legacyKeysFor('youtube', 'google_official'));
  if (!setting?.api_key) throw new Error('Google Official YouTube API Key 未配置');
  const apiKey = encodeURIComponent(setting.api_key);
  const maxResults = Math.max(1, Math.min(Number(request.limit || 10), 50));
  const candidates = [];
  let lastEndpoint = '';
  for (const query of keywordQueries(request)) {
    const remaining = maxResults - candidates.length;
    if (remaining <= 0) break;
    const q = encodeURIComponent(query);
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${Math.min(remaining, 10)}&q=${q}&key=${apiKey}`;
    lastEndpoint = searchUrl;
    const searchData = await fetchJson(searchUrl);
    const items = searchData.items || [];
    const channelIds = [...new Set(items.map((item) => item.snippet?.channelId).filter(Boolean))];
    let channels = {};
    if (channelIds.length) {
      const channelUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${encodeURIComponent(channelIds.join(','))}&key=${apiKey}`;
      lastEndpoint = channelUrl;
      const channelData = await fetchJson(channelUrl);
      channels = Object.fromEntries((channelData.items || []).map((item) => [item.id, item]));
    }
    candidates.push(...youtubeItemsToCandidates(items, channels, { ...request, cycle: { ...request.cycle, keywords: query } }, `Matched YouTube search: ${query}`));
  }
  if (!candidates.length) throw new Error('YouTube Search 返回 0 条候选；建议先用更短关键词测试。');
  return { provider: 'youtube_search', endpoint: lastEndpoint, candidates };
}

function youtubeItemsToCandidates(items, channels, request, reason) {
  return items.map((item) => {
    const snippet = item.snippet || {};
    const channel = channels[snippet.channelId] || {};
    return {
      platform: 'youtube',
      kol_name: snippet.channelTitle || channel.snippet?.title || '',
      profile_url: snippet.channelId ? `https://www.youtube.com/channel/${snippet.channelId}` : '',
      followers: channel.statistics?.subscriberCount || '',
      avg_views: '',
      email: '',
      country_region: channel.snippet?.country || '',
      matched_keywords: request.cycle.keywords,
      matched_persona: request.strategy.persona_config?.primary_persona || '',
      representative_video_url: item.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : '',
      representative_video_title: snippet.title || '',
      reason,
      raw_data: { search_item: item, channel }
    };
  });
}

async function scrapeCreatorsFinderAdapter(request) {
  const setting = await getSetting(providerKey(request.target_platform, 'scrapecreators'), legacyKeysFor(request.target_platform, 'scrapecreators'));
  if (!setting?.api_key) throw new Error('ScrapeCreators API Key 未配置');
  const baseUrl = (setting.base_url || 'https://api.scrapecreators.com').replace(/\/$/, '');
  const headers = { 'x-api-key': setting.api_key, Authorization: `Bearer ${setting.api_key}` };
  const q = encodeURIComponent(request.cycle.keywords || request.campaign.product || request.campaign.name);
  const limit = encodeURIComponent(String(request.limit || 10));
  const endpoints = request.target_platform === 'instagram'
    ? [`${baseUrl}/v1/instagram/search?query=${q}&limit=${limit}`, `${baseUrl}/v1/instagram/profile/search?query=${q}&limit=${limit}`, `${baseUrl}/v1/instagram/users/search?query=${q}&limit=${limit}`]
    : [`${baseUrl}/v1/tiktok/search?query=${q}&limit=${limit}`, `${baseUrl}/v1/tiktok/users/search?query=${q}&limit=${limit}`, `${baseUrl}/v1/tiktok/user/search?query=${q}&limit=${limit}`];
  const result = await fetchFirstJson(endpoints, { headers });
  const rawCandidates = extractCandidateArray(result.data);
  if (!rawCandidates.length) throw new Error('ScrapeCreators 未返回候选结果');
  const candidates = rawCandidates.map((item) => {
    const user = item.user || item.author || item.owner || item;
    const username = clean(user.username || user.unique_id || user.handle || user.nickname || item.username || item.author_name);
    const profileUrl = clean(user.profile_url || item.profile_url || (username ? (request.platform === 'instagram' ? `https://www.instagram.com/${username}/` : `https://www.tiktok.com/@${username}`) : ''));
    return {
      platform: request.target_platform,
      kol_name: clean(user.full_name || user.nickname || username || item.name),
      profile_url: profileUrl,
      followers: clean(user.follower_count || user.followers || user.followers_count || item.followers),
      avg_views: clean(user.avg_views || item.avg_views || item.views),
      email: clean(user.email || item.email),
      country_region: clean(user.country || user.region || item.country_region),
      matched_keywords: request.cycle.keywords,
      matched_persona: request.strategy.persona_config?.primary_persona || '',
      representative_video_url: clean(item.video_url || item.url || item.post_url),
      representative_video_title: clean(item.title || item.desc || item.description),
      reason: `Matched ${PROVIDER_LABELS[request.search_source] || PROVIDER_LABELS.scrapecreators} search: ${request.cycle.keywords}`,
      raw_data: item
    };
  });
  return { provider: request.search_source || 'scrapecreators', endpoint: result.url, candidates };
}

function normalizeCandidate(input, request, provider) {
  const platform = clean(input.platform || request.target_platform || request.platform);
  const profileUrl = clean(input.profile_url || input.profileUrl || input.channel_url || input.url || '');
  const evidenceUrl = clean(input.evidence_url || input.evidenceUrl || input.representative_video_url || input.video_url || input.videoUrl || input.source_url || profileUrl);
  const evidenceTitle = clean(input.evidence_title || input.evidenceTitle || input.representative_video_title || input.video_title || input.title);
  const evidenceType = clean(input.evidence_type || input.evidenceType || (evidenceUrl.includes('watch?') || evidenceUrl.includes('/video/') || evidenceUrl.includes('/reel/') ? 'video' : profileUrl && evidenceUrl === profileUrl ? 'profile' : 'search_result')) || 'search_result';
  const videoUrl = evidenceType === 'video' ? evidenceUrl : clean(input.representative_video_url || input.video_url || input.videoUrl || '');
  return {
    platform,
    kol_name: clean(input.kol_name || input.name || input.creator_name || input.channel_title || input.username || input.handle),
    profile_url: profileUrl,
    video_url: videoUrl,
    video_title: evidenceType === 'video' ? evidenceTitle : clean(input.representative_video_title || input.video_title || input.title),
    followers: clean(input.followers || input.follower_count || input.subscriber_count || input.subscribers),
    avg_views: clean(input.avg_views || input.average_views || input.views),
    email: clean(input.email),
    country_region: clean(input.country_region || input.country || input.region),
    matched_keywords: clean(input.matched_keywords || request.cycle.keywords),
    matched_persona: clean(input.matched_persona || request.strategy.persona_config?.primary_persona),
    ai_score: normalizeNumber(input.ai_score || input.score),
    ai_match_reason: clean(input.reason || input.ai_match_reason || `Found by ${PROVIDER_LABELS[provider] || provider}`),
    scoring_breakdown: input.scoring_breakdown || {},
    evidence_url: evidenceUrl,
    evidence_title: evidenceTitle,
    evidence_type: evidenceType,
    source_query: clean(input.source_query || request.cycle.keywords),
    raw_data: input.raw_data || input
  };
}

function profileKey(candidate) {
  if (candidate.profile_url) return `profile:${candidate.profile_url.toLowerCase().replace(/\/$/, '')}`;
  if (candidate.email) return `email:${candidate.email.toLowerCase()}`;
  return `name:${candidate.platform}:${candidate.kol_name.toLowerCase()}`;
}

async function rawCandidateExists(candidate, strategyId) {
  if (candidate.profile_url) {
    const row = await dbOperations.get('SELECT * FROM raw_candidates WHERE strategy_id = ? AND profile_url = ? LIMIT 1', [strategyId, candidate.profile_url]);
    if (row) return row;
  }
  if (candidate.email) {
    const row = await dbOperations.get('SELECT * FROM raw_candidates WHERE strategy_id = ? AND email = ? LIMIT 1', [strategyId, candidate.email]);
    if (row) return row;
  }
  return dbOperations.get('SELECT * FROM raw_candidates WHERE strategy_id = ? AND platform = ? AND kol_name = ? LIMIT 1', [strategyId, candidate.platform, candidate.kol_name]);
}

async function masterExists(candidate) {
  if (candidate.profile_url) {
    const row = await dbOperations.get(
      'SELECT id FROM customers WHERE profile_url = ? OR youtube_url = ? OR instagram_url = ? OR tiktok_url = ? LIMIT 1',
      [candidate.profile_url, candidate.profile_url, candidate.profile_url, candidate.profile_url]
    );
    if (row) return row;
  }
  if (candidate.email) {
    const row = await dbOperations.get('SELECT id FROM customers WHERE email = ? LIMIT 1', [candidate.email]);
    if (row) return row;
  }
  if (candidate.kol_name) {
    return dbOperations.get('SELECT id FROM customers WHERE name = ? LIMIT 1', [candidate.kol_name]);
  }
  return null;
}

async function upsertRawCandidate(candidate, task, cycle, provider) {
  if (!candidate.kol_name && !candidate.profile_url) {
    return { inserted: false, skipped: true, reason: 'Missing kol_name/profile_url' };
  }
  const existing = await rawCandidateExists(candidate, task.strategy_id);
  const status = await masterExists(candidate) ? 'duplicate' : 'new';
  const rawData = JSON.stringify({
    provider,
    finder_task_id: task.id,
    search_cycle: cycle.cycle,
    data: candidate.raw_data
  });
  if (existing) {
    await dbOperations.run(
      `UPDATE raw_candidates SET
       followers = COALESCE(NULLIF(followers, ''), ?),
       avg_views = COALESCE(NULLIF(avg_views, ''), ?),
       email = COALESCE(NULLIF(email, ''), ?),
       country_region = COALESCE(NULLIF(country_region, ''), ?),
       video_url = COALESCE(NULLIF(video_url, ''), ?),
       video_title = COALESCE(NULLIF(video_title, ''), ?),
       evidence_url = COALESCE(NULLIF(evidence_url, ''), ?),
       evidence_title = COALESCE(NULLIF(evidence_title, ''), ?),
       evidence_type = COALESCE(NULLIF(evidence_type, ''), ?),
       source_query = COALESCE(NULLIF(source_query, ''), ?),
       ai_score = COALESCE(ai_score, ?),
       ai_match_reason = COALESCE(NULLIF(ai_match_reason, ''), ?),
       raw_data = ?,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        candidate.followers,
        candidate.avg_views,
        candidate.email,
        candidate.country_region,
        candidate.video_url,
        candidate.video_title,
        candidate.evidence_url,
        candidate.evidence_title,
        candidate.evidence_type,
        candidate.source_query,
        candidate.ai_score,
        candidate.ai_match_reason,
        rawData,
        existing.id
      ]
    );
    return { inserted: false, duplicate: true };
  }
  const result = await dbOperations.run(
    `INSERT INTO raw_candidates
     (finder_task_id, campaign_id, strategy_id, platform, kol_name, profile_url, video_url, video_title,
      followers, avg_views, email, country_region, matched_keywords, ai_score, ai_match_reason,
      status, source, raw_data, search_cycle, matched_persona, scoring_breakdown,
      evidence_url, evidence_title, evidence_type, source_query)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      task.campaign_id,
      task.strategy_id,
      candidate.platform,
      candidate.kol_name || candidate.profile_url,
      candidate.profile_url,
      candidate.video_url,
      candidate.video_title,
      candidate.followers,
      candidate.avg_views,
      candidate.email,
      candidate.country_region,
      candidate.matched_keywords,
      candidate.ai_score,
      candidate.ai_match_reason,
      status,
      provider,
      rawData,
      cycle.cycle,
      candidate.matched_persona,
      JSON.stringify(candidate.scoring_breakdown || {}),
      candidate.evidence_url,
      candidate.evidence_title,
      candidate.evidence_type,
      candidate.source_query
    ]
  );
  return { inserted: true, id: result.id, status };
}

async function runProvider(request, allowFallback) {
  const attempts = [];
  const source = request.search_source;
  try {
    let maton = null;
    if (source === 'maton_agent' || source === 'google_web') {
      maton = await matonFinderAdapter(request);
    } else if (source === 'youtube_search') {
      maton = await youtubeSearchAdapter(request);
    } else if (source === 'instagram_search' || source === 'tiktok_search') {
      maton = await scrapeCreatorsFinderAdapter(request);
    } else {
      throw new Error(`Unsupported search source: ${source}`);
    }
    attempts.push({ search_source: source, provider: maton.provider, ok: true, endpoint: maton.endpoint });
    return { ...maton, attempts };
  } catch (error) {
    attempts.push({ search_source: source, provider: source, ok: false, error: error.message });
    if (!allowFallback || source !== 'maton_agent') throw Object.assign(new Error(error.message), { attempts });
  }

  try {
    const fallback = request.target_platform === 'youtube'
      ? await youtubeSearchAdapter({ ...request, search_source: 'youtube_search' })
      : await scrapeCreatorsFinderAdapter({
        ...request,
        search_source: request.target_platform === 'instagram' ? 'instagram_search' : 'tiktok_search'
      });
    attempts.push({ search_source: fallback.provider, provider: fallback.provider, ok: true, endpoint: fallback.endpoint });
    return { ...fallback, attempts };
  } catch (error) {
    attempts.push({ search_source: request.target_platform === 'youtube' ? 'youtube_search' : `${request.target_platform}_search`, provider: request.target_platform === 'youtube' ? 'google_official' : 'scrapecreators', ok: false, error: error.message });
    throw Object.assign(new Error(error.message), { attempts });
  }
}

async function updateTask(id, patch) {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  const assignments = fields.map((field) => `${field} = ?`).join(', ');
  await dbOperations.run(
    `UPDATE finder_tasks SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [...fields.map((field) => patch[field]), id]
  );
}

async function processTask(taskId, options = {}) {
  const task = await dbOperations.get('SELECT * FROM finder_tasks WHERE id = ?', [taskId]);
  if (!task) return;
  const strategy = await getReadyStrategy(task.strategy_id);
  const cycles = parseJson(task.search_cycles, DEFAULT_SEARCH_CYCLES);
  const allAttempts = [];
  const responseSummary = [];
  let successCount = 0;
  let failedCount = 0;
  let completedCycles = 0;

  await updateTask(taskId, { status: 'running', started_at: new Date().toISOString(), total_cycles: cycles.length });

  for (const cycle of cycles) {
    if (cancelledTasks.has(taskId)) {
      await updateTask(taskId, { status: 'cancelled', finished_at: new Date().toISOString(), provider_attempts: JSON.stringify(allAttempts), raw_response_summary: JSON.stringify(responseSummary) });
      cancelledTasks.delete(taskId);
      return;
    }
    const pairs = sourceTargetPairs(cycle, strategy, options.searchSources || [], options.targetPlatforms || []);
    await updateTask(taskId, { current_cycle: cycle.cycle });

    for (const pair of pairs) {
      const { searchSource, targetPlatform } = pair;
      const request = buildCycleRequest(strategy, cycle, searchSource, targetPlatform, options.limit || 10);
      try {
        const result = await runProvider(request, options.allowFallback !== false);
        allAttempts.push(...result.attempts.map((attempt) => ({ ...attempt, cycle: cycle.cycle, search_source: searchSource, target_platform: targetPlatform })));
        const seen = new Set();
        let inserted = 0;
        let skipped = 0;
        for (const raw of result.candidates.slice(0, options.limit || 10)) {
          const normalized = normalizeCandidate(raw, request, result.provider);
          const key = profileKey(normalized);
          if (seen.has(key)) {
            skipped += 1;
            continue;
          }
          seen.add(key);
          const saved = await upsertRawCandidate(normalized, task, cycle, result.provider);
          if (saved.inserted) inserted += 1;
          if (saved.skipped) skipped += 1;
        }
        successCount += inserted;
        responseSummary.push({ cycle: cycle.cycle, search_source: searchSource, target_platform: targetPlatform, provider: result.provider, returned: result.candidates.length, inserted, skipped });
      } catch (error) {
        failedCount += 1;
        allAttempts.push(...(error.attempts || [{ provider: 'unknown', ok: false, error: error.message }]).map((attempt) => ({ ...attempt, cycle: cycle.cycle, search_source: searchSource, target_platform: targetPlatform })));
        responseSummary.push({ cycle: cycle.cycle, search_source: searchSource, target_platform: targetPlatform, error: error.message });
      }
    }

    completedCycles += 1;
    await updateTask(taskId, {
      completed_cycles: completedCycles,
      success_count: successCount,
      failed_count: failedCount,
      result_count: successCount,
      provider_attempts: JSON.stringify(allAttempts),
      raw_response_summary: JSON.stringify(responseSummary)
    });
  }

  const status = successCount > 0 && failedCount > 0 ? 'partial_failed' : successCount > 0 ? 'success' : 'failed';
  await updateTask(taskId, {
    status,
    error_message: status === 'failed' ? 'No candidates were inserted. Check provider attempts.' : '',
    finished_at: new Date().toISOString(),
    provider_attempts: JSON.stringify(allAttempts),
    raw_response_summary: JSON.stringify(responseSummary)
  });
}

router.get('/', async (req, res) => {
  try {
    const { strategy_id, status } = req.query;
    let sql = `
      SELECT ft.*, ks.name as strategy_name, c.name as campaign_name
      FROM finder_tasks ft
      LEFT JOIN kol_strategies ks ON ks.id = ft.strategy_id
      LEFT JOIN campaigns c ON c.id = ft.campaign_id
      WHERE 1=1
    `;
    const params = [];
    if (strategy_id) {
      sql += ' AND ft.strategy_id = ?';
      params.push(strategy_id);
    }
    if (status) {
      sql += ' AND ft.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY ft.created_at DESC, ft.id DESC LIMIT 50';
    const rows = await dbOperations.query(sql, params);
    res.json({ success: true, data: rows.map((row) => ({
      ...row,
      search_sources: parseJson(row.search_sources, parseList(row.search_sources)),
      target_platforms: parseJson(row.target_platforms, parseList(row.target_platforms || row.platform)),
      search_cycles: parseJson(row.search_cycles, []),
      provider_attempts: parseJson(row.provider_attempts, []),
      raw_response_summary: parseJson(row.raw_response_summary, [])
    })) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await dbOperations.get(`
      SELECT ft.*, ks.name as strategy_name, c.name as campaign_name
      FROM finder_tasks ft
      LEFT JOIN kol_strategies ks ON ks.id = ft.strategy_id
      LEFT JOIN campaigns c ON c.id = ft.campaign_id
      WHERE ft.id = ?
    `, [req.params.id]);
    if (!row) return res.status(404).json({ success: false, error: 'Finder task not found' });
    res.json({ success: true, data: {
      ...row,
      search_sources: parseJson(row.search_sources, parseList(row.search_sources)),
      target_platforms: parseJson(row.target_platforms, parseList(row.target_platforms || row.platform)),
      search_cycles: parseJson(row.search_cycles, []),
      provider_attempts: parseJson(row.provider_attempts, []),
      raw_response_summary: parseJson(row.raw_response_summary, [])
    } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const strategy = await getReadyStrategy(body.strategy_id);
    const requestedCycles = body.cycles?.length ? body.cycles : (strategy.search_strategy || DEFAULT_SEARCH_CYCLES).map((cycle) => cycle.cycle);
    const cycles = (strategy.search_strategy || DEFAULT_SEARCH_CYCLES)
      .filter((cycle) => requestedCycles.includes(cycle.cycle))
      .map((cycle) => ({ ...cycle, target_count: Math.min(Number(body.limit_per_platform || cycle.target_count || 10), 50) }));
    if (!cycles.length) return res.status(400).json({ success: false, error: 'Please select at least one search cycle' });
    const targetPlatforms = (body.target_platforms || body.platforms || []).filter((p) => TARGET_PLATFORMS.includes(p));
    const searchSources = (body.search_sources || []).filter((source) => SEARCH_SOURCES.includes(source));
    const normalizedCycles = cycles.map((cycle) => ({
      ...cycle,
      search_sources: searchSources.length ? searchSources : searchSourcesForCycle(cycle),
      target_platforms: targetPlatforms.length ? targetPlatforms : targetPlatformsForCycle(cycle, strategy)
    }));
    const rawRequest = {
      strategy_id: strategy.id,
      cycles: normalizedCycles.map((c) => c.cycle),
      search_sources: searchSources,
      target_platforms: targetPlatforms,
      limit_per_platform: Number(body.limit_per_platform || 10),
      allow_fallback: body.allow_fallback !== false
    };
    const result = await dbOperations.run(
      `INSERT INTO finder_tasks
       (campaign_id, strategy_id, name, platform, keywords, status, search_sources, target_platforms, search_cycles, total_cycles, raw_request, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        strategy.campaign_id,
        strategy.id,
        `${strategy.name} Finder ${new Date().toLocaleString()}`,
        (targetPlatforms.length ? targetPlatforms : [...new Set(normalizedCycles.flatMap((cycle) => cycle.target_platforms || []))]).join(','),
        normalizedCycles.map((cycle) => keywordString(cycle, strategy)).join(' | '),
        'draft',
        JSON.stringify(searchSources.length ? searchSources : [...new Set(normalizedCycles.flatMap((cycle) => cycle.search_sources || []))]),
        JSON.stringify(targetPlatforms.length ? targetPlatforms : [...new Set(normalizedCycles.flatMap((cycle) => cycle.target_platforms || []))]),
        JSON.stringify(normalizedCycles),
        normalizedCycles.length,
        JSON.stringify(rawRequest),
        body.notes || ''
      ]
    );
    const task = await dbOperations.get('SELECT * FROM finder_tasks WHERE id = ?', [result.id]);
    setImmediate(() => {
      processTask(result.id, {
        searchSources,
        targetPlatforms,
        limit: Math.max(1, Math.min(Number(body.limit_per_platform || 10), 50)),
        allowFallback: body.allow_fallback !== false
      }).catch((error) => {
        updateTask(result.id, {
          status: 'failed',
          error_message: error.message,
          finished_at: new Date().toISOString()
        });
      });
    });
    res.json({ success: true, data: task, message: 'Finder task started' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    cancelledTasks.add(Number(req.params.id));
    await updateTask(req.params.id, { status: 'cancelled', finished_at: new Date().toISOString() });
    res.json({ success: true, message: 'Finder task cancelled' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
