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
const DEFAULT_CYCLE_BY_ID = Object.fromEntries(DEFAULT_SEARCH_CYCLES.map((cycle) => [cycle.cycle, cycle]));

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
  youtube_native_search: [{ searchSource: 'youtube_search', targetPlatform: 'youtube', sourcePlatform: 'youtube' }],
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
  if (targets.includes('youtube')) routes.push('youtube_native_search', 'google_web_to_youtube', 'spider_web_expansion');
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

function sourceTargetPairs(cycle, strategy, requestedSources = [], requestedTargets = [], requestedRoutes = []) {
  const targets = targetPlatformsForCycle(cycle, strategy, requestedTargets);
  const routes = discoveryRoutesForCycle(cycle, strategy, requestedRoutes, targets);
  const pairs = [];
  for (const route of routes) {
    for (const mapped of ROUTE_SOURCE_TARGETS[route] || []) {
      if (targets.includes(mapped.targetPlatform)) pairs.push({ ...mapped, discoveryRoute: route });
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
      ...(!hasSeedUrls && targets.includes('tiktok') ? [skippedRouteItem('seed_posts_to_profile', 'no_seed')] : []),
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
  const desiredStatus = ['ignored', 'error'].includes(candidate.status) ? candidate.status : '';
  const status = desiredStatus || (await masterExists(candidate) ? 'duplicate' : 'new');
  const rawData = JSON.stringify({
    provider,
    finder_task_id: task.id,
    search_cycle: cycle.cycle,
    discovery_route: candidate.discovery_route,
    source_platform: candidate.source_platform,
    target_platform: candidate.target_platform,
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
       discovery_route = COALESCE(NULLIF(discovery_route, ''), ?),
       source_platform = COALESCE(NULLIF(source_platform, ''), ?),
       target_platform = COALESCE(NULLIF(target_platform, ''), ?),
       source_agent = COALESCE(NULLIF(source_agent, ''), ?),
       status = CASE WHEN status IN ('approved', 'duplicate') THEN status WHEN ? <> '' THEN ? ELSE status END,
       error_message = COALESCE(NULLIF(error_message, ''), ?),
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
        candidate.discovery_route,
        candidate.source_platform,
        candidate.target_platform,
        candidate.source_agent || provider,
        desiredStatus,
        desiredStatus,
        candidate.error_message,
        candidate.ai_score,
        candidate.ai_match_reason,
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
      raw_data, error_message, search_cycle, matched_persona, scoring_breakdown,
      evidence_url, evidence_title, evidence_type, source_query)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    const pairs = sourceTargetPairs(cycle, strategy, options.searchSources || [], options.targetPlatforms || [], options.discoveryRoutes || []);
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

router.get('/:id/subtasks', async (req, res) => {
  try {
    const rows = await dbOperations.query(
      'SELECT * FROM finder_subtasks WHERE finder_task_id = ? ORDER BY id ASC',
      [req.params.id]
    );
    res.json({ success: true, data: rows.map((row) => ({
      ...row,
      agent_result_summary: parseJson(row.agent_result_summary, null)
    })) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/subtasks/generate', async (req, res) => {
  try {
    const task = await dbOperations.get('SELECT * FROM finder_tasks WHERE id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ success: false, error: 'Finder task not found' });
    const strategy = await getReadyStrategy(task.strategy_id);
    const rawRequest = parseJson(task.raw_request, {});
    const taskTargets = parseJson(task.target_platforms, parseList(task.target_platforms || task.platform));
    const taskRoutes = parseJson(task.discovery_routes, parseList(task.discovery_routes));
    const requestedTargets = (rawRequest.target_platforms?.length ? rawRequest.target_platforms : taskTargets || []).filter((p) => TARGET_PLATFORMS.includes(p));
    const requestedRoutes = (rawRequest.discovery_routes?.length ? rawRequest.discovery_routes : taskRoutes || []).filter((route) => route !== 'cycle_multi_route' && DISCOVERY_ROUTES.includes(route));
    const seedUrls = parseList(rawRequest.seed_urls || rawRequest.seedUrls);
    const cycles = parseJson(task.search_cycles, DEFAULT_SEARCH_CYCLES);
    const subtaskMode = clean(req.body?.subtask_mode || req.body?.subtaskMode || rawRequest.subtask_mode || rawRequest.subtaskMode || 'cycle');
    const existing = await existingProfiles(strategy.id, strategy.campaign_id);
    const created = [];

    await dbOperations.run('DELETE FROM finder_subtasks WHERE finder_task_id = ? AND status = ?', [task.id, 'pending']);

    if (subtaskMode === 'route_cycle') {
      for (const cycle of cycles) {
        const pairs = sourceTargetPairsForSubagents(cycle, strategy, requestedTargets, requestedRoutes);
        const sourceQuery = keywordString(cycle, strategy);
        for (const pair of pairs) {
          const name = `${cycle.cycle} ${routeLabel(pair.discoveryRoute)} → ${pair.targetPlatform}`;
          const inserted = await dbOperations.run(
            `INSERT INTO finder_subtasks
             (finder_task_id, strategy_id, campaign_id, name, status, discovery_route, source_platform, target_platform, search_cycle, source_query, agent_prompt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              task.id,
              strategy.id,
              strategy.campaign_id,
              name,
              'pending',
              pair.discoveryRoute,
              pair.sourcePlatform,
              pair.targetPlatform,
              cycle.cycle,
              sourceQuery,
              ''
            ]
          );
          const prompt = buildSubagentPrompt({
            subtaskId: inserted.id,
            task,
            strategy,
            cycle,
            pair,
            sourceQuery,
            seedUrls,
            existing
          });
          await dbOperations.run('UPDATE finder_subtasks SET agent_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [prompt, inserted.id]);
          created.push(await dbOperations.get('SELECT * FROM finder_subtasks WHERE id = ?', [inserted.id]));
        }
      }
    } else {
      const routePlans = buildRouteCoveragePlan(cycles, strategy, requestedTargets, requestedRoutes, seedUrls);
      for (const cycle of cycles) {
        const routePlan = routePlans.find((plan) => plan.cycle === cycle.cycle);
        const sourceQuery = routePlan?.source_query || keywordString(cycle, strategy);
        const targetPlatforms = routePlan?.target_platforms || requestedTargets;
        const routeNames = [...(routePlan?.required_routes || []), ...(routePlan?.optional_routes || []), ...(routePlan?.skipped_routes || [])].map((route) => route.route);
        const name = `${cycle.cycle} ${cycle.name || 'Cycle Research'} → ${(targetPlatforms || []).join(', ') || 'targets'}`;
        const initialStatus = routePlan?.cycle_status === 'skipped' ? 'completed' : 'pending';
        const initialSummary = {
          cycle_status: routePlan?.cycle_status === 'skipped' ? 'skipped' : 'pending',
          cycle_status_reason: routePlan?.cycle_status_reason || routePlan?.skipped_reason || '',
          route_plan: routePlan,
          route_coverage: routePlan?.cycle_status === 'skipped'
            ? (routePlan.skipped_routes || []).map((route) => ({
              route: route.route,
              status: 'skipped',
              reason: route.reason || routePlan.cycle_status_reason || routePlan.skipped_reason || 'skipped'
            }))
            : [],
          route_attempts: [],
          accepted_count: 0,
          rejected_count: 0,
          failed_count: 0
        };
        const inserted = await dbOperations.run(
          `INSERT INTO finder_subtasks
           (finder_task_id, strategy_id, campaign_id, name, status, discovery_route, source_platform, target_platform, search_cycle, source_query, agent_prompt, agent_result_summary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            task.id,
            strategy.id,
            strategy.campaign_id,
            name,
            initialStatus,
            'cycle_multi_route',
            'multi',
            (targetPlatforms || []).join(','),
            cycle.cycle,
            sourceQuery,
            '',
            JSON.stringify(initialSummary)
          ]
        );
        const prompt = buildSubagentPrompt({
          subtaskId: inserted.id,
          task,
          strategy,
          cycle,
          routePlan,
          sourceQuery,
          seedUrls,
          existing
        });
        await dbOperations.run('UPDATE finder_subtasks SET agent_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [prompt, inserted.id]);
        const row = await dbOperations.get('SELECT * FROM finder_subtasks WHERE id = ?', [inserted.id]);
        created.push({ ...row, route_plan_routes: routeNames });
      }
    }

    await updateTask(task.id, {
      status: 'draft',
      total_cycles: created.length,
      completed_cycles: created.filter((row) => row.status === 'completed').length,
      raw_response_summary: JSON.stringify(created.map((row) => ({
        subtask_id: row.id,
        discovery_route: row.discovery_route,
        source_platform: row.source_platform,
        target_platform: row.target_platform,
        search_cycle: row.search_cycle,
        route_plan_routes: row.route_plan_routes || [],
        cycle_status: parseJson(row.agent_result_summary, {})?.cycle_status || 'pending',
        cycle_status_reason: parseJson(row.agent_result_summary, {})?.cycle_status_reason || '',
        status: row.status
      })))
    });
    res.json({
      success: true,
      data: created.map((row) => ({
        ...row,
        agent_result_summary: parseJson(row.agent_result_summary, null)
      }))
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
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
    const requestedCycles = body.cycles?.length ? body.cycles : (strategy.search_strategy || DEFAULT_SEARCH_CYCLES).map((cycle) => cycle.cycle);
    const cycles = (strategy.search_strategy || DEFAULT_SEARCH_CYCLES)
      .filter((cycle) => requestedCycles.includes(cycle.cycle))
      .map((cycle) => ({ ...cycle, target_count: Math.min(Number(body.limit_per_platform || cycle.target_count || 10), 50) }));
    if (!cycles.length) return res.status(400).json({ success: false, error: 'Please select at least one search cycle' });
    const targetPlatforms = (body.target_platforms || body.platforms || []).filter((p) => TARGET_PLATFORMS.includes(p));
    const searchSources = (body.search_sources || []).filter((source) => SEARCH_SOURCES.includes(source));
    const discoveryRoutes = (body.discovery_routes || body.discoveryRoutes || []).filter((route) => route !== 'cycle_multi_route' && DISCOVERY_ROUTES.includes(route));
    const normalizedCycles = cycles.map((cycle) => ({
      ...cycle,
      discovery_routes: discoveryRoutes.length ? discoveryRoutes : discoveryRoutesForCycle(cycle, strategy, [], targetPlatforms),
      search_sources: searchSources.length ? searchSources : searchSourcesForCycle(cycle),
      target_platforms: targetPlatforms.length ? targetPlatforms : targetPlatformsForCycle(cycle, strategy)
    }));
    const rawRequest = {
      strategy_id: strategy.id,
      execution_mode: clean(body.execution_mode || body.executionMode || 'system_provider'),
      subtask_mode: clean(body.subtask_mode || body.subtaskMode || 'cycle'),
      cycles: normalizedCycles.map((c) => c.cycle),
      discovery_routes: discoveryRoutes,
      search_sources: searchSources,
      target_platforms: targetPlatforms,
      seed_urls: parseList(body.seed_urls || body.seedUrls),
      limit_per_platform: Number(body.limit_per_platform || 10),
      allow_fallback: body.allow_fallback !== false
    };
    const result = await dbOperations.run(
      `INSERT INTO finder_tasks
       (campaign_id, strategy_id, name, platform, keywords, status, search_sources, discovery_routes, target_platforms, search_cycles, total_cycles, raw_request, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        strategy.campaign_id,
        strategy.id,
        `${strategy.name} Finder ${new Date().toLocaleString()}`,
        (targetPlatforms.length ? targetPlatforms : [...new Set(normalizedCycles.flatMap((cycle) => cycle.target_platforms || []))]).join(','),
        normalizedCycles.map((cycle) => keywordString(cycle, strategy)).join(' | '),
        'draft',
        JSON.stringify(searchSources.length ? searchSources : [...new Set(normalizedCycles.flatMap((cycle) => cycle.search_sources || []))]),
        JSON.stringify(discoveryRoutes.length ? discoveryRoutes : [...new Set(normalizedCycles.flatMap((cycle) => cycle.discovery_routes || []))]),
        JSON.stringify(targetPlatforms.length ? targetPlatforms : [...new Set(normalizedCycles.flatMap((cycle) => cycle.target_platforms || []))]),
        JSON.stringify(normalizedCycles),
        normalizedCycles.length,
        JSON.stringify(rawRequest),
        body.notes || ''
      ]
    );
    const task = await dbOperations.get('SELECT * FROM finder_tasks WHERE id = ?', [result.id]);
    if (rawRequest.execution_mode !== 'subagent_hybrid') {
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
    } else {
      await updateTask(result.id, { source_agent: 'subagent_hybrid', status: 'draft' });
    }
    res.json({ success: true, data: task, message: rawRequest.execution_mode === 'subagent_hybrid' ? 'Finder task created for subagent subtasks' : 'Finder task started' });
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
