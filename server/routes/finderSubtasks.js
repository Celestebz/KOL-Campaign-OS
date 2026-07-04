const express = require('express');
const { dbOperations } = require('../database');

const router = express.Router();

const ALLOWED_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'cancelled']);

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

function mergeSummary(base, extra) {
  return {
    ...(parseJson(base, {})),
    ...(typeof extra === 'string' ? parseJson(extra, {}) : (extra || {}))
  };
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function getSubtask(id) {
  return dbOperations.get(`
    SELECT fs.*, ft.name as finder_task_name, ft.raw_request, ks.name as strategy_name
    FROM finder_subtasks fs
    LEFT JOIN finder_tasks ft ON ft.id = fs.finder_task_id
    LEFT JOIN kol_strategies ks ON ks.id = fs.strategy_id
    WHERE fs.id = ?
  `, [id]);
}

async function masterExists(candidate) {
  const profileUrl = clean(candidate.profile_url);
  const email = clean(candidate.email);
  const name = clean(candidate.kol_name || candidate.name);
  if (profileUrl) {
    const row = await dbOperations.get(
      'SELECT id FROM customers WHERE profile_url = ? OR youtube_url = ? OR instagram_url = ? OR tiktok_url = ? LIMIT 1',
      [profileUrl, profileUrl, profileUrl, profileUrl]
    );
    if (row) return row;
  }
  if (email) {
    const row = await dbOperations.get('SELECT id FROM customers WHERE email = ? LIMIT 1', [email]);
    if (row) return row;
  }
  if (name) return dbOperations.get('SELECT id FROM customers WHERE name = ? LIMIT 1', [name]);
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

function normalizeCandidate(input, subtask, defaults) {
  const candidate = input || {};
  const rejected = defaults.status === 'ignored';
  const profileUrl = clean(candidate.profile_url || candidate.profileUrl || candidate.channel_url || candidate.url);
  const evidenceUrl = clean(candidate.evidence_url || candidate.evidenceUrl || candidate.video_url || candidate.representative_video_url || profileUrl);
  const evidenceType = clean(candidate.evidence_type || candidate.evidenceType || (evidenceUrl.includes('/reel/') || evidenceUrl.includes('watch?') ? 'video' : 'profile'));
  return {
    finder_task_id: subtask.finder_task_id,
    campaign_id: subtask.campaign_id,
    strategy_id: subtask.strategy_id,
    platform: clean(candidate.platform || subtask.target_platform),
    kol_name: clean(candidate.kol_name || candidate.name || candidate.creator_name || candidate.username || profileUrl),
    contact_name: clean(candidate.contact_name),
    profile_url: profileUrl,
    video_url: clean(candidate.video_url || candidate.representative_video_url || (evidenceType === 'video' ? evidenceUrl : '')),
    video_title: clean(candidate.video_title || candidate.representative_video_title || candidate.evidence_title || candidate.evidenceTitle),
    followers: clean(candidate.followers || candidate.follower_count || candidate.subscriber_count),
    avg_views: clean(candidate.avg_views || candidate.average_views || candidate.views),
    email: clean(candidate.email),
    phone: clean(candidate.phone),
    country_region: clean(candidate.country_region || candidate.country || candidate.region),
    matched_keywords: clean(candidate.matched_keywords || candidate.keywords || candidate.source_query || subtask.source_query),
    ai_score: normalizeNumber(candidate.ai_score || candidate.score),
    ai_match_reason: clean(candidate.ai_match_reason || candidate.reason || candidate.agent_reason),
    status: rejected ? 'ignored' : clean(candidate.status || 'new'),
    source: clean(defaults.source),
    discovery_route: clean(candidate.discovery_route || candidate.discoveryRoute || subtask.discovery_route),
    source_platform: clean(candidate.source_platform || candidate.sourcePlatform || subtask.source_platform),
    target_platform: clean(candidate.target_platform || candidate.targetPlatform || subtask.target_platform),
    source_agent: clean(candidate.source_agent || candidate.sourceAgent || defaults.source),
    raw_data: {
      finder_subtask_id: subtask.id,
      finder_task_id: subtask.finder_task_id,
      source_agent: defaults.source,
      data: candidate.raw_data || candidate
    },
    error_message: clean(candidate.error_message || candidate.reject_reason || candidate.rejection_reason),
    search_cycle: clean(candidate.search_cycle || candidate.cycle || subtask.search_cycle),
    matched_persona: clean(candidate.matched_persona || candidate.persona),
    scoring_breakdown: candidate.scoring_breakdown || candidate.score_breakdown || {},
    evidence_url: evidenceUrl,
    evidence_title: clean(candidate.evidence_title || candidate.evidenceTitle || candidate.video_title),
    evidence_type: evidenceType || 'profile',
    source_query: clean(candidate.source_query || candidate.query || subtask.source_query)
  };
}

function hasInvalidCycleRoute(candidate, subtask) {
  if (subtask.discovery_route !== 'cycle_multi_route') return false;
  const route = clean(candidate.discovery_route || candidate.discoveryRoute || subtask.discovery_route);
  return route === 'cycle_multi_route';
}

async function upsertCandidate(candidate) {
  if (!candidate.kol_name && !candidate.profile_url) {
    return { success: false, skipped: true, error: 'Missing kol_name/profile_url' };
  }
  const existing = await rawExists(candidate, candidate.strategy_id);
  const shouldIgnore = candidate.status === 'ignored' || candidate.status === 'error';
  const status = shouldIgnore ? candidate.status : (await masterExists(candidate) ? 'duplicate' : 'new');
  const rawData = JSON.stringify(candidate.raw_data || candidate);
  const scoring = asJson(candidate.scoring_breakdown, {});

  if (existing) {
    await dbOperations.run(
      `UPDATE raw_candidates SET
       followers = COALESCE(NULLIF(followers, ''), ?),
       avg_views = COALESCE(NULLIF(avg_views, ''), ?),
       email = COALESCE(NULLIF(email, ''), ?),
       country_region = COALESCE(NULLIF(country_region, ''), ?),
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
       scoring_breakdown = CASE WHEN scoring_breakdown IS NULL OR scoring_breakdown = '' OR scoring_breakdown = '{}' THEN ? ELSE scoring_breakdown END,
       raw_data = ?,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        candidate.followers,
        candidate.avg_views,
        candidate.email,
        candidate.country_region,
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
      evidence_url, evidence_title, evidence_type, source_query)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      candidate.source_query
    ]
  );
  return { success: true, id: result.id, status };
}

async function refreshParentSummary(finderTaskId) {
  const rows = await dbOperations.query('SELECT * FROM finder_subtasks WHERE finder_task_id = ? ORDER BY id ASC', [finderTaskId]);
  const successCount = rows.reduce((sum, row) => sum + Number(row.accepted_count || 0), 0);
  const rejectedCount = rows.reduce((sum, row) => sum + Number(row.rejected_count || 0), 0);
  const failedCount = rows.reduce((sum, row) => sum + Number(row.failed_count || 0), 0);
  const completed = rows.filter((row) => ['completed', 'failed', 'cancelled'].includes(row.status)).length;
  const hasRunning = rows.some((row) => row.status === 'running');
  const hasProgress = rows.some((row) => ['completed', 'failed'].includes(row.status) || Number(row.accepted_count || 0) || Number(row.rejected_count || 0));
  const allDone = rows.length > 0 && completed === rows.length;
  const status = allDone
    ? failedCount > 0 && successCount > 0 ? 'partial_failed' : failedCount > 0 && successCount === 0 ? 'failed' : 'success'
    : hasRunning || hasProgress ? 'running' : 'draft';
  await dbOperations.run(
    `UPDATE finder_tasks SET
     status = ?, completed_cycles = ?, total_cycles = ?, success_count = ?, failed_count = ?, result_count = ?,
     raw_response_summary = ?, provider_attempts = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      status,
      completed,
      rows.length,
      successCount,
      failedCount,
      successCount,
      JSON.stringify(rows.map((row) => ({
        subtask_id: row.id,
        discovery_route: row.discovery_route,
        source_platform: row.source_platform,
        target_platform: row.target_platform,
        search_cycle: row.search_cycle,
        route_plan: parseJson(row.agent_result_summary, {})?.route_plan || null,
        route_coverage: parseJson(row.agent_result_summary, {})?.route_coverage || [],
        accepted_count: row.accepted_count || 0,
        rejected_count: row.rejected_count || 0,
        failed_count: row.failed_count || 0,
        status: row.status
      }))),
      JSON.stringify(rows.map((row) => ({
        provider: row.source_platform,
        source_agent: `subagent_${row.discovery_route}`,
        discovery_route: row.discovery_route,
        ok: row.status !== 'failed',
        imported_count: Number(row.accepted_count || 0) + Number(row.rejected_count || 0)
      }))),
      finderTaskId
    ]
  );
}

router.get('/:id/prompt', async (req, res) => {
  try {
    const subtask = await getSubtask(req.params.id);
    if (!subtask) return res.status(404).json({ success: false, error: 'Finder subtask not found' });
    res.json({ success: true, data: { ...subtask, agent_prompt: subtask.agent_prompt || '' } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/status', async (req, res) => {
  try {
    const status = clean(req.body?.status);
    if (!ALLOWED_STATUSES.has(status)) return res.status(400).json({ success: false, error: 'Invalid subtask status' });
    const subtask = await getSubtask(req.params.id);
    if (!subtask) return res.status(404).json({ success: false, error: 'Finder subtask not found' });
    const summary = req.body?.agent_result_summary || req.body?.route_coverage || req.body?.route_attempts
      ? JSON.stringify({
        ...mergeSummary(subtask.agent_result_summary, req.body?.agent_result_summary),
        route_coverage: req.body?.route_coverage || parseJson(subtask.agent_result_summary, {})?.route_coverage || [],
        route_attempts: req.body?.route_attempts || parseJson(subtask.agent_result_summary, {})?.route_attempts || []
      })
      : subtask.agent_result_summary;
    await dbOperations.run(
      `UPDATE finder_subtasks SET
       status = ?,
       agent_result_summary = ?,
       started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN CURRENT_TIMESTAMP ELSE started_at END,
       finished_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN CURRENT_TIMESTAMP ELSE finished_at END,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, summary, status, status, subtask.id]
    );
    await refreshParentSummary(subtask.finder_task_id);
    const updated = await getSubtask(subtask.id);
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/import', async (req, res) => {
  try {
    const subtask = await getSubtask(req.params.id);
    if (!subtask) return res.status(404).json({ success: false, error: 'Finder subtask not found' });
    const body = req.body || {};
    const accepted = Array.isArray(body.accepted_candidates) ? body.accepted_candidates : [];
    const rejected = Array.isArray(body.rejected_candidates) ? body.rejected_candidates : [];
    const defaultSourceAgent = subtask.discovery_route === 'cycle_multi_route'
      ? `codex_subagent_${clean(subtask.search_cycle || 'cycle').toLowerCase()}_cycle`
      : `codex_subagent_${subtask.discovery_route}`;
    const source = clean(body.source_agent || defaultSourceAgent);
    const routeCoverage = Array.isArray(body.route_coverage) ? body.route_coverage : [];
    const routeAttempts = Array.isArray(body.route_attempts) ? body.route_attempts : [];
    if (!accepted.length && !rejected.length && !routeCoverage.length && !routeAttempts.length) {
      return res.status(400).json({ success: false, error: 'No candidates or route coverage provided' });
    }
    const invalidCycleRoute = [...accepted, ...rejected].find((item) => hasInvalidCycleRoute(item, subtask));
    if (invalidCycleRoute) {
      return res.status(400).json({
        success: false,
        error: 'Cycle subtask candidates must include a real discovery_route, not cycle_multi_route'
      });
    }

    const results = [];
    for (const item of accepted) {
      const normalized = normalizeCandidate(item, subtask, { source, status: 'new' });
      results.push({ ...(await upsertCandidate(normalized)), kol_name: normalized.kol_name, profile_url: normalized.profile_url });
    }
    for (const item of rejected) {
      const normalized = normalizeCandidate(item, subtask, { source, status: 'ignored' });
      results.push({ ...(await upsertCandidate(normalized)), kol_name: normalized.kol_name, profile_url: normalized.profile_url });
    }

    const successCount = results.filter((item) => item.success && item.status !== 'ignored').length;
    const rejectedCount = results.filter((item) => item.success && item.status === 'ignored').length;
    const failedCount = results.filter((item) => !item.success).length;
    const finalStatus = failedCount > 0 && successCount === 0 && rejectedCount === 0 ? 'failed' : 'completed';
    await dbOperations.run(
      `UPDATE finder_subtasks SET
       status = ?, accepted_count = ?, rejected_count = ?, failed_count = ?,
       agent_result_summary = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        finalStatus,
        successCount,
        rejectedCount,
        failedCount,
        JSON.stringify({
          ...mergeSummary(subtask.agent_result_summary),
          source_agent: source,
          accepted_count: successCount,
          rejected_count: rejectedCount,
          failed_count: failedCount,
          route_coverage: routeCoverage,
          route_attempts: routeAttempts,
          results
        }),
        subtask.id
      ]
    );
    await refreshParentSummary(subtask.finder_task_id);
    res.json({ success: true, data: { accepted_count: successCount, rejected_count: rejectedCount, failed_count: failedCount, route_coverage: routeCoverage, route_attempts: routeAttempts, results } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
