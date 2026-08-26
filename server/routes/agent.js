const express = require('express');
const { dbOperations } = require('../database');
const agentCampaignOps = require('../services/agentCampaignOps');
const { getTikTokMedianExposure } = require('../services/tiktokCreatorMetrics');
const { requireAgentToken } = require('../middleware/agentAuth');

const router = express.Router();
const TARGET_PLATFORMS = ['youtube', 'instagram', 'tiktok'];


const creatorMetricRequests = new Map();
function allowCreatorMetricRequest(req) {
  const key = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (creatorMetricRequests.get(key) || []).filter((time) => now - time < 60000);
  if (recent.length >= 5) return false;
  recent.push(now);
  creatorMetricRequests.set(key, recent);
  return true;
}

router.get('/creator-metrics/tiktok', async (req, res) => {
  try {
    if (!allowCreatorMetricRequest(req)) return res.status(429).json({ success: false, error: 'Too many creator metric requests; retry in one minute' });
    const input = req.query.profile_url || req.query.handle;
    const data = await getTikTokMedianExposure(input);
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ success: false, error: error.message });
  }
});
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

function campaignId(req) {
  const value = Number(req.params.campaignId);
  if (!Number.isSafeInteger(value) || value <= 0) {
    const error = new Error('campaignId must be a positive integer');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function sendAgentError(res, error) {
  res.status(error.statusCode || 400).json({ success: false, error: error.message });
}

router.get('/campaigns/:campaignId/kol-master/search', requireAgentToken, async (req, res) => {
  try {
    const data = await agentCampaignOps.searchKols(campaignId(req), req.query);
    res.json({ success: true, data });
  } catch (error) {
    sendAgentError(res, error);
  }
});

router.post('/campaigns/:campaignId/kol-master/batch-upsert', requireAgentToken, async (req, res) => {
  try {
    const data = await agentCampaignOps.batchKols(campaignId(req), req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    sendAgentError(res, error);
  }
});

router.post('/campaigns/:campaignId/kol-master/batch-update-email', requireAgentToken, async (req, res) => {
  try {
    const data = await agentCampaignOps.batchUpdateKolEmail(campaignId(req), req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    sendAgentError(res, error);
  }
});

router.post('/campaigns/:campaignId/candidate-pool/batch', requireAgentToken, async (req, res) => {
  try {
    const data = await agentCampaignOps.batchCandidates(campaignId(req), req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    sendAgentError(res, error);
  }
});

router.post('/campaigns/:campaignId/email-drafts/batch-upsert', requireAgentToken, async (req, res) => {
  try {
    const data = await agentCampaignOps.batchDrafts(campaignId(req), req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    sendAgentError(res, error);
  }
});

router.get('/campaigns/:campaignId/email-drafts', requireAgentToken, async (req, res) => {
  try {
    const data = await agentCampaignOps.listDrafts(campaignId(req), req.query);
    res.json({ success: true, data });
  } catch (error) {
    sendAgentError(res, error);
  }
});

module.exports = router;
