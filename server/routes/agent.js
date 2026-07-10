const express = require('express');
const { dbOperations } = require('../database');

const router = express.Router();
const AGENT_API_PROVIDER_KEY = 'agent.external_api';
const TARGET_PLATFORMS = ['youtube', 'instagram', 'tiktok'];

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

function bearerToken(req) {
  const auth = clean(req.headers.authorization);
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return clean(req.headers['x-agent-token'] || req.query.agent_token || req.body?.agent_token);
}

async function requireAgentToken(req, res, next) {
  try {
    const row = await dbOperations.get(
      'SELECT api_key FROM api_settings WHERE provider = ?',
      [AGENT_API_PROVIDER_KEY]
    );
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
    scoring_weights: parseJson(row.scoring_weights, {}),
    finder_handoff: parseJson(row.finder_handoff, {}),
    source_material_meta: parseJson(row.source_material_meta, {})
  };
}

async function getReadyStrategy(strategyId) {
  const row = await dbOperations.get(
    'SELECT ks.*, c.name AS campaign_name, c.brand AS campaign_brand, ' +
    'c.product AS campaign_product FROM kol_strategies ks ' +
    'LEFT JOIN campaigns c ON c.id = ks.campaign_id WHERE ks.id = ?',
    [strategyId]
  );
  if (!row) throw new Error('Strategy not found');
  if (row.status !== 'ready') throw new Error('Only published Strategy can be used by external agents');
  return normalizeStrategy(row);
}

function suggestedTargetPlatforms(strategy) {
  const saved = [
    strategy.primary_platform,
    ...(strategy.secondary_platforms || []),
    ...parseList(strategy.finder_handoff?.required_platforms)
  ].filter((platform) => TARGET_PLATFORMS.includes(platform));
  return [...new Set(saved.length ? saved : ['youtube'])];
}

async function existingProfiles(strategyId, campaignId) {
  const customers = await dbOperations.query(
    'SELECT id, name, email, profile_url, youtube_url, instagram_url, tiktok_url, ' +
    'cooperation_status, cooperation_risk_category, cooperation_risk_reason ' +
    'FROM customers ORDER BY updated_at DESC, id DESC LIMIT 200'
  );
  const rawCandidates = await dbOperations.query(
    'SELECT id, strategy_id, campaign_id, platform, kol_name, email, profile_url, status ' +
    'FROM raw_candidates WHERE strategy_id = ? OR campaign_id = ? ' +
    'ORDER BY updated_at DESC, id DESC LIMIT 200',
    [strategyId, campaignId]
  );
  return { kol_master: customers, raw_candidates: rawCandidates };
}

router.get('/brief/:strategyId', requireAgentToken, async (req, res) => {
  try {
    const strategy = await getReadyStrategy(req.params.strategyId);
    const existing = await existingProfiles(strategy.id, strategy.campaign_id);
    res.json({
      success: true,
      data: {
        brief_version: 'video-evidence-signals-v1',
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
        finder: {
          workflow: 'target_platform_video_evidence',
          suggested_target_platforms: suggestedTargetPlatforms(strategy),
          confirmation_required: true,
          rules: [
            'Create one Finder task for exactly one confirmed target platform.',
            'Find and import relevant videos from that same target platform.',
            'A profile URL is identity only and is never accepted as video evidence.',
            'AI assigns zero or more evidence signals after video analysis.',
            'Generate Raw Candidates only from analyzed video evidence.'
          ],
          evidence_signals: ['competitor', 'category', 'use_case', 'feature', 'community']
        },
        existing,
        write_api: {
          create_task: {
            method: 'POST',
            path: '/api/finder-tasks',
            body: {
              strategy_id: strategy.id,
              target_platform: suggestedTargetPlatforms(strategy)[0],
              limit: 10
            }
          },
          import_video_evidence: {
            method: 'POST',
            path: '/api/finder-tasks/{finder_task_id}/video-evidence/import',
            accepted_shape: {
              videos: [{
                video_url: 'target-platform video URL',
                author_profile_url: 'creator profile URL',
                source_query: 'query that found the video',
                evidence_reason: 'why this video may be relevant'
              }]
            }
          },
          score_evidence: {
            method: 'POST',
            path: '/api/finder-tasks/{finder_task_id}/evidence-analysis'
          },
          generate_candidates: {
            method: 'POST',
            path: '/api/finder-tasks/{finder_task_id}/generate-candidates-from-evidence'
          }
        },
        rules: {
          approve_is_manual: true,
          agent_must_not_approve: true,
          direct_raw_candidate_import: false
        }
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/raw-candidates/import', requireAgentToken, (req, res) => {
  res.status(410).json({
    success: false,
    error: 'Direct Agent Raw Candidate import is retired. Import target-platform video evidence through Finder.'
  });
});

module.exports = router;