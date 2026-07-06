const express = require('express');
const { dbOperations } = require('../database');

const router = express.Router();

const AGENT_API_PROVIDER_KEY = 'agent.external_api';
const ALLOWED_STATUSES = new Set(['new', 'ignored', 'duplicate', 'risk_review', 'error']);
const CYCLE_ORDER = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'];

const DISCOVERY_ROUTE_OPTIONS = {
  youtube: [
    { route: 'youtube_native_search', label: 'YouTube Native Search', executor: 'system_or_agent', default_enabled: true },
    { route: 'google_web_to_youtube', label: 'Google Web -> YouTube', executor: 'external_agent', default_enabled: true },
    { route: 'spider_web_expansion', label: 'Spider-web Expansion', executor: 'external_agent', default_enabled: true }
  ],
  instagram: [
    { route: 'youtube_to_instagram', label: 'YouTube -> Instagram', executor: 'external_agent', default_enabled: true },
    { route: 'google_web_to_instagram', label: 'Google/Web -> Instagram', executor: 'external_agent', default_enabled: true },
    { route: 'seed_posts_to_profile', label: 'Seed Posts/Reels -> Instagram Profile', executor: 'system_or_agent', default_enabled: true },
    { route: 'instagram_native_small_batch', label: 'Instagram Native Small Batch', executor: 'system', default_enabled: false, caution: 'Slow and noisy; use only as fallback with short queries.' }
  ],
  tiktok: [
    { route: 'google_web_to_tiktok', label: 'Google/Web -> TikTok', executor: 'external_agent', default_enabled: true },
    { route: 'seed_posts_to_profile', label: 'Seed Videos -> TikTok Profile', executor: 'system_or_agent', default_enabled: true },
    { route: 'tiktok_native_small_batch', label: 'TikTok Native Small Batch', executor: 'system', default_enabled: false }
  ]
};

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

function asJson(value, fallback = {}) {
  if (value === undefined || value === null || value === '') return JSON.stringify(fallback);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return clean(value).split(/[,，;\n]/).map(clean).filter(Boolean);
}

function normalizeSearchStrategy(cycles) {
  const list = Array.isArray(cycles) ? cycles : [];
  return [...list].sort((a, b) => {
    const ai = CYCLE_ORDER.indexOf(clean(a?.cycle).toUpperCase());
    const bi = CYCLE_ORDER.indexOf(clean(b?.cycle).toUpperCase());
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

function recommendedDiscoveryRoutes(strategy) {
  const targets = [
    strategy.primary_platform,
    ...(Array.isArray(strategy.secondary_platforms) ? strategy.secondary_platforms : []),
    ...parseList(strategy.finder_handoff?.required_platforms)
  ].filter(Boolean);
  const uniqueTargets = [...new Set(targets.length ? targets : ['youtube'])];
  return Object.fromEntries(uniqueTargets.map((platform) => [
    platform,
    DISCOVERY_ROUTE_OPTIONS[platform] || []
  ]));
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function bearerToken(req) {
  const auth = clean(req.headers.authorization);
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return clean(req.headers['x-agent-token'] || req.query.agent_token || req.body?.agent_token);
}

async function requireAgentToken(req, res, next) {
  try {
    const row = await dbOperations.get('SELECT api_key FROM api_settings WHERE provider = ?', [AGENT_API_PROVIDER_KEY]);
    const expected = clean(row?.api_key);
    if (!expected) {
      return res.status(403).json({ success: false, error: 'External Agent API Token is not configured' });
    }
    if (bearerToken(req) !== expected) {
      return res.status(401).json({ success: false, error: 'Invalid External Agent API Token' });
    }
    return next();
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

function normalizeStrategy(row) {
  if (!row) return row;
  return {
    ...row,
    secondary_platforms: parseJson(row.secondary_platforms, []),
    product_context: parseJson(row.product_context, {}),
    persona_config: parseJson(row.persona_config, {}),
    search_strategy: normalizeSearchStrategy(parseJson(row.search_strategy, [])),
    scoring_weights: parseJson(row.scoring_weights, {}),
    finder_handoff: parseJson(row.finder_handoff, {}),
    source_material_meta: parseJson(row.source_material_meta, {})
  };
}

async function getReadyStrategy(strategyId) {
  const row = await dbOperations.get(`
    SELECT ks.*, c.name as campaign_name, c.brand as campaign_brand, c.product as campaign_product
    FROM kol_strategies ks
    LEFT JOIN campaigns c ON c.id = ks.campaign_id
    WHERE ks.id = ?
  `, [strategyId]);
  if (!row) throw new Error('Strategy not found');
  if (row.status !== 'ready') throw new Error('Only published Strategy can be used by external agents');
  return normalizeStrategy(row);
}

async function existingProfiles(strategyId, campaignId) {
  const customers = await dbOperations.query(`
    SELECT id, name, email, profile_url, youtube_url, instagram_url, tiktok_url,
      cooperation_status, cooperation_risk_category, cooperation_risk_reason
    FROM customers
    ORDER BY updated_at DESC, id DESC
  `);
  const raw = await dbOperations.query(`
    SELECT id, strategy_id, campaign_id, platform, kol_name, email, profile_url, status
    FROM raw_candidates
    WHERE strategy_id = ? OR campaign_id = ?
    ORDER BY updated_at DESC, id DESC
  `, [strategyId, campaignId]);
  return {
    kol_master: customers,
    raw_candidates: raw
  };
}

async function masterExists(candidate) {
  const profileUrl = clean(candidate.profile_url);
  const email = clean(candidate.email);
  const name = clean(candidate.kol_name || candidate.name);
  if (profileUrl) {
    const row = await dbOperations.get(
      'SELECT * FROM customers WHERE profile_url = ? OR youtube_url = ? OR instagram_url = ? OR tiktok_url = ? LIMIT 1',
      [profileUrl, profileUrl, profileUrl, profileUrl]
    );
    if (row) return row;
  }
  if (email) {
    const row = await dbOperations.get('SELECT * FROM customers WHERE email = ? LIMIT 1', [email]);
    if (row) return row;
  }
  if (name) return dbOperations.get('SELECT * FROM customers WHERE name = ? LIMIT 1', [name]);
  return null;
}

async function rawExists(candidate, strategyId) {
  const profileUrl = clean(candidate.profile_url);
  const email = clean(candidate.email);
  const platform = clean(candidate.platform);
  const name = clean(candidate.kol_name || candidate.name);
  if (profileUrl) {
    const row = await dbOperations.get('SELECT * FROM raw_candidates WHERE strategy_id = ? AND profile_url = ? LIMIT 1', [strategyId, profileUrl]);
    if (row) return row;
  }
  if (email) {
    const row = await dbOperations.get('SELECT * FROM raw_candidates WHERE strategy_id = ? AND email = ? LIMIT 1', [strategyId, email]);
    if (row) return row;
  }
  if (platform && name) {
    return dbOperations.get('SELECT * FROM raw_candidates WHERE strategy_id = ? AND platform = ? AND kol_name = ? LIMIT 1', [strategyId, platform, name]);
  }
  return null;
}

function normalizeCandidate(input, defaults) {
  const candidate = input || {};
  const requestedStatus = clean(candidate.status);
  const status = ALLOWED_STATUSES.has(requestedStatus) ? requestedStatus : defaults.status;
  return {
    finder_task_id: defaults.finder_task_id,
    campaign_id: defaults.campaign_id,
    strategy_id: defaults.strategy_id,
    platform: clean(candidate.platform || defaults.platform),
    kol_name: clean(candidate.kol_name || candidate.name || candidate.creator_name || candidate.username || candidate.profile_url),
    contact_name: clean(candidate.contact_name),
    profile_url: clean(candidate.profile_url || candidate.profileUrl || candidate.channel_url),
    video_url: clean(candidate.video_url || candidate.representative_video_url || candidate.evidence_video_url),
    video_title: clean(candidate.video_title || candidate.representative_video_title || candidate.evidence_title),
    followers: clean(candidate.followers || candidate.follower_count || candidate.subscriber_count),
    avg_views: clean(candidate.avg_views || candidate.average_views || candidate.views),
    email: clean(candidate.email),
    phone: clean(candidate.phone),
    country_region: clean(candidate.country_region || candidate.country || candidate.region),
    matched_keywords: clean(candidate.matched_keywords || candidate.keywords || candidate.source_query),
    ai_score: normalizeNumber(candidate.ai_score || candidate.score),
    ai_match_reason: clean(candidate.ai_match_reason || candidate.reason || candidate.agent_reason),
    status,
    source: clean(candidate.source || defaults.source),
    discovery_route: clean(candidate.discovery_route || candidate.discoveryRoute || defaults.discovery_route),
    source_platform: clean(candidate.source_platform || candidate.sourcePlatform || defaults.source_platform),
    target_platform: clean(candidate.target_platform || candidate.targetPlatform || candidate.platform || defaults.target_platform || defaults.platform),
    source_agent: clean(candidate.source_agent || candidate.sourceAgent || defaults.source_agent || defaults.source),
    raw_data: {
      external_agent: defaults.source,
      discovery_route: clean(candidate.discovery_route || candidate.discoveryRoute || defaults.discovery_route),
      source_platform: clean(candidate.source_platform || candidate.sourcePlatform || defaults.source_platform),
      target_platform: clean(candidate.target_platform || candidate.targetPlatform || candidate.platform || defaults.target_platform || defaults.platform),
      cross_platform_links: candidate.cross_platform_links || candidate.crossPlatformLinks || {},
      seed_url: clean(candidate.seed_url || candidate.seedUrl || defaults.seed_url),
      finder_run: defaults.finder_run,
      data: candidate.raw_data || candidate
    },
    error_message: clean(candidate.error_message || candidate.reject_reason || candidate.rejection_reason),
    search_cycle: clean(candidate.search_cycle || candidate.cycle || defaults.search_cycle),
    matched_persona: clean(candidate.matched_persona || candidate.persona),
    scoring_breakdown: candidate.scoring_breakdown || candidate.score_breakdown || {},
    evidence_url: clean(candidate.evidence_url || candidate.evidenceUrl || candidate.profile_url || candidate.video_url),
    evidence_title: clean(candidate.evidence_title || candidate.evidenceTitle || candidate.video_title),
    evidence_type: clean(candidate.evidence_type || candidate.evidenceType || (candidate.video_url ? 'video' : 'profile')),
    source_query: clean(candidate.source_query || candidate.query || candidate.matched_keywords)
  };
}

async function upsertCandidate(candidate) {
  if (!candidate.kol_name && !candidate.profile_url) {
    return { success: false, skipped: true, error: 'Missing kol_name/profile_url' };
  }
  const existing = await rawExists(candidate, candidate.strategy_id);
  const shouldIgnore = candidate.status === 'ignored' || candidate.status === 'error';
  const master = await masterExists(candidate);
  const globalRisk = master?.cooperation_status === 'do_not_contact';
  const status = shouldIgnore ? candidate.status : globalRisk ? 'risk_review' : (master ? 'duplicate' : 'new');
  const rawData = JSON.stringify({
    ...(candidate.raw_data || candidate),
    global_cooperation_risk: globalRisk ? {
      customer_id: master.id,
      cooperation_status: master.cooperation_status,
      category: master.cooperation_risk_category || '',
      reason: master.cooperation_risk_reason || ''
    } : undefined
  });
  const scoring = asJson(candidate.scoring_breakdown, {});

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
       matched_keywords = COALESCE(NULLIF(matched_keywords, ''), ?),
       ai_score = COALESCE(ai_score, ?),
       ai_match_reason = COALESCE(NULLIF(ai_match_reason, ''), ?),
       error_message = COALESCE(NULLIF(error_message, ''), ?),
       status = CASE WHEN status IN ('approved', 'duplicate', 'ignored') THEN status WHEN ? = 'risk_review' THEN ? ELSE status END,
       rejection_scope = CASE WHEN ? = 'risk_review' THEN 'global' ELSE rejection_scope END,
       rejection_category = CASE WHEN ? = 'risk_review' THEN ? ELSE rejection_category END,
       rejection_reason = CASE WHEN ? = 'risk_review' THEN ? ELSE rejection_reason END,
       scoring_breakdown = CASE WHEN scoring_breakdown IS NULL OR scoring_breakdown = '' OR scoring_breakdown = '{}' THEN ? ELSE scoring_breakdown END,
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
        candidate.source_agent,
        candidate.matched_keywords,
        candidate.ai_score,
        candidate.ai_match_reason,
        candidate.error_message,
        status,
        status,
        status,
        status,
        master?.cooperation_risk_category || '',
        status,
        master?.cooperation_risk_reason || '',
        scoring,
        rawData,
        existing.id
      ]
    );
    return { success: true, id: existing.id, status: existing.status || status, duplicate_raw: true };
  }

  const result = await dbOperations.run(
    `INSERT INTO raw_candidates
     (finder_task_id, campaign_id, strategy_id, platform, kol_name, contact_name, profile_url, video_url, video_title,
      followers, avg_views, email, phone, country_region, matched_keywords, ai_score, ai_match_reason,
      status, source, discovery_route, source_platform, target_platform, source_agent,
      raw_data, error_message, search_cycle, matched_persona, scoring_breakdown,
      evidence_url, evidence_title, evidence_type, source_query, rejection_scope, rejection_category, rejection_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      candidate.finder_task_id,
      candidate.campaign_id,
      candidate.strategy_id,
      candidate.platform,
      candidate.kol_name,
      candidate.contact_name,
      candidate.profile_url,
      candidate.video_url,
      candidate.video_title,
      candidate.followers,
      candidate.avg_views,
      candidate.email,
      candidate.phone,
      candidate.country_region,
      candidate.matched_keywords,
      candidate.ai_score,
      candidate.ai_match_reason,
      status,
      candidate.source,
      candidate.discovery_route,
      candidate.source_platform,
      candidate.target_platform,
      candidate.source_agent,
      rawData,
      candidate.error_message,
      candidate.search_cycle,
      candidate.matched_persona,
      scoring,
      candidate.evidence_url,
      candidate.evidence_title,
      candidate.evidence_type,
      candidate.source_query,
      status === 'ignored' ? 'project' : status === 'risk_review' ? 'global' : '',
      status === 'risk_review' ? master?.cooperation_risk_category || '' : '',
      status === 'risk_review' ? master?.cooperation_risk_reason || '' : ''
    ]
  );
  return { success: true, id: result.id, status, global_cooperation_risk: globalRisk };
}

router.get('/brief/:strategyId', requireAgentToken, async (req, res) => {
  try {
    const strategy = await getReadyStrategy(req.params.strategyId);
    const existing = await existingProfiles(strategy.id, strategy.campaign_id);
    res.json({
      success: true,
      data: {
        brief_version: 'finder-v2-agent-brief',
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
        strategy,
        finder_v2: {
          target_platforms: Object.keys(recommendedDiscoveryRoutes(strategy)),
          target_platform_confirmation_required: true,
          target_platform_confirmation_note: 'Saved Strategy platforms are historical context only. Confirm the current target KOL platform(s) before Finder unless the current request or UI/API payload explicitly selected them.',
          recommended_discovery_routes: recommendedDiscoveryRoutes(strategy),
          instagram_native_search_policy: {
            default_enabled: false,
            route: 'instagram_native_small_batch',
            reason: 'Instagram profile search is slow/noisy; use as fallback only with short queries and human-reviewed evidence.'
          },
          required_candidate_context: [
            'discovery_route',
            'source_platform',
            'target_platform',
            'evidence_url',
            'evidence_type',
            'source_query'
          ]
        },
        existing,
        rules: {
          approve_is_manual: true,
          agent_may_write_statuses: ['new', 'ignored', 'duplicate', 'risk_review', 'error'],
          agent_must_not_approve: true,
          raw_candidates_are_review_queue: true
        },
        write_api: {
          method: 'POST',
          path: '/api/agent/raw-candidates/import',
          auth: 'Authorization: Bearer <External Agent API Token>',
          accepted_shape: {
            strategy_id: strategy.id,
            source_agent: 'codex_agent | workbuddy_agent',
            finder_run: { name: 'optional run name', notes: 'optional notes' },
            target_platforms: ['instagram'],
            discovery_routes: ['youtube_to_instagram', 'google_web_to_instagram'],
            candidates: []
          }
        }
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/raw-candidates/import', requireAgentToken, async (req, res) => {
  try {
    const body = req.body || {};
    const strategy = await getReadyStrategy(body.strategy_id);
    const source = clean(body.source_agent || body.agent || 'external_agent');
    const accepted = Array.isArray(body.accepted_candidates) ? body.accepted_candidates : [];
    const rejected = Array.isArray(body.rejected_candidates) ? body.rejected_candidates : [];
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    const all = [
      ...candidates.map((item) => ({ ...item, status: item.status || 'new' })),
      ...accepted.map((item) => ({ ...item, status: item.status || 'new' })),
      ...rejected.map((item) => ({ ...item, status: 'ignored' }))
    ];
    if (!all.length) return res.status(400).json({ success: false, error: 'No candidates provided' });

    const runName = clean(body.finder_run?.name || `${strategy.name} External Agent ${new Date().toLocaleString()}`);
    const taskResult = await dbOperations.run(
      `INSERT INTO finder_tasks
       (campaign_id, strategy_id, name, platform, keywords, status, search_sources, discovery_routes, target_platforms,
        search_cycles, total_cycles, raw_request, notes, source_agent, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        strategy.campaign_id,
        strategy.id,
        runName,
        clean(body.platform || ''),
        clean(body.keywords || ''),
        'success',
        JSON.stringify([source]),
        JSON.stringify(body.discovery_routes || body.discoveryRoutes || []),
        JSON.stringify(body.target_platforms || []),
        JSON.stringify(body.search_cycles || []),
        Array.isArray(body.search_cycles) ? body.search_cycles.length : 0,
        JSON.stringify({ source_agent: source, finder_run: body.finder_run || {}, discovery_routes: body.discovery_routes || body.discoveryRoutes || [], count: all.length }),
        clean(body.finder_run?.notes || body.notes || 'Imported from external agent API'),
        source,
        new Date().toISOString(),
        new Date().toISOString()
      ]
    );

    const defaults = {
      finder_task_id: taskResult.id,
      campaign_id: strategy.campaign_id,
      strategy_id: strategy.id,
      source,
      platform: clean(body.platform || strategy.primary_platform || ''),
      target_platform: clean((body.target_platforms || [])[0] || body.platform || strategy.primary_platform || ''),
      source_agent: source,
      discovery_route: clean((body.discovery_routes || body.discoveryRoutes || [])[0] || ''),
      source_platform: clean(body.source_platform || body.sourcePlatform || ''),
      seed_url: clean(body.seed_url || body.seedUrl || ''),
      search_cycle: clean(body.search_cycle || ''),
      status: 'new',
      finder_run: body.finder_run || {}
    };
    const results = [];
    for (const item of all) {
      try {
        const normalized = normalizeCandidate(item, defaults);
        const saved = await upsertCandidate(normalized);
        results.push({ ...saved, kol_name: normalized.kol_name, profile_url: normalized.profile_url });
      } catch (error) {
        results.push({ success: false, error: error.message, kol_name: item.kol_name || item.name || '' });
      }
    }

    const successCount = results.filter((item) => item.success && item.status !== 'ignored').length;
    const rejectedCount = results.filter((item) => item.success && item.status === 'ignored').length;
    const failedCount = results.filter((item) => !item.success).length;
    const finalStatus = successCount > 0 && failedCount > 0 ? 'partial_failed' : failedCount === results.length ? 'failed' : 'success';
    await dbOperations.run(
      `UPDATE finder_tasks SET
       status = ?, success_count = ?, failed_count = ?, result_count = ?,
       raw_response_summary = ?, provider_attempts = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        finalStatus,
        successCount,
        failedCount,
        successCount,
        JSON.stringify([{ source_agent: source, discovery_routes: body.discovery_routes || body.discoveryRoutes || [], accepted_count: successCount, rejected_count: rejectedCount, failed_count: failedCount }]),
        JSON.stringify([{ provider: source, source_agent: source, discovery_routes: body.discovery_routes || body.discoveryRoutes || [], ok: finalStatus !== 'failed', imported_count: all.length }]),
        finalStatus === 'failed' ? 'External agent import failed for all candidates' : '',
        taskResult.id
      ]
    );

    res.json({
      success: true,
      data: {
        finder_task_id: taskResult.id,
        success_count: successCount,
        rejected_count: rejectedCount,
        failed_count: failedCount,
        results
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
