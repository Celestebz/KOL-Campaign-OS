const express = require('express');
const crypto = require('crypto');
const { dbOperations, sequelize, Sequelize } = require('../database');
const { computeUrlHash } = require('../utils/videoUrlNormalizer');
const {
  buildInstagramReelSearchUrl,
  extractInstagramReels,
  instagramReelToCandidate
} = require('../utils/instagramReelSearch');
const {
  buildTikTokKeywordSearchUrl,
  extractTikTokVideos,
  tiktokVideoToCandidate
} = require('../utils/tiktokKeywordSearch');

const router = express.Router();

const SYSTEM_SELECTION_KEY = 'system.provider_selection';

const MIN_RELEVANT_SIGNAL_SCORE = 20; // soft-signal floor for entering raw candidate pool
const EVIDENCE_SIGNAL_TYPES = new Set(['competitor', 'category', 'use_case', 'feature', 'community']);
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

const TARGET_PLATFORMS = ['youtube', 'instagram', 'tiktok'];
const cancelledTasks = new Set();

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizedPlatform(value, profileUrl = '') {
  const platform = clean(value).toLowerCase();
  return TARGET_PLATFORMS.includes(platform) ? platform : detectPlatformFromUrl(profileUrl);
}

function normalizeProfileIdentity(platform, profileUrl) {
  let value = clean(profileUrl);
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const parsed = new URL(value);
    const detectedPlatform = normalizedPlatform(platform, value);
    let hostname = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (detectedPlatform === 'youtube' && (hostname === 'youtube.com' || hostname.endsWith('.youtube.com'))) {
      hostname = 'www.youtube.com';
    } else if (detectedPlatform === 'instagram' && (hostname === 'instagram.com' || hostname.endsWith('.instagram.com'))) {
      hostname = 'www.instagram.com';
    } else if (detectedPlatform === 'tiktok' && (hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com'))) {
      hostname = 'www.tiktok.com';
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length) {
      const accountPath = parts[0].startsWith('@') || ['user', 'c'].includes(parts[0].toLowerCase());
      if (detectedPlatform === 'instagram' || detectedPlatform === 'tiktok' || accountPath) {
        for (let index = 0; index < parts.length; index += 1) parts[index] = parts[index].toLowerCase();
      }
    }
    const pathname = parts.length ? `/${parts.join('/')}` : '';
    const platformTrailingSlash = detectedPlatform === 'instagram' && pathname ? '/' : '';
    return `https://${hostname}${pathname}${platformTrailingSlash}`;
  } catch (error) {
    return value.toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

function buildCandidateIdentity(platform, profileUrl, authorName) {
  const normalized = normalizedPlatform(platform, profileUrl) || 'unknown';
  const normalizedProfileUrl = normalizeProfileIdentity(normalized, profileUrl);
  const normalizedAuthor = clean(authorName).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  const identityKey = normalizedProfileUrl
    ? `profile:${normalized}:${normalizedProfileUrl}`
    : `author:${normalized}:${normalizedAuthor || 'unknown'}`;
  return {
    identityKey,
    identityKeyHash: crypto.createHash('sha256').update(identityKey).digest('hex')
  };
}

function redactKnownSecrets(value, secrets = []) {
  let redacted = clean(value);
  for (const secret of secrets.map(clean).filter(Boolean)) {
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function normalizeEvidenceSignals(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const signal = clean(typeof item === 'string' ? item : item?.signal).toLowerCase();
    if (!EVIDENCE_SIGNAL_TYPES.has(signal) || seen.has(signal)) return [];
    seen.add(signal);
    return [{ signal, reason: clean(typeof item === 'string' ? '' : item?.reason) }];
  });
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
    evidence_signals: [],
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
    if (Array.isArray(parsed.evidence_signals)) result.evidence_signals = parsed.evidence_signals;
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
    throw Object.assign(
      new Error(data?.error?.message || data?.message || `HTTP ${response.status}`),
      { status: response.status }
    );
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
    evidence_signals: normalizeEvidenceSignals(parsed.evidence_signals),
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
  const creatorContext = await resolveExistingCreatorContext(
    evidence.target_platform || video.platform,
    evidence.author_profile_url || video.author_profile_url,
    evidence.author_name || evidence.video_author_name || video.author_name || video.kol_name
  );
  const systemPrompt = [
    'You are a KOL Finder evidence analyst.',
    'Return valid JSON only. Do not include Markdown, explanations, or chain-of-thought.',
    'Your job is to evaluate whether the video author is a KOL candidate worth entering the raw candidate pool.',
    'Evaluate in two layers: (1) video evidence fit and multi-label evidence_signals, and (2) creator profile / account quality.',
    'Assign zero or more evidence_signals from competitor, category, use_case, feature, community. A video may match multiple signals.',
    'Do not analyze cooperation performance. Do not assume comments are available.',
    'Existing creator history is advisory context only. It must not auto-approve, auto-reject, or replace current video evidence.',
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
      global_product: {
        id: strategy.product_id,
        brand: strategy.product_brand || '',
        name: strategy.product_name || '',
        sku: strategy.product_sku || '',
        category: strategy.product_category || '',
        product_url: strategy.product_url || '',
        price: strategy.product_price,
        currency: strategy.product_currency || '',
        description: strategy.product_description || '',
        selling_points: parseJson(strategy.product_selling_points, strategy.product_selling_points || [])
      },
      campaign_product: {
        id: strategy.campaign_product_id,
        role: strategy.role || '',
        priority: strategy.priority,
        campaign_brief: strategy.campaign_brief || '',
        status: strategy.campaign_product_status || ''
      },
      product_context: strategy.product_context || {},
      persona_config: strategy.persona_config || {},
      finder_handoff: strategy.finder_handoff || {},
      existing_creator_context: creatorContext?.ai_summary || { known_creator: false }
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
      evidence_signals: [{ signal: 'competitor | category | use_case | feature | community', reason: 'Why the video supports this signal' }],
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

async function scopedGet(sql, params, transaction = null) {
  if (!transaction) return dbOperations.get(sql, params);
  const rows = await sequelize.query(sql, {
    replacements: params,
    type: Sequelize.QueryTypes.SELECT,
    transaction,
    logging: false
  });
  return rows[0] || null;
}

async function scopedRun(sql, params, transaction = null) {
  if (!transaction) return dbOperations.run(sql, params);
  const [result, metadata] = await sequelize.query(sql, {
    replacements: params,
    type: Sequelize.QueryTypes.RAW,
    transaction,
    logging: false
  });
  return {
    id: /^\s*INSERT\b/i.test(sql) ? (Number(result) || 0) : 0,
    changes: Number(metadata !== undefined ? metadata : result) || 0
  };
}

async function scopedQuery(sql, params, transaction = null) {
  if (!transaction) return dbOperations.query(sql, params);
  return sequelize.query(sql, {
    replacements: params,
    type: Sequelize.QueryTypes.SELECT,
    transaction,
    logging: false
  });
}

async function getReadyStrategy(strategyId, { requireActiveProduct = false, transaction = null } = {}) {
  const row = await scopedGet(`
    SELECT ks.*, c.name as campaign_name, c.brand as campaign_brand, c.product as campaign_product
    FROM kol_strategies ks
    LEFT JOIN campaigns c ON c.id = ks.campaign_id
    WHERE ks.id = ?${transaction ? ' FOR UPDATE' : ''}
  `, [strategyId], transaction);
  if (!row) throw new Error('Strategy not found');
  if (row.status !== 'ready') throw new Error('Only published Strategy can start Finder');
  let campaignProduct = null;
  if (row.campaign_product_id) {
    campaignProduct = await scopedGet(`
      SELECT cp.id, cp.campaign_id, cp.product_id, cp.role, cp.priority,
        cp.campaign_brief, cp.status AS campaign_product_status,
        p.brand AS product_brand, p.name AS product_name, p.sku AS product_sku,
        p.category AS product_category, p.product_url, p.price AS product_price,
        p.currency AS product_currency, p.description AS product_description,
        p.selling_points AS product_selling_points, p.status AS product_status
      FROM campaign_products cp
      JOIN products p ON p.id = cp.product_id
      WHERE cp.id = ? AND cp.campaign_id = ?${transaction ? ' FOR UPDATE' : ''}
    `, [row.campaign_product_id, row.campaign_id], transaction);
  }
  if (requireActiveProduct && !campaignProduct) {
    throw new Error('Ready Strategy requires a valid Campaign Product binding');
  }
  if (requireActiveProduct && campaignProduct.campaign_product_status !== 'active') {
    throw new Error('Campaign Product must be active before starting Finder');
  }
  if (requireActiveProduct && campaignProduct.product_status !== 'active') {
    throw new Error('Product must be active before starting Finder');
  }
  return {
    ...row,
    ...(campaignProduct || {}),
    secondary_platforms: parseJson(row.secondary_platforms, []),
    product_context: parseJson(row.product_context, {}),
    persona_config: parseJson(row.persona_config, {}),
    scoring_weights: parseJson(row.scoring_weights, {}),
    finder_handoff: parseJson(row.finder_handoff, {})
  };
}

function taskBindingError(message) {
  return Object.assign(new Error(message), { status: 409 });
}

async function getReadyStrategyForTask(task, { transaction = null } = {}) {
  if (!task?.campaign_product_id) throw taskBindingError('Finder task requires a Campaign Product binding');
  let strategy;
  try {
    strategy = await getReadyStrategy(task.strategy_id, { requireActiveProduct: true, transaction });
  } catch (error) {
    throw taskBindingError(error.message);
  }
  if (Number(strategy.campaign_id) !== Number(task.campaign_id)) {
    throw taskBindingError('Finder task campaign does not match its Strategy');
  }
  if (Number(strategy.campaign_product_id) !== Number(task.campaign_product_id)) {
    throw taskBindingError('Finder task Campaign Product does not match its Strategy');
  }
  return strategy;
}

async function withActiveTaskBindingForWrite(taskId, callback) {
  return sequelize.transaction(async (transaction) => {
    const task = await scopedGet('SELECT * FROM finder_tasks WHERE id = ? FOR UPDATE', [taskId], transaction);
    if (!task) throw Object.assign(new Error('Finder task not found'), { status: 404 });
    const strategy = await getReadyStrategyForTask(task, { transaction });
    return callback({ task, strategy, transaction });
  });
}

function usernameFromProfileUrl(platform, profileUrl) {
  const normalized = normalizeProfileIdentity(platform, profileUrl);
  if (!normalized) return '';
  try {
    const parts = new URL(normalized).pathname.split('/').filter(Boolean);
    const first = clean(parts[0]);
    if (!first) return '';
    if (normalizedPlatform(platform, normalized) === 'youtube' && first.startsWith('@')) return first.slice(1).toLowerCase();
    if (['instagram', 'tiktok'].includes(normalizedPlatform(platform, normalized))) return first.replace(/^@/, '').toLowerCase();
    return first.replace(/^@/, '').toLowerCase();
  } catch (error) {
    return '';
  }
}

function creatorContextSummary(matched, cooperationHistory) {
  const history = Array.isArray(cooperationHistory) ? cooperationHistory : [];
  const completed = history.filter((item) => ['completed', 'complete', 'done'].includes(clean(item.status || item.content_status).toLowerCase())).length;
  const issues = history.filter((item) => ['cancelled', 'failed', 'disputed', 'issue'].includes(clean(item.status || item.project_status).toLowerCase())).length;
  return {
    known_creator: true,
    campaign_count: history.length,
    cooperation_status: clean(matched.cooperation_status) || 'unknown',
    do_not_contact: clean(matched.cooperation_status).toLowerCase() === 'do_not_contact',
    risk_category: clean(matched.cooperation_risk_category) || 'none',
    completed_count: completed,
    issue_count: issues
  };
}

async function resolveExistingCreatorContext(platform, profileUrl, authorName) {
  const normalized = normalizedPlatform(platform, profileUrl) || 'unknown';
  const normalizedProfileUrl = normalizeProfileIdentity(normalized, profileUrl);
  const normalizedAuthor = clean(authorName).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  const customerFields = `c.id AS customer_id, c.name AS customer_name,
    c.cooperation_status, c.cooperation_risk_category, c.cooperation_risk_reason,
    c.country_region AS customer_country_region`;
  let matched = null;

  if (normalizedProfileUrl) {
    const profileUrlHash = computeUrlHash(normalizedProfileUrl);
    matched = await dbOperations.get(`
      SELECT ${customerFields}, kpa.id AS platform_account_id,
        kpa.platform AS account_platform, kpa.username AS account_username,
        kpa.profile_url AS account_profile_url, kpa.followers_text AS account_followers
      FROM kol_platform_accounts kpa
      JOIN customers c ON c.id = kpa.customer_id
      WHERE LOWER(kpa.platform) = ?
        AND (kpa.profile_url_hash = ? OR kpa.profile_url = ?)
      ORDER BY kpa.id ASC
      LIMIT 1
    `, [normalized, profileUrlHash, normalizedProfileUrl]);

    if (!matched) {
      const platformColumn = normalized === 'youtube'
        ? 'youtube_url'
        : normalized === 'instagram'
          ? 'instagram_url'
          : normalized === 'tiktok'
            ? 'tiktok_url'
            : 'profile_url';
      matched = await dbOperations.get(`
        SELECT ${customerFields}, NULL AS platform_account_id,
          ? AS account_platform, NULL AS account_username,
          ${platformColumn} AS account_profile_url, NULL AS account_followers
        FROM customers c
        WHERE c.profile_url = ? OR c.${platformColumn} = ?
        ORDER BY c.id ASC
        LIMIT 1
      `, [normalized, normalizedProfileUrl, normalizedProfileUrl]);
    }
    if (!matched) {
      const username = usernameFromProfileUrl(normalized, normalizedProfileUrl);
      if (username) {
        matched = await dbOperations.get(`
          SELECT ${customerFields}, kpa.id AS platform_account_id,
            kpa.platform AS account_platform, kpa.username AS account_username,
            kpa.profile_url AS account_profile_url, kpa.followers_text AS account_followers
          FROM kol_platform_accounts kpa
          JOIN customers c ON c.id = kpa.customer_id
          WHERE LOWER(kpa.platform) = ? AND REPLACE(LOWER(kpa.username), '@', '') = ?
          ORDER BY kpa.id ASC
          LIMIT 1
        `, [normalized, username]);
      }
    }
  } else if (normalizedAuthor) {
    matched = await dbOperations.get(`
      SELECT ${customerFields}, kpa.id AS platform_account_id,
        kpa.platform AS account_platform, kpa.username AS account_username,
        kpa.profile_url AS account_profile_url, kpa.followers_text AS account_followers
      FROM kol_platform_accounts kpa
      JOIN customers c ON c.id = kpa.customer_id
      WHERE LOWER(kpa.platform) = ? AND LOWER(kpa.username) = ?
      ORDER BY kpa.id ASC
      LIMIT 1
    `, [normalized, normalizedAuthor]);
  }

  if (!matched) return null;
  const cooperationHistory = await dbOperations.query(`
    SELECT campaign_id, target_platform, project_status, priority_level,
      candidate_priority_score, outreach_status, negotiation_status,
      contract_status, payment_status, content_status, status, updated_at
    FROM campaign_kols
    WHERE customer_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 20
  `, [matched.customer_id]);
  return {
    customer_id: matched.customer_id,
    cooperation_status: matched.cooperation_status,
    cooperation_risk_category: matched.cooperation_risk_category,
    platform_account: matched.platform_account_id ? {
      id: matched.platform_account_id,
      platform: matched.account_platform,
      username: matched.account_username,
      profile_url: matched.account_profile_url,
      followers: matched.account_followers
    } : null,
    cooperation_history: cooperationHistory,
    ai_summary: creatorContextSummary(matched, cooperationHistory)
  };
}

function discoveryKeywords(strategy) {
  return [...new Set([
    ...parseList(strategy.finder_handoff?.required_keywords),
    ...parseList(strategy.finder_handoff?.competitor_keywords),
    strategy.product || strategy.campaign_product || strategy.campaign_name,
    strategy.category
  ].flatMap(parseList))].filter(Boolean).slice(0, 12).join(', ');
}

function keywordQueries(request) {
  const queries = parseList(request.discovery.keywords || request.campaign.product || request.campaign.name);
  const fallback = clean(request.campaign.product || request.campaign.name);
  return [...new Set((queries.length ? queries : [fallback]).filter(Boolean))].slice(0, 8);
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

function buildEvidenceDiscoveryRequest(strategy, keywords, searchSource, targetPlatform, limit) {
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
    product: {
      id: strategy.product_id,
      name: strategy.product_name || '',
      brand: strategy.product_brand || '',
      sku: strategy.product_sku || '',
      description: strategy.product_description || '',
      selling_points: parseJson(strategy.product_selling_points, strategy.product_selling_points || [])
    },
    campaign_product: {
      id: strategy.campaign_product_id,
      role: strategy.role || '',
      priority: strategy.priority,
      campaign_brief: strategy.campaign_brief || ''
    },
    discovery: {
      keywords,
      exclusions: parseList(strategy.finder_handoff?.exclusion_keywords).join(', '),
      target_count: limit
    },
    search_source: searchSource,
    discovery_route: 'target_platform_first',
    source_platform: targetPlatform,
    target_platform: targetPlatform,
    platform: targetPlatform,
    limit,
    response_schema: {
      candidates: [{
        platform: 'youtube | instagram | tiktok',
        kol_name: 'Creator name',
        profile_url: 'Creator profile URL',
        representative_video_url: 'Relevant target-platform video URL',
        representative_video_title: 'Relevant target-platform video title',
        reason: 'Why the video is relevant evidence',
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
  const setting = await getSetting(providerKey('youtube', 'maton_gateway'));
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
    candidates.push(...youtubeItemsToCandidates(items, channels, { ...request, discovery: { ...request.discovery, keywords: query } }, `Matched Maton YouTube Gateway search: ${query}`));
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
    candidates.push(...youtubeItemsToCandidates(items, channels, { ...request, discovery: { ...request.discovery, keywords: query } }, `Matched YouTube search: ${query}`));
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
      matched_keywords: request.discovery.keywords,
      matched_persona: request.strategy.persona_config?.primary_persona || '',
      representative_video_url: item.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : '',
      representative_video_title: snippet.title || '',
      reason,
      raw_data: { search_item: item, channel }
    };
  });
}

async function scrapeCreatorsFinderAdapterV2(request) {
  const setting = await getSetting(providerKey(request.target_platform, 'scrapecreators'), legacyKeysFor(request.target_platform, 'scrapecreators'));
  if (!setting?.api_key) throw new Error('ScrapeCreators API Key is not configured');
  const baseUrl = (setting.base_url || 'https://api.scrapecreators.com').replace(/\/$/, '').replace(/\/v1$/, '');
  const maxResults = Math.max(1, Math.min(Number(request.limit || 10), 50));
  const candidates = [];
  const seenTikTokVideoIds = new Set();
  const tiktokQueryAttempts = [];
  const tiktokQueryErrors = [];
  let lastEndpoint = '';
  let instagramReelCount = 0;
  let tiktokVideoCount = 0;

  for (const query of keywordQueries(request)) {
    if (candidates.length >= maxResults) break;
    if (request.target_platform === 'instagram') {
      const endpoint = buildInstagramReelSearchUrl(baseUrl, query);
      const data = await fetchJson(endpoint, { headers: { 'x-api-key': setting.api_key } });
      lastEndpoint = endpoint;
      const reels = extractInstagramReels(data);
      instagramReelCount += reels.length;
      const mapped = reels
        .map((reel) => instagramReelToCandidate(reel, {
          ...request,
          discovery: { ...request.discovery, keywords: query }
        }))
        .filter(Boolean);
      candidates.push(...mapped.slice(0, maxResults - candidates.length));
      continue;
    }

    const endpoint = buildTikTokKeywordSearchUrl(baseUrl, query);
    lastEndpoint = endpoint;
    try {
      const data = await fetchJson(endpoint, { headers: { 'x-api-key': setting.api_key } });
      const videos = extractTikTokVideos(data);
      tiktokVideoCount += videos.length;
      for (const video of videos) {
        const mapped = tiktokVideoToCandidate(video, {
          ...request,
          discovery: { ...request.discovery, keywords: query }
        });
        if (!mapped) continue;
        const videoId = video.aweme_id.trim();
        if (seenTikTokVideoIds.has(videoId)) continue;
        seenTikTokVideoIds.add(videoId);
        candidates.push(mapped);
        if (candidates.length >= maxResults) break;
      }
      tiktokQueryAttempts.push({
        search_source: request.search_source || 'tiktok_search',
        provider: 'scrapecreators',
        ok: true,
        endpoint,
        query
      });
    } catch (error) {
      const safeMessage = redactKnownSecrets(error.message, [setting.api_key]);
      const attempt = {
        search_source: request.search_source || 'tiktok_search',
        provider: 'scrapecreators',
        ok: false,
        endpoint,
        query,
        error: safeMessage
      };
      if (error.status !== undefined) attempt.status = error.status;
      tiktokQueryAttempts.push(attempt);
      tiktokQueryErrors.push(attempt);
    }
  }

  if (!candidates.length && request.target_platform === 'tiktok') {
    if (tiktokQueryErrors.length) {
      const latest = tiktokQueryErrors[tiktokQueryErrors.length - 1];
      throw Object.assign(new Error(latest.error), {
        status: latest.status,
        provider: latest.provider,
        query: latest.query,
        attempts: tiktokQueryAttempts
      });
    }
    if (tiktokVideoCount === 0) {
      throw Object.assign(
        new Error('TikTok Keyword Search returned 0 videos. Try shorter or broader Strategy keywords.'),
        { attempts: tiktokQueryAttempts }
      );
    }
    throw Object.assign(
      new Error('TikTok Keyword Search returned videos, but none contained valid public video evidence with an identifiable author.'),
      { attempts: tiktokQueryAttempts }
    );
  }

  if (!candidates.length) {
    if (request.target_platform === 'instagram' && instagramReelCount === 0) {
      throw new Error('ScrapeCreators returned 0 Instagram Reels. Try shorter or broader Strategy keywords.');
    }
    if (request.target_platform === 'instagram') {
      throw new Error('ScrapeCreators returned Instagram Reels, but none contained valid public Reel evidence with an identifiable author.');
    }
    throw new Error('ScrapeCreators returned 0 candidates. Try shorter Instagram keywords.');
  }
  return {
    provider: request.search_source || 'scrapecreators',
    endpoint: lastEndpoint,
    candidates: candidates.slice(0, maxResults),
    attempts: request.target_platform === 'tiktok' ? tiktokQueryAttempts : []
  };
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
    matched_keywords: clean(input.matched_keywords || request.discovery.keywords),
    matched_persona: clean(input.matched_persona || request.strategy.persona_config?.primary_persona),
    ai_score: normalizeNumber(input.ai_score || input.score),
    ai_match_reason: clean(input.reason || input.ai_match_reason || `Found by ${PROVIDER_LABELS[provider] || provider}`),
    status: clean(input.status),
    error_message: clean(input.error_message),
    scoring_breakdown: input.scoring_breakdown || {},
    evidence_url: evidenceUrl,
    evidence_title: evidenceTitle,
    evidence_type: evidenceType,
    source_query: clean(input.source_query || request.discovery.keywords),
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

async function rawCandidateExists(candidate, strategyId, transaction = null) {
  if (candidate.profile_url) {
    return scopedGet('SELECT * FROM raw_candidates WHERE strategy_id = ? AND profile_url = ? LIMIT 1', [strategyId, candidate.profile_url], transaction);
  }
  return scopedGet('SELECT * FROM raw_candidates WHERE strategy_id = ? AND platform = ? AND kol_name = ? LIMIT 1', [strategyId, candidate.platform, candidate.kol_name], transaction);
}

async function upsertRawCandidate(candidate, task, provider, creatorContext = null, transaction = null) {
  if (!candidate.kol_name && !candidate.profile_url) {
    return { inserted: false, skipped: true, reason: 'Missing kol_name/profile_url' };
  }
  const existing = await rawCandidateExists(candidate, task.strategy_id, transaction);
  const desiredStatus = ['new', 'ignored', 'error', 'manual_review', 'risk_review'].includes(candidate.status) ? candidate.status : '';
  const globalRisk = creatorContext?.cooperation_status === 'do_not_contact';
  const status = desiredStatus || 'new';
  const rawData = JSON.stringify({
    provider,
    finder_task_id: task.id,
    discovery_route: candidate.discovery_route,
    source_platform: candidate.source_platform,
    target_platform: candidate.target_platform,
    global_cooperation_risk: globalRisk ? {
      customer_id: creatorContext.customer_id,
      cooperation_status: creatorContext.cooperation_status,
      category: creatorContext.cooperation_risk_category || '',
      reason: creatorContext.cooperation_risk_reason || ''
    } : undefined,
    existing_creator_context: creatorContext || undefined,
    data: candidate.raw_data
  });
  if (existing) {
    await scopedRun(
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
        creatorContext?.cooperation_risk_category || '',
        status,
        creatorContext?.cooperation_risk_reason || '',
        candidate.error_message,
        candidate.ai_score,
        candidate.ai_match_reason,
        candidate.matched_persona,
        rawData,
        existing.id
      ], transaction
    );
    return { inserted: false, duplicate: true, id: existing.id, status: existing.status || status };
  }
  const result = await scopedRun(
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
      status === 'risk_review' ? creatorContext?.cooperation_risk_category || '' : '',
      status === 'risk_review' ? creatorContext?.cooperation_risk_reason || '' : ''
    ], transaction
  );
  return { inserted: true, id: result.id, status };
}

function uniqueEvidence(values = []) {
  const seen = new Set();
  return values.filter((value) => {
    const key = clean(value?.video_source_id || value?.evidence_id || value?.video_url || value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function upsertRawCandidateProductFit(candidate, task, identity, creatorContext, rawCandidateId, transaction = null) {
  if (!task.campaign_product_id) {
    throw new Error('Finder task is missing its Campaign Product binding');
  }
  const existingFit = await scopedGet(
    `SELECT * FROM raw_candidate_product_fits WHERE campaign_product_id = ? AND identity_key_hash = ?${transaction ? ' FOR UPDATE' : ''}`,
    [task.campaign_product_id, identity.identityKeyHash], transaction
  );
  const previousSummary = parseJson(existingFit?.evidence_summary, {}) || {};
  const evidence = uniqueEvidence([...(Array.isArray(previousSummary.evidence) ? previousSummary.evidence : []), ...(Array.isArray(candidate.raw_data?.evidence) ? candidate.raw_data.evidence : [])]);
  const evidenceIds = [...new Set([...(previousSummary.evidence_ids || []), ...(candidate.raw_data?.evidence_ids || [])])];
  const analysisIds = [...new Set([...(previousSummary.analysis_ids || []), ...(candidate.raw_data?.analysis_ids || [])])];
  const videoSourceIds = [...new Set([...(previousSummary.video_source_ids || []), ...(candidate.raw_data?.video_source_ids || [])])];
  const evidenceSummary = JSON.stringify({
    identity_key: identity.identityKey,
    evidence_count: evidence.length,
    evidence_ids: evidenceIds,
    analysis_ids: analysisIds,
    video_source_ids: videoSourceIds,
    evidence,
    best_score: candidate.scoring_breakdown?.best_score ?? candidate.ai_score,
    average_score: candidate.scoring_breakdown?.average_score ?? candidate.ai_score,
    matched_persona: candidate.matched_persona,
    recommendation: candidate.ai_match_reason,
    existing_creator_context: creatorContext || null
  });
  const identityStatus = creatorContext ? 'known_kol_new_product_fit' : 'new_kol';
  await scopedRun(
    `INSERT INTO raw_candidate_product_fits
     (latest_raw_candidate_id, existing_customer_id, campaign_product_id, platform,
      identity_key_hash, strategy_id, finder_task_id, identity_status, fit_score,
      matched_persona, evidence_summary, decision_status, analysis_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1)
     ON DUPLICATE KEY UPDATE
      latest_raw_candidate_id = VALUES(latest_raw_candidate_id),
      existing_customer_id = COALESCE(VALUES(existing_customer_id), existing_customer_id),
      platform = VALUES(platform),
      strategy_id = VALUES(strategy_id),
      finder_task_id = VALUES(finder_task_id),
      identity_status = 'existing_product_fit_updated',
      fit_score = VALUES(fit_score),
      matched_persona = VALUES(matched_persona),
      evidence_summary = VALUES(evidence_summary),
      analysis_version = analysis_version + 1,
      decision_status = CASE
        WHEN decision_status IN ('approved', 'rejected') THEN decision_status
        ELSE VALUES(decision_status)
      END,
      updated_at = CURRENT_TIMESTAMP`,
    [
      rawCandidateId,
      creatorContext?.customer_id || null,
      task.campaign_product_id,
      candidate.platform,
      identity.identityKeyHash,
      task.strategy_id,
      task.id,
      identityStatus,
      candidate.ai_score,
      candidate.matched_persona,
      evidenceSummary
    ], transaction
  );
  return scopedGet(
    'SELECT * FROM raw_candidate_product_fits WHERE campaign_product_id = ? AND identity_key_hash = ?',
    [task.campaign_product_id, identity.identityKeyHash], transaction
  );
}

function appendProviderErrorAttempts(attempts, error, fallback) {
  if (Array.isArray(error.attempts) && error.attempts.length) {
    attempts.push(...error.attempts);
    if (error.attempts.some((attempt) => attempt?.ok === false)) return;
  }
  const attempt = {
    ...fallback,
    provider: error.provider || fallback.provider,
    ok: false,
    error: error.message
  };
  if (error.status !== undefined) attempt.status = error.status;
  if (error.query) attempt.query = error.query;
  attempts.push(attempt);
}

function providerErrorWithAttempts(error, attempts) {
  const wrapped = Object.assign(new Error(error.message), { attempts });
  for (const field of ['status', 'provider', 'query']) {
    if (error[field] !== undefined) wrapped[field] = error[field];
  }
  return wrapped;
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
    attempts.push(...(maton.attempts || []));
    attempts.push({ search_source: source, provider: maton.provider, ok: true, endpoint: maton.endpoint });
    return { ...maton, attempts };
  } catch (error) {
    appendProviderErrorAttempts(attempts, error, { search_source: source, provider: source });
    if (!allowFallback || source !== 'maton_agent' || externalAgentRoute) {
      throw providerErrorWithAttempts(error, attempts);
    }
  }

  try {
    const fallback = request.target_platform === 'youtube'
      ? await youtubeSearchAdapter({ ...request, search_source: 'youtube_search' })
      : await scrapeCreatorsFinderAdapterV2({
        ...request,
        search_source: request.target_platform === 'instagram' ? 'instagram_search' : 'tiktok_search'
      });
    attempts.push(...(fallback.attempts || []));
    attempts.push({ search_source: fallback.provider, provider: fallback.provider, ok: true, endpoint: fallback.endpoint });
    return { ...fallback, attempts };
  } catch (error) {
    appendProviderErrorAttempts(attempts, error, {
      search_source: request.target_platform === 'youtube' ? 'youtube_search' : `${request.target_platform}_search`,
      provider: request.target_platform === 'youtube' ? 'google_official' : 'scrapecreators'
    });
    throw providerErrorWithAttempts(error, attempts);
  }
}

function toMysqlDatetime(value) {
  if (!value) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

async function updateTask(id, patch, transaction = null) {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  const assignments = fields.map((field) => `${field} = ?`).join(', ');
  const values = fields.map((field) => {
    if (['started_at', 'finished_at', 'created_at', 'updated_at'].includes(field)) {
      return toMysqlDatetime(patch[field]);
    }
    return patch[field];
  });
  await scopedRun(
    `UPDATE finder_tasks SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [...values, id], transaction
  );
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

async function upsertVideoSourceForEvidence(task, evidence, transaction = null) {
  const { normalizeVideoUrl } = require('../utils/videoUrlNormalizer');
  const sourceUrl = evidence.video_url;
  const normalized = normalizeVideoUrl(sourceUrl);
  const platformVideoId = normalized.platformVideoId || evidence.platform_video_id || '';
  let reusedByTikTokId = false;

  let video = null;
  if (normalized.platform === 'tiktok' && platformVideoId) {
    video = await scopedGet(
      'SELECT * FROM video_sources WHERE platform = ? AND platform_video_id = ? ORDER BY id ASC LIMIT 1',
      [normalized.platform, platformVideoId], transaction
    );
    reusedByTikTokId = Boolean(video);
  }
  if (!video) {
    video = await scopedGet(
      'SELECT * FROM video_sources WHERE canonical_url_hash = ?',
      [normalized.canonicalUrlHash], transaction
    );
  }

  if (video) {
    await scopedRun(
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
        platformVideoId,
        sourceUrl,
        reusedByTikTokId ? video.canonical_url : normalized.canonicalUrl,
        evidence.title || '',
        evidence.author_name || '',
        evidence.author_name || '',
        evidence.author_profile_url || '',
        `Finder video evidence task ${task.id}`,
        video.id
      ], transaction
    );
    video = await scopedGet('SELECT * FROM video_sources WHERE id = ?', [video.id], transaction);
  } else {
    const result = await scopedRun(
      `INSERT INTO video_sources
       (platform, platform_video_id, source_url, canonical_url, canonical_url_hash,
        title, kol_name, author_name, author_profile_url, notes, status, crawl_status, analysis_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalized.platform,
        platformVideoId,
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
      ], transaction
    );
    video = await scopedGet('SELECT * FROM video_sources WHERE id = ?', [result.id], transaction);
  }

  // Link video to the task's campaign.
  const campaignId = task.campaign_id || evidence.campaign_id || null;
  if (campaignId) {
    await scopedRun(
      `INSERT INTO campaign_videos (campaign_id, video_source_id, added_reason, added_by_finder_task_id)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`,
      [campaignId, video.id, 'finder', task.id], transaction
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

async function saveVideoEvidence(task, input, defaults = {}, transaction = null) {
  const evidence = normalizeEvidenceInput(input, task, defaults);
  if (!evidence.video_url) throw new Error('video_url is required');
  if (!isVideoEvidenceUrl(evidence.video_url)) throw new Error(`Not a supported video evidence URL: ${evidence.video_url}`);
  if (!TARGET_PLATFORMS.includes(evidence.target_platform)) throw new Error(`Unsupported target platform: ${evidence.target_platform}`);
  if (evidence.evidence_platform !== evidence.target_platform && evidence.discovery_scope === 'target_platform_only') {
    throw new Error('MVP requires evidence_platform to equal target_platform');
  }

  const video = await upsertVideoSourceForEvidence(task, evidence, transaction);
  const existing = await scopedGet(
    'SELECT * FROM finder_video_evidence WHERE finder_task_id = ? AND video_source_id = ? LIMIT 1',
    [task.id, video.id], transaction
  );
  if (existing) {
    await scopedRun(
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
      ], transaction
    );
    return { row: await scopedGet('SELECT * FROM finder_video_evidence WHERE id = ?', [existing.id], transaction), inserted: false, video };
  }
  const result = await scopedRun(
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
    ], transaction
  );
  return { row: await scopedGet('SELECT * FROM finder_video_evidence WHERE id = ?', [result.id], transaction), inserted: true, video };
}

function failedQueryAudit(attempts = []) {
  return attempts
    .filter((attempt) => attempt?.ok === false && attempt?.query)
    .map((attempt) => ({
      provider: attempt.provider,
      query: attempt.query,
      status: attempt.status,
      error: attempt.error
    }));
}

async function processVideoEvidenceTask(taskId, options = {}) {
  const task = await dbOperations.get('SELECT * FROM finder_tasks WHERE id = ?', [taskId]);
  if (!task) return;
  let strategy;
  try {
    strategy = await getReadyStrategyForTask(task);
  } catch (error) {
    await updateTask(taskId, { status: 'failed', error_message: `Finder task binding failed: ${error.message}`, finished_at: new Date().toISOString() });
    return;
  }
  const rawRequest = parseJson(task.raw_request, {});
  const targetPlatform = clean(rawRequest.target_platform || options.targetPlatform || task.platform);
  const limit = Math.max(1, Math.min(Number(rawRequest.limit || options.limit || 10), 50));
  const keywords = discoveryKeywords(strategy);
  const searchSource = await preferredSearchSourceForTargetPlatform(targetPlatform);
  const request = buildEvidenceDiscoveryRequest(strategy, keywords, searchSource, targetPlatform, limit);
  const allAttempts = [];
  const responseSummary = [];
  let insertedCount = 0;
  let failedCount = 0;
  let discoveryError = '';

  await updateTask(taskId, { status: 'running', started_at: new Date().toISOString(), source_agent: 'video_evidence_finder' });

  if (cancelledTasks.has(taskId)) {
    await updateTask(taskId, { status: 'cancelled', finished_at: new Date().toISOString() });
    cancelledTasks.delete(taskId);
    return;
  }

  try {
    const result = await runProvider(request, true);
    allAttempts.push(...result.attempts.map((attempt) => ({
      ...attempt,
      discovery_route: 'target_platform_first',
      source_platform: targetPlatform,
      target_platform: targetPlatform
    })));
    let skipped = 0;
    for (const raw of result.candidates.slice(0, limit)) {
      const normalized = normalizeCandidate(raw, request, result.provider);
      const videoUrl = clean(normalized.video_url || normalized.evidence_url);
      if (!isVideoEvidenceUrl(videoUrl) || detectPlatformFromUrl(videoUrl) !== targetPlatform) {
        skipped += 1;
        continue;
      }
      const saved = await withActiveTaskBindingForWrite(taskId, ({ task: activeTask, transaction }) => saveVideoEvidence(activeTask, {
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
        source_signal: 'unclassified',
        source_query: normalized.source_query || keywords,
        discovery_scope: 'target_platform_only',
        discovery_route: 'target_platform_first'
      }, transaction));
      await ensureVideoSnapshot(saved.video);
      if (saved.inserted) insertedCount += 1;
      else skipped += 1;
    }
    responseSummary.push({
      stage: 'video_evidence_discovery',
      target_platform: targetPlatform,
      provider: result.provider,
      returned: result.candidates.length,
      inserted: insertedCount,
      skipped,
      query_failures: failedQueryAudit(result.attempts)
    });
  } catch (error) {
    failedCount = 1;
    discoveryError = error.message;
    allAttempts.push(...(error.attempts || [{ provider: 'unknown', ok: false, error: error.message }]));
    responseSummary.push({
      stage: 'video_evidence_discovery',
      target_platform: targetPlatform,
      error: error.message,
      query_failures: failedQueryAudit(error.attempts)
    });
  }

  const status = insertedCount > 0 && failedCount > 0 ? 'partial_failed' : insertedCount > 0 ? 'success' : 'failed';
  await updateTask(taskId, {
    status,
    success_count: insertedCount,
    failed_count: failedCount,
    result_count: insertedCount,
    error_message: status === 'failed' ? (discoveryError || 'No target-platform video evidence was inserted.') : '',
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
      target_platform: clean(row.platform),
      provider_attempts: parseJson(row.provider_attempts, []),
      raw_response_summary: parseJson(row.raw_response_summary, [])
    })) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/video-evidence/import', async (req, res) => {
  try {
    const existingTask = await dbOperations.get('SELECT * FROM finder_tasks WHERE id = ?', [req.params.id]);
    if (!existingTask) return res.status(404).json({ success: false, error: 'Finder task not found' });
    const rawRequest = parseJson(existingTask.raw_request, {});
    const defaultTarget = clean(req.body?.target_platform || req.body?.targetPlatform || rawRequest.target_platform || existingTask.platform).split(',')[0] || 'youtube';
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
        const saved = await withActiveTaskBindingForWrite(existingTask.id, ({ task, transaction }) => saveVideoEvidence(task, row, {
          target_platform: targetPlatform,
          evidence_platform: targetPlatform,
          source_signal: clean(row.source_signal || 'unclassified'),
          source_query: clean(row.source_query || req.body?.source_query || ''),
          discovery_scope: 'target_platform_only',
          discovery_route: 'target_platform_first'
        }, transaction));
        await ensureVideoSnapshot(saved.video);
        results.push({ success: true, inserted: saved.inserted, data: saved.row });
      } catch (error) {
        if (error.status) throw error;
        results.push({ success: false, error: error.message, input: row });
      }
    }

    const inserted = results.filter((item) => item.success && item.inserted).length;
    const updated = results.filter((item) => item.success && !item.inserted).length;
    await updateTask(existingTask.id, {
      success_count: Number(existingTask.success_count || 0) + inserted,
      result_count: Number(existingTask.result_count || 0) + inserted,
      raw_response_summary: JSON.stringify({ stage: 'manual_video_evidence_import', inserted, updated, failed: results.filter((item) => !item.success).length })
    });
    res.json({ success: true, data: { inserted, updated, failed: results.filter((item) => !item.success).length, results } });
  } catch (error) {
    if (error.status) await updateTask(req.params.id, { status: 'failed', error_message: `Finder task binding failed: ${error.message}`, finished_at: new Date().toISOString() });
    res.status(error.status || 400).json({ success: false, error: error.message });
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
        vai.evidence_signals,
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
    const strategy = await getReadyStrategyForTask(task);
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
        const video = await dbOperations.get('SELECT * FROM video_sources WHERE id = ?', [evidence.video_source_id]);
        const snapshot = await dbOperations.get('SELECT * FROM video_snapshots WHERE video_source_id = ? ORDER BY snapshot_at DESC LIMIT 1', [evidence.video_source_id]);
        const ai = await runFinderEvidenceAnalysis(video || {}, snapshot, evidence, strategy);
        const parsed = ai.parsed || {};
        const normalized = normalizeFinderEvidenceResult(parsed);
        const extraData = JSON.stringify({
          finder_task_id: task.id,
          ...normalized
        });
        await withActiveTaskBindingForWrite(task.id, ({ transaction }) => scopedRun(
          `INSERT INTO video_ai_analysis_results
           (video_source_id, analysis_type, analysis_scope_id, status, model_name, score, summary,
            raw_result, extra_data, evidence_signals, final_prompt)
           VALUES (?, 'finder_evidence', ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
            status = VALUES(status), model_name = VALUES(model_name), score = VALUES(score),
            summary = VALUES(summary), raw_result = VALUES(raw_result), extra_data = VALUES(extra_data),
            evidence_signals = VALUES(evidence_signals), final_prompt = VALUES(final_prompt), error_message = NULL, updated_at = CURRENT_TIMESTAMP`,
          [
            evidence.video_source_id,
            evidence.id,
            'success',
            ai.model,
            normalized.candidate_decision.candidate_priority_score,
            normalized.candidate_decision.reason || normalized.hard_filter.hard_filter_notes,
            JSON.stringify(ai.raw || parsed),
            extraData,
            JSON.stringify(normalized.evidence_signals),
            ai.finalPrompt
          ], transaction
        ).then(() => scopedRun('UPDATE finder_video_evidence SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['analyzed', evidence.id], transaction)));
        successCount += 1;
        results.push({ evidence_id: evidence.id, success: true });
      } catch (error) {
        if (error.status) throw error;
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
    if (error.status) await updateTask(req.params.id, { status: 'failed', error_message: `Finder task binding failed: ${error.message}`, finished_at: new Date().toISOString() });
    res.status(error.status || 400).json({ success: false, error: error.message });
  }
});

router.post('/:id/generate-candidates-from-evidence', async (req, res) => {
  try {
    const task = await dbOperations.get('SELECT * FROM finder_tasks WHERE id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ success: false, error: 'Finder task not found' });
    const strategy = await getReadyStrategyForTask(task);
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
      const profileUrl = clean(row.author_profile_url);
      if (!authorName && !profileUrl) continue;
      if (!profileUrl && !clean(row.video_url)) continue;
      const identity = buildCandidateIdentity(row.target_platform || row.evidence_platform, profileUrl, authorName);
      if (!groups.has(identity.identityKeyHash)) {
        groups.set(identity.identityKeyHash, {
          identity,
          normalizedProfileUrl: normalizeProfileIdentity(row.target_platform || row.evidence_platform, profileUrl),
          rows: []
        });
      }
      groups.get(identity.identityKeyHash).rows.push(row);
    }

    const generated = await sequelize.transaction(async (transaction) => {
      const lockedStrategy = await getReadyStrategyForTask(task, { transaction });
      await scopedGet('SELECT id FROM campaign_products WHERE id = ? FOR UPDATE', [task.campaign_product_id], transaction);
      const inserted = [];
      const skipped = [];
      const productFits = [];
    for (const evidenceGroup of groups.values()) {
      const sorted = evidenceGroup.rows.sort((a, b) => Number(b.candidate_priority_score || 0) - Number(a.candidate_priority_score || 0));
      const best = sorted[0];
      const averageScore = Math.round(sorted.reduce((sum, item) => sum + Number(item.candidate_priority_score || 0), 0) / sorted.length);
      const recommendedStatus = clean(best.recommended_status) || 'manual_review';
      const matchedPersona = inferPersonaFromEvidence(best, lockedStrategy);
      const creatorContext = await resolveExistingCreatorContext(
        best.target_platform || best.evidence_platform,
        evidenceGroup.normalizedProfileUrl,
        best.author_name || best.video_author_name || best.kol_name
      );
      const candidate = {
        platform: best.target_platform,
        target_platform: best.target_platform,
        source_platform: best.evidence_platform,
        discovery_route: 'target_platform_first',
        source_agent: 'video_evidence_finder',
        kol_name: clean(best.author_name || best.video_author_name || best.kol_name),
        profile_url: evidenceGroup.normalizedProfileUrl,
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
      const saved = await upsertRawCandidate(candidate, task, 'video_evidence_finder', creatorContext, transaction);
      if (saved.id) {
        productFits.push(await upsertRawCandidateProductFit(
          candidate,
          task,
          evidenceGroup.identity,
          creatorContext,
          saved.id,
          transaction
        ));
      }
      if (saved.inserted) inserted.push(saved);
      else skipped.push(saved);
    }
    await updateTask(task.id, {
      result_count: Number(task.result_count || 0) + inserted.length,
      raw_response_summary: JSON.stringify({
        stage: 'generate_candidates_from_evidence',
        inserted: inserted.length,
        skipped: skipped.length,
        product_fits: productFits.length
      })
    }, transaction);
      return { inserted, skipped, productFits };
    });
    const { inserted, skipped, productFits } = generated;
    res.json({
      success: true,
      data: {
        inserted_count: inserted.length,
        skipped_count: skipped.length,
        product_fit_count: productFits.length,
        inserted,
        skipped
      }
    });
  } catch (error) {
    res.status(error.status || 400).json({ success: false, error: error.message });
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
      target_platform: clean(row.platform),
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
    const legacyFields = [
      'cycles', 'search_cycles', 'searchCycles', 'search_intensity', 'searchIntensity',
      'discovery_routes', 'discoveryRoutes', 'execution_mode', 'executionMode',
      'subtask_mode', 'subtaskMode', 'allow_cross_platform_evidence',
      'allowCrossPlatformEvidence', 'target_platforms', 'platforms'
    ].filter((key) => Object.prototype.hasOwnProperty.call(body, key));
    if (legacyFields.length) {
      return res.status(400).json({
        success: false,
        error: 'Legacy Finder fields are no longer supported: ' + legacyFields.join(', ')
      });
    }

    const targetPlatform = clean(body.target_platform);
    if (!TARGET_PLATFORMS.includes(targetPlatform)) {
      return res.status(400).json({
        success: false,
        error: 'Finder requires exactly one target_platform: youtube, instagram, or tiktok'
      });
    }
    const limit = Math.max(1, Math.min(Number(body.limit || 10), 50));
    const searchSource = await preferredSearchSourceForTargetPlatform(targetPlatform);
    const task = await sequelize.transaction(async (transaction) => {
      const strategy = await getReadyStrategy(body.strategy_id, {
        requireActiveProduct: true,
        transaction
      });
      const keywords = discoveryKeywords(strategy);
      const rawRequest = {
        strategy_id: strategy.id,
        campaign_product_id: strategy.campaign_product_id,
        target_platform: targetPlatform,
        limit
      };
      const result = await scopedRun(
        'INSERT INTO finder_tasks ' +
        '(campaign_id, campaign_product_id, strategy_id, name, platform, keywords, status, search_sources, ' +
        'discovery_routes, raw_request, notes, source_agent) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          strategy.campaign_id,
          strategy.campaign_product_id,
          strategy.id,
          `${strategy.name} Finder ${new Date().toLocaleString()}`,
          targetPlatform,
          keywords,
          'draft',
          JSON.stringify([searchSource]),
          JSON.stringify(['target_platform_first']),
          JSON.stringify(rawRequest),
          clean(body.notes),
          'video_evidence_finder'
        ],
        transaction
      );
      return scopedGet('SELECT * FROM finder_tasks WHERE id = ?', [result.id], transaction);
    });
    if (process.env.NODE_ENV !== 'test') {
      setImmediate(() => {
        processVideoEvidenceTask(task.id, { targetPlatform, limit }).catch((error) => {
          updateTask(task.id, {
            status: 'failed',
            error_message: error.message,
            finished_at: new Date().toISOString()
          });
        });
      });
    }
    res.json({ success: true, data: task, message: 'Video Evidence Finder task started' });
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
module.exports.runVideoEvidenceDiscovery = processVideoEvidenceTask;
module.exports.buildCandidateIdentity = buildCandidateIdentity;
