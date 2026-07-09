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

const CYCLE_ORDER = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'];
const MIN_RELEVANT_SIGNAL_SCORE = 20; // soft-signal floor for entering raw candidate pool
const DEFAULT_CYCLE_BY_ID = Object.fromEntries(DEFAULT_SEARCH_CYCLES.map((cycle) => [cycle.cycle, cycle]));
const SEARCH_INTENSITY_CYCLES = {
  youtube: {
    quick: ['C1', 'C2', 'C4'],
    standard: ['C1', 'C2', 'C3', 'C4'],
    full: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']
  },
  instagram: {
    quick: ['C2', 'C3', 'C5'],
    standard: ['C1', 'C2', 'C3', 'C5'],
    full: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']
  },
  tiktok: {
    quick: ['C2', 'C3', 'C5'],
    standard: ['C2', 'C3', 'C5', 'C6'],
    full: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']
  }
};

const PROVIDER_LABELS = {
  maton_agent: 'Maton Agent',
  google_web: 'Google Web',
  youtube_search: 'YouTube Search',
  instagram_search: 'Instagram Search',
  tiktok_search: 'TikTok Search',
  youtube_to_instagram: 'YouTube -> Instagram',
  google_web_to_instagram: 'Google/Web -> Instagram',
  seed_posts_to_profile: 'Seed Posts -> Profile',
  instagram_native_small_batch: 'Instagram Native Small Batch',
  reddit_to_instagram: 'Reddit -> Instagram',
  youtube_native_search: 'YouTube Native Search',
  google_web_to_youtube: 'Google/Web -> YouTube',
  google_web_to_tiktok: 'Google/Web -> TikTok',
  youtube_to_tiktok: 'YouTube -> TikTok',
  instagram_to_tiktok: 'Instagram -> TikTok',
  reddit_to_tiktok: 'Reddit -> TikTok',
  tiktok_native_small_batch: 'TikTok Native Small Batch',
  google_official: 'Google Official',
  scrapecreators: 'ScrapeCreators'
};

const SEARCH_SOURCES = ['maton_agent', 'google_web', 'youtube_search', 'instagram_search', 'tiktok_search'];
const DISCOVERY_ROUTES = [
  'cycle_multi_route',
  'youtube_native_search',
  'google_web_to_youtube',
  'youtube_to_instagram',
  'google_web_to_instagram',
  'seed_posts_to_profile',
  'instagram_native_small_batch',
  'reddit_to_instagram',
  'google_web_to_tiktok',
  'youtube_to_tiktok',
  'instagram_to_tiktok',
  'reddit_to_tiktok',
  'tiktok_native_small_batch',
  'spider_web_expansion'
];
const TARGET_PLATFORMS = ['youtube', 'instagram', 'tiktok'];
const LEGAL_SOURCE_TARGETS = {
  maton_agent: TARGET_PLATFORMS,
  google_web: TARGET_PLATFORMS,
  youtube_search: ['youtube'],
  instagram_search: ['instagram'],
  tiktok_search: ['tiktok']
};
const ROUTE_SOURCE_TARGETS = {
  youtube_native_search: [{ searchSource: 'auto', targetPlatform: 'youtube', sourcePlatform: 'youtube' }],
  google_web_to_youtube: [{ searchSource: 'google_web', targetPlatform: 'youtube', sourcePlatform: 'google_web' }],
  youtube_to_instagram: [{ searchSource: 'maton_agent', targetPlatform: 'instagram', sourcePlatform: 'youtube' }],
  google_web_to_instagram: [{ searchSource: 'google_web', targetPlatform: 'instagram', sourcePlatform: 'google_web' }],
  seed_posts_to_profile: [
    { searchSource: 'maton_agent', targetPlatform: 'instagram', sourcePlatform: 'seed_url' },
    { searchSource: 'maton_agent', targetPlatform: 'tiktok', sourcePlatform: 'seed_url' }
  ],
  instagram_native_small_batch: [{ searchSource: 'instagram_search', targetPlatform: 'instagram', sourcePlatform: 'instagram' }],
  reddit_to_instagram: [{ searchSource: 'google_web', targetPlatform: 'instagram', sourcePlatform: 'reddit' }],
  google_web_to_tiktok: [{ searchSource: 'google_web', targetPlatform: 'tiktok', sourcePlatform: 'google_web' }],
  youtube_to_tiktok: [{ searchSource: 'google_web', targetPlatform: 'tiktok', sourcePlatform: 'youtube' }],
  instagram_to_tiktok: [{ searchSource: 'google_web', targetPlatform: 'tiktok', sourcePlatform: 'instagram' }],
  reddit_to_tiktok: [{ searchSource: 'google_web', targetPlatform: 'tiktok', sourcePlatform: 'reddit' }],
  tiktok_native_small_batch: [{ searchSource: 'tiktok_search', targetPlatform: 'tiktok', sourcePlatform: 'tiktok' }],
  spider_web_expansion: TARGET_PLATFORMS.map((platform) => ({ searchSource: 'maton_agent', targetPlatform: platform, sourcePlatform: 'cross_platform' }))
};

const ROUTE_PREFERRED_CYCLES = {
  youtube_native_search: ['C1', 'C2', 'C6'],
  google_web_to_youtube: ['C2', 'C1', 'C4'],
  youtube_to_instagram: ['C1', 'C3', 'C7'],
  google_web_to_instagram: ['C2', 'C4', 'C1'],
  reddit_to_instagram: ['C5', 'C3'],
  seed_posts_to_profile: ['C7', 'C6'],
  instagram_native_small_batch: ['C6'],
  google_web_to_tiktok: ['C2', 'C3', 'C4'],
  youtube_to_tiktok: ['C1', 'C3', 'C4'],
  instagram_to_tiktok: ['C3', 'C6'],
  reddit_to_tiktok: ['C5', 'C3'],
  tiktok_native_small_batch: ['C6'],
  spider_web_expansion: ['C7']
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

function normalizeSearchIntensity(value) {
  const text = clean(value).toLowerCase();
  return ['quick', 'standard', 'full'].includes(text) ? text : 'standard';
}

function recommendedCycleIdsForTargets(targets = [], intensity = 'standard') {
  const normalizedTargets = [...new Set(targets.filter((target) => TARGET_PLATFORMS.includes(target)))];
  const selectedTargets = normalizedTargets.length ? normalizedTargets : ['youtube'];
  const cycleIds = selectedTargets.flatMap((target) => (
    SEARCH_INTENSITY_CYCLES[target]?.[normalizeSearchIntensity(intensity)] || SEARCH_INTENSITY_CYCLES.youtube.standard
  ));
  return CYCLE_ORDER.filter((cycleId) => cycleIds.includes(cycleId) && cycleId !== 'C7');
}

function expansionDeferredSummary(reason = 'waiting_for_seeds') {
  return {
    expansion_cycle: 'C7',
    expansion_status: 'deferred',
    expansion_reason: reason
  };
}

function hasExpansionSeeds(seedUrls = [], existing = {}) {
  if (seedUrls.length) return true;
  const acceptedRaw = (existing.raw_candidates || []).some((candidate) => (
    ['new', 'approved'].includes(clean(candidate.status || 'new')) && clean(candidate.profile_url)
  ));
  if (acceptedRaw) return true;
  return (existing.kol_master || []).some((kol) => (
    clean(kol.profile_url || kol.youtube_url || kol.instagram_url || kol.tiktok_url)
  ));
}

function selectSubtaskCycles({ allCycles, explicitCycles, requestedTargets, searchIntensity, phase, hasSeeds }) {
  const requested = explicitCycles.length
    ? explicitCycles
    : phase === 'expansion'
      ? ['C7']
      : recommendedCycleIdsForTargets(requestedTargets, searchIntensity);
  const normalized = CYCLE_ORDER.filter((cycleId) => requested.includes(cycleId));
  const shouldDeferC7 = normalized.includes('C7') && !hasSeeds;
  const runnable = normalized.filter((cycleId) => cycleId !== 'C7' || hasSeeds);
  return {
    cycles: allCycles.filter((cycle) => runnable.includes(cycle.cycle)),
    deferred: shouldDeferC7 ? expansionDeferredSummary('waiting_for_seeds') : null
  };
}

function normalizeSearchStrategy(value) {
  const parsed = Array.isArray(value) ? value : parseJson(value, DEFAULT_SEARCH_CYCLES);
  const byCycle = {};
  for (const item of Array.isArray(parsed) ? parsed : []) {
    const cycleId = clean(item?.cycle).toUpperCase();
    if (CYCLE_ORDER.includes(cycleId)) {
      byCycle[cycleId] = { ...item, cycle: cycleId };
    }
  }
  return CYCLE_ORDER.map((cycleId, index) => ({
    ...DEFAULT_CYCLE_BY_ID[cycleId],
    ...(byCycle[cycleId] || {}),
    cycle: cycleId,
    priority: index + 1
  }));
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function clampScore(value) {
  const n = normalizeNumber(value);
  if (n === null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function detectPlatformFromUrl(url = '') {
  const lower = clean(url).toLowerCase();
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube';
  if (lower.includes('instagram.com')) return 'instagram';
  if (lower.includes('tiktok.com')) return 'tiktok';
  return 'unknown';
}

function isVideoEvidenceUrl(url = '') {
  const lower = clean(url).toLowerCase();
  if (!lower.startsWith('http')) return false;
  if (lower.includes('youtube.com/watch') || lower.includes('youtu.be/') || lower.includes('youtube.com/shorts/')) return true;
  if (lower.includes('instagram.com/reel/') || lower.includes('instagram.com/p/')) return true;
  if (lower.includes('tiktok.com/') && lower.includes('/video/')) return true;
  return false;
}

function extractJsonObject(text) {
  // Find the outermost balanced JSON object { ... }.
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{' && text[i - 1] !== '\\') depth += 1;
    else if (char === '}' && text[i - 1] !== '\\') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extractJsonArray(text) {
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === '[' && text[i - 1] !== '\\') depth += 1;
    else if (char === ']' && text[i - 1] !== '\\') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseKeyValuePairs(text) {
  // Fallback for plain text / markdown list output like:
  // - content_relevance_score: 35
  // - recommendation: "reject"
  const result = {};
  const regex = /(?:^|\n)\s*[-*]?\s*([a-zA-Z_][a-zA-Z0-9_\.]*)\s*[:=]\s*(.+?)(?=\n(?:\s*[-*]?\s*[a-zA-Z_][a-zA-Z0-9_\.]\s*[:=]|\s*$))/gs;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const key = match[1].trim();
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.toLowerCase() === 'true') value = true;
    else if (value.toLowerCase() === 'false') value = false;
    else if (value.toLowerCase() === 'null' || value.toLowerCase() === 'none') value = null;
    else if (!Number.isNaN(Number(value)) && value !== '') value = Number(value);
    result[key] = value;
  }
  return result;
}

function normalizeParsedAnalysis(parsed, rawText) {
  // Ensure the structure expected by downstream consumers even when the model
  // returns partial JSON or plain text.
  const result = {
    hard_filter: { passed: true, is_real_creator: true, target_platform_match: true, follower_range_match: true, market_language_match: 'certain', profile_accessible: true, hard_filter_notes: '' },
    signal_scores: { competitor_fit: 0, category_fit: 0, use_case_fit: 0, feature_fit: 0, community_fit: 0 },
    evidence_strength_score: 0,
    creator_profile_scores: { creator_tone_fit: 0, content_consistency: 0, posting_frequency: 0, traffic_quality: 0, audience_market_fit: 0, contactability: 0 },
    risk: { risk_level: 'low', risk_notes: '', risk_deduction: 0 },
    candidate_decision: { enter_raw_candidates: false, candidate_priority_score: 0, priority_level: 'normal', recommended_status: 'ignored', reason: '' }
  };

  function merge(target, source) {
    if (!source || typeof source !== 'object') return;
    for (const key of Object.keys(target)) {
      if (source[key] !== undefined) target[key] = source[key];
    }
  }

  if (parsed && typeof parsed === 'object') {
    merge(result.hard_filter, parsed.hard_filter);
    merge(result.signal_scores, parsed.signal_scores);
    merge(result.creator_profile_scores, parsed.creator_profile_scores);
    merge(result.risk, parsed.risk);
    merge(result.candidate_decision, parsed.candidate_decision);
    if (parsed.evidence_strength_score !== undefined) result.evidence_strength_score = parsed.evidence_strength_score;
  }

  // Accept flat keys emitted by some providers (e.g. content_relevance_score, recommendation).
  const flat = parseKeyValuePairs(rawText);
  if (flat.content_relevance_score !== undefined) result.signal_scores.category_fit = Number(flat.content_relevance_score) || 0;
  if (flat.creator_fit_score !== undefined) result.creator_profile_scores.creator_tone_fit = Number(flat.creator_fit_score) || 0;
  if (flat.kol_candidate_potential_score !== undefined) result.candidate_decision.candidate_priority_score = Number(flat.kol_candidate_potential_score) || 0;
  if (flat.evidence_strength_score !== undefined) result.evidence_strength_score = Number(flat.evidence_strength_score) || 0;
  if (flat.recommendation !== undefined) {
    const rec = String(flat.recommendation).toLowerCase();
    result.candidate_decision.enter_raw_candidates = !['reject', 'weak_evidence', 'ignore'].includes(rec);
    result.candidate_decision.recommended_status = rec === 'reject' ? 'ignored' : rec === 'risk' ? 'risk_review' : 'manual_review';
    if (!result.candidate_decision.reason) result.candidate_decision.reason = String(flat.recommendation);
  }
  if (flat.risk_level !== undefined) result.risk.risk_level = String(flat.risk_level).toLowerCase();

  // Final normalization.
  if (result.hard_filter.passed === false) {
    result.candidate_decision.enter_raw_candidates = false;
    result.candidate_decision.recommended_status = 'ignored';
  }
  if (result.candidate_decision.enter_raw_candidates && !result.candidate_decision.recommended_status) {
    result.candidate_decision.recommended_status = 'manual_review';
  }
  if (!result.candidate_decision.reason) result.candidate_decision.reason = rawText.slice(0, 500);

  return result;
}

function parseAiContentRobust(content) {
  const raw = String(content || '').trim();
  if (!raw) return normalizeParsedAnalysis(null, raw);

  const candidates = [];

  // 1. Markdown fenced code block.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) candidates.push(fenceMatch[1].trim());

  // 2. Text with think tags removed.
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  candidates.push(withoutThink);

  // 3. Raw content.
  candidates.push(raw);

  // 4. Extract outermost JSON object/array from each candidate.
  for (const candidate of [...candidates]) {
    const obj = extractJsonObject(candidate);
    if (obj) candidates.push(obj);
    const arr = extractJsonArray(candidate);
    if (arr) candidates.push(arr);
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      return normalizeParsedAnalysis(parsed, raw);
    } catch (error) {
      // Try the next extraction strategy.
    }
  }

  // Final fallback: plain text key-value extraction.
  return normalizeParsedAnalysis(parseKeyValuePairs(raw), raw);
}

function parseMetricNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim().toLowerCase().replace(/,/g, '');
  if (!text) return null;
  const match = text.match(/([\d.]+)\s*([kmb万萬]?)/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const unit = match[2];
  if (unit === 'k') return Math.round(base * 1000);
  if (unit === 'm') return Math.round(base * 1000000);
  if (unit === 'b') return Math.round(base * 1000000000);
  if (unit === '万' || unit === '萬') return Math.round(base * 10000);
  return Math.round(base);
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

function hasUsableSetting(row) {
  const extra = parseJson(row?.extra_config, {});
  return Boolean(
    row?.api_key ||
    row?.base_url ||
    row?.model ||
    extra.connection_id ||
    extra.auth_header_name ||
    extra.custom_provider_name
  );
}

async function getSetting(key, legacyKeys = []) {
  const direct = await dbOperations.get('SELECT * FROM api_settings WHERE provider = ?', [key]);
  if (hasUsableSetting(direct)) return direct;
  for (const legacyKey of legacyKeys) {
    const legacy = await dbOperations.get('SELECT * FROM api_settings WHERE provider = ?', [legacyKey]);
    if (hasUsableSetting(legacy)) return legacy;
  }
  return direct || null;
}

async function getSelection() {
  const row = await dbOperations.get('SELECT extra_config FROM api_settings WHERE provider = ?', [SYSTEM_SELECTION_KEY]);
  return parseJson(row?.extra_config, {});
}

function searchSourceForPlatformProvider(platform, provider) {
  if (provider === 'maton_gateway') return 'maton_agent';
  if (platform === 'youtube') return 'youtube_search';
  if (platform === 'instagram') return 'instagram_search';
  if (platform === 'tiktok') return 'tiktok_search';
  return '';
}

async function preferredSearchSourceForTargetPlatform(platform) {
  const selection = await getSelection();
  const provider = clean(selection.platforms?.[platform]?.primary);
  return searchSourceForPlatformProvider(platform, provider) || searchSourceForPlatformProvider(platform);
}

async function preferredSearchSourcesForTargetPlatforms(platforms = []) {
  const sources = await Promise.all(platforms.map((platform) => preferredSearchSourceForTargetPlatform(platform)));
  return [...new Set(sources.filter((source) => SEARCH_SOURCES.includes(source)))];
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

async function callFinderAi(setting, provider, systemPrompt, finalPrompt) {
  if (!setting?.api_key) throw new Error(`${PROVIDER_LABELS[provider] || provider} API Key is not configured`);

  if (provider === 'minimax') {
    const configuredBase = (setting.base_url || 'https://api.minimaxi.com').replace(/\/$/, '');
    const model = setting.model || 'MiniMax-M3';
    const endpoint = /\/v1$/i.test(configuredBase) || /minimax-m3/i.test(model)
      ? `${configuredBase}/chat/completions`
      : `${configuredBase.replace(/\/v1$/i, '')}/v1/text/chatcompletion_v2`;
    const modern = endpoint.endsWith('/chat/completions');
    const data = await fetchJson(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${setting.api_key}`
      },
      body: JSON.stringify(modern ? {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: finalPrompt }
        ],
        temperature: 0.2
      } : {
        model,
        messages: [
          { sender_type: 'BOT', text: systemPrompt },
          { sender_type: 'USER', text: finalPrompt }
        ],
        temperature: 0.2
      })
    });
    const content = data.reply || data.output_text || data.choices?.[0]?.message?.content || data.data?.reply || JSON.stringify(data);
    return { parsed: parseAiContentRobust(content), raw: data, model };
  }

  const defaultBaseUrl = provider === 'openai'
    ? 'https://api.openai.com/v1'
    : provider === 'deepseek'
      ? 'https://api.deepseek.com'
      : '';
  const baseUrl = (setting.base_url || defaultBaseUrl).replace(/\/$/, '');
  if (!baseUrl) throw new Error(`${PROVIDER_LABELS[provider] || provider} Base URL is not configured`);
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

function normalizeFinderEvidenceResult(parsed = {}) {
  const hardFilter = parsed.hard_filter || {};
  const signalScores = parsed.signal_scores || {};
  const creatorScores = parsed.creator_profile_scores || {};
  const risk = parsed.risk || {};
  const decision = parsed.candidate_decision || {};

  const bestSignal = Math.max(
    Number(signalScores.competitor_fit) || 0,
    Number(signalScores.category_fit) || 0,
    Number(signalScores.use_case_fit) || 0,
    Number(signalScores.feature_fit) || 0,
    Number(signalScores.community_fit) || 0
  );
  const creatorValues = [
    Number(creatorScores.creator_tone_fit) || 0,
    Number(creatorScores.content_consistency) || 0,
    Number(creatorScores.posting_frequency) || 0,
    Number(creatorScores.traffic_quality) || 0,
    Number(creatorScores.audience_market_fit) || 0,
    Number(creatorScores.contactability) || 0
  ];
  const avgCreator = creatorValues.length
    ? Math.round(creatorValues.reduce((a, b) => a + b, 0) / creatorValues.length)
    : 0;

  const normalizedHardFilter = {
    passed: hardFilter.passed !== undefined ? Boolean(hardFilter.passed) : true,
    is_real_creator: hardFilter.is_real_creator !== undefined ? Boolean(hardFilter.is_real_creator) : true,
    target_platform_match: hardFilter.target_platform_match !== undefined ? Boolean(hardFilter.target_platform_match) : true,
    follower_range_match: hardFilter.follower_range_match !== undefined ? Boolean(hardFilter.follower_range_match) : true,
    market_language_match: clean(hardFilter.market_language_match) || 'certain',
    profile_accessible: Boolean(hardFilter.profile_accessible),
    hard_filter_notes: clean(hardFilter.hard_filter_notes)
  };

  const normalizedRisk = {
    risk_level: clean(risk.risk_level) || 'low',
    risk_notes: clean(risk.risk_notes),
    risk_deduction: Number(risk.risk_deduction) || 0
  };

  // Business rule: score is for ranking only. A candidate enters the raw pool when:
  // 1. All hard filters pass (real creator, right platform, follower range, market/language, accessible profile)
  // 2. At least one soft signal (competitor/category/use-case/feature/community) shows relevance (>= 20)
  // 3. Risk is not high
  // 4. No explicit hard-filter failure note that overrides the above
  const hardConditionsMet =
    normalizedHardFilter.passed !== false &&
    normalizedHardFilter.is_real_creator !== false &&
    normalizedHardFilter.target_platform_match !== false &&
    normalizedHardFilter.follower_range_match !== false &&
    normalizedHardFilter.profile_accessible !== false &&
    normalizedHardFilter.market_language_match !== 'mismatch';

  const softSignalMet = bestSignal >= MIN_RELEVANT_SIGNAL_SCORE || Number(parsed.evidence_strength_score) >= MIN_RELEVANT_SIGNAL_SCORE;
  const notHighRisk = normalizedRisk.risk_level !== 'high';

  const shouldEnterRaw = hardConditionsMet && softSignalMet && notHighRisk;

  let enterRawCandidates = Boolean(decision.enter_raw_candidates);
  let recommendedStatus = clean(decision.recommended_status) || 'manual_review';
  let reason = clean(decision.reason);

  // Override the model if it wrongly rejected a candidate that meets business rules.
  if (shouldEnterRaw && (!enterRawCandidates || recommendedStatus === 'ignored')) {
    enterRawCandidates = true;
    recommendedStatus = recommendedStatus === 'risk_review' ? 'risk_review' : 'manual_review';
    reason = reason || `硬条件全部通过，且至少一个信号与策略相关（最高 ${bestSignal} 分）。根据业务规则应进入 Raw Candidates，等待人工审核。`;
  }

  // If the model says enter but business rules say no, still trust explicit hard_filter.fail or high risk.
  if (!shouldEnterRaw && enterRawCandidates && normalizedHardFilter.passed === false) {
    enterRawCandidates = false;
    recommendedStatus = 'ignored';
    reason = reason || '硬条件未通过，不进入 Raw Candidates。';
  }

  // Ensure every raw-candidate entry has a Chinese reason, even if the model left it empty.
  if (enterRawCandidates && !reason) {
    reason = `硬条件通过，最高信号 ${bestSignal} 分，风险等级 ${normalizedRisk.risk_level}，进入 Raw Candidates 人工审核。`;
  }
  if (!reason) {
    reason = normalizedHardFilter.passed === false
      ? '硬条件未通过。'
      : `未进入 Raw Candidates：最高信号 ${bestSignal} 分，风险等级 ${normalizedRisk.risk_level}。`;
  }

  return {
    hard_filter: normalizedHardFilter,
    signal_scores: {
      competitor_fit: clampScore(signalScores.competitor_fit),
      category_fit: clampScore(signalScores.category_fit),
      use_case_fit: clampScore(signalScores.use_case_fit),
      feature_fit: clampScore(signalScores.feature_fit),
      community_fit: clampScore(signalScores.community_fit)
    },
    creator_profile_scores: {
      creator_tone_fit: clampScore(creatorScores.creator_tone_fit),
      content_consistency: clampScore(creatorScores.content_consistency),
      posting_frequency: clampScore(creatorScores.posting_frequency),
      traffic_quality: clampScore(creatorScores.traffic_quality),
      audience_market_fit: clampScore(creatorScores.audience_market_fit),
      contactability: clampScore(creatorScores.contactability)
    },
    evidence_strength_score: clampScore(parsed.evidence_strength_score),
    risk: normalizedRisk,
    candidate_decision: {
      enter_raw_candidates: enterRawCandidates,
      candidate_priority_score: clampScore(decision.candidate_priority_score),
      priority_level: clean(decision.priority_level) || 'normal',
      recommended_status: recommendedStatus,
      reason
    },
    // Backward-compatible flat fields for consumers still reading old shape
    content_relevance_score: bestSignal,
    creator_fit_score: avgCreator,
    brand_safety_risk: normalizedRisk.risk_level,
    kol_candidate_potential_score: clampScore(decision.candidate_priority_score),
    recommendation: recommendedStatus,
    matched_topics: [],
    matched_personas: []
  };
}

async function runFinderEvidenceAnalysis(video, snapshot, evidence, strategy) {
  const selection = await getSelection();
  const provider = selection.aiModels?.active || 'deepseek';
  if (provider === 'custom_http_api') throw new Error('Custom HTTP API is not available for Finder evidence analysis yet');
  if (!['openai', 'deepseek', 'custom_openai_compatible', 'minimax'].includes(provider)) {
    throw new Error(`${PROVIDER_LABELS[provider] || provider} is not available for Finder evidence analysis`);
  }
  const setting = await getSetting(providerKey('ai', provider), legacyKeysFor('ai', provider));
  const systemPrompt = [
    'You are a KOL Finder evidence analyst.',
    'Return valid JSON only. Do not include Markdown, explanations, or chain-of-thought.',
    'Your job is to evaluate whether the video author is a KOL candidate worth entering the raw candidate pool.',
    'Evaluate in two layers: (1) video evidence fit (signal_scores) and (2) creator profile / account quality (creator_profile_scores).',
    'Do not analyze cooperation performance. Do not assume comments are available.',
    'AI score is for ranking only; do not use it as a hard filter to reject candidates.',
    `Enter raw candidates when: (1) hard_filter passes, (2) at least one signal score >= ${MIN_RELEVANT_SIGNAL_SCORE} (competitor, category, use_case, feature, or community), and (3) risk is not high.`,
    'If the above conditions are met, set enter_raw_candidates = true and recommended_status = manual_review (or new if strong).',
    'Only set enter_raw_candidates = false when hard_filter fails, market/language is a clear mismatch, or risk is high.'
  ].join(' ');
  const finalPrompt = [
    'Campaign and strategy context:',
    JSON.stringify({
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
      product_context: strategy.product_context || {},
      persona_config: strategy.persona_config || {},
      finder_handoff: strategy.finder_handoff || {}
    }, null, 2),
    '',
    'Video evidence:',
    JSON.stringify({
      evidence_id: evidence.id,
      target_platform: evidence.target_platform,
      evidence_platform: evidence.evidence_platform,
      discovery_scope: evidence.discovery_scope,
      discovery_route: evidence.discovery_route,
      source_signal: evidence.source_signal,
      source_query: evidence.source_query,
      video_url: evidence.video_url,
      title: evidence.title || video.title || '',
      author_name: evidence.author_name || video.author_name || video.kol_name || '',
      author_profile_url: evidence.author_profile_url || '',
      published_at: video.published_at || '',
      content_type: video.content_type || '',
      metrics: snapshot ? {
        play_count: snapshot.play_count,
        like_count: snapshot.like_count,
        comment_count: snapshot.comment_count,
        collect_count: snapshot.collect_count,
        share_count: snapshot.share_count,
        primary_exposure_count: snapshot.primary_exposure_count,
        exposure_metric_type: snapshot.exposure_metric_type,
        data_quality_note: snapshot.data_quality_note
      } : null
    }, null, 2),
    '',
    'Return this exact JSON shape:',
    JSON.stringify({
      hard_filter: {
        passed: true,
        is_real_creator: true,
        target_platform_match: true,
        follower_range_match: true,
        market_language_match: 'certain | uncertain | mismatch',
        profile_accessible: true,
        hard_filter_notes: 'Explain any hard filter concerns'
      },
      signal_scores: {
        competitor_fit: 0,
        category_fit: 0,
        use_case_fit: 0,
        feature_fit: 0,
        community_fit: 0
      },
      evidence_strength_score: 0,
      creator_profile_scores: {
        creator_tone_fit: 0,
        content_consistency: 0,
        posting_frequency: 0,
        traffic_quality: 0,
        audience_market_fit: 0,
        contactability: 0
      },
      risk: {
        risk_level: 'low | medium | high',
        risk_notes: '',
        risk_deduction: 0
      },
      candidate_decision: {
        enter_raw_candidates: true,
        candidate_priority_score: 0,
        priority_level: 'low | normal | high',
        recommended_status: 'new | manual_review | risk_review | ignored',
        reason: '完整中文推荐理由。必须围绕：视频证据、主页判断、基础条件、风险/待确认项、推荐动作五个部分。不要只给一句话，要给出人工审核所需的关键信息。'
      }
    }, null, 2),
    '',
    'Scoring guidelines:',
    '0 = completely unrelated, 30 = slightly relevant, 50 = relevant but weak, 70 = clear evidence, 85 = strong evidence, 95 = almost exactly the target content.',
    'candidate_priority_score is for ranking only and should combine video evidence (50%), creator profile quality (35%), and risk (15%). It must not be used to reject candidates.',
    `Decision rule: enter_raw_candidates = true when hard_filter passes AND at least one signal score >= ${MIN_RELEVANT_SIGNAL_SCORE} AND risk.risk_level is not high.`,
    'candidate_decision.reason must be a complete Chinese recommendation summary. Structure it around: (1) 视频证据, (2) 主页判断, (3) 基础条件, (4) 风险/待确认项, (5) 推荐动作.',
    'If hard_filter.passed is false, set enter_raw_candidates = false and recommended_status = ignored.',
    'If risk.risk_level is high or historical cooperation issue, set recommended_status = risk_review (but keep enter_raw_candidates = true if hard_filter and signal conditions pass).',
    'If the evidence is relevant but uncertain, set recommended_status = manual_review instead of rejecting.'
  ].join('\n');
  const result = await callFinderAi(setting, provider, systemPrompt, finalPrompt);
  return { ...result, finalPrompt };
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
    search_strategy: normalizeSearchStrategy(row.search_strategy),
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

function defaultDiscoveryRoutesForTargets(targets) {
  const routes = [];
  if (targets.includes('youtube')) routes.push('youtube_native_search', 'google_web_to_youtube', 'spider_web_expansion');
  if (targets.includes('instagram')) routes.push('youtube_to_instagram', 'google_web_to_instagram', 'seed_posts_to_profile');
  if (targets.includes('tiktok')) routes.push('google_web_to_tiktok', 'seed_posts_to_profile');
  return [...new Set(routes.length ? routes : ['youtube_native_search'])];
}

function defaultSubagentRoutesForTargets(targets) {
  const routes = [];
  if (targets.includes('youtube')) routes.push('youtube_native_search', 'google_web_to_youtube');
  if (targets.includes('instagram')) {
    routes.push('youtube_to_instagram', 'google_web_to_instagram', 'reddit_to_instagram', 'seed_posts_to_profile', 'instagram_native_small_batch');
  }
  if (targets.includes('tiktok')) routes.push('google_web_to_tiktok', 'youtube_to_tiktok', 'instagram_to_tiktok', 'reddit_to_tiktok');
  return [...new Set(routes.length ? routes : ['youtube_native_search'])];
}

function discoveryRoutesForCycle(cycle, strategy, requestedRoutes = [], requestedTargets = []) {
  const cycleRoutes = parseList(cycle.discovery_routes);
  const targets = targetPlatformsForCycle(cycle, strategy, requestedTargets);
  return [...new Set((requestedRoutes.length ? requestedRoutes : cycleRoutes.length ? cycleRoutes : defaultDiscoveryRoutesForTargets(targets)).filter((route) => DISCOVERY_ROUTES.includes(route)))];
}

async function sourceTargetPairs(cycle, strategy, requestedSources = [], requestedTargets = [], requestedRoutes = []) {
  const targets = targetPlatformsForCycle(cycle, strategy, requestedTargets);
  const routes = discoveryRoutesForCycle(cycle, strategy, requestedRoutes, targets);
  const pairs = [];
  for (const route of routes) {
    for (const mapped of ROUTE_SOURCE_TARGETS[route] || []) {
      if (targets.includes(mapped.targetPlatform)) {
        const searchSource = mapped.searchSource === 'auto'
          ? await preferredSearchSourceForTargetPlatform(mapped.targetPlatform)
          : mapped.searchSource;
        pairs.push({ ...mapped, searchSource, discoveryRoute: route });
      }
    }
  }
  if (pairs.length) return pairs;
  const sources = searchSourcesForCycle(cycle, requestedSources);
  for (const source of sources) {
    for (const target of targets) {
      if ((LEGAL_SOURCE_TARGETS[source] || []).includes(target)) {
        pairs.push({ searchSource: source, targetPlatform: target, sourcePlatform: source.replace('_search', ''), discoveryRoute: source });
      }
    }
  }
  return pairs;
}

function sourceTargetPairsForSubagents(cycle, strategy, requestedTargets = [], requestedRoutes = []) {
  const targets = targetPlatformsForCycle(cycle, strategy, requestedTargets);
  const cycleRoutes = parseList(cycle.discovery_routes);
  const routes = [...new Set((requestedRoutes.length ? requestedRoutes : cycleRoutes.length ? cycleRoutes : defaultSubagentRoutesForTargets(targets)).filter((route) => route !== 'cycle_multi_route' && DISCOVERY_ROUTES.includes(route)))];
  const pairs = [];
  for (const route of routes) {
    for (const mapped of ROUTE_SOURCE_TARGETS[route] || []) {
      if (targets.includes(mapped.targetPlatform)) pairs.push({ ...mapped, discoveryRoute: route });
    }
  }
  return pairs;
}

function routeLabel(route) {
  return PROVIDER_LABELS[route] || route;
}

function routeMappingsForTargets(route, targets) {
  return (ROUTE_SOURCE_TARGETS[route] || []).filter((mapped) => targets.includes(mapped.targetPlatform));
}

function routeExecutor(route) {
  if (route === 'seed_posts_to_profile' || route === 'spider_web_expansion') return 'seed_expansion';
  if (route === 'tiktok_native_small_batch') return 'native_unavailable';
  if (route.includes('_to_tiktok') && route !== 'google_web_to_tiktok') return 'cross_platform_lookup';
  if (route.includes('_to_instagram') && route !== 'google_web_to_instagram') return 'cross_platform_lookup';
  if (route.includes('_to_youtube') && route !== 'google_web_to_youtube') return 'cross_platform_lookup';
  return 'web_search';
}

function routePlanItem(route, targets, required, reason) {
  return {
    route,
    label: routeLabel(route),
    executor: routeExecutor(route),
    mappings: routeMappingsForTargets(route, targets),
    required: Boolean(required),
    reason
  };
}

function skippedRouteItem(route, reason) {
  return {
    route,
    label: routeLabel(route),
    executor: routeExecutor(route),
    required: false,
    skipped: true,
    reason
  };
}

function closestSelectedCycle(preferred, selectedCycleIds) {
  const selected = selectedCycleIds.filter((cycle) => CYCLE_ORDER.includes(cycle));
  if (!selected.length) return '';
  for (const cycle of preferred) {
    if (selected.includes(cycle)) return cycle;
  }
  const preferredIndex = CYCLE_ORDER.indexOf(preferred.find((cycle) => CYCLE_ORDER.includes(cycle)) || selected[0]);
  return selected.reduce((best, cycle) => {
    const distance = Math.abs(CYCLE_ORDER.indexOf(cycle) - preferredIndex);
    const bestDistance = Math.abs(CYCLE_ORDER.indexOf(best) - preferredIndex);
    return distance < bestDistance ? cycle : best;
  }, selected[0]);
}

function buildRouteCoveragePlan(cycles, strategy, requestedTargets = [], requestedRoutes = [], seedUrls = []) {
  const selectedCycleIds = cycles.map((cycle) => cycle.cycle);
  const targets = [...new Set((requestedTargets.length ? requestedTargets : cycles.flatMap((cycle) => targetPlatformsForCycle(cycle, strategy))).filter((p) => TARGET_PLATFORMS.includes(p)))];
  const fallbackRoutes = defaultSubagentRoutesForTargets(targets);
  const baseRoutes = requestedRoutes.length ? requestedRoutes : fallbackRoutes;
  const routes = [...new Set([
    ...baseRoutes,
    ...(targets.includes('tiktok') ? ['google_web_to_tiktok'] : [])
  ].filter((route) => route !== 'cycle_multi_route' && DISCOVERY_ROUTES.includes(route)))];
  const usableRoutes = routes.filter((route) => routeMappingsForTargets(route, targets).length);
  const hasSeedUrls = seedUrls.length > 0;
  const unavailableRoutes = usableRoutes.filter((route) => route === 'tiktok_native_small_batch');
  const executableRoutes = usableRoutes.filter((route) => (
    route !== 'tiktok_native_small_batch'
    && (route !== 'seed_posts_to_profile' || hasSeedUrls)
  ));
  const requiredByCycle = Object.fromEntries(selectedCycleIds.map((cycle) => [cycle, []]));

  for (const route of executableRoutes.filter((route) => !(targets.includes('tiktok') && route !== 'seed_posts_to_profile' && route !== 'google_web_to_tiktok'))) {
    const preferred = ROUTE_PREFERRED_CYCLES[route] || ['C2'];
    const assignedCycle = closestSelectedCycle(preferred, selectedCycleIds);
    if (assignedCycle) requiredByCycle[assignedCycle].push(route);
  }

  return cycles.map((cycle) => {
    const cycleTargets = targetPlatformsForCycle(cycle, strategy, targets);
    const cycleTargetSet = cycleTargets.length ? cycleTargets : targets;
    const isTikTokCycle = cycleTargetSet.includes('tiktok') && targets.includes('tiktok');
    const skippedRoutes = [
      ...(!hasSeedUrls && usableRoutes.includes('seed_posts_to_profile') ? [skippedRouteItem('seed_posts_to_profile', 'no_seed')] : []),
      ...unavailableRoutes.map((route) => skippedRouteItem(route, 'native_unavailable_no_login_v1'))
    ].filter((item, index, list) => item.route && list.findIndex((other) => other.route === item.route) === index);

    if (isTikTokCycle && cycle.cycle === 'C7' && !hasSeedUrls) {
      return {
        cycle: cycle.cycle,
        cycle_name: cycle.name,
        purpose: cycle.purpose || '',
        target_platforms: cycleTargets.length ? cycleTargets : targets,
        source_query: keywordString(cycle, strategy),
        seed_urls: seedUrls,
        target_count: 0,
        cycle_status: 'skipped',
        cycle_status_reason: 'no_seed',
        required_routes: [],
        optional_routes: [],
        skipped_routes: skippedRoutes,
        cycle_status_rule: 'Skipped because C7 is seed expansion and no seed URLs were provided.',
        coverage_rule: 'Return route_coverage with skipped/no_seed and do not import candidates for this cycle.'
      };
    }

    const requiredRouteNames = isTikTokCycle
      ? cycle.cycle === 'C7' && hasSeedUrls
        ? ['seed_posts_to_profile']
        : executableRoutes.includes('google_web_to_tiktok')
          ? ['google_web_to_tiktok']
          : []
      : [...new Set([
        ...(requiredByCycle[cycle.cycle] || []),
        ...((requiredByCycle[cycle.cycle] || []).length ? [] : executableRoutes.find((route) => routeMappingsForTargets(route, cycleTargetSet).length) ? [executableRoutes.find((route) => routeMappingsForTargets(route, cycleTargetSet).length)] : [])
      ])];
    const requiredRoutes = requiredRouteNames.map((route) => routePlanItem(
      route,
      targets,
      true,
      isTikTokCycle
        ? route === 'seed_posts_to_profile'
          ? 'Required seed expansion path for C7 when seed URLs are available'
          : `Baseline executable route for ${cycle.cycle} ${cycle.name || ''}`.trim()
        : (requiredByCycle[cycle.cycle] || []).includes(route)
          ? `Primary coverage for ${cycle.cycle} ${cycle.name || ''}`.trim()
          : `Required executable route for ${cycle.cycle} ${cycle.name || ''}`.trim()
    ));
    const optionalRoutes = usableRoutes
      .filter((route) => !requiredRoutes.some((item) => item.route === route))
      .filter((route) => !skippedRoutes.some((item) => item.route === route))
      .filter((route) => routeMappingsForTargets(route, cycleTargetSet).length)
      .filter((route) => !(isTikTokCycle && route === 'seed_posts_to_profile' && cycle.cycle !== 'C7'))
      .map((route) => routePlanItem(
        route,
        cycleTargetSet,
        false,
        'Optional evidence path if it fits this cycle intent'
      ));
    return {
      cycle: cycle.cycle,
      cycle_name: cycle.name,
      purpose: cycle.purpose || '',
      target_platforms: cycleTargets.length ? cycleTargets : targets,
      source_query: keywordString(cycle, strategy),
      seed_urls: seedUrls,
      target_count: cycle.target_count || 10,
      cycle_status: 'pending',
      required_routes: requiredRoutes,
      optional_routes: optionalRoutes,
      skipped_routes: skippedRoutes,
      cycle_status_rule: 'completed = required routes attempted with coverage/no_result notes; skipped = system says this cycle should not run; blocked = required route cannot be attempted.',
      coverage_rule: 'Required routes must be attempted or reported with a skip/no_result/block reason. Optional routes should be attempted when useful and reported when skipped. Candidates must record their actual discovery_route.'
    };
  });
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

async function existingProfiles(strategyId, campaignId) {
  const customers = await dbOperations.query(`
    SELECT id, name, email, profile_url, youtube_url, instagram_url, tiktok_url
    FROM customers
    ORDER BY updated_at DESC, id DESC
    LIMIT 200
  `);
  const raw = await dbOperations.query(`
    SELECT id, strategy_id, campaign_id, platform, kol_name, email, profile_url, status
    FROM raw_candidates
    WHERE strategy_id = ? OR campaign_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 200
  `, [strategyId, campaignId]);
  return { kol_master: customers, raw_candidates: raw };
}

function buildSubagentPrompt({ subtaskId, task, strategy, cycle, pair, routePlan, sourceQuery, seedUrls, existing }) {
  const isCycleSubtask = Boolean(routePlan);
  const routeName = pair?.discoveryRoute || 'cycle_multi_route';
  const routeLabelText = isCycleSubtask ? `${cycle.cycle} ${cycle.name || 'Cycle Research'}` : routeLabel(routeName);
  const sourceAgent = isCycleSubtask ? `codex_subagent_${cycle.cycle.toLowerCase()}_cycle` : `codex_subagent_${routeName}`;
  const payload = {
    finder_subtask_id: subtaskId,
    strategy_id: strategy.id,
    source_agent: sourceAgent,
    route_coverage: isCycleSubtask ? [] : undefined,
    accepted_candidates: [],
    rejected_candidates: []
  };
  if (!isCycleSubtask) delete payload.route_coverage;
  return [
    isCycleSubtask
      ? `You are a KOL Finder cycle subagent for KOL Campaign OS. Work only on this search intent: ${routeLabelText}.`
      : `You are a KOL Finder subagent for KOL Campaign OS. Work only on this focused discovery route: ${routeLabelText}.`,
    '',
    'Campaign:',
    JSON.stringify({
      id: strategy.campaign_id,
      name: strategy.campaign_name,
      brand: strategy.brand || strategy.campaign_brand || '',
      product: strategy.product || strategy.campaign_product || '',
      category: strategy.category || '',
      target_market: strategy.target_market || '',
      language: strategy.language || '',
      goal: strategy.campaign_goal || ''
    }, null, 2),
    '',
    'Strategy:',
    JSON.stringify({
      id: strategy.id,
      name: strategy.name,
      product_context: strategy.product_context,
      persona_config: strategy.persona_config,
      scoring_weights: strategy.scoring_weights,
      finder_handoff: strategy.finder_handoff
    }, null, 2),
    '',
    'Subtask scope:',
    JSON.stringify(isCycleSubtask ? {
      finder_task_id: task.id,
      search_cycle: cycle.cycle,
      cycle_name: cycle.name,
      cycle_purpose: cycle.purpose || '',
      discovery_route: 'cycle_multi_route',
      target_platforms: routePlan.target_platforms,
      source_query: sourceQuery,
      seed_urls: seedUrls,
      route_plan: routePlan
    } : {
      finder_task_id: task.id,
      search_cycle: cycle.cycle,
      cycle_name: cycle.name,
      discovery_route: pair.discoveryRoute,
      source_platform: pair.sourcePlatform,
      target_platform: pair.targetPlatform,
      source_query: sourceQuery,
      seed_urls: seedUrls
    }, null, 2),
    '',
    'Existing records to avoid duplicating:',
    JSON.stringify(existing, null, 2),
    '',
    'Rules:',
    '- Return valid JSON only. No Markdown.',
    '- Do not approve candidates or write to KOL Master.',
    '- Treat search results as leads. Inspect enough evidence before accepting.',
    '- Do not invent follower counts, emails, countries, prices, or engagement numbers. Leave unknown fields blank.',
    '- Every candidate must include its real discovery_route, source_platform, target_platform, evidence_url, source_query, and search_cycle.',
    '- For cycle_multi_route subtasks, do not import candidates with discovery_route = cycle_multi_route. Use the actual route that found the candidate.',
    '- For Instagram targets, accepted candidates must have a reachable profile_url and verified handle attribution. Do not rely only on a listicle, directory, Reddit mention, or search snippet.',
    '- For TikTok targets, accepted candidates must use the real TikTok profile_url and the handle must be attributable to the creator through the TikTok profile, creator-owned page, YouTube/Instagram bio, brand collaboration page, or a trustworthy article. Do not rely only on listicles, search snippets, or Reddit mentions.',
    '- Import meaningful rejected candidates with a clear reject_reason so the same bad path is not repeated.',
    '- When orchestrating multiple generated cycle prompts, use parallel workers if your agent platform supports them. If it only supports sequential execution, tell the user before starting because it will be slower.',
    '- If web search, browser, or relevant API tools are unavailable, return cycle_status = "blocked" with a clear cycle_status_reason. Do not fabricate no-result candidates from tool failure.',
    isCycleSubtask ? '- Required routes must be attempted. If a required route cannot be searched or produces no useful leads, include it in route_coverage with a blocked, skip_reason, or no_result reason.' : '',
    isCycleSubtask ? '- Optional routes should be attempted when useful. If skipped, include a short reason in route_coverage or route_attempts.' : '',
    isCycleSubtask ? '- Skipped routes must not be forced. Record the skipped reason and do not fabricate candidates for them.' : '',
    isCycleSubtask ? '- If route_plan.cycle_status is skipped, return empty accepted_candidates and rejected_candidates plus route_coverage explaining the skip.' : '',
    isCycleSubtask ? '- Do not include candidates from other search cycles in this subtask output.' : '',
    '',
    'Required output shape:',
    JSON.stringify(payload, null, 2),
    '',
    'Each candidate must include: platform, target_platform, source_platform, discovery_route, kol_name, profile_url, evidence_url, evidence_type, source_query, search_cycle, ai_match_reason, status. Rejected candidates must also include reject_reason.'
  ].join('\n');
}

const EU_COUNTRIES = [
  'austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czech republic', 'czechia',
  'denmark', 'estonia', 'finland', 'france', 'germany', 'greece', 'hungary', 'ireland',
  'italy', 'latvia', 'lithuania', 'luxembourg', 'malta', 'netherlands', 'poland',
  'portugal', 'romania', 'slovakia', 'slovenia', 'spain', 'sweden'
];

function inferCountryRegion(...values) {
  const text = values.map(clean).filter(Boolean).join(' ').toLowerCase();
  if (!text) return '';
  const patterns = [
    { value: 'Philippines', tests: ['philippines', 'filipino', '🇵🇭'] },
    { value: 'United States', tests: ['united states', 'usa', 'u.s.', 'u.s.a', '🇺🇸'] },
    { value: 'United Kingdom', tests: ['united kingdom', 'uk', 'u.k.', 'england', 'britain', '🇬🇧'] },
    { value: 'Canada', tests: ['canada', '🇨🇦'] },
    { value: 'Australia', tests: ['australia', '🇦🇺'] },
    { value: 'Germany', tests: ['germany', 'deutschland', '🇩🇪'] },
    { value: 'France', tests: ['france', '🇫🇷'] },
    { value: 'Spain', tests: ['spain', 'españa', '🇪🇸'] },
    { value: 'Italy', tests: ['italy', 'italia', '🇮🇹'] },
    { value: 'Netherlands', tests: ['netherlands', 'holland', '🇳🇱'] },
    { value: 'Sweden', tests: ['sweden', '🇸🇪'] },
    { value: 'Poland', tests: ['poland', '🇵🇱'] },
    { value: 'Japan', tests: ['japan', '🇯🇵'] },
    { value: 'South Korea', tests: ['south korea', 'korea', '🇰🇷'] },
    { value: 'China', tests: ['china', '🇨🇳'] },
    { value: 'Brazil', tests: ['brazil', 'brasil', '🇧🇷'] },
    { value: 'Mexico', tests: ['mexico', 'méxico', '🇲🇽'] }
  ];
  const matched = patterns.find((item) => item.tests.some((pattern) => text.includes(pattern)));
  if (matched?.value) return matched.value;
  if (['indonesia', 'bali', 'gianyar', 'batubulan'].some((pattern) => text.includes(pattern))) return 'Indonesia';
  return '';
}

function targetMarketAllowsCountry(targetMarket, countryRegion) {
  const target = clean(targetMarket).toLowerCase();
  const country = clean(countryRegion).toLowerCase();
  if (!target || !country || target.includes('global') || target.includes('worldwide')) return true;
  const wantsUs = /\b(us|usa|u\.s\.|united states)\b/.test(target);
  const wantsEu = /\b(eu|europe|european)\b/.test(target);
  const wantsUk = /\b(uk|u\.k\.|united kingdom)\b/.test(target);
  const inUs = country === 'united states' || country === 'usa' || country === 'us';
  const inUk = country === 'united kingdom' || country === 'uk';
  const inEu = EU_COUNTRIES.includes(country);
  if (wantsUs && inUs) return true;
  if (wantsEu && inEu) return true;
  if (wantsUk && inUk) return true;
  return target.includes(country);
}

function applyMarketGate(candidate, request) {
  const targetMarket = request.campaign?.target_market || '';
  if (!targetMarket || !candidate.country_region) return candidate;
  if (targetMarketAllowsCountry(targetMarket, candidate.country_region)) return candidate;
  return {
    ...candidate,
    status: 'ignored',
    error_message: `Market mismatch: ${candidate.country_region} is outside target market ${targetMarket}`,
    reason: `${candidate.reason || ''} Market mismatch: ${candidate.country_region} is outside target market ${targetMarket}`.trim()
  };
}

function applyFollowerGate(candidate, request) {
  const handoff = request.strategy?.finder_handoff || {};
  const minFollowers = parseMetricNumber(handoff.minimum_followers || handoff.min_followers);
  const maxFollowers = parseMetricNumber(handoff.maximum_followers || handoff.max_followers);
  const minAvgViews = parseMetricNumber(handoff.minimum_avg_views || handoff.min_avg_views);
  const followerCount = parseMetricNumber(candidate.followers);
  const avgViews = parseMetricNumber(candidate.avg_views);
  const failures = [];

  if (minFollowers !== null && followerCount !== null && followerCount < minFollowers) {
    failures.push(`followers ${followerCount} < minimum ${minFollowers}`);
  }
  if (maxFollowers !== null && followerCount !== null && followerCount > maxFollowers) {
    failures.push(`followers ${followerCount} > maximum ${maxFollowers}`);
  }
  if (minAvgViews !== null && avgViews !== null && avgViews < minAvgViews) {
    failures.push(`avg views ${avgViews} < minimum ${minAvgViews}`);
  }

  if (!failures.length) return candidate;
  const message = `Follower rule mismatch: ${failures.join('; ')}`;
  return {
    ...candidate,
    status: 'ignored',
    error_message: [candidate.error_message, message].filter(Boolean).join(' | '),
    reason: `${candidate.reason || ''} ${message}`.trim()
  };
}

const CREATOR_POSITIVE_TERMS = [
  'review', 'reviewer', 'reviews', 'demo', 'gear', 'pedal', 'vocal', 'vocals',
  'singer', 'songwriter', 'musician', 'producer', 'loop', 'looping', 'looper',
  'worship', 'busking', 'live performer', 'youtube', 'creator', 'content',
  'studio', 'recording', 'audio', 'mixing', 'sound', 'tutorial'
];

const NON_CREATOR_NEGATIVE_TERMS = [
  'store', 'shop', 'online store', 'music store', 'open everyday', 'dealer',
  'distributor', 'rental', 'repair', 'restaurant', 'cafe', 'fashion', 'beauty',
  'makeup', 'fitness', 'real estate', 'agency'
];

const STRONG_NON_CREATOR_TERMS = [
  'online store', 'music store', 'open everyday', 'dealer', 'distributor', 'rental', 'repair'
];

function appendGateFailure(candidate, message) {
  return {
    ...candidate,
    status: 'ignored',
    error_message: [candidate.error_message, message].filter(Boolean).join(' | '),
    reason: `${candidate.reason || ''} ${message}`.trim()
  };
}

function applyInstagramCreatorQualityGate(candidate) {
  if (candidate.platform !== 'instagram') return candidate;
  const raw = candidate.raw_data || {};
  const text = [
    candidate.kol_name,
    raw.username,
    raw.full_name,
    raw.biography,
    raw.category_name,
    raw.google_title,
    raw.google_description,
    raw.external_url
  ].map(clean).join(' ').toLowerCase();
  const followers = parseMetricNumber(candidate.followers);
  const mediaCount = parseMetricNumber(raw.media_count);
  const failures = [];
  const positives = CREATOR_POSITIVE_TERMS.filter((term) => text.includes(term));
  const negatives = NON_CREATOR_NEGATIVE_TERMS.filter((term) => text.includes(term));
  const strongNegatives = STRONG_NON_CREATOR_TERMS.filter((term) => text.includes(term));

  if (raw.is_private) failures.push('private account');
  if (followers !== null && followers < 1000) failures.push(`followers ${followers} < Instagram baseline 1000`);
  if (mediaCount !== null && mediaCount < 30) failures.push(`media count ${mediaCount} < baseline 30`);
  if (strongNegatives.length) failures.push(`strong non-creator profile signals: ${strongNegatives.slice(0, 3).join(', ')}`);
  if (negatives.length && !positives.length) failures.push(`non-creator profile signals: ${negatives.slice(0, 3).join(', ')}`);
  if (!positives.length) failures.push('missing creator/reviewer/gear signals in profile');
  if (raw.matched_from === 'caption' && followers !== null && followers < 5000 && positives.length < 2) {
    failures.push('caption-only match with weak creator signals');
  }

  if (!failures.length) {
    return {
      ...candidate,
      scoring_breakdown: {
        ...(candidate.scoring_breakdown || {}),
        creator_quality_signals: positives.slice(0, 6),
        instagram_media_count: mediaCount
      }
    };
  }
  return appendGateFailure(candidate, `Instagram quality mismatch: ${failures.join('; ')}`);
}

function applyFinderGates(candidate, request) {
  return applyInstagramCreatorQualityGate(applyFollowerGate(applyMarketGate(candidate, request), request));
}

function buildCycleRequest(strategy, cycle, searchSource, targetPlatform, limit, discoveryRoute = searchSource, sourcePlatform = searchSource) {
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
    discovery_route: discoveryRoute,
    source_platform: sourcePlatform,
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
  if (Array.isArray(data?.profiles)) return data.profiles;
  if (Array.isArray(data?.data?.profiles)) return data.data.profiles;
  if (Array.isArray(data?.searchResults)) return data.searchResults;
  if (Array.isArray(data?.data?.searchResults)) return data.data.searchResults;
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

async function scrapeCreatorsFinderAdapterV2(request) {
  const setting = await getSetting(providerKey(request.target_platform, 'scrapecreators'), legacyKeysFor(request.target_platform, 'scrapecreators'));
  if (!setting?.api_key) throw new Error('ScrapeCreators API Key is not configured');
  const baseUrl = (setting.base_url || 'https://api.scrapecreators.com').replace(/\/$/, '').replace(/\/v1$/, '');
  const headers = { 'x-api-key': setting.api_key, Authorization: `Bearer ${setting.api_key}` };
  const maxResults = Math.max(1, Math.min(Number(request.limit || 10), 50));
  const candidates = [];
  let lastEndpoint = '';

  for (const query of keywordQueries(request)) {
    if (candidates.length >= maxResults) break;
    const endpoints = request.target_platform === 'instagram'
      ? [buildUrl(baseUrl, '/v1/instagram/search/profiles', { query })]
      : [
        buildUrl(baseUrl, '/v1/tiktok/search', { query, limit: maxResults }),
        buildUrl(baseUrl, '/v1/tiktok/users/search', { query, limit: maxResults }),
        buildUrl(baseUrl, '/v1/tiktok/user/search', { query, limit: maxResults })
      ];
    const result = await fetchFirstJson(endpoints, { headers });
    lastEndpoint = result.url;
    const rawCandidates = extractCandidateArray(result.data);
    for (const item of rawCandidates) {
      const user = item.user || item.author || item.owner || item;
      const username = clean(user.username || user.unique_id || user.handle || user.nickname || item.username || item.author_name);
      const profileUrl = clean(user.profile_url || user.url || item.profile_url || item.url || (username ? (request.target_platform === 'instagram' ? `https://www.instagram.com/${username}/` : `https://www.tiktok.com/@${username}`) : ''));
      const evidenceTitle = clean(user.google_title || item.google_title || user.full_name || user.nickname || username || item.name);
      const inferredCountry = clean(user.country || user.region || item.country_region || inferCountryRegion(user.biography, user.bio, user.google_description, item.google_description, item.description));
      candidates.push(applyMarketGate({
        platform: request.target_platform,
        kol_name: clean(user.full_name || user.nickname || username || item.name),
        profile_url: profileUrl,
        followers: clean(user.follower_count || user.followers || user.followers_count || item.followers || item.follower_count),
        avg_views: clean(user.avg_views || item.avg_views || item.views),
        email: clean(user.email || item.email),
        country_region: inferredCountry,
        matched_keywords: query,
        matched_persona: request.strategy.persona_config?.primary_persona || '',
        representative_video_url: clean(item.video_url || item.post_url),
        representative_video_title: clean(item.title || item.desc || item.description),
        evidence_url: profileUrl,
        evidence_title: evidenceTitle,
        evidence_type: 'profile',
        source_query: query,
        reason: `Matched ${PROVIDER_LABELS[request.search_source] || PROVIDER_LABELS.scrapecreators} search: ${query}`,
        raw_data: item
      }, request));
      if (candidates.length >= maxResults) break;
    }
  }

  if (!candidates.length) {
    throw new Error('ScrapeCreators returned 0 candidates. Try shorter Instagram keywords.');
  }
  return { provider: request.search_source || 'scrapecreators', endpoint: lastEndpoint, candidates: candidates.slice(0, maxResults) };
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
    status: clean(input.status),
    error_message: clean(input.error_message),
    scoring_breakdown: input.scoring_breakdown || {},
    evidence_url: evidenceUrl,
    evidence_title: evidenceTitle,
    evidence_type: evidenceType,
    source_query: clean(input.source_query || request.cycle.keywords),
    discovery_route: clean(input.discovery_route || request.discovery_route),
    source_platform: clean(input.source_platform || request.source_platform),
    target_platform: platform,
    source_agent: clean(input.source_agent || ''),
    raw_data: input.raw_data || input
  };
}

function firstNonEmpty(...values) {
  return values.map(clean).find(Boolean) || '';
}

function primaryPersonaFromStrategy(strategy = {}) {
  const persona = strategy.persona_config || {};
  return firstNonEmpty(
    persona.primary_persona,
    persona.primaryPersona,
    Array.isArray(persona.secondary_personas) ? persona.secondary_personas[0] : '',
    Array.isArray(persona.personas) ? persona.personas[0] : ''
  );
}

function inferPersonaFromEvidence(row = {}, strategy = {}) {
  const configured = primaryPersonaFromStrategy(strategy);
  if (configured) return configured;

  const text = [
    row.source_signal,
    row.source_query,
    row.title,
    row.video_title,
    row.summary,
    row.decision_reason,
    row.content_relevance_score,
    row.evidence_strength_score
  ].map((value) => String(value || '').toLowerCase()).join(' ');

  const scores = {
    competitor: Number(row.competitor_fit) || 0,
    category: Number(row.category_fit) || 0,
    useCase: Number(row.use_case_fit) || 0,
    feature: Number(row.feature_fit) || 0,
    community: Number(row.community_fit) || 0
  };
  const strongest = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (strongest?.[1] >= MIN_RELEVANT_SIGNAL_SCORE) {
    if (strongest[0] === 'competitor') return '竞品评测型 KOL';
    if (strongest[0] === 'category' || strongest[0] === 'feature') return '品类评测型 KOL';
    if (strongest[0] === 'useCase') return '场景体验型 KOL';
    if (strongest[0] === 'community') return '垂直社群型 KOL';
  }

  if (text.includes('competitor')) return '竞品评测型 KOL';
  if (text.includes('review') || text.includes('category') || text.includes('backpack') || text.includes('carrier')) return '品类评测型 KOL';
  if (text.includes('use_case') || text.includes('travel') || text.includes('outdoor')) return '场景体验型 KOL';
  if (text.includes('community') || text.includes('cat')) return '垂直社群型 KOL';
  return '待确认画像';
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
      'SELECT * FROM customers WHERE profile_url = ? OR youtube_url = ? OR instagram_url = ? OR tiktok_url = ? LIMIT 1',
      [candidate.profile_url, candidate.profile_url, candidate.profile_url, candidate.profile_url]
    );
    if (row) return row;
  }
  if (candidate.email) {
    const row = await dbOperations.get('SELECT * FROM customers WHERE email = ? LIMIT 1', [candidate.email]);
    if (row) return row;
  }
  if (candidate.kol_name) {
    return dbOperations.get('SELECT * FROM customers WHERE name = ? LIMIT 1', [candidate.kol_name]);
  }
  return null;
}

async function upsertRawCandidate(candidate, task, cycle, provider) {
  if (!candidate.kol_name && !candidate.profile_url) {
    return { inserted: false, skipped: true, reason: 'Missing kol_name/profile_url' };
  }
  const existing = await rawCandidateExists(candidate, task.strategy_id);
  const desiredStatus = ['ignored', 'error', 'manual_review', 'risk_review'].includes(candidate.status) ? candidate.status : '';
  const master = await masterExists(candidate);
  const globalRisk = master?.cooperation_status === 'do_not_contact';
  const status = desiredStatus || (globalRisk ? 'risk_review' : (master ? 'duplicate' : 'new'));
  const rawData = JSON.stringify({
    provider,
    finder_task_id: task.id,
    search_cycle: cycle.cycle,
    discovery_route: candidate.discovery_route,
    source_platform: candidate.source_platform,
    target_platform: candidate.target_platform,
    global_cooperation_risk: globalRisk ? {
      customer_id: master.id,
      cooperation_status: master.cooperation_status,
      category: master.cooperation_risk_category || '',
      reason: master.cooperation_risk_reason || ''
    } : undefined,
    data: candidate.raw_data
  });
  if (existing) {
    await dbOperations.run(
      `UPDATE raw_candidates SET
       profile_url = COALESCE(NULLIF(profile_url, ''), ?),
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
       discovery_route = COALESCE(NULLIF(discovery_route, ''), ?),
       source_platform = COALESCE(NULLIF(source_platform, ''), ?),
       target_platform = COALESCE(NULLIF(target_platform, ''), ?),
       source_agent = COALESCE(NULLIF(source_agent, ''), ?),
       status = CASE WHEN status IN ('approved', 'duplicate', 'ignored') THEN status WHEN ? <> '' THEN ? WHEN ? = 'risk_review' THEN ? ELSE status END,
       rejection_scope = CASE WHEN ? = 'risk_review' THEN 'global' ELSE rejection_scope END,
       rejection_category = CASE WHEN ? = 'risk_review' THEN ? ELSE rejection_category END,
       rejection_reason = CASE WHEN ? = 'risk_review' THEN ? ELSE rejection_reason END,
       error_message = COALESCE(NULLIF(error_message, ''), ?),
       ai_score = COALESCE(ai_score, ?),
       ai_match_reason = COALESCE(NULLIF(ai_match_reason, ''), ?),
       matched_persona = COALESCE(NULLIF(matched_persona, ''), ?),
       raw_data = ?,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        candidate.profile_url,
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
        candidate.discovery_route,
        candidate.source_platform,
        candidate.target_platform,
        candidate.source_agent || provider,
        desiredStatus,
        desiredStatus,
        status,
        status,
        status,
        status,
        master?.cooperation_risk_category || '',
        status,
        master?.cooperation_risk_reason || '',
        candidate.error_message,
        candidate.ai_score,
        candidate.ai_match_reason,
        candidate.matched_persona,
        rawData,
        existing.id
      ]
    );
    return { inserted: false, duplicate: true, status: existing.status || status };
  }
  const result = await dbOperations.run(
    `INSERT INTO raw_candidates
     (finder_task_id, campaign_id, strategy_id, platform, kol_name, profile_url, video_url, video_title,
      followers, avg_views, email, country_region, matched_keywords, ai_score, ai_match_reason,
      status, source, discovery_route, source_platform, target_platform, source_agent,
      raw_data, error_message, matched_persona, scoring_breakdown,
      evidence_url, evidence_title, evidence_type, source_query, rejection_scope, rejection_category, rejection_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      candidate.discovery_route,
      candidate.source_platform,
      candidate.target_platform,
      candidate.source_agent || provider,
      rawData,
      candidate.error_message,
      candidate.matched_persona,
      JSON.stringify(candidate.scoring_breakdown || {}),
      candidate.evidence_url,
      candidate.evidence_title,
      candidate.evidence_type,
      candidate.source_query,
      status === 'ignored' ? 'project' : status === 'risk_review' ? 'global' : '',
      status === 'risk_review' ? master?.cooperation_risk_category || '' : '',
      status === 'risk_review' ? master?.cooperation_risk_reason || '' : ''
    ]
  );
  return { inserted: true, id: result.id, status };
}

async function runProvider(request, allowFallback) {
  const attempts = [];
  const source = request.search_source;
  const externalAgentRoute = [
    'youtube_to_instagram',
    'google_web_to_instagram',
    'reddit_to_instagram',
    'seed_posts_to_profile',
    'google_web_to_tiktok',
    'youtube_to_tiktok',
    'instagram_to_tiktok',
    'reddit_to_tiktok',
    'spider_web_expansion'
  ].includes(request.discovery_route);
  try {
    if (externalAgentRoute && request.target_platform !== 'youtube') {
      throw new Error(`${PROVIDER_LABELS[request.discovery_route] || request.discovery_route} is an External Agent route. Use the Agent Brief/API import flow; Instagram native search is not used by default.`);
    }
    let maton = null;
    if (source === 'maton_agent' || source === 'google_web') {
      maton = await matonFinderAdapter(request);
    } else if (source === 'youtube_search') {
      maton = await youtubeSearchAdapter(request);
    } else if (source === 'instagram_search' || source === 'tiktok_search') {
      maton = await scrapeCreatorsFinderAdapterV2(request);
    } else {
      throw new Error(`Unsupported search source: ${source}`);
    }
    attempts.push({ search_source: source, provider: maton.provider, ok: true, endpoint: maton.endpoint });
    return { ...maton, attempts };
  } catch (error) {
    attempts.push({ search_source: source, provider: source, ok: false, error: error.message });
    if (!allowFallback || source !== 'maton_agent' || externalAgentRoute) throw Object.assign(new Error(error.message), { attempts });
  }

  try {
    const fallback = request.target_platform === 'youtube'
      ? await youtubeSearchAdapter({ ...request, search_source: 'youtube_search' })
      : await scrapeCreatorsFinderAdapterV2({
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

function toMysqlDatetime(value) {
  if (!value) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

async function updateTask(id, patch) {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  const assignments = fields.map((field) => `${field} = ?`).join(', ');
  const values = fields.map((field) => {
    if (['started_at', 'finished_at', 'created_at', 'updated_at'].includes(field)) {
      return toMysqlDatetime(patch[field]);
    }
    return patch[field];
  });
  await dbOperations.run(
    `UPDATE finder_tasks SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [...values, id]
  );
}

function sourceSignalForCycle(cycle = {}) {
  const cycleId = clean(cycle.cycle).toUpperCase();
  if (cycle.source_signal) return clean(cycle.source_signal);
  if (cycleId === 'C1') return 'competitor';
  if (cycleId === 'C2') return 'category';
  if (cycleId === 'C3') return 'use_case';
  if (cycleId === 'C4') return 'feature';
  if (cycleId === 'C5') return 'community';
  if (cycleId === 'C6') return 'native_platform';
  if (cycleId === 'C7') return 'seed_graph';
  return 'native_platform';
}

const SNAPSHOT_TTL_DAYS = 30;

async function getLatestSnapshot(videoSourceId) {
  return dbOperations.get(
    'SELECT * FROM video_snapshots WHERE video_source_id = ? ORDER BY snapshot_at DESC LIMIT 1',
    [videoSourceId]
  );
}

function isSnapshotStale(video, snapshot) {
  if (!snapshot) return true;
  if (!video.last_crawled_at) return true;
  const ttl = Date.now() - SNAPSHOT_TTL_DAYS * 24 * 60 * 60 * 1000;
  return new Date(video.last_crawled_at).getTime() < ttl;
}

async function ensureVideoSnapshot(video) {
  const snapshot = await getLatestSnapshot(video.id);
  if (!isSnapshotStale(video, snapshot)) {
    return { snapshot, crawled: false };
  }
  try {
    const { crawlVideo } = require('./videos');
    await crawlVideo(video.id);
    const fresh = await getLatestSnapshot(video.id);
    return { snapshot: fresh, crawled: true };
  } catch (error) {
    await dbOperations.run(
      'UPDATE video_sources SET crawl_status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['failed', error.message, video.id]
    );
    return { snapshot, crawled: false, error: error.message };
  }
}

async function upsertVideoSourceForEvidence(task, evidence) {
  const { normalizeVideoUrl } = require('../utils/videoUrlNormalizer');
  const sourceUrl = evidence.video_url;
  const normalized = normalizeVideoUrl(sourceUrl);

  let video = await dbOperations.get(
    'SELECT * FROM video_sources WHERE canonical_url_hash = ?',
    [normalized.canonicalUrlHash]
  );

  if (video) {
    await dbOperations.run(
      `UPDATE video_sources SET
        platform = COALESCE(NULLIF(?, ''), platform),
        platform_video_id = COALESCE(NULLIF(?, ''), platform_video_id),
        source_url = COALESCE(NULLIF(?, ''), source_url),
        canonical_url = COALESCE(NULLIF(?, ''), canonical_url),
        title = COALESCE(NULLIF(?, ''), title),
        kol_name = COALESCE(NULLIF(?, ''), kol_name),
        author_name = COALESCE(NULLIF(?, ''), author_name),
        author_profile_url = COALESCE(NULLIF(?, ''), author_profile_url),
        notes = COALESCE(NULLIF(notes, ''), ?),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        normalized.platform,
        normalized.platformVideoId || evidence.platform_video_id || '',
        sourceUrl,
        normalized.canonicalUrl,
        evidence.title || '',
        evidence.author_name || '',
        evidence.author_name || '',
        evidence.author_profile_url || '',
        `Finder video evidence task ${task.id}`,
        video.id
      ]
    );
    video = await dbOperations.get('SELECT * FROM video_sources WHERE id = ?', [video.id]);
  } else {
    const result = await dbOperations.run(
      `INSERT INTO video_sources
       (platform, platform_video_id, source_url, canonical_url, canonical_url_hash,
        title, kol_name, author_name, author_profile_url, notes, status, crawl_status, analysis_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalized.platform,
        normalized.platformVideoId || evidence.platform_video_id || '',
        sourceUrl,
        normalized.canonicalUrl,
        normalized.canonicalUrlHash,
        evidence.title || '',
        evidence.author_name || '',
        evidence.author_name || '',
        evidence.author_profile_url || '',
        `Finder video evidence task ${task.id}`,
        'pending',
        'pending',
        'not_analyzed'
      ]
    );
    video = await dbOperations.get('SELECT * FROM video_sources WHERE id = ?', [result.id]);
  }

  // Link video to the task's campaign.
  const campaignId = task.campaign_id || evidence.campaign_id || null;
  if (campaignId) {
    await dbOperations.run(
      `INSERT INTO campaign_videos (campaign_id, video_source_id, added_reason, added_by_finder_task_id)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`,
      [campaignId, video.id, 'finder', task.id]
    );
  }

  return video;
}

function normalizeEvidenceInput(input = {}, task = {}, defaults = {}) {
  const videoUrl = clean(input.video_url || input.videoUrl || input.source_url || input.url || input.evidence_url || input.representative_video_url);
  const targetPlatform = clean(input.target_platform || defaults.target_platform || task.platform || detectPlatformFromUrl(videoUrl)).split(',')[0];
  const evidencePlatform = clean(input.evidence_platform || defaults.evidence_platform || targetPlatform || detectPlatformFromUrl(videoUrl));
  return {
    finder_task_id: task.id,
    strategy_id: task.strategy_id,
    campaign_id: task.campaign_id,
    target_platform: targetPlatform,
    evidence_platform: evidencePlatform,
    discovery_scope: clean(input.discovery_scope || defaults.discovery_scope || 'target_platform_only'),
    discovery_route: clean(input.discovery_route || defaults.discovery_route || 'target_platform_first'),
    video_url: videoUrl,
    platform_video_id: clean(input.platform_video_id || input.platformVideoId),
    title: clean(input.title || input.video_title || input.representative_video_title || input.evidence_title),
    author_name: clean(input.author_name || input.kol_name || input.channel_title || input.creator_name || input.username || input.handle),
    author_profile_url: clean(input.author_profile_url || input.profile_url || input.channel_url),
    source_signal: clean(input.source_signal || defaults.source_signal || 'native_platform'),
    source_query: clean(input.source_query || input.matched_keywords || defaults.source_query),
    evidence_reason: clean(input.evidence_reason || input.reason || input.ai_match_reason),
    raw_data: input.raw_data || input
  };
}

async function saveVideoEvidence(task, input, defaults = {}) {
  const evidence = normalizeEvidenceInput(input, task, defaults);
  if (!evidence.video_url) throw new Error('video_url is required');
  if (!isVideoEvidenceUrl(evidence.video_url)) throw new Error(`Not a supported video evidence URL: ${evidence.video_url}`);
  if (!TARGET_PLATFORMS.includes(evidence.target_platform)) throw new Error(`Unsupported target platform: ${evidence.target_platform}`);
  if (evidence.evidence_platform !== evidence.target_platform && evidence.discovery_scope === 'target_platform_only') {
    throw new Error('MVP requires evidence_platform to equal target_platform');
  }

  const video = await upsertVideoSourceForEvidence(task, evidence);
  await ensureVideoSnapshot(video);
  const existing = await dbOperations.get(
    'SELECT * FROM finder_video_evidence WHERE finder_task_id = ? AND video_source_id = ? LIMIT 1',
    [task.id, video.id]
  );
  if (existing) {
    await dbOperations.run(
      `UPDATE finder_video_evidence SET
       video_source_id = ?, target_platform = ?, evidence_platform = ?, discovery_scope = ?, discovery_route = ?,
       source_signal = COALESCE(NULLIF(?, ''), source_signal),
       source_query = COALESCE(NULLIF(?, ''), source_query),
       evidence_reason = COALESCE(NULLIF(?, ''), evidence_reason),
       raw_data = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        video.id,
        evidence.target_platform,
        evidence.evidence_platform,
        evidence.discovery_scope,
        evidence.discovery_route,
        evidence.source_signal,
        evidence.source_query,
        evidence.evidence_reason,
        JSON.stringify(evidence.raw_data || {}),
        existing.id
      ]
    );
    return { row: await dbOperations.get('SELECT * FROM finder_video_evidence WHERE id = ?', [existing.id]), inserted: false };
  }
  const result = await dbOperations.run(
    `INSERT INTO finder_video_evidence
     (finder_task_id, strategy_id, campaign_id, video_source_id, target_platform, evidence_platform,
      discovery_scope, discovery_route, source_signal, source_query, evidence_reason, status, raw_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      task.strategy_id,
      task.campaign_id,
      video.id,
      evidence.target_platform,
      evidence.evidence_platform,
      evidence.discovery_scope,
      evidence.discovery_route,
      evidence.source_signal,
      evidence.source_query,
      evidence.evidence_reason,
      'discovered',
      JSON.stringify(evidence.raw_data || {})
    ]
  );
  return { row: await dbOperations.get('SELECT * FROM finder_video_evidence WHERE id = ?', [result.id]), inserted: true };
}

async function processVideoEvidenceTask(taskId, options = {}) {
  const task = await dbOperations.get('SELECT * FROM finder_tasks WHERE id = ?', [taskId]);
  if (!task) return;
  const strategy = await getReadyStrategy(task.strategy_id);
  const cycles = parseJson(task.search_cycles, DEFAULT_SEARCH_CYCLES);
  const rawRequest = parseJson(task.raw_request, {});
  const storedTargets = parseJson(task.target_platforms, parseList(task.platform));
  const targetPlatforms = (rawRequest.target_platforms?.length ? rawRequest.target_platforms : options.targetPlatforms?.length ? options.targetPlatforms : storedTargets).filter((p) => TARGET_PLATFORMS.includes(p));
  const targets = targetPlatforms.length ? targetPlatforms : ['youtube'];
  const allAttempts = [];
  const responseSummary = [];
  let insertedCount = 0;
  let failedCount = 0;
  let completedCycles = 0;

  await updateTask(taskId, { status: 'running', started_at: new Date().toISOString(), total_cycles: cycles.length, source_agent: 'video_evidence_finder' });

  for (const cycle of cycles) {
    if (cancelledTasks.has(taskId)) {
      await updateTask(taskId, { status: 'cancelled', finished_at: new Date().toISOString(), provider_attempts: JSON.stringify(allAttempts), raw_response_summary: JSON.stringify(responseSummary) });
      cancelledTasks.delete(taskId);
      return;
    }
    await updateTask(taskId, { current_cycle: sourceSignalForCycle(cycle) });
    for (const targetPlatform of targets) {
      const searchSource = await preferredSearchSourceForTargetPlatform(targetPlatform);
      const request = buildCycleRequest(strategy, cycle, searchSource, targetPlatform, options.limit || 10, 'target_platform_first', targetPlatform);
      try {
        const result = await runProvider(request, options.allowFallback !== false);
        allAttempts.push(...result.attempts.map((attempt) => ({ ...attempt, source_signal: sourceSignalForCycle(cycle), discovery_route: 'target_platform_first', source_platform: targetPlatform, target_platform: targetPlatform })));
        let inserted = 0;
        let skipped = 0;
        for (const raw of result.candidates.slice(0, options.limit || 10)) {
          const normalized = normalizeCandidate(raw, request, result.provider);
          const videoUrl = clean(normalized.video_url || normalized.evidence_url);
          if (!isVideoEvidenceUrl(videoUrl)) {
            skipped += 1;
            continue;
          }
          const saved = await saveVideoEvidence(task, {
            ...normalized,
            video_url: videoUrl,
            title: normalized.video_title || normalized.evidence_title,
            author_name: normalized.kol_name,
            author_profile_url: normalized.profile_url,
            evidence_reason: normalized.ai_match_reason,
            raw_data: { provider: result.provider, data: raw }
          }, {
            target_platform: targetPlatform,
            evidence_platform: targetPlatform,
            source_signal: sourceSignalForCycle(cycle),
            source_query: normalized.source_query || keywordString(cycle, strategy),
            discovery_scope: 'target_platform_only',
            discovery_route: 'target_platform_first'
          });
          if (saved.inserted) inserted += 1;
          else skipped += 1;
        }
        insertedCount += inserted;
        responseSummary.push({ stage: 'video_evidence_discovery', source_signal: sourceSignalForCycle(cycle), target_platform: targetPlatform, provider: result.provider, returned: result.candidates.length, inserted, skipped });
      } catch (error) {
        failedCount += 1;
        allAttempts.push(...(error.attempts || [{ provider: 'unknown', ok: false, error: error.message }]).map((attempt) => ({ ...attempt, source_signal: sourceSignalForCycle(cycle), discovery_route: 'target_platform_first', source_platform: targetPlatform, target_platform: targetPlatform })));
        responseSummary.push({ stage: 'video_evidence_discovery', source_signal: sourceSignalForCycle(cycle), target_platform: targetPlatform, error: error.message });
      }
    }
    completedCycles += 1;
    await updateTask(taskId, {
      completed_cycles: completedCycles,
      success_count: insertedCount,
      failed_count: failedCount,
      result_count: insertedCount,
      provider_attempts: JSON.stringify(allAttempts),
      raw_response_summary: JSON.stringify(responseSummary)
    });
  }

  const status = insertedCount > 0 && failedCount > 0 ? 'partial_failed' : insertedCount > 0 ? 'success' : 'failed';
  await updateTask(taskId, {
    status,
    error_message: status === 'failed' ? 'No video evidence was inserted. Import video links manually or check provider attempts.' : '',
    finished_at: new Date().toISOString(),
    provider_attempts: JSON.stringify(allAttempts),
    raw_response_summary: JSON.stringify(responseSummary)
  });
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
    const pairs = await sourceTargetPairs(cycle, strategy, options.searchSources || [], options.targetPlatforms || [], options.discoveryRoutes || []);
    await updateTask(taskId, { current_cycle: cycle.cycle });

    for (const pair of pairs) {
      const { searchSource, targetPlatform, discoveryRoute, sourcePlatform } = pair;
      const request = buildCycleRequest(strategy, cycle, searchSource, targetPlatform, options.limit || 10, discoveryRoute, sourcePlatform);
      try {
        const result = await runProvider(request, options.allowFallback !== false);
        allAttempts.push(...result.attempts.map((attempt) => ({ ...attempt, cycle: cycle.cycle, discovery_route: discoveryRoute, source_platform: sourcePlatform, search_source: searchSource, target_platform: targetPlatform })));
        const seen = new Set();
        let inserted = 0;
        let skipped = 0;
        for (const raw of result.candidates.slice(0, options.limit || 10)) {
          const normalized = applyFinderGates(normalizeCandidate(raw, request, result.provider), request);
          const key = profileKey(normalized);
          if (seen.has(key)) {
            skipped += 1;
            continue;
          }
          seen.add(key);
          const saved = await upsertRawCandidate(normalized, task, cycle, result.provider);
          if (saved.inserted && saved.status !== 'ignored') inserted += 1;
          if (saved.skipped || saved.status === 'ignored') skipped += 1;
        }
        successCount += inserted;
        responseSummary.push({ cycle: cycle.cycle, discovery_route: discoveryRoute, source_platform: sourcePlatform, search_source: searchSource, target_platform: targetPlatform, provider: result.provider, returned: result.candidates.length, inserted, skipped });
      } catch (error) {
        failedCount += 1;
        allAttempts.push(...(error.attempts || [{ provider: 'unknown', ok: false, error: error.message }]).map((attempt) => ({ ...attempt, cycle: cycle.cycle, discovery_route: discoveryRoute, source_platform: sourcePlatform, search_source: searchSource, target_platform: targetPlatform })));
        responseSummary.push({ cycle: cycle.cycle, discovery_route: discoveryRoute, source_platform: sourcePlatform, search_source: searchSource, target_platform: targetPlatform, error: error.message });
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
    const { campaign_id, strategy_id, status } = req.query;
    let sql = `
      SELECT ft.*, ks.name as strategy_name, c.name as campaign_name
      FROM finder_tasks ft
      LEFT JOIN kol_strategies ks ON ks.id = ft.strategy_id
      LEFT JOIN campaigns c ON c.id = ft.campaign_id
      WHERE 1=1
    `;
    const params = [];
    if (campaign_id) {
      sql += ' AND ft.campaign_id = ?';
      params.push(campaign_id);
    }
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
      discovery_routes: parseJson(row.discovery_routes, parseList(row.discovery_routes)),
      target_platforms: parseJson(row.target_platforms, parseList(row.target_platforms || row.platform)),
      search_cycles: parseJson(row.search_cycles, []),
      provider_attempts: parseJson(row.provider_attempts, []),
      raw_response_summary: parseJson(row.raw_response_summary, [])
    })) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/video-evidence/import', async (req, res) => {
  try {
    const task = await dbOperations.get('SELECT * FROM finder_tasks WHERE id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ success: false, error: 'Finder task not found' });
    const rawRequest = parseJson(task.raw_request, {});
    const targetPlatforms = parseJson(task.target_platforms, parseList(task.platform)).filter((p) => TARGET_PLATFORMS.includes(p));
    const defaultTarget = clean(req.body?.target_platform || req.body?.targetPlatform || targetPlatforms[0] || rawRequest.target_platforms?.[0] || task.platform).split(',')[0] || 'youtube';
    const rows = Array.isArray(req.body?.video_evidence)
      ? req.body.video_evidence
      : Array.isArray(req.body?.videos)
        ? req.body.videos
        : Array.isArray(req.body?.evidence)
          ? req.body.evidence
          : parseList(req.body?.video_urls || req.body?.videoUrls || req.body?.source_urls || req.body?.sourceUrls || req.body?.text).map((url) => ({ video_url: url }));
    if (!rows.length) return res.status(400).json({ success: false, error: 'Please provide videos or video_urls' });

    const results = [];
    for (const row of rows) {
      try {
        const videoUrl = clean(row.video_url || row.source_url || row.url);
        const targetPlatform = clean(row.target_platform || defaultTarget || detectPlatformFromUrl(videoUrl));
        const saved = await saveVideoEvidence(task, row, {
          target_platform: targetPlatform,
          evidence_platform: targetPlatform,
          source_signal: clean(row.source_signal || 'native_platform'),
          source_query: clean(row.source_query || req.body?.source_query || ''),
          discovery_scope: 'target_platform_only',
          discovery_route: 'target_platform_first'
        });
        results.push({ success: true, inserted: saved.inserted, data: saved.row });
      } catch (error) {
        results.push({ success: false, error: error.message, input: row });
      }
    }

    const inserted = results.filter((item) => item.success && item.inserted).length;
    const updated = results.filter((item) => item.success && !item.inserted).length;
    await updateTask(task.id, {
      success_count: Number(task.success_count || 0) + inserted,
      result_count: Number(task.result_count || 0) + inserted,
      raw_response_summary: JSON.stringify({ stage: 'manual_video_evidence_import', inserted, updated, failed: results.filter((item) => !item.success).length })
    });
    res.json({ success: true, data: { inserted, updated, failed: results.filter((item) => !item.success).length, results } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.get('/:id/video-evidence', async (req, res) => {
  try {
    const task = await dbOperations.get('SELECT * FROM finder_tasks WHERE id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ success: false, error: 'Finder task not found' });
    const strategy = await getReadyStrategy(task.strategy_id);
    const rows = await dbOperations.query(`
      SELECT fve.*, vs.source_url as video_url, vs.title, vs.author_name, vs.kol_name, vs.author_profile_url,
        vs.crawl_status, vs.analysis_status as video_analysis_status,
        snap.play_count, snap.like_count, snap.comment_count, snap.primary_exposure_count, snap.exposure_metric_type, snap.snapshot_at,
        vai.status as finder_analysis_status,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.content_relevance_score')) as content_relevance_score,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.creator_fit_score')) as creator_fit_score,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.evidence_strength_score')) as evidence_strength_score,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.signal_scores.competitor_fit')) as competitor_fit,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.signal_scores.category_fit')) as category_fit,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.signal_scores.use_case_fit')) as use_case_fit,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.signal_scores.feature_fit')) as feature_fit,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.signal_scores.community_fit')) as community_fit,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.brand_safety_risk')) as brand_safety_risk,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.kol_candidate_potential_score')) as kol_candidate_potential_score,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.recommendation')) as recommendation,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.candidate_decision.candidate_priority_score')) as candidate_priority_score,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.candidate_decision.recommended_status')) as recommended_status,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.candidate_decision.priority_level')) as priority_level,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.candidate_decision.enter_raw_candidates')) as enter_raw_candidates,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.candidate_decision.reason')) as decision_reason,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.risk.risk_level')) as risk_level,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.risk.risk_notes')) as risk_notes,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.hard_filter.hard_filter_notes')) as hard_filter_notes,
        vai.extra_data as analysis_result,
        vai.summary as finder_summary,
        vai.updated_at as finder_analysis_updated_at
      FROM finder_video_evidence fve
      LEFT JOIN video_sources vs ON vs.id = fve.video_source_id
      LEFT JOIN video_snapshots snap ON snap.id = (
        SELECT id FROM video_snapshots WHERE video_source_id = fve.video_source_id ORDER BY snapshot_at DESC LIMIT 1
      )
      LEFT JOIN video_ai_analysis_results vai ON vai.analysis_scope_id = fve.id AND vai.analysis_type = 'finder_evidence'
      WHERE fve.finder_task_id = ?
      ORDER BY fve.created_at DESC, fve.id DESC
    `, [task.id]);
    res.json({ success: true, data: rows.map((row) => ({
      ...row,
      raw_data: parseJson(row.raw_data, {})
    })) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/evidence-analysis', async (req, res) => {
  try {
    const task = await dbOperations.get('SELECT * FROM finder_tasks WHERE id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ success: false, error: 'Finder task not found' });
    const strategy = await getReadyStrategy(task.strategy_id);
    const ids = (req.body?.evidence_ids || req.body?.evidenceIds || []).map(Number).filter(Boolean);
    let sql = `
      SELECT fve.*, vs.source_url as video_url, vs.title as video_title, vs.author_name as video_author_name,
        vs.author_profile_url, vs.kol_name, vs.published_at, vs.content_type
      FROM finder_video_evidence fve
      LEFT JOIN video_sources vs ON vs.id = fve.video_source_id
      WHERE fve.finder_task_id = ?
    `;
    const params = [task.id];
    if (ids.length) {
      sql += ` AND fve.id IN (${ids.map(() => '?').join(',')})`;
      params.push(...ids);
    }
    sql += ' ORDER BY fve.id ASC';
    const evidenceRows = await dbOperations.query(sql, params);
    if (!evidenceRows.length) return res.status(400).json({ success: false, error: 'No video evidence found for analysis' });

    let successCount = 0;
    let failedCount = 0;
    const results = [];
    for (const evidence of evidenceRows) {
      try {
        await dbOperations.run(
          `INSERT INTO video_ai_analysis_results
           (video_source_id, analysis_type, analysis_scope_id, status)
           VALUES (?, 'finder_evidence', ?, ?)
           ON DUPLICATE KEY UPDATE status = VALUES(status), error_message = NULL, updated_at = CURRENT_TIMESTAMP`,
          [evidence.video_source_id, evidence.id, 'running']
        );
        const video = await dbOperations.get('SELECT * FROM video_sources WHERE id = ?', [evidence.video_source_id]);
        const snapshot = await dbOperations.get('SELECT * FROM video_snapshots WHERE video_source_id = ? ORDER BY snapshot_at DESC LIMIT 1', [evidence.video_source_id]);
        const ai = await runFinderEvidenceAnalysis(video || {}, snapshot, evidence, strategy);
        const parsed = ai.parsed || {};
        const normalized = normalizeFinderEvidenceResult(parsed);
        const extraData = JSON.stringify({
          finder_task_id: task.id,
          ...normalized
        });
        await dbOperations.run(
          `INSERT INTO video_ai_analysis_results
           (video_source_id, analysis_type, analysis_scope_id, status, model_name, score, summary,
            raw_result, extra_data, final_prompt)
           VALUES (?, 'finder_evidence', ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
            status = VALUES(status), model_name = VALUES(model_name), score = VALUES(score),
            summary = VALUES(summary), raw_result = VALUES(raw_result), extra_data = VALUES(extra_data),
            final_prompt = VALUES(final_prompt), error_message = NULL, updated_at = CURRENT_TIMESTAMP`,
          [
            evidence.video_source_id,
            evidence.id,
            'success',
            ai.model,
            normalized.candidate_decision.candidate_priority_score,
            normalized.candidate_decision.reason || normalized.hard_filter.hard_filter_notes,
            JSON.stringify(ai.raw || parsed),
            extraData,
            ai.finalPrompt
          ]
        );
        await dbOperations.run('UPDATE finder_video_evidence SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['analyzed', evidence.id]);
        successCount += 1;
        results.push({ evidence_id: evidence.id, success: true });
      } catch (error) {
        failedCount += 1;
        await dbOperations.run(
          `INSERT INTO video_ai_analysis_results
           (video_source_id, analysis_type, analysis_scope_id, status, error_message)
           VALUES (?, 'finder_evidence', ?, ?, ?)
           ON DUPLICATE KEY UPDATE status = VALUES(status), error_message = VALUES(error_message), updated_at = CURRENT_TIMESTAMP`,
          [evidence.video_source_id, evidence.id, 'failed', error.message]
        );
        results.push({ evidence_id: evidence.id, success: false, error: error.message });
      }
    }
    res.json({ success: true, data: { success_count: successCount, failed_count: failedCount, results } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/:id/generate-candidates-from-evidence', async (req, res) => {
  try {
    const task = await dbOperations.get('SELECT * FROM finder_tasks WHERE id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ success: false, error: 'Finder task not found' });
    const strategy = await getReadyStrategy(task.strategy_id);
    const rows = await dbOperations.query(`
      SELECT fve.*, vai.id as analysis_id,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.content_relevance_score')) as content_relevance_score,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.creator_fit_score')) as creator_fit_score,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.evidence_strength_score')) as evidence_strength_score,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.signal_scores.competitor_fit')) as competitor_fit,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.signal_scores.category_fit')) as category_fit,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.signal_scores.use_case_fit')) as use_case_fit,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.signal_scores.feature_fit')) as feature_fit,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.signal_scores.community_fit')) as community_fit,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.brand_safety_risk')) as brand_safety_risk,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.kol_candidate_potential_score')) as kol_candidate_potential_score,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.recommendation')) as recommendation,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.candidate_decision.enter_raw_candidates')) as enter_raw_candidates,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.candidate_decision.candidate_priority_score')) as candidate_priority_score,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.candidate_decision.recommended_status')) as recommended_status,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.candidate_decision.reason')) as decision_reason,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.candidate_decision.priority_level')) as priority_level,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.risk.risk_level')) as risk_level,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.risk.risk_notes')) as risk_notes,
        JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.hard_filter.hard_filter_notes')) as hard_filter_notes,
        JSON_UNQUOTE(JSON_EXTRACT(fve.raw_data, '$.data.followers')) as followers,
        JSON_UNQUOTE(JSON_EXTRACT(fve.raw_data, '$.data.country_region')) as country_region,
        vai.summary,
        vs.kol_name, vs.author_name, vs.author_name as video_author_name, vs.author_profile_url,
        vs.title, vs.title as video_title, vs.source_url as video_url
      FROM finder_video_evidence fve
      JOIN video_ai_analysis_results vai ON vai.analysis_scope_id = fve.id AND vai.analysis_type = 'finder_evidence'
      LEFT JOIN video_sources vs ON vs.id = fve.video_source_id
      WHERE fve.finder_task_id = ?
        AND vai.status = 'success'
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.hard_filter.passed')), 'true') = 'true'
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.hard_filter.market_language_match')), 'certain') != 'mismatch'
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.risk.risk_level')), 'low') != 'high'
        AND (
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.signal_scores.competitor_fit')), 0) >= ${MIN_RELEVANT_SIGNAL_SCORE}
          OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.signal_scores.category_fit')), 0) >= ${MIN_RELEVANT_SIGNAL_SCORE}
          OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.signal_scores.use_case_fit')), 0) >= ${MIN_RELEVANT_SIGNAL_SCORE}
          OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.signal_scores.feature_fit')), 0) >= ${MIN_RELEVANT_SIGNAL_SCORE}
          OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.signal_scores.community_fit')), 0) >= ${MIN_RELEVANT_SIGNAL_SCORE}
          OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.evidence_strength_score')), 0) >= ${MIN_RELEVANT_SIGNAL_SCORE}
        )
      ORDER BY COALESCE(JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.candidate_decision.candidate_priority_score')), JSON_UNQUOTE(JSON_EXTRACT(vai.extra_data, '$.kol_candidate_potential_score')), 0) DESC, fve.id ASC
    `, [task.id]);
    const groups = new Map();
    for (const row of rows) {
      const authorName = clean(row.author_name || row.video_author_name || row.kol_name);
      if (!authorName) continue;
      if (!clean(row.author_profile_url) && !clean(row.video_url)) continue;
      const key = clean(row.author_profile_url)
        ? `profile:${clean(row.author_profile_url).toLowerCase().replace(/\/$/, '')}`
        : `author:${row.evidence_platform}:${authorName.toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const inserted = [];
    const skipped = [];
    for (const evidenceGroup of groups.values()) {
      const sorted = evidenceGroup.sort((a, b) => Number(b.candidate_priority_score || 0) - Number(a.candidate_priority_score || 0));
      const best = sorted[0];
      const averageScore = Math.round(sorted.reduce((sum, item) => sum + Number(item.candidate_priority_score || 0), 0) / sorted.length);
      const recommendedStatus = clean(best.recommended_status) || 'manual_review';
      const matchedPersona = inferPersonaFromEvidence(best, strategy);
      const candidate = {
        platform: best.target_platform,
        target_platform: best.target_platform,
        source_platform: best.evidence_platform,
        discovery_route: 'target_platform_first',
        source_agent: 'video_evidence_finder',
        kol_name: clean(best.author_name || best.video_author_name || best.kol_name),
        profile_url: clean(best.author_profile_url),
        video_url: clean(best.video_url),
        video_title: clean(best.title || best.video_title),
        evidence_url: clean(best.video_url),
        evidence_title: clean(best.title || best.video_title),
        evidence_type: 'video',
        source_query: clean(best.source_query),
        status: recommendedStatus,
        followers: clean(best.followers),
        avg_views: '',
        email: '',
        country_region: clean(best.country_region),
        error_message: '',
        rejection_scope: '',
        rejection_category: '',
        rejection_reason: '',
        matched_keywords: [...new Set(sorted.map((item) => clean(item.source_query)).filter(Boolean))].join(', '),
        matched_persona: matchedPersona,
        ai_score: clampScore(best.candidate_priority_score),
        ai_match_reason: clean(best.decision_reason || best.summary) || `硬条件通过，最高信号 ${best.content_relevance_score || 0} 分，风险等级 ${best.risk_level || best.brand_safety_risk || 'low'}，建议人工审核。`,
        scoring_breakdown: {
          best_score: clampScore(best.candidate_priority_score),
          average_score: averageScore,
          evidence_count: sorted.length,
          content_relevance_score: best.content_relevance_score,
          creator_fit_score: best.creator_fit_score,
          evidence_strength_score: best.evidence_strength_score,
          brand_safety_risk: best.risk_level || best.brand_safety_risk,
          risk_notes: best.risk_notes || ''
        },
        raw_data: {
          evidence_ids: sorted.map((item) => item.id),
          analysis_ids: sorted.map((item) => item.analysis_id),
          video_source_ids: sorted.map((item) => item.video_source_id),
          average_score: averageScore,
          evidence: sorted.map((item) => ({
            video_url: item.video_url,
            title: item.title,
            source_signal: item.source_signal,
            source_query: item.source_query,
            score: item.candidate_priority_score,
            summary: item.summary,
            risk: item.risk_level || item.brand_safety_risk
          }))
        }
      };
      const saved = await upsertRawCandidate(candidate, task, { cycle: 'video_evidence', name: 'Video Evidence Finder' }, 'video_evidence_finder');
      if (saved.inserted) inserted.push(saved);
      else skipped.push(saved);
    }
    await updateTask(task.id, {
      result_count: Number(task.result_count || 0) + inserted.length,
      raw_response_summary: JSON.stringify({ stage: 'generate_candidates_from_evidence', inserted: inserted.length, skipped: skipped.length })
    });
    res.json({ success: true, data: { inserted_count: inserted.length, skipped_count: skipped.length, inserted, skipped } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.get('/:id/subtasks', async (req, res) => {
  // V2: finder_subtasks removed per DEVELOPMENT_PLAN_V2.
  res.json({ success: true, data: [] });
});

router.post('/:id/subtasks/generate', async (req, res) => {
  // V2: finder_subtasks removed per DEVELOPMENT_PLAN_V2. Use video evidence flow instead.
  return res.status(410).json({ success: false, error: 'Subtask generation is removed in V2. Use the video evidence finder flow instead.' });
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
      discovery_routes: parseJson(row.discovery_routes, parseList(row.discovery_routes)),
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
    const executionMode = clean(body.execution_mode || body.executionMode || 'system_provider');
    const targetPlatforms = (body.target_platforms || body.platforms || []).filter((p) => TARGET_PLATFORMS.includes(p));
    const searchIntensity = normalizeSearchIntensity(body.search_intensity || body.searchIntensity);
    const explicitCycleIds = parseList(body.cycles || body.search_cycles || body.searchCycles);
    const cyclesSource = clean(body.cycles_source || body.cyclesSource);
    const hasManualCycles = explicitCycleIds.length > 0 && cyclesSource !== 'intensity';
    const requestedTargets = targetPlatforms.length
      ? targetPlatforms
      : [...new Set((strategy.search_strategy || DEFAULT_SEARCH_CYCLES).flatMap((cycle) => targetPlatformsForCycle(cycle, strategy)))];
    const requestedCycles = hasManualCycles
      ? explicitCycleIds
      : executionMode === 'video_evidence_finder'
        ? ['C2', 'C3', 'C6']
        : recommendedCycleIdsForTargets(requestedTargets, searchIntensity);
    const videoEvidenceSearchSources = executionMode === 'video_evidence_finder'
      ? await preferredSearchSourcesForTargetPlatforms(requestedTargets)
      : [];
    const fullStrategyCycles = (strategy.search_strategy || DEFAULT_SEARCH_CYCLES)
      .map((cycle) => ({ ...cycle, target_count: Math.min(Number(body.limit_per_platform || cycle.target_count || 10), 50) }));
    const cycles = fullStrategyCycles
      .filter((cycle) => requestedCycles.includes(cycle.cycle))
      .map((cycle) => ({ ...cycle }));
    if (!cycles.length) return res.status(400).json({ success: false, error: 'Please select at least one search cycle' });
    const searchSources = (body.search_sources || []).filter((source) => SEARCH_SOURCES.includes(source));
    const discoveryRoutes = (body.discovery_routes || body.discoveryRoutes || []).filter((route) => route !== 'cycle_multi_route' && DISCOVERY_ROUTES.includes(route));
    const normalizedCycles = cycles.map((cycle) => ({
      ...cycle,
      discovery_routes: discoveryRoutes.length ? discoveryRoutes : discoveryRoutesForCycle(cycle, strategy, [], targetPlatforms),
      search_sources: videoEvidenceSearchSources.length ? videoEvidenceSearchSources : searchSources.length ? searchSources : searchSourcesForCycle(cycle),
      target_platforms: targetPlatforms.length ? targetPlatforms : targetPlatformsForCycle(cycle, strategy)
    }));
    const rawRequest = {
      strategy_id: strategy.id,
      execution_mode: executionMode,
      subtask_mode: clean(body.subtask_mode || body.subtaskMode || 'cycle'),
      search_intensity: searchIntensity,
      cycles_source: hasManualCycles ? 'manual' : 'intensity',
      cycles: normalizedCycles.map((c) => c.cycle),
      discovery_routes: discoveryRoutes,
      search_sources: videoEvidenceSearchSources.length ? videoEvidenceSearchSources : searchSources,
      target_platforms: targetPlatforms.length ? targetPlatforms : [...new Set(normalizedCycles.flatMap((cycle) => cycle.target_platforms || []))],
      discovery_scope: executionMode === 'video_evidence_finder' ? 'target_platform_only' : clean(body.discovery_scope || body.discoveryScope || ''),
      discovery_route: executionMode === 'video_evidence_finder' ? 'target_platform_first' : '',
      allow_cross_platform_evidence: executionMode === 'video_evidence_finder' ? false : Boolean(body.allow_cross_platform_evidence || body.allowCrossPlatformEvidence),
      seed_urls: parseList(body.seed_urls || body.seedUrls),
      limit_per_platform: Number(body.limit_per_platform || 10),
      allow_fallback: body.allow_fallback !== false
    };
    const result = await dbOperations.run(
      `INSERT INTO finder_tasks
       (campaign_id, strategy_id, name, platform, keywords, status, search_sources, discovery_routes, target_platforms, raw_request, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        strategy.campaign_id,
        strategy.id,
        `${strategy.name} Finder ${new Date().toLocaleString()}`,
        (targetPlatforms.length ? targetPlatforms : [...new Set(normalizedCycles.flatMap((cycle) => cycle.target_platforms || []))]).join(','),
        normalizedCycles.map((cycle) => keywordString(cycle, strategy)).join(' | '),
        executionMode === 'video_evidence_finder' ? 'draft' : 'draft',
        JSON.stringify(searchSources.length ? searchSources : [...new Set(normalizedCycles.flatMap((cycle) => cycle.search_sources || []))]),
        JSON.stringify(executionMode === 'video_evidence_finder' ? ['target_platform_first'] : (discoveryRoutes.length ? discoveryRoutes : [...new Set(normalizedCycles.flatMap((cycle) => cycle.discovery_routes || []))])),
        JSON.stringify(targetPlatforms.length ? targetPlatforms : [...new Set(normalizedCycles.flatMap((cycle) => cycle.target_platforms || []))]),
        JSON.stringify(rawRequest),
        body.notes || ''
      ]
    );
    const task = await dbOperations.get('SELECT * FROM finder_tasks WHERE id = ?', [result.id]);
    if (rawRequest.execution_mode === 'video_evidence_finder') {
      if (process.env.NODE_ENV !== 'test') {
        setImmediate(() => {
          processVideoEvidenceTask(result.id, {
            targetPlatforms: targetPlatforms.length ? targetPlatforms : [...new Set(normalizedCycles.flatMap((cycle) => cycle.target_platforms || []))],
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
      }
    } else if (rawRequest.execution_mode !== 'subagent_hybrid') {
      if (process.env.NODE_ENV !== 'test') {
        setImmediate(() => {
          processTask(result.id, {
            searchSources,
            discoveryRoutes,
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
      }
    } else {
      await updateTask(result.id, { source_agent: 'subagent_hybrid', status: 'draft' });
    }
    res.json({ success: true, data: task, message: rawRequest.execution_mode === 'subagent_hybrid' ? 'Finder task created for subagent subtasks' : rawRequest.execution_mode === 'video_evidence_finder' ? 'Video Evidence Finder task started' : 'Finder task started' });
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
