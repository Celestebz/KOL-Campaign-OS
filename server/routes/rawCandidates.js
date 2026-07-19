const express = require('express');
const crypto = require('crypto');
const { dbOperations, sequelize, Sequelize } = require('../database');
const { buildCandidateIdentity } = require('./finderTasks');

const router = express.Router();
const MYSQL_SIGNED_INT_MAX = 2147483647;

const GLOBAL_RISK_CATEGORIES = new Set([
  'historical_refusal',
  'communication_risk',
  'price_mismatch',
  'brand_safety',
  'delivery_issue',
  'other'
]);

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseBodyId(value) {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MYSQL_SIGNED_INT_MAX
    ? value
    : null;
}

async function transactionGet(sql, params, transaction) {
  const rows = await sequelize.query(sql, {
    replacements: params,
    type: Sequelize.QueryTypes.SELECT,
    transaction,
    logging: false
  });
  return rows[0] || null;
}

async function transactionRun(sql, params, transaction) {
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

async function scopedGet(sql, params, transaction = null) {
  return transaction ? transactionGet(sql, params, transaction) : dbOperations.get(sql, params);
}

async function scopedRun(sql, params, transaction = null) {
  return transaction ? transactionRun(sql, params, transaction) : dbOperations.run(sql, params);
}

function approvalError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

async function getReadyStrategy(strategyId, transaction = null) {
  const id = parseBodyId(strategyId);
  if (!id) throw approvalError('strategy_id is required and must be a positive integer');
  const strategy = await scopedGet(
    `SELECT * FROM kol_strategies WHERE id = ?${transaction ? ' FOR UPDATE' : ''}`,
    [id],
    transaction
  );
  if (!strategy) throw approvalError('Strategy not found');
  if (strategy.status !== 'ready') throw approvalError('Only Ready Strategy can approve Raw Candidates');
  return strategy;
}

function profileFieldFor(platform) {
  if (platform === 'youtube') return ['youtube_url', 'youtube_followers'];
  if (platform === 'instagram') return ['instagram_url', 'instagram_followers'];
  if (platform === 'tiktok') return ['tiktok_url', 'tiktok_followers'];
  return ['profile_url', null];
}

function splitName(name, contactName) {
  const source = clean(contactName || name);
  if (!source) return { first_name: '', last_name: '' };
  if (source.includes(' ')) {
    const parts = source.split(/\s+/);
    return {
      first_name: parts.slice(0, -1).join(' ') || parts[0],
      last_name: parts.length > 1 ? parts[parts.length - 1] : ''
    };
  }
  return {
    first_name: source.length > 1 ? source.slice(1) : source,
    last_name: source.length > 1 ? source.charAt(0) : ''
  };
}

function customerDataFromCandidate(candidate) {
  const platform = clean(candidate.platform);
  const [profileField, followersField] = profileFieldFor(platform);
  const names = splitName(candidate.kol_name, candidate.contact_name);
  const data = {
    name: clean(candidate.kol_name),
    contact_name: clean(candidate.contact_name),
    email: clean(candidate.email),
    phone: clean(candidate.phone),
    country_region: clean(candidate.country_region),
    notes: clean(candidate.ai_match_reason),
    rating: candidate.ai_score ? String(candidate.ai_score) : '',
    platform,
    profile_url: clean(candidate.profile_url),
    creator_type: 'KOL',
    source_raw_candidate_id: candidate.id,
    sync_status: 'sync_pending',
    first_name: names.first_name,
    last_name: names.last_name
  };

  if (profileField) data[profileField] = clean(candidate.profile_url);
  if (followersField) data[followersField] = clean(candidate.followers);
  return data;
}

async function findExistingCustomer(candidate, transaction = null) {
  const checks = [];
  const email = clean(candidate.email);
  const profileUrl = clean(candidate.profile_url);
  const name = clean(candidate.kol_name);

  if (profileUrl) {
    checks.push({
      sql: `SELECT * FROM customers WHERE youtube_url = ? OR instagram_url = ? OR tiktok_url = ? OR profile_url = ? LIMIT 1`,
      params: [profileUrl, profileUrl, profileUrl, profileUrl]
    });
  }
  if (email) checks.push({ sql: 'SELECT * FROM customers WHERE email = ? LIMIT 1', params: [email] });
  if (name) checks.push({ sql: 'SELECT * FROM customers WHERE name = ? LIMIT 1', params: [name] });

  for (const check of checks) {
    const existing = await scopedGet(
      `${check.sql.replace(/ LIMIT 1$/, '')}${transaction ? ' FOR UPDATE' : ' LIMIT 1'}`,
      check.params,
      transaction
    );
    if (existing) return existing;
  }
  return null;
}

function normalizeRiskCategory(value) {
  const category = clean(value);
  return GLOBAL_RISK_CATEGORIES.has(category) ? category : 'other';
}

async function createCustomerFromCandidate(candidate, transaction = null) {
  const data = customerDataFromCandidate(candidate);
  if (!data.name) throw new Error('KOL name is required');

  const fields = [
    'name', 'contact_name', 'email', 'phone', 'country_region', 'notes', 'rating',
    'platform', 'profile_url', 'youtube_url', 'youtube_followers', 'instagram_url',
    'instagram_followers', 'tiktok_url', 'tiktok_followers', 'creator_type',
    'source_raw_candidate_id', 'sync_status', 'first_name', 'last_name'
  ];
  const values = fields.map((field) => data[field] || null);
  const placeholders = fields.map(() => '?').join(', ');
  const result = await scopedRun(
    `INSERT INTO customers (${fields.join(', ')}) VALUES (${placeholders})`,
    values,
    transaction
  );
  return scopedGet('SELECT * FROM customers WHERE id = ?', [result.id], transaction);
}

async function updateCustomerMissingFields(customer, candidate, transaction = null) {
  const data = customerDataFromCandidate(candidate);
  const fields = [
    'contact_name', 'email', 'phone', 'country_region', 'notes', 'rating',
    'platform', 'profile_url', 'youtube_url', 'youtube_followers', 'instagram_url',
    'instagram_followers', 'tiktok_url', 'tiktok_followers', 'creator_type',
    'source_raw_candidate_id', 'sync_status'
  ];
  const assignments = fields.map((field) => (
    `${field} = CASE WHEN ${field} IS NULL OR ${field} = '' THEN ? ELSE ${field} END`
  )).join(', ');
  const values = fields.map((field) => data[field] || null);
  await scopedRun(
    `UPDATE customers SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [...values, customer.id],
    transaction
  );
  return scopedGet('SELECT * FROM customers WHERE id = ?', [customer.id], transaction);
}

const { computeUrlHash } = require('../utils/videoUrlNormalizer');

async function findOrCreatePlatformAccount(customer, candidate, transaction = null) {
  const platform = clean(candidate.platform || candidate.target_platform);
  const profileUrl = clean(candidate.profile_url);
  if (!platform || !profileUrl) return null;

  const profileUrlHash = computeUrlHash(profileUrl);
  const existing = await scopedGet(
    `SELECT * FROM kol_platform_accounts WHERE customer_id = ? AND platform = ? AND profile_url_hash = ?${transaction ? ' FOR UPDATE' : ' LIMIT 1'}`,
    [customer.id, platform, profileUrlHash],
    transaction
  );
  if (existing) return existing;

  const result = await scopedRun(
    `INSERT INTO kol_platform_accounts
     (customer_id, platform, username, profile_url, profile_url_hash, followers_text, raw_data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      customer.id,
      platform,
      clean(candidate.kol_name),
      profileUrl,
      profileUrlHash,
      clean(candidate.followers),
      JSON.stringify({ source: 'raw_candidate', candidate_id: candidate.id })
    ],
    transaction
  );
  return scopedGet('SELECT * FROM kol_platform_accounts WHERE id = ?', [result.id], transaction);
}

function buildMasterSnapshot(customer, platformAccount, candidate) {
  const snapshot = {
    customer_id: customer.id,
    name: customer.name,
    contact_name: customer.contact_name,
    email: customer.email,
    phone: customer.phone,
    country_region: customer.country_region,
    platform: platformAccount?.platform || candidate.platform || candidate.target_platform,
    profile_url: platformAccount?.profile_url || candidate.profile_url,
    followers: platformAccount?.followers_text || candidate.followers,
    avg_views: candidate.avg_views,
    youtube_url: customer.youtube_url,
    instagram_url: customer.instagram_url,
    tiktok_url: customer.tiktok_url
  };
  return JSON.stringify(snapshot);
}

function buildEvidenceSummary(candidate) {
  return JSON.stringify({
    video_url: candidate.video_url,
    video_title: candidate.video_title,
    evidence_url: candidate.evidence_url,
    evidence_title: candidate.evidence_title,
    ai_score: candidate.ai_score,
    ai_match_reason: candidate.ai_match_reason,
    matched_keywords: candidate.matched_keywords,
    scoring_breakdown: candidate.scoring_breakdown
  });
}

async function upsertCampaignKol(campaignId, customer, platformAccount, candidate, strategy, finderTask, overrides = {}, transaction = null) {
  const platformAccountId = platformAccount?.id || null;
  const targetPlatform = clean(candidate.platform || candidate.target_platform);

  const existing = platformAccountId
    ? await scopedGet(
      `SELECT * FROM campaign_kols WHERE campaign_id = ? AND platform_account_id = ?${transaction ? ' FOR UPDATE' : ''}`,
      [campaignId, platformAccountId],
      transaction
    )
    : await scopedGet(
      `SELECT * FROM campaign_kols WHERE campaign_id = ? AND customer_id = ?${transaction ? ' FOR UPDATE' : ''}`,
      [campaignId, customer.id],
      transaction
    );

  const masterSnapshot = buildMasterSnapshot(customer, platformAccount, candidate);
  const evidenceSummary = buildEvidenceSummary(candidate);

  const snapshot = {
    raw_candidate_id: candidate.id,
    strategy_id: strategy?.id || candidate.strategy_id || null,
    finder_task_id: finderTask?.id || candidate.finder_task_id || null,
    customer_id: customer.id,
    platform_account_id: platformAccountId,
    target_platform: targetPlatform,
    source: 'raw_candidate',
    project_status: 'candidate',
    priority_level: candidate.ai_score >= 80 ? 'high' : 'normal',
    candidate_priority_score: normalizeNumber(candidate.ai_score),
    best_evidence_url: clean(candidate.video_url || candidate.evidence_url),
    evidence_summary: evidenceSummary,
    master_snapshot: masterSnapshot,
    contact_email_override: clean(candidate.email),
    contact_name_override: clean(candidate.contact_name),
    project_notes: clean(candidate.ai_match_reason),
    sync_status: 'sync_pending',
    // Compatibility fields
    kol_name_snapshot: customer.name || candidate.kol_name || '',
    contact_name_snapshot: customer.contact_name || candidate.contact_name || '',
    email_snapshot: customer.email || candidate.email || '',
    country_region_snapshot: customer.country_region || candidate.country_region || '',
    youtube_url_snapshot: customer.youtube_url || '',
    instagram_url_snapshot: customer.instagram_url || '',
    tiktok_url_snapshot: customer.tiktok_url || '',
    youtube_followers_snapshot: customer.youtube_followers || '',
    instagram_followers_snapshot: customer.instagram_followers || '',
    tiktok_followers_snapshot: customer.tiktok_followers || '',
    quoted_price: overrides.quoted_price || customer.video_price || '',
    exchange_rate: overrides.exchange_rate || customer.exchange_rate || '',
    price_rmb: overrides.price_rmb || customer.price_rmb || '',
    status: 'candidate',
    notes: clean(candidate.ai_match_reason)
  };

  if (existing) {
    await scopedRun(
      `UPDATE campaign_kols SET
       raw_candidate_id = COALESCE(raw_candidate_id, ?),
       strategy_id = COALESCE(strategy_id, ?),
       finder_task_id = COALESCE(finder_task_id, ?),
       customer_id = ?,
       platform_account_id = COALESCE(platform_account_id, ?),
       target_platform = COALESCE(NULLIF(target_platform, ''), ?),
       candidate_priority_score = COALESCE(candidate_priority_score, ?),
       best_evidence_url = COALESCE(NULLIF(best_evidence_url, ''), ?),
       evidence_summary = COALESCE(NULLIF(evidence_summary, ''), ?),
       master_snapshot = COALESCE(NULLIF(master_snapshot, ''), ?),
       contact_email_override = COALESCE(NULLIF(contact_email_override, ''), ?),
       contact_name_override = COALESCE(NULLIF(contact_name_override, ''), ?),
       project_notes = COALESCE(NULLIF(project_notes, ''), ?),
       kol_name_snapshot = COALESCE(NULLIF(kol_name_snapshot, ''), ?),
       contact_name_snapshot = COALESCE(NULLIF(contact_name_snapshot, ''), ?),
       email_snapshot = COALESCE(NULLIF(email_snapshot, ''), ?),
       country_region_snapshot = COALESCE(NULLIF(country_region_snapshot, ''), ?),
       youtube_url_snapshot = COALESCE(NULLIF(youtube_url_snapshot, ''), ?),
       instagram_url_snapshot = COALESCE(NULLIF(instagram_url_snapshot, ''), ?),
       tiktok_url_snapshot = COALESCE(NULLIF(tiktok_url_snapshot, ''), ?),
       youtube_followers_snapshot = COALESCE(NULLIF(youtube_followers_snapshot, ''), ?),
       instagram_followers_snapshot = COALESCE(NULLIF(instagram_followers_snapshot, ''), ?),
       tiktok_followers_snapshot = COALESCE(NULLIF(tiktok_followers_snapshot, ''), ?),
       sync_status = CASE WHEN feishu_record_id IS NULL OR feishu_record_id = '' THEN 'sync_pending' ELSE sync_status END,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        snapshot.raw_candidate_id,
        snapshot.strategy_id,
        snapshot.finder_task_id,
        snapshot.customer_id,
        snapshot.platform_account_id,
        snapshot.target_platform,
        snapshot.candidate_priority_score,
        snapshot.best_evidence_url,
        snapshot.evidence_summary,
        snapshot.master_snapshot,
        snapshot.contact_email_override,
        snapshot.contact_name_override,
        snapshot.project_notes,
        snapshot.kol_name_snapshot,
        snapshot.contact_name_snapshot,
        snapshot.email_snapshot,
        snapshot.country_region_snapshot,
        snapshot.youtube_url_snapshot,
        snapshot.instagram_url_snapshot,
        snapshot.tiktok_url_snapshot,
        snapshot.youtube_followers_snapshot,
        snapshot.instagram_followers_snapshot,
        snapshot.tiktok_followers_snapshot,
        existing.id
      ],
      transaction
    );
    return scopedGet('SELECT * FROM campaign_kols WHERE id = ?', [existing.id], transaction);
  }

  const fields = Object.keys(snapshot);
  const placeholders = fields.map(() => '?').join(', ');
  const result = await scopedRun(
    `INSERT INTO campaign_kols (campaign_id, ${fields.join(', ')}) VALUES (?, ${placeholders})`,
    [campaignId, ...Object.values(snapshot)],
    transaction
  );
  return scopedGet('SELECT * FROM campaign_kols WHERE id = ?', [result.id], transaction);
}

async function findProductFitForCandidate(candidate, campaignProductId, transaction) {
  let fit = await scopedGet(
    'SELECT * FROM raw_candidate_product_fits WHERE latest_raw_candidate_id = ? LIMIT 1',
    [candidate.id],
    transaction
  );
  if (fit) return fit;

  const platform = clean(candidate.platform || candidate.target_platform);
  const identity = buildCandidateIdentity(platform, candidate.profile_url, candidate.kol_name);
  fit = await scopedGet(
    'SELECT * FROM raw_candidate_product_fits WHERE campaign_product_id = ? AND identity_key_hash = ?',
    [campaignProductId, identity.identityKeyHash],
    transaction
  );
  return fit;
}

async function upsertCampaignKolProduct(campaignKolId, campaignProductId, fit, transaction) {
  const existing = await scopedGet(
    `SELECT * FROM campaign_kol_products WHERE campaign_kol_id = ? AND campaign_product_id = ?${transaction ? ' FOR UPDATE' : ''}`,
    [campaignKolId, campaignProductId],
    transaction
  );

  const evidenceSummary = typeof fit.evidence_summary === 'string'
    ? fit.evidence_summary
    : JSON.stringify(fit.evidence_summary || {});
  const fitStatus = fit.decision_status === 'approved' ? 'approved' : 'pending';

  if (existing) {
    await scopedRun(
      `UPDATE campaign_kol_products SET
       source_raw_candidate_product_fit_id = COALESCE(source_raw_candidate_product_fit_id, ?),
       fit_score = COALESCE(fit_score, ?),
       fit_status = COALESCE(NULLIF(fit_status, ''), ?),
       evidence_summary = COALESCE(NULLIF(evidence_summary, ''), ?),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [fit.id, fit.fit_score, fitStatus, evidenceSummary, existing.id],
      transaction
    );
    return scopedGet('SELECT * FROM campaign_kol_products WHERE id = ?', [existing.id], transaction);
  }

  const result = await scopedRun(
    `INSERT INTO campaign_kol_products
     (campaign_kol_id, campaign_product_id, source_raw_candidate_product_fit_id, fit_score, fit_status,
      evidence_summary, assignment_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [campaignKolId, campaignProductId, fit.id, fit.fit_score, fitStatus, evidenceSummary],
    transaction
  );
  return scopedGet('SELECT * FROM campaign_kol_products WHERE id = ?', [result.id], transaction);
}

async function approveCandidate(id, body = {}) {
  return sequelize.transaction(async (transaction) => {
    const candidate = await scopedGet('SELECT * FROM raw_candidates WHERE id = ?', [id], transaction);
    if (!candidate) throw approvalError('Raw candidate not found');
    if (candidate.status === 'ignored') throw approvalError('Ignored candidate cannot be approved');

    const strategy = await getReadyStrategy(body.strategy_id || candidate.strategy_id, transaction);
    const finderTask = candidate.finder_task_id
      ? await scopedGet('SELECT * FROM finder_tasks WHERE id = ?', [candidate.finder_task_id], transaction)
      : null;

    const campaignId = Number(body.campaign_id || candidate.campaign_id || strategy.campaign_id || 1);
    const campaignProductId = parseBodyId(body.campaign_product_id || candidate.campaign_product_id || strategy.campaign_product_id);

    if (campaignProductId && Number(strategy.campaign_product_id) !== campaignProductId) {
      throw approvalError('Campaign Product does not match Strategy');
    }
    if (finderTask && campaignProductId && Number(finderTask.campaign_product_id) !== campaignProductId) {
      throw approvalError('Campaign Product does not match Finder Task');
    }

    const fit = campaignProductId
      ? await findProductFitForCandidate(candidate, campaignProductId, transaction)
      : null;

    const existing = await findExistingCustomer(candidate, transaction);
    const customer = existing
      ? await updateCustomerMissingFields(existing, candidate, transaction)
      : await createCustomerFromCandidate(candidate, transaction);
    const platformAccount = await findOrCreatePlatformAccount(customer, candidate, transaction);
    const campaignKol = await upsertCampaignKol(campaignId, customer, platformAccount, candidate, strategy, finderTask, body, transaction);

    let campaignKolProduct = null;
    if (fit) {
      campaignKolProduct = await upsertCampaignKolProduct(campaignKol.id, campaignProductId, fit, transaction);
    }

    await scopedRun(
      `UPDATE raw_candidates SET status = ?, campaign_id = ?, strategy_id = ?, approved_customer_id = ?,
       approved_campaign_kol_id = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [existing ? 'duplicate' : 'approved', campaignId, strategy.id, customer.id, campaignKol.id, id],
      transaction
    );

    return {
      customer,
      platformAccount,
      campaignKol,
      campaignKolProduct,
      candidateStatus: existing ? 'duplicate' : 'approved'
    };
  });
}

router.get('/', async (req, res) => {
  try {
    const { campaign_id, strategy_id, platform, status, min_score, search, identity_status, campaign_product_id } = req.query;
    let sql = `
      SELECT rc.*, c.name as campaign_name, ft.name as finder_task_name,
        ks.name as strategy_name, ks.status as strategy_status,
        ks.campaign_product_id as strategy_campaign_product_id,
        mk.id as matched_customer_id,
        mk.cooperation_status as global_cooperation_status,
        mk.cooperation_risk_category as global_cooperation_risk_category,
        mk.cooperation_risk_reason as global_cooperation_risk_reason,
        mk.cooperation_status_updated_at as global_cooperation_status_updated_at,
        rcpf.id as product_fit_id,
        rcpf.campaign_product_id as fit_campaign_product_id,
        rcpf.identity_status as fit_identity_status,
        rcpf.fit_score,
        rcpf.matched_persona as fit_matched_persona,
        rcpf.decision_status as fit_decision_status,
        cp.role as campaign_product_role,
        cp.priority as campaign_product_priority,
        p.id as product_id,
        p.brand as product_brand,
        p.name as product_name,
        p.category as product_category,
        p.product_url as product_url
      FROM raw_candidates rc
      LEFT JOIN campaigns c ON c.id = rc.campaign_id
      LEFT JOIN finder_tasks ft ON ft.id = rc.finder_task_id
      LEFT JOIN kol_strategies ks ON ks.id = rc.strategy_id
      LEFT JOIN raw_candidate_product_fits rcpf ON rcpf.latest_raw_candidate_id = rc.id
      LEFT JOIN campaign_products cp ON cp.id = rcpf.campaign_product_id
      LEFT JOIN products p ON p.id = cp.product_id
      LEFT JOIN customers mk ON (
        (rc.profile_url IS NOT NULL AND rc.profile_url != '' AND (
          mk.profile_url = rc.profile_url OR mk.youtube_url = rc.profile_url OR mk.instagram_url = rc.profile_url OR mk.tiktok_url = rc.profile_url
        ))
        OR (rc.email IS NOT NULL AND rc.email != '' AND mk.email = rc.email)
        OR (rc.kol_name IS NOT NULL AND rc.kol_name != '' AND mk.name = rc.kol_name)
      )
      WHERE 1=1
    `;
    const params = [];

    if (campaign_id) {
      sql += ' AND rc.campaign_id = ?';
      params.push(campaign_id);
    }
    if (strategy_id) {
      sql += ' AND rc.strategy_id = ?';
      params.push(strategy_id);
    }
    if (campaign_product_id) {
      sql += ' AND rcpf.campaign_product_id = ?';
      params.push(campaign_product_id);
    }
    if (platform) {
      sql += ' AND rc.platform = ?';
      params.push(platform);
    }
    if (status) {
      if (status === 'pending') {
        sql += ' AND rc.status IN (?, ?)';
        params.push('new', 'manual_review');
      } else {
        sql += ' AND rc.status = ?';
        params.push(status);
      }
    }
    if (identity_status) {
      sql += ' AND rcpf.identity_status = ?';
      params.push(identity_status);
    }
    if (min_score) {
      sql += ' AND COALESCE(rc.ai_score, 0) >= ?';
      params.push(Number(min_score));
    }
    if (search) {
      sql += ` AND (
        rc.kol_name LIKE ? OR rc.contact_name LIKE ? OR rc.profile_url LIKE ?
        OR rc.video_url LIKE ? OR rc.email LIKE ? OR rc.country_region LIKE ?
        OR rc.matched_keywords LIKE ? OR rc.ai_match_reason LIKE ?
        OR p.name LIKE ? OR p.brand LIKE ?
      )`;
      const term = `%${search}%`;
      params.push(term, term, term, term, term, term, term, term, term, term);
    }

    sql += ' ORDER BY rc.created_at DESC, rc.id DESC';
    const rows = await dbOperations.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', (req, res) => {
  res.status(410).json({
    success: false,
    error: 'Direct Raw Candidate creation is retired. Generate candidates from analyzed video evidence.'
  });
});

router.post('/batch-approve', async (req, res) => {
  try {
    const ids = req.body.ids || req.body.candidateIds || [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'Please select candidates' });

    const results = [];
    for (const id of ids) {
      try {
        const approved = await approveCandidate(id, req.body);
        results.push({ id, success: true, ...approved });
      } catch (error) {
        await dbOperations.run(
          'UPDATE raw_candidates SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['error', error.message, id]
        );
        results.push({ id, success: false, error: error.message });
      }
    }

    res.json({
      success: true,
      data: {
        success_count: results.filter((item) => item.success).length,
        failed_count: results.filter((item) => !item.success).length,
        results
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/batch-ignore', async (req, res) => {
  try {
    const ids = req.body.ids || req.body.candidateIds || [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'Please select candidates' });
    const placeholders = ids.map(() => '?').join(',');
    const category = clean(req.body.rejection_category);
    const reason = clean(req.body.rejection_reason || req.body.reason);
    await dbOperations.run(
      `UPDATE raw_candidates
       SET status = ?, rejection_scope = ?, rejection_category = COALESCE(NULLIF(?, ''), rejection_category),
           rejection_reason = COALESCE(NULLIF(?, ''), rejection_reason), updated_at = CURRENT_TIMESTAMP
       WHERE id IN (${placeholders})`,
      ['ignored', 'project', category, reason, ...ids]
    );
    res.json({ success: true, message: `Ignored ${ids.length} candidates` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/mark-do-not-contact', async (req, res) => {
  try {
    const candidate = await dbOperations.get('SELECT * FROM raw_candidates WHERE id = ?', [req.params.id]);
    if (!candidate) return res.status(404).json({ success: false, error: 'Raw candidate not found' });
    const reason = clean(req.body.reason || req.body.cooperation_risk_reason);
    if (!reason) return res.status(400).json({ success: false, error: 'Global cooperation risk reason is required' });
    const category = normalizeRiskCategory(req.body.category || req.body.cooperation_risk_category);
    const existing = await findExistingCustomer(candidate);
    const customer = existing || await createCustomerFromCandidate(candidate);

    await dbOperations.run(
      `UPDATE customers SET
       cooperation_status = ?,
       cooperation_risk_category = ?,
       cooperation_risk_reason = ?,
       cooperation_status_updated_at = CURRENT_TIMESTAMP,
       cooperation_status_source_raw_candidate_id = ?,
       sync_status = 'sync_pending',
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      ['do_not_contact', category, reason, candidate.id, customer.id]
    );
    await dbOperations.run(
      `UPDATE raw_candidates SET
       status = CASE WHEN status IN ('approved', 'duplicate') THEN status ELSE 'risk_review' END,
       rejection_scope = 'global',
       rejection_category = ?,
       rejection_reason = ?,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [category, reason, candidate.id]
    );
    const updated = await dbOperations.get('SELECT * FROM customers WHERE id = ?', [customer.id]);
    res.json({ success: true, data: updated, message: 'KOL marked as global do-not-contact' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/batch', async (req, res) => {
  try {
    const ids = req.body.ids || req.body.candidateIds || [];
    if (!ids.length) return res.status(400).json({ success: false, error: 'Please select candidates' });
    const placeholders = ids.map(() => '?').join(',');
    await dbOperations.run(`DELETE FROM raw_candidates WHERE id IN (${placeholders})`, ids);
    res.json({ success: true, message: `Deleted ${ids.length} candidates` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const result = await approveCandidate(req.params.id, req.body);
    res.json({ success: true, data: result, message: 'Candidate approved' });
  } catch (error) {
    await dbOperations.run(
      'UPDATE raw_candidates SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['error', error.message, req.params.id]
    );
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/:id/ignore', async (req, res) => {
  try {
    const category = clean(req.body.rejection_category);
    const reason = clean(req.body.rejection_reason || req.body.reason);
    await dbOperations.run(
      `UPDATE raw_candidates
       SET status = ?, rejection_scope = ?, rejection_category = COALESCE(NULLIF(?, ''), rejection_category),
           rejection_reason = COALESCE(NULLIF(?, ''), rejection_reason), updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      ['ignored', 'project', category, reason, req.params.id]
    );
    res.json({ success: true, message: 'Candidate ignored' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await dbOperations.run('DELETE FROM raw_candidates WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Candidate deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = { router, approveCandidate };
