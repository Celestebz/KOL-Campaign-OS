const express = require('express');
const { dbOperations } = require('../database');

const router = express.Router();

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

async function getReadyStrategy(strategyId) {
  const id = Number(strategyId);
  if (!id) throw new Error('Please select a Ready Strategy first');
  const strategy = await dbOperations.get('SELECT * FROM kol_strategies WHERE id = ?', [id]);
  if (!strategy) throw new Error('Strategy not found');
  if (strategy.status !== 'ready') throw new Error('Only Ready Strategy can be used in KOL Finder');
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

async function findExistingCustomer(candidate) {
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
    const existing = await dbOperations.get(check.sql, check.params);
    if (existing) return existing;
  }
  return null;
}

function normalizeRiskCategory(value) {
  const category = clean(value);
  return GLOBAL_RISK_CATEGORIES.has(category) ? category : 'other';
}

async function createCustomerFromCandidate(candidate) {
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
  const result = await dbOperations.run(
    `INSERT INTO customers (${fields.join(', ')}) VALUES (${placeholders})`,
    values
  );
  return dbOperations.get('SELECT * FROM customers WHERE id = ?', [result.id]);
}

async function updateCustomerMissingFields(customer, candidate) {
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
  await dbOperations.run(
    `UPDATE customers SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [...values, customer.id]
  );
  return dbOperations.get('SELECT * FROM customers WHERE id = ?', [customer.id]);
}

const { computeUrlHash } = require('../utils/videoUrlNormalizer');

async function findOrCreatePlatformAccount(customer, candidate) {
  const platform = clean(candidate.platform || candidate.target_platform);
  const profileUrl = clean(candidate.profile_url);
  if (!platform || !profileUrl) return null;

  const profileUrlHash = computeUrlHash(profileUrl);
  const existing = await dbOperations.get(
    'SELECT * FROM kol_platform_accounts WHERE customer_id = ? AND platform = ? AND profile_url_hash = ? LIMIT 1',
    [customer.id, platform, profileUrlHash]
  );
  if (existing) return existing;

  const result = await dbOperations.run(
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
    ]
  );
  return dbOperations.get('SELECT * FROM kol_platform_accounts WHERE id = ?', [result.id]);
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

async function upsertCampaignKol(campaignId, customer, platformAccount, candidate, strategy, finderTask, overrides = {}) {
  const platformAccountId = platformAccount?.id || null;
  const targetPlatform = clean(candidate.platform || candidate.target_platform);

  const existing = platformAccountId
    ? await dbOperations.get('SELECT * FROM campaign_kols WHERE campaign_id = ? AND platform_account_id = ?', [campaignId, platformAccountId])
    : await dbOperations.get('SELECT * FROM campaign_kols WHERE campaign_id = ? AND customer_id = ?', [campaignId, customer.id]);

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
    await dbOperations.run(
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
      ]
    );
    return dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [existing.id]);
  }

  const fields = Object.keys(snapshot);
  const placeholders = fields.map(() => '?').join(', ');
  const result = await dbOperations.run(
    `INSERT INTO campaign_kols (campaign_id, ${fields.join(', ')}) VALUES (?, ${placeholders})`,
    [campaignId, ...Object.values(snapshot)]
  );
  return dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [result.id]);
}

async function approveCandidate(id, body = {}) {
  const candidate = await dbOperations.get('SELECT * FROM raw_candidates WHERE id = ?', [id]);
  if (!candidate) throw new Error('Raw candidate not found');
  if (candidate.status === 'ignored') throw new Error('Ignored candidate cannot be approved');
  const strategy = await getReadyStrategy(body.strategy_id || candidate.strategy_id);
  const finderTask = candidate.finder_task_id
    ? await dbOperations.get('SELECT * FROM finder_tasks WHERE id = ?', [candidate.finder_task_id])
    : null;

  const campaignId = Number(body.campaign_id || candidate.campaign_id || strategy.campaign_id || 1);
  const existing = await findExistingCustomer(candidate);
  const customer = existing
    ? await updateCustomerMissingFields(existing, candidate)
    : await createCustomerFromCandidate(candidate);
  const platformAccount = await findOrCreatePlatformAccount(customer, candidate);
  const campaignKol = await upsertCampaignKol(campaignId, customer, platformAccount, candidate, strategy, finderTask, body);

  await dbOperations.run(
    `UPDATE raw_candidates SET status = ?, campaign_id = ?, strategy_id = ?, approved_customer_id = ?,
     approved_campaign_kol_id = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [existing ? 'duplicate' : 'approved', campaignId, strategy.id, customer.id, campaignKol.id, id]
  );

  return { customer, platformAccount, campaignKol, candidateStatus: existing ? 'duplicate' : 'approved' };
}

router.get('/', async (req, res) => {
  try {
    const { campaign_id, strategy_id, platform, status, min_score, search } = req.query;
    let sql = `
      SELECT rc.*, c.name as campaign_name, ft.name as finder_task_name,
        ks.name as strategy_name, ks.status as strategy_status,
        mk.id as matched_customer_id,
        mk.cooperation_status as global_cooperation_status,
        mk.cooperation_risk_category as global_cooperation_risk_category,
        mk.cooperation_risk_reason as global_cooperation_risk_reason,
        mk.cooperation_status_updated_at as global_cooperation_status_updated_at
      FROM raw_candidates rc
      LEFT JOIN campaigns c ON c.id = rc.campaign_id
      LEFT JOIN finder_tasks ft ON ft.id = rc.finder_task_id
      LEFT JOIN kol_strategies ks ON ks.id = rc.strategy_id
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
    if (platform) {
      sql += ' AND rc.platform = ?';
      params.push(platform);
    }
    if (status) {
      sql += ' AND rc.status = ?';
      params.push(status);
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
      )`;
      const term = `%${search}%`;
      params.push(term, term, term, term, term, term, term, term);
    }

    sql += ' ORDER BY rc.created_at DESC, rc.id DESC';
    const rows = await dbOperations.query(sql, params);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const data = req.body || {};
    const kolName = clean(data.kol_name || data.name);
    if (!kolName) return res.status(400).json({ success: false, error: 'KOL name is required' });
    const strategy = await getReadyStrategy(data.strategy_id);

    const fields = [
        'finder_task_id', 'campaign_id', 'strategy_id', 'platform', 'kol_name', 'contact_name',
      'profile_url', 'video_url', 'video_title', 'followers', 'avg_views',
      'email', 'phone', 'country_region', 'matched_keywords', 'ai_score',
      'ai_match_reason', 'status', 'source', 'raw_data', 'search_cycle',
      'matched_persona', 'scoring_breakdown', 'discovery_route', 'source_platform',
      'target_platform', 'source_agent', 'evidence_url', 'evidence_title',
      'evidence_type', 'source_query', 'rejection_scope', 'rejection_category', 'rejection_reason'
    ];
    const values = [
      data.finder_task_id || null,
      data.campaign_id || strategy.campaign_id || 1,
      strategy.id,
      clean(data.platform),
      kolName,
      clean(data.contact_name),
      clean(data.profile_url),
      clean(data.video_url),
      clean(data.video_title),
      clean(data.followers),
      clean(data.avg_views),
      clean(data.email),
      clean(data.phone),
      clean(data.country_region),
      clean(data.matched_keywords),
      normalizeNumber(data.ai_score),
      clean(data.ai_match_reason),
      clean(data.status) || 'new',
      clean(data.source) || 'manual',
      JSON.stringify(data.raw_data || data),
      clean(data.search_cycle),
      clean(data.matched_persona),
      typeof data.scoring_breakdown === 'string' ? data.scoring_breakdown : JSON.stringify(data.scoring_breakdown || {}),
      clean(data.discovery_route),
      clean(data.source_platform),
      clean(data.target_platform || data.platform),
      clean(data.source_agent || data.source),
      clean(data.evidence_url),
      clean(data.evidence_title),
      clean(data.evidence_type),
      clean(data.source_query),
      clean(data.rejection_scope),
      clean(data.rejection_category),
      clean(data.rejection_reason)
    ];
    const placeholders = fields.map(() => '?').join(', ');
    const result = await dbOperations.run(
      `INSERT INTO raw_candidates (${fields.join(', ')}) VALUES (${placeholders})`,
      values
    );
    const row = await dbOperations.get('SELECT * FROM raw_candidates WHERE id = ?', [result.id]);
    res.json({ success: true, data: row, message: 'Raw candidate saved' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
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
