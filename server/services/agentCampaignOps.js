const crypto = require('crypto');
const { dbOperations } = require('../database');
const { PRIORITY_LEVELS, normalizePriorityLevel } = require('../utils/campaignKolEnums');
const { draftDedupeKey, isDuplicateError } = require('./emailDraftDedupe');

const ALLOWED_PLATFORMS = new Set(['youtube', 'instagram', 'tiktok', 'facebook', 'x']);
const MAX_CANDIDATE_BATCH = 100;
const MAX_DRAFT_BATCH = 50;
const SEARCH_PLATFORMS = {
  youtube: { url: 'youtube_url', followers: 'youtube_followers' },
  instagram: { url: 'instagram_url', followers: 'instagram_followers' },
  tiktok: { url: 'tiktok_url', followers: 'tiktok_followers' }
};

function positiveInt(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stable(value[key]);
      return out;
    }, {});
  }
  return value;
}

function requestHash(body) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(body))).digest('hex');
}

async function assertActiveCampaign(campaignId) {
  const campaign = await dbOperations.get('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
  if (!campaign) {
    const error = new Error('Campaign not found');
    error.statusCode = 404;
    throw error;
  }
  if (campaign.campaign_type !== 'active_project' || campaign.status !== 'active') {
    const error = new Error('Only active projects can be modified');
    error.statusCode = 400;
    throw error;
  }
  return campaign;
}

async function getIdempotentResult(operation, key, body) {
  const normalizedKey = clean(key);
  if (!normalizedKey) {
    const error = new Error('idempotency_key is required');
    error.statusCode = 400;
    throw error;
  }
  if (normalizedKey.length > 255) {
    const error = new Error('idempotency_key must be at most 255 characters');
    error.statusCode = 400;
    throw error;
  }
  const hash = requestHash(body);
  const existing = await dbOperations.get(
    'SELECT * FROM agent_api_requests WHERE operation = ? AND idempotency_key = ?',
    [operation, normalizedKey]
  );
  if (!existing) return { key: normalizedKey, hash, existing: null };
  if (existing.request_hash !== hash) {
    const error = new Error('idempotency_key was already used with a different request');
    error.statusCode = 409;
    throw error;
  }
  if (existing.status !== 'completed') {
    const error = new Error('A request with this idempotency_key is still running');
    error.statusCode = 409;
    throw error;
  }
  return { key: normalizedKey, hash, existing: JSON.parse(existing.response_json || '{}') };
}

async function saveRequestStart(operation, campaignId, state, body) {
  try {
    const result = await dbOperations.run(
      `INSERT INTO agent_api_requests
       (idempotency_key, operation, campaign_id, request_hash, status, created_at)
       VALUES (?, ?, ?, ?, 'running', NOW())`,
      [state.key, operation, campaignId, state.hash]
    );
    return result.id;
  } catch (error) {
    const code = error?.original?.code || error?.parent?.code || error?.code;
    if (code !== 'ER_DUP_ENTRY' && !String(error.message).includes('Duplicate entry')) throw error;
    const replay = await getIdempotentResult(operation, state.key, body);
    if (replay.existing) return { replay: replay.existing };
    throw error;
  }
}

async function saveRequestResult(requestId, response) {
  await dbOperations.run(
    `UPDATE agent_api_requests SET response_json = ?, status = 'completed', completed_at = NOW()
     WHERE id = ?`,
    [JSON.stringify(response), requestId]
  );
}

async function searchKols(campaignId, query) {
  await assertActiveCampaign(campaignId);
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.page_size) || 50));
  const platform = clean(query.platform || 'youtube').toLowerCase();
  const platformConfig = SEARCH_PLATFORMS[platform];
  if (!platformConfig) throw new Error('platform must be youtube, instagram, or tiktok');
  const hasAvgMin = clean(query.min_avg_views_30d) !== '';
  const hasMedianMin = clean(query.min_median_views_30d) !== '';
  const hasFollowerMin = clean(query.min_followers) !== '';
  const avgMin = hasAvgMin ? Number(query.min_avg_views_30d) : NaN;
  const medianMin = hasMedianMin ? Number(query.min_median_views_30d) : NaN;
  const followerMin = hasFollowerMin ? Number(query.min_followers) : NaN;
  if ((hasAvgMin && (!Number.isFinite(avgMin) || avgMin < 0))
      || (hasMedianMin && (!Number.isFinite(medianMin) || medianMin < 0))) {
    throw new Error('View thresholds must be non-negative numbers');
  }
  if (hasFollowerMin && (!Number.isFinite(followerMin) || followerMin < 0)) {
    throw new Error('min_followers must be a non-negative number');
  }
  if (platform !== 'youtube' && (hasAvgMin || hasMedianMin)) {
    throw new Error(`${platform} view metrics are not available; use min_followers instead`);
  }
  const mode = clean(query.metric_mode || 'any').toLowerCase();
  if (!['any', 'all'].includes(mode)) throw new Error('metric_mode must be any or all');
  const metricParts = [];
  const metricParams = [];
  if (Number.isFinite(avgMin)) {
    metricParts.push('COALESCE(c.youtube_avg_views_30d, 0) > ?');
    metricParams.push(avgMin);
  }
  if (Number.isFinite(medianMin)) {
    metricParts.push('COALESCE(c.youtube_median_views_30d, 0) > ?');
    metricParams.push(medianMin);
  }
  if (platform === 'youtube' && !metricParts.length && !hasFollowerMin) {
    throw new Error('At least one view threshold or min_followers is required');
  }
  if (platform !== 'youtube' && !hasFollowerMin) {
    throw new Error('min_followers is required for instagram and tiktok searches');
  }

  const where = [
    ...(metricParts.length ? [`(${metricParts.join(mode === 'all' ? ' AND ' : ' OR ')})`] : []),
    `(c.${platformConfig.url} IS NOT NULL AND c.${platformConfig.url} <> '')`,
    "COALESCE(c.cooperation_status, 'available') <> 'do_not_contact'"
  ];
  const params = [...metricParams];
  if (hasFollowerMin) {
    const normalizedFollowers = `CASE
      WHEN LOWER(REPLACE(TRIM(c.${platformConfig.followers}), ',', '')) REGEXP '^[0-9]+(\\\\.[0-9]+)?k$'
        THEN CAST(LEFT(LOWER(REPLACE(TRIM(c.${platformConfig.followers}), ',', '')), CHAR_LENGTH(LOWER(REPLACE(TRIM(c.${platformConfig.followers}), ',', ''))) - 1) AS DECIMAL(20,2)) * 1000
      WHEN LOWER(REPLACE(TRIM(c.${platformConfig.followers}), ',', '')) REGEXP '^[0-9]+(\\\\.[0-9]+)?m$'
        THEN CAST(LEFT(LOWER(REPLACE(TRIM(c.${platformConfig.followers}), ',', '')), CHAR_LENGTH(LOWER(REPLACE(TRIM(c.${platformConfig.followers}), ',', ''))) - 1) AS DECIMAL(20,2)) * 1000000
      WHEN REPLACE(TRIM(c.${platformConfig.followers}), ',', '') REGEXP '^[0-9]+(\\\\.[0-9]+)?$'
        THEN CAST(REPLACE(TRIM(c.${platformConfig.followers}), ',', '') AS DECIMAL(20,2))
      ELSE 0 END`;
    where.push(`(${normalizedFollowers}) >= ?`);
    params.push(followerMin);
  }
  if (String(query.exclude_in_campaign ?? 'true').toLowerCase() !== 'false') {
    where.push('ck.id IS NULL');
  }
  const from = `FROM customers c
    LEFT JOIN campaign_kols ck ON ck.customer_id = c.id AND ck.campaign_id = ?`;
  const allParams = [campaignId, ...params];
  const totalRow = await dbOperations.get(
    `SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`,
    allParams
  );
  const rows = await dbOperations.query(
    `SELECT c.id AS customer_id, c.name, c.profile_url, '${platform}' AS platform,
            c.${platformConfig.url} AS platform_url,
            c.${platformConfig.followers} AS followers,
            c.youtube_url,
            c.youtube_followers, c.youtube_posts_30d, c.youtube_avg_views_30d,
            c.youtube_median_views_30d, c.youtube_engagement_rate_30d,
            c.youtube_snapshot_updated_at, c.creator_type, c.audience_fit,
            c.country_region, c.cooperation_status, c.cooperation_risk_category,
            c.cooperation_risk_reason, ck.id AS campaign_kol_id
     ${from} WHERE ${where.join(' AND ')}
     ORDER BY ${platform === 'youtube'
    ? `GREATEST(COALESCE(c.youtube_avg_views_30d, 0), COALESCE(c.youtube_median_views_30d, 0))`
    : 'c.id'} DESC, c.id DESC
     LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    allParams
  );
  return { campaign_id: campaignId, platform, page, page_size: pageSize, total: Number(totalRow?.total || 0), items: rows };
}

function normalizeCandidateItem(item) {
  const customerId = positiveInt(item.customer_id, 'customer_id');
  const priority = normalizePriorityLevel(item.priority_level || item.priority || 't2');
  if (!PRIORITY_LEVELS.has(priority)) throw new Error('priority_level must be t1, t2, t3, or t4');
  const cooperationPlatforms = (Array.isArray(item.cooperation_platforms) ? item.cooperation_platforms : [])
    .map((value) => clean(value).toLowerCase())
    .filter((value, index, values) => ALLOWED_PLATFORMS.has(value) && values.indexOf(value) === index);
  return {
    customerId,
    priority,
    cooperationPlatforms,
    notes: clean(item.recommendation_note || item.notes)
  };
}

async function previewCandidate(campaignId, item) {
  let normalized;
  try {
    normalized = normalizeCandidateItem(item);
    const customer = await dbOperations.get('SELECT * FROM customers WHERE id = ?', [normalized.customerId]);
    if (!customer) return { customer_id: normalized.customerId, action: 'rejected', error: 'KOL not found' };
    const existing = await dbOperations.get(
      'SELECT id FROM campaign_kols WHERE campaign_id = ? AND customer_id = ?',
      [campaignId, normalized.customerId]
    );
    return {
      customer_id: normalized.customerId,
      action: existing ? 'duplicate' : 'add',
      campaign_kol_id: existing?.id || null,
      normalized: { priority_level: normalized.priority, cooperation_platforms: normalized.cooperationPlatforms }
    };
  } catch (error) {
    return { customer_id: item?.customer_id ?? null, action: 'rejected', error: error.message };
  }
}

async function addCandidate(campaignId, item) {
  const normalized = normalizeCandidateItem(item);
  const customer = await dbOperations.get('SELECT * FROM customers WHERE id = ?', [normalized.customerId]);
  if (!customer) return { customer_id: normalized.customerId, action: 'rejected', error: 'KOL not found' };
  const existing = await dbOperations.get(
    'SELECT id FROM campaign_kols WHERE campaign_id = ? AND customer_id = ?',
    [campaignId, normalized.customerId]
  );
  if (existing) return { customer_id: normalized.customerId, action: 'duplicate', campaign_kol_id: existing.id };
  try {
    const result = await dbOperations.run(
      `INSERT INTO campaign_kols
       (campaign_id, customer_id, pipeline_stage, project_status, outreach_status, source, priority_level,
        cooperation_platforms, notes, project_notes, kol_name_snapshot, contact_name_snapshot, email_snapshot,
        country_region_snapshot, youtube_url_snapshot, youtube_followers_snapshot, instagram_url_snapshot,
        instagram_followers_snapshot, tiktok_url_snapshot, tiktok_followers_snapshot, posts_30d_snapshot,
        avg_views_30d_snapshot, median_views_30d_snapshot, engagement_rate_30d_snapshot,
        youtube_snapshot_updated_at, sync_status)
       VALUES (?, ?, 'candidate', 'pending_confirmation', 'not_contacted', 'agent_api', ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sync_pending')`,
      [
        campaignId, normalized.customerId, normalized.priority, JSON.stringify(normalized.cooperationPlatforms),
        normalized.notes, normalized.notes, customer.name || '', customer.contact_name || '',
        customer.email || '', customer.country_region || '', customer.youtube_url || '',
        customer.youtube_followers || '', customer.instagram_url || '', customer.instagram_followers || '',
        customer.tiktok_url || '', customer.tiktok_followers || '', customer.youtube_posts_30d,
        customer.youtube_avg_views_30d, customer.youtube_median_views_30d,
        customer.youtube_engagement_rate_30d, customer.youtube_snapshot_updated_at
      ]
    );
    return { customer_id: normalized.customerId, action: 'added', campaign_kol_id: result.id };
  } catch (error) {
    const code = error?.original?.code || error?.parent?.code || error?.code;
    if (code === 'ER_DUP_ENTRY' || String(error.message).includes('Duplicate entry')) {
      const duplicate = await dbOperations.get(
        'SELECT id FROM campaign_kols WHERE campaign_id = ? AND customer_id = ?',
        [campaignId, normalized.customerId]
      );
      return { customer_id: normalized.customerId, action: 'duplicate', campaign_kol_id: duplicate?.id || null };
    }
    return { customer_id: normalized.customerId, action: 'rejected', error: error.message };
  }
}

async function batchCandidates(campaignId, body) {
  await assertActiveCampaign(campaignId);
  if (!Array.isArray(body.items) || !body.items.length) throw new Error('items must be a non-empty array');
  if (body.items.length > MAX_CANDIDATE_BATCH) throw new Error(`items cannot exceed ${MAX_CANDIDATE_BATCH}`);
  const dryRun = body.dry_run === true;
  const operation = dryRun ? 'candidate_pool.preview' : 'candidate_pool.batch';
  if (dryRun) {
    const items = [];
    for (const item of body.items) items.push(await previewCandidate(campaignId, item));
    return { dry_run: true, items };
  }
  const state = await getIdempotentResult(operation, body.idempotency_key, body);
  if (state.existing) return { ...state.existing, idempotent_replay: true };
  const requestId = await saveRequestStart(operation, campaignId, state, body);
  const items = [];
  for (const item of body.items) items.push(await addCandidate(campaignId, item));
  const response = { dry_run: false, items };
  await saveRequestResult(requestId, response);
  return response;
}

async function validateDraft(campaignId, item) {
  try {
    const customerId = positiveInt(item.customer_id, 'customer_id');
    const subject = clean(item.subject);
    const bodyText = clean(item.body_text);
    if (!subject || subject.length > 500) throw new Error('subject is required and must be at most 500 characters');
    if (!bodyText) throw new Error('body_text is required');
    const campaignKol = await dbOperations.get(
      'SELECT id FROM campaign_kols WHERE campaign_id = ? AND customer_id = ?',
      [campaignId, customerId]
    );
    if (!campaignKol) throw new Error('KOL is not in this campaign candidate pool');
    const existing = await dbOperations.get(
      `SELECT id, status FROM email_drafts
       WHERE campaign_id = ? AND customer_id = ? AND kind = 'first_touch'
       ORDER BY id DESC LIMIT 1`,
      [campaignId, customerId]
    );
    if (existing && existing.status !== 'pending_review') {
      throw new Error(`Existing first_touch draft has protected status: ${existing.status}`);
    }
    return { customer_id: customerId, action: existing ? 'update' : 'create', draft_id: existing?.id || null };
  } catch (error) {
    return { customer_id: item?.customer_id ?? null, action: 'rejected', error: error.message };
  }
}

async function upsertDraft(campaignId, item) {
  const validation = await validateDraft(campaignId, item);
  if (validation.action === 'rejected') return validation;
  const subject = clean(item.subject);
  const bodyText = clean(item.body_text);
  if (validation.action === 'update') {
    await dbOperations.run(
      `INSERT INTO email_draft_versions (draft_id, subject, body_text, source, created_at)
       VALUES (?, ?, ?, 'agent', NOW())`,
      [validation.draft_id, subject, bodyText]
    );
    await dbOperations.run(
      `UPDATE email_drafts SET subject = ?, body_text = ?, status = 'pending_review',
       risk_level = 'none', risk_reasons = '[]', updated_at = NOW() WHERE id = ?`,
      [subject, bodyText, validation.draft_id]
    );
    await closeCandidateApproval(campaignId, validation.customer_id);
    return validation;
  }
  let result;
  try {
    result = await dbOperations.run(
      `INSERT INTO email_drafts
     (campaign_id, customer_id, kind, subject, body_text, status, risk_level, risk_reasons,
      evidence, prompt_version, dedupe_key, created_at, updated_at)
     VALUES (?, ?, 'first_touch', ?, ?, 'pending_review', 'none', '[]', ?, 'agent-manual-v1', ?, NOW(), NOW())`,
      [campaignId, validation.customer_id, subject, bodyText, JSON.stringify({ source: 'external_agent' }),
        draftDedupeKey({ campaignId, customerId: validation.customer_id, kind: 'first_touch' })]
    );
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
    return { ...validation, action: 'duplicate', error: 'A first_touch draft already exists' };
  }
  await dbOperations.run(
    `INSERT INTO email_draft_versions (draft_id, subject, body_text, source, created_at)
     VALUES (?, ?, ?, 'agent', NOW())`,
    [result.id, subject, bodyText]
  );
  await closeCandidateApproval(campaignId, validation.customer_id);
  return { ...validation, draft_id: result.id };
}

async function closeCandidateApproval(campaignId, customerId) {
  await dbOperations.run(
    `UPDATE approval_items SET status = 'cancelled', decision = 'agent_handled',
       decided_by = 'external_agent', decided_at = NOW(), updated_at = NOW()
     WHERE type = 'candidate' AND subject_type = 'campaign_kol' AND status = 'pending'
       AND subject_id = (SELECT id FROM campaign_kols WHERE campaign_id = ? AND customer_id = ? ORDER BY id DESC LIMIT 1)`,
    [campaignId, customerId]
  );
}

async function batchDrafts(campaignId, body) {
  await assertActiveCampaign(campaignId);
  if (body.kind && body.kind !== 'first_touch') throw new Error('Only first_touch drafts are supported');
  if (!Array.isArray(body.drafts) || !body.drafts.length) throw new Error('drafts must be a non-empty array');
  if (body.drafts.length > MAX_DRAFT_BATCH) throw new Error(`drafts cannot exceed ${MAX_DRAFT_BATCH}`);
  if (body.validate_only === true) {
    const items = [];
    for (const draft of body.drafts) items.push(await validateDraft(campaignId, draft));
    return { validate_only: true, items };
  }
  const operation = 'email_drafts.batch_upsert';
  const state = await getIdempotentResult(operation, body.idempotency_key, body);
  if (state.existing) return { ...state.existing, idempotent_replay: true };
  const requestId = await saveRequestStart(operation, campaignId, state, body);
  const items = [];
  for (const draft of body.drafts) items.push(await upsertDraft(campaignId, draft));
  const response = { validate_only: false, items };
  await saveRequestResult(requestId, response);
  return response;
}

async function listDrafts(campaignId, query) {
  await assertActiveCampaign(campaignId);
  const params = [campaignId];
  const where = ['ed.campaign_id = ?'];
  if (query.status) {
    where.push('ed.status = ?');
    params.push(clean(query.status));
  }
  if (query.kind) {
    where.push('ed.kind = ?');
    params.push(clean(query.kind));
  }
  if (query.customer_id) {
    where.push('ed.customer_id = ?');
    params.push(positiveInt(query.customer_id, 'customer_id'));
  }
  return dbOperations.query(
    `SELECT ed.id AS draft_id, ed.customer_id, c.name AS kol_name, ed.kind, ed.status,
            ed.subject, SHA2(CONCAT(COALESCE(ed.subject, ''), '\n', COALESCE(ed.body_text, '')), 256) AS content_hash,
            ed.created_at, ed.updated_at
     FROM email_drafts ed JOIN customers c ON c.id = ed.customer_id
     WHERE ${where.join(' AND ')} ORDER BY ed.updated_at DESC, ed.id DESC LIMIT 200`,
    params
  );
}

module.exports = {
  searchKols,
  batchCandidates,
  batchDrafts,
  listDrafts,
  assertActiveCampaign,
  requestHash
};
