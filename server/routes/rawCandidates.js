const express = require('express');
const { dbOperations } = require('../database');

const router = express.Router();

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

async function upsertCampaignKol(campaignId, customer, candidate, overrides = {}) {
  const existing = await dbOperations.get(
    'SELECT * FROM campaign_kols WHERE campaign_id = ? AND customer_id = ?',
    [campaignId, customer.id]
  );

  const snapshot = {
    raw_candidate_id: candidate.id,
    kol_name_snapshot: customer.name || candidate.kol_name || '',
    contact_name_snapshot: customer.contact_name || candidate.contact_name || '',
    youtube_url_snapshot: customer.youtube_url || '',
    youtube_followers_snapshot: customer.youtube_followers || '',
    instagram_url_snapshot: customer.instagram_url || '',
    instagram_followers_snapshot: customer.instagram_followers || '',
    tiktok_url_snapshot: customer.tiktok_url || '',
    tiktok_followers_snapshot: customer.tiktok_followers || '',
    email_snapshot: customer.email || candidate.email || '',
    country_region_snapshot: customer.country_region || candidate.country_region || '',
    quoted_price: overrides.quoted_price || customer.video_price || '',
    exchange_rate: overrides.exchange_rate || customer.exchange_rate || '',
    price_rmb: overrides.price_rmb || customer.price_rmb || '',
    status: overrides.status || 'candidate',
    owner: overrides.owner || '',
    youtube_video_link: candidate.platform === 'youtube' ? clean(candidate.video_url) : '',
    instagram_video_link: candidate.platform === 'instagram' ? clean(candidate.video_url) : '',
    tiktok_video_link: candidate.platform === 'tiktok' ? clean(candidate.video_url) : '',
    notes: overrides.notes || candidate.ai_match_reason || '',
    sync_status: 'sync_pending'
  };

  if (existing) {
    await dbOperations.run(
      `UPDATE campaign_kols SET
       raw_candidate_id = COALESCE(raw_candidate_id, ?),
       kol_name_snapshot = COALESCE(NULLIF(kol_name_snapshot, ''), ?),
       contact_name_snapshot = COALESCE(NULLIF(contact_name_snapshot, ''), ?),
       youtube_url_snapshot = COALESCE(NULLIF(youtube_url_snapshot, ''), ?),
       youtube_followers_snapshot = COALESCE(NULLIF(youtube_followers_snapshot, ''), ?),
       instagram_url_snapshot = COALESCE(NULLIF(instagram_url_snapshot, ''), ?),
       instagram_followers_snapshot = COALESCE(NULLIF(instagram_followers_snapshot, ''), ?),
       tiktok_url_snapshot = COALESCE(NULLIF(tiktok_url_snapshot, ''), ?),
       tiktok_followers_snapshot = COALESCE(NULLIF(tiktok_followers_snapshot, ''), ?),
       email_snapshot = COALESCE(NULLIF(email_snapshot, ''), ?),
       country_region_snapshot = COALESCE(NULLIF(country_region_snapshot, ''), ?),
       notes = COALESCE(NULLIF(notes, ''), ?),
       sync_status = CASE WHEN feishu_record_id IS NULL OR feishu_record_id = '' THEN 'sync_pending' ELSE sync_status END,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        snapshot.raw_candidate_id,
        snapshot.kol_name_snapshot,
        snapshot.contact_name_snapshot,
        snapshot.youtube_url_snapshot,
        snapshot.youtube_followers_snapshot,
        snapshot.instagram_url_snapshot,
        snapshot.instagram_followers_snapshot,
        snapshot.tiktok_url_snapshot,
        snapshot.tiktok_followers_snapshot,
        snapshot.email_snapshot,
        snapshot.country_region_snapshot,
        snapshot.notes,
        existing.id
      ]
    );
    return dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [existing.id]);
  }

  const fields = [
    'campaign_id', 'customer_id', ...Object.keys(snapshot)
  ];
  const values = [campaignId, customer.id, ...Object.values(snapshot)];
  const placeholders = fields.map(() => '?').join(', ');
  const result = await dbOperations.run(
    `INSERT INTO campaign_kols (${fields.join(', ')}) VALUES (${placeholders})`,
    values
  );
  return dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [result.id]);
}

async function approveCandidate(id, body = {}) {
  const candidate = await dbOperations.get('SELECT * FROM raw_candidates WHERE id = ?', [id]);
  if (!candidate) throw new Error('Raw candidate not found');
  if (candidate.status === 'ignored') throw new Error('Ignored candidate cannot be approved');
  const strategy = await getReadyStrategy(body.strategy_id || candidate.strategy_id);

  const campaignId = Number(body.campaign_id || candidate.campaign_id || strategy.campaign_id || 1);
  const existing = await findExistingCustomer(candidate);
  const customer = existing
    ? await updateCustomerMissingFields(existing, candidate)
    : await createCustomerFromCandidate(candidate);
  const campaignKol = await upsertCampaignKol(campaignId, customer, candidate, body);

  await dbOperations.run(
    `UPDATE raw_candidates SET status = ?, campaign_id = ?, strategy_id = ?, approved_customer_id = ?,
     approved_campaign_kol_id = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [existing ? 'duplicate' : 'approved', campaignId, strategy.id, customer.id, campaignKol.id, id]
  );

  return { customer, campaignKol, candidateStatus: existing ? 'duplicate' : 'approved' };
}

router.get('/', async (req, res) => {
  try {
    const { campaign_id, strategy_id, platform, status, min_score, search } = req.query;
    let sql = `
      SELECT rc.*, c.name as campaign_name, ft.name as finder_task_name,
        ks.name as strategy_name, ks.status as strategy_status
      FROM raw_candidates rc
      LEFT JOIN campaigns c ON c.id = rc.campaign_id
      LEFT JOIN finder_tasks ft ON ft.id = rc.finder_task_id
      LEFT JOIN kol_strategies ks ON ks.id = rc.strategy_id
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
      'evidence_type', 'source_query'
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
      clean(data.source_query)
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
    await dbOperations.run(
      `UPDATE raw_candidates SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
      ['ignored', ...ids]
    );
    res.json({ success: true, message: `Ignored ${ids.length} candidates` });
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
    await dbOperations.run(
      'UPDATE raw_candidates SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['ignored', req.params.id]
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

module.exports = router;
