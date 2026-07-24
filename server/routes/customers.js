const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const { dbOperations } = require('../database');
const { runYoutubeIntakeSnapshot } = require('../services/youtubeIntakeSnapshot');

const router = express.Router();

const LEGACY_PLATFORMS = [
  ['youtube', 'youtube_url', 'youtube_followers'],
  ['instagram', 'instagram_url', 'instagram_followers'],
  ['tiktok', 'tiktok_url', 'tiktok_followers']
];

function mergePlatformAccounts(customer, accounts = []) {
  const normalized = accounts.map((account) => ({
    id: account.id,
    platform: String(account.platform || '').toLowerCase(),
    username: account.username || null,
    profile_url: account.profile_url || null,
    followers_text: account.followers_text || null,
    followers_count: account.followers_count ?? null,
    source: 'normalized'
  }));
  const present = new Set(normalized.map((account) => account.platform));
  const fallback = LEGACY_PLATFORMS
    .filter(([platform, urlField, followersField]) => (
      !present.has(platform) && (customer[urlField] || customer[followersField])
    ))
    .map(([platform, urlField, followersField]) => ({
      id: null,
      platform,
      username: null,
      profile_url: customer[urlField] || null,
      followers_text: customer[followersField] || null,
      followers_count: null,
      source: 'legacy'
    }));
  return [...normalized, ...fallback];
}

function toProjectHistory(row) {
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    project_status: row.project_status || row.status || null,
    quoted_fee: row.quoted_fee || row.quoted_price || null,
    final_fee: row.final_fee || row.price_rmb || null,
    currency: row.currency || null,
    owner: row.owner || null,
    best_evidence_url: row.best_evidence_url || null,
    youtube_video_link: row.youtube_video_link || null,
    instagram_video_link: row.instagram_video_link || null,
    tiktok_video_link: row.tiktok_video_link || null,
    project_notes: row.project_notes || row.notes || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

function parseEvidenceSummary(value) {
  if (!value) return '';
  if (typeof value === 'object') {
    return value.summary || value.reason || value.recommendation || value.evidence_summary || JSON.stringify(value);
  }
  try {
    const parsed = JSON.parse(value);
    return parsed.summary || parsed.reason || parsed.recommendation || parsed.evidence_summary || value;
  } catch (error) {
    return String(value);
  }
}

function isHistoricalCooperation(row) {
  return ['confirmed', 'published'].includes(row.project_status)
    || row.assignment_status === 'completed'
    || row.content_status === 'published';
}

function selectBestFit(fits = []) {
  return [...fits].sort((left, right) => {
    const leftApproved = ['approved', 'duplicate'].includes(left.candidate_status) || left.decision_status === 'approved';
    const rightApproved = ['approved', 'duplicate'].includes(right.candidate_status) || right.decision_status === 'approved';
    if (leftApproved !== rightApproved) return rightApproved - leftApproved;
    const scoreDifference = Number(right.fit_score ?? -1) - Number(left.fit_score ?? -1);
    if (scoreDifference) return scoreDifference;
    return new Date(right.updated_at || 0).getTime() - new Date(left.updated_at || 0).getTime();
  })[0] || null;
}

function creatorGrade(posts, medianViews, engagementRate) {
  if (Number(posts || 0) < 3 || medianViews === null || medianViews === undefined || engagementRate === null || engagementRate === undefined) {
    return '待评估';
  }
  if (Number(medianViews) >= 50000 && Number(engagementRate) >= 0.03) return 'A';
  if (Number(medianViews) >= 15000 && Number(engagementRate) >= 0.015) return 'B';
  return 'C';
}

function platformLabel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ({ youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', twitter: 'X', x: 'X' })[normalized]
    || String(value || '').trim();
}

function projectStatusLabel(value) {
  return ({
    candidate: '候选', to_contact: '待联系', contacted: '已联系', replied: '已回复',
    no_reply: '未回复', negotiating: '沟通中', confirmed: '已确认', published: '已发布',
    completed: '已完成', not_fit: '不合适', cancelled: '已取消', archived: '已归档'
  })[value] || value || '候选';
}

function isActiveProject(row) {
  return !['published', 'completed', 'not_fit', 'cancelled', 'archived'].includes(row.project_status);
}

async function attachKolInsights(customers) {
  if (!customers.length) return customers;
  const ids = customers.map((customer) => customer.id);
  const placeholders = ids.map(() => '?').join(',');
  const fits = await dbOperations.query(
    `SELECT COALESCE(rc.approved_customer_id, rcpf.existing_customer_id) customer_id,
       rcpf.id, rcpf.platform, rcpf.fit_score, rcpf.matched_persona, rcpf.evidence_summary,
       rcpf.decision_status, rcpf.identity_status, rcpf.updated_at,
       rc.evidence_url, rc.video_url, rc.ai_match_reason, rc.status candidate_status,
       p.sku product_sku, p.name product_name, p.category product_category
     FROM raw_candidate_product_fits rcpf
     LEFT JOIN raw_candidates rc ON rc.id = rcpf.latest_raw_candidate_id
     JOIN campaign_products cp ON cp.id = rcpf.campaign_product_id
     JOIN products p ON p.id = cp.product_id
     WHERE COALESCE(rc.approved_customer_id, rcpf.existing_customer_id) IN (${placeholders})
     ORDER BY rcpf.updated_at DESC, rcpf.id DESC`,
    ids
  );
  const projectRows = await dbOperations.query(
    `SELECT ck.customer_id, ck.id campaign_kol_id, ck.campaign_id, ck.project_status, ck.updated_at,
       c.name campaign_name, ck.owner, ck.candidate_priority_score, ck.evidence_summary, ck.best_evidence_url,
       ckp.assignment_status, ckp.content_status, ckp.result_summary,
       p.sku product_sku, p.name product_name
     FROM campaign_kols ck
     JOIN campaigns c ON c.id = ck.campaign_id
     LEFT JOIN campaign_kol_products ckp ON ckp.campaign_kol_id = ck.id
     LEFT JOIN campaign_products cp ON cp.id = ckp.campaign_product_id
     LEFT JOIN products p ON p.id = cp.product_id
     WHERE ck.customer_id IN (${placeholders})
     ORDER BY ck.updated_at DESC, ck.id DESC`,
    ids
  );

  const fitsByCustomer = new Map();
  for (const fit of fits) {
    const key = Number(fit.customer_id);
    if (!fitsByCustomer.has(key)) fitsByCustomer.set(key, []);
    fitsByCustomer.get(key).push(fit);
  }
  const projectsByCustomer = new Map();
  for (const row of projectRows) {
    const key = Number(row.customer_id);
    if (!projectsByCustomer.has(key)) projectsByCustomer.set(key, []);
    projectsByCustomer.get(key).push(row);
  }

  return customers.map((customer) => {
    const customerFits = fitsByCustomer.get(Number(customer.id)) || [];
    const customerProjects = projectsByCustomer.get(Number(customer.id)) || [];
    const projectFits = customerProjects
      .filter((row) => row.product_sku && !isHistoricalCooperation(row))
      .map((row) => ({
        ...row,
        fit_score: row.candidate_priority_score,
        evidence_url: row.best_evidence_url,
        decision_status: 'approved',
        candidate_status: 'approved'
      }));
    const latestFit = selectBestFit([...customerFits, ...projectFits]);
    const historicalRows = customerProjects.filter(isHistoricalCooperation);
    const historicalCampaignIds = new Set(historicalRows.map((row) => row.campaign_kol_id));
    const historicalSkus = Array.from(new Set(historicalRows
      .map((row) => row.product_sku || row.product_name)
      .filter(Boolean)));
    const latestHistory = historicalRows[0] || null;
    const accounts = Array.isArray(customer.platform_accounts) ? customer.platform_accounts : [];
    const primaryAccount = accounts.find((account) => (
      String(account.platform || '').toLowerCase() === String(latestFit?.platform || '').toLowerCase()
    )) || accounts[0] || null;
    const coveredPlatforms = Array.from(new Set(accounts.map((account) => platformLabel(account.platform)).filter(Boolean)));
    const activeRows = customerProjects.filter(isActiveProject);
    const activeProjects = Array.from(activeRows.reduce((map, row) => {
      const key = row.campaign_id || row.campaign_kol_id;
      const current = map.get(key) || { ...row, skus: [] };
      const sku = row.product_sku || row.product_name;
      if (sku && !current.skus.includes(sku)) current.skus.push(sku);
      map.set(key, current);
      return map;
    }, new Map()).values());
    return {
      ...customer,
      covered_platforms: coveredPlatforms,
      primary_platform: platformLabel(primaryAccount?.platform),
      primary_account_name: primaryAccount?.username || null,
      primary_profile_url: primaryAccount?.profile_url || null,
      primary_followers: primaryAccount?.followers_count ?? primaryAccount?.followers_text ?? null,
      content_category: latestFit?.matched_persona || latestFit?.product_category || null,
      current_product_fit_id: latestFit?.id || null,
      current_target_sku: latestFit?.product_sku || latestFit?.product_name || null,
      current_product_name: latestFit?.product_name || null,
      current_fit_score: latestFit?.fit_score ?? null,
      current_fit_reason: parseEvidenceSummary(latestFit?.evidence_summary)
        || latestFit?.ai_match_reason || null,
      current_evidence_url: latestFit?.evidence_url || latestFit?.video_url || null,
      current_fit_decision: ['approved', 'duplicate'].includes(latestFit?.candidate_status)
        ? 'approved'
        : latestFit?.decision_status || null,
      identity_status: latestFit?.identity_status || null,
      historical_cooperation_count: historicalCampaignIds.size,
      historical_cooperation_skus: historicalSkus,
      latest_cooperation_project: latestHistory?.campaign_name || null,
      latest_cooperation_review: latestHistory?.result_summary || null,
      developer: customerProjects[0]?.owner || null,
      repurpose_recommended: null,
      active_project_count: activeProjects.length,
      active_project_summary: activeProjects.map((row) => {
        const sku = row.skus.length ? `｜${row.skus.join('、')}` : '';
        return `${row.campaign_name}｜${projectStatusLabel(row.project_status)}${sku}`;
      }).join('；'),
      latest_project_updated_at: activeProjects[0]?.updated_at || null,
      avg_views_30d: customer.youtube_avg_views_30d ?? null,
      median_views_30d: customer.youtube_median_views_30d ?? null,
      posts_30d: customer.youtube_posts_30d ?? null,
      engagement_rate_30d: customer.youtube_engagement_rate_30d ?? null
      ,creator_grade: creatorGrade(
        customer.youtube_posts_30d,
        customer.youtube_median_views_30d,
        customer.youtube_engagement_rate_30d
      )
    };
  });
}

async function attachPlatformAccounts(customers) {
  if (!customers.length) return customers;
  const placeholders = customers.map(() => '?').join(',');
  const accounts = await dbOperations.query(
    `SELECT id, customer_id, platform, username, profile_url, followers_text, followers_count
     FROM kol_platform_accounts WHERE customer_id IN (${placeholders})
     ORDER BY platform, id`,
    customers.map((customer) => customer.id)
  );
  return customers.map((customer) => ({
    ...customer,
    platform_accounts: mergePlatformAccounts(
      customer,
      accounts.filter((account) => account.customer_id === customer.id)
    )
  }));
}

const TEMPLATE_HEADERS = [
  'KOL',
  '联系人',
  'YouTube',
  'YouTube粉丝量',
  'Instagram',
  'Instagram 粉丝量',
  'TikTok',
  'TikTok 粉丝量',
  'Email',
  '电话',
  '国家地区',
  '视频价格',
  '汇率',
  '价格（RMB）',
  '评分',
  '备注'
];

const FIELD_MAP = {
  KOL: 'name',
  'KOL名称': 'name',
  'KOL 名称': 'name',
  姓名: 'name',
  联系人: 'contact_name',
  YouTube: 'youtube_url',
  Youtube: 'youtube_url',
  youtube: 'youtube_url',
  YouTube粉丝量: 'youtube_followers',
  'YouTube 粉丝量': 'youtube_followers',
  Instagram: 'instagram_url',
  instagram: 'instagram_url',
  'Instagram 粉丝量': 'instagram_followers',
  Instagram粉丝量: 'instagram_followers',
  TikTok: 'tiktok_url',
  Tiktok: 'tiktok_url',
  tiktok: 'tiktok_url',
  'TikTok 粉丝量': 'tiktok_followers',
  TikTok粉丝量: 'tiktok_followers',
  Email: 'email',
  email: 'email',
  邮箱: 'email',
  电话: 'phone',
  联系方式: 'phone',
  国家地区: 'country_region',
  国家: 'country_region',
  地区: 'country_region',
  视频价格: 'video_price',
  报价: 'video_price',
  汇率: 'exchange_rate',
  '价格（RMB）': 'price_rmb',
  '价格(RMB)': 'price_rmb',
  RMB价格: 'price_rmb',
  评分: 'rating',
  备注: 'notes',
  分组: 'group_name',
  公司: 'company',
  频道: 'company'
};

const CUSTOMER_FIELDS = [
  'name',
  'contact_name',
  'youtube_url',
  'youtube_followers',
  'instagram_url',
  'instagram_followers',
  'tiktok_url',
  'tiktok_followers',
  'email',
  'phone',
  'country_region',
  'video_price',
  'exchange_rate',
  'price_rmb',
  'rating',
  'cooperation_status',
  'cooperation_risk_category',
  'cooperation_risk_reason',
  'notes',
  'company',
  'group_id'
];

const getDataDir = () => {
  if (process.pkg) return path.join(path.dirname(process.execPath), 'data');
  return path.join(__dirname, '..', '..', 'data');
};

const uploadsDir = path.join(getDataDir(), 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) cb(null, true);
    else cb(new Error('只支持 Excel 或 CSV 文件'));
  }
});

function normalizeValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function validateCooperationStatus(data) {
  if (normalizeValue(data.cooperation_status) === 'do_not_contact' && !normalizeValue(data.cooperation_risk_reason)) {
    throw new Error('Global do-not-contact KOLs require a cooperation risk reason');
  }
}

function normalizeHeader(header) {
  return normalizeValue(header).replace(/\s+/g, ' ');
}

function mapRow(row) {
  const mapped = {};
  Object.entries(row).forEach(([rawKey, rawValue]) => {
    const normalizedKey = normalizeHeader(rawKey);
    const field = FIELD_MAP[normalizedKey] || FIELD_MAP[normalizedKey.replace(/\s+/g, '')];
    if (field) mapped[field] = normalizeValue(rawValue);
  });
  return mapped;
}

function splitName(name, contactName) {
  const source = normalizeValue(contactName || name);
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

async function getOrCreateGroupId(groupName) {
  const name = normalizeValue(groupName);
  if (!name) return null;
  let group = await dbOperations.get('SELECT id FROM customer_groups WHERE name = ?', [name]);
  if (!group) {
    const result = await dbOperations.run('INSERT INTO customer_groups (name) VALUES (?)', [name]);
    group = { id: result.id };
  }
  return group.id;
}

async function findExistingKol(data, idToExclude) {
  if (data.email) {
    const params = idToExclude ? [data.email, idToExclude] : [data.email];
    const sql = idToExclude
      ? 'SELECT id FROM customers WHERE email = ? AND id != ?'
      : 'SELECT id FROM customers WHERE email = ?';
    const existing = await dbOperations.get(sql, params);
    if (existing) return existing;
  }

  if (data.name) {
    const params = idToExclude ? [data.name, idToExclude] : [data.name];
    const sql = idToExclude
      ? 'SELECT id FROM customers WHERE name = ? AND id != ?'
      : 'SELECT id FROM customers WHERE name = ?';
    return dbOperations.get(sql, params);
  }

  return null;
}

async function insertKol(data) {
  const names = splitName(data.name, data.contact_name);
  const fields = [
    ...CUSTOMER_FIELDS,
    'first_name',
    'last_name'
  ];
  const values = fields.map((field) => {
    if (field === 'first_name') return names.first_name;
    if (field === 'last_name') return names.last_name;
    return data[field] || null;
  });
  const placeholders = fields.map(() => '?').join(', ');
  const result = await dbOperations.run(
    `INSERT INTO customers (${fields.join(', ')}) VALUES (${placeholders})`,
    values
  );
  if (data.cooperation_status) {
    await dbOperations.run(
      'UPDATE customers SET cooperation_status_updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [result.id]
    );
  }
  return result.id;
}

async function updateKol(id, data) {
  const names = splitName(data.name, data.contact_name);
  const fields = [
    ...CUSTOMER_FIELDS,
    'first_name',
    'last_name'
  ];
  const assignments = fields.map((field) => `${field} = ?`).join(', ');
  const values = fields.map((field) => {
    if (field === 'first_name') return names.first_name;
    if (field === 'last_name') return names.last_name;
    return data[field] || null;
  });
  await dbOperations.run(
    `UPDATE customers SET ${assignments}, sync_status = 'sync_pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [...values, id]
  );
  if (data.cooperation_status) {
    await dbOperations.run(
      'UPDATE customers SET cooperation_status_updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [id]
    );
  }
}

function buildTemplateWorkbook() {
  const sampleRows = [
    {
      KOL: 'Sample Creator',
      联系人: 'Contact Name',
      YouTube: 'https://www.youtube.com/@sample',
      YouTube粉丝量: '100K',
      Instagram: 'https://www.instagram.com/sample',
      'Instagram 粉丝量': '50K',
      TikTok: 'https://www.tiktok.com/@sample',
      'TikTok 粉丝量': '80K',
      Email: 'sample@example.com',
      电话: '',
      国家地区: 'US',
      视频价格: '',
      汇率: '',
      '价格（RMB）': '',
      评分: '',
      备注: ''
    }
  ];

  const worksheet = xlsx.utils.json_to_sheet(sampleRows, { header: TEMPLATE_HEADERS });
  worksheet['!cols'] = [
    { wch: 24 },
    { wch: 18 },
    { wch: 38 },
    { wch: 14 },
    { wch: 38 },
    { wch: 16 },
    { wch: 34 },
    { wch: 15 },
    { wch: 28 },
    { wch: 16 },
    { wch: 12 },
    { wch: 14 },
    { wch: 10 },
    { wch: 14 },
    { wch: 10 },
    { wch: 30 }
  ];
  worksheet['!freeze'] = { xSplit: 0, ySplit: 1 };

  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'KOL汇总');
  return workbook;
}

router.get('/', async (req, res) => {
  try {
    const { group_id, status, cooperation_status, platform, country_region, search } = req.query;
    let sql = `
      SELECT c.*, g.name as group_name,
        (SELECT cp.name FROM campaign_kols ck JOIN campaigns cp ON cp.id = ck.campaign_id
         WHERE ck.customer_id = c.id ORDER BY ck.updated_at DESC, ck.id DESC LIMIT 1) latest_project_name,
        (SELECT ck.project_status FROM campaign_kols ck WHERE ck.customer_id = c.id
         ORDER BY ck.updated_at DESC, ck.id DESC LIMIT 1) latest_project_status
      FROM customers c
      LEFT JOIN customer_groups g ON c.group_id = g.id
      WHERE 1=1
    `;
    const params = [];

    if (group_id) {
      sql += ' AND c.group_id = ?';
      params.push(group_id);
    }

    if (status) {
      sql += ' AND c.status = ?';
      params.push(status);
    }

    if (cooperation_status) {
      sql += ' AND c.cooperation_status = ?';
      params.push(cooperation_status);
    }
    if (country_region) {
      sql += ' AND c.country_region = ?';
      params.push(country_region);
    }
    if (platform) {
      const legacyColumn = ['youtube', 'instagram', 'tiktok'].includes(platform)
        ? `${platform}_url`
        : null;
      sql += ` AND (EXISTS (
        SELECT 1 FROM kol_platform_accounts kpa
        WHERE kpa.customer_id = c.id AND LOWER(kpa.platform) = ?
      )${legacyColumn ? ` OR (NOT EXISTS (
        SELECT 1 FROM kol_platform_accounts kpa2
        WHERE kpa2.customer_id = c.id AND LOWER(kpa2.platform) = ?
      ) AND COALESCE(c.${legacyColumn}, '') <> '')` : ''})`;
      params.push(platform);
      if (legacyColumn) params.push(platform);
    }

    if (search) {
      sql += ` AND (
        c.name LIKE ? OR c.contact_name LIKE ? OR c.email LIKE ? OR c.company LIKE ?
        OR c.youtube_url LIKE ? OR c.instagram_url LIKE ? OR c.tiktok_url LIKE ?
      )`;
      const term = `%${search}%`;
      params.push(term, term, term, term, term, term, term);
    }

    sql += ' ORDER BY c.created_at DESC';
    const customers = await dbOperations.query(sql, params);
    const withAccounts = await attachPlatformAccounts(customers);
    res.json({ success: true, data: await attachKolInsights(withAccounts) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/filter-options', async (req, res) => {
  try {
    const countries = await dbOperations.query(
      `SELECT DISTINCT country_region value FROM customers
       WHERE COALESCE(country_region, '') <> '' ORDER BY country_region`
    );
    const normalized = await dbOperations.query(
      `SELECT DISTINCT LOWER(platform) value FROM kol_platform_accounts
       WHERE COALESCE(platform, '') <> '' ORDER BY value`
    );
    const platforms = Array.from(new Set([
      ...normalized.map((row) => row.value),
      'youtube', 'instagram', 'tiktok'
    ])).sort();
    res.json({ success: true, data: { countries: countries.map((row) => row.value), platforms } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/template/download', async (req, res) => {
  try {
    const workbook = buildTemplateWorkbook();
    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const filename = encodeURIComponent('KOL导入模板.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '请选择要导入的 Excel/CSV 文件' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    let rows = [];

    if (ext === '.csv') {
      const workbook = xlsx.readFile(req.file.path, { type: 'file' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = xlsx.utils.sheet_to_json(worksheet, { defval: '' });
    } else {
      const workbook = xlsx.readFile(req.file.path);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = xlsx.utils.sheet_to_json(worksheet, { defval: '' });
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const [index, row] of rows.entries()) {
      const data = mapRow(row);
      data.group_id = await getOrCreateGroupId(data.group_name);

      if (!data.name && !data.email && !data.youtube_url && !data.instagram_url && !data.tiktok_url) {
        skipped++;
        continue;
      }

      if (!data.name) {
        errors.push(`第 ${index + 2} 行：缺少 KOL 名称`);
        continue;
      }

      try {
        const existing = await findExistingKol(data);
        if (existing) {
          await updateKol(existing.id, data);
          updated++;
        } else {
          await insertKol(data);
          inserted++;
        }
      } catch (error) {
        errors.push(`第 ${index + 2} 行：${error.message}`);
      }
    }

    res.json({
      success: true,
      message: `导入完成：新增 ${inserted} 条，更新 ${updated} 条，跳过 ${skipped} 条，失败 ${errors.length} 条`,
      data: { inserted, updated, skipped, failed: errors.length, errors: errors.slice(0, 20) }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
  }
});

router.post('/', async (req, res) => {
  try {
    const data = { ...req.body };
    data.group_id = data.group_id || null;
    validateCooperationStatus(data);

    if (!data.name) {
      return res.status(400).json({ success: false, error: 'KOL 名称为必填字段' });
    }

    const existing = await findExistingKol(data);
    if (existing) {
      return res.status(400).json({ success: false, error: '该 KOL 或邮箱已存在' });
    }

    const id = await insertKol(data);
    let youtube_snapshot = null;
    if (data.youtube_url || String(data.platform || '').toLowerCase() === 'youtube') {
      try { youtube_snapshot = await runYoutubeIntakeSnapshot(id); } catch (error) { youtube_snapshot = { error: error.message }; }
    }
    res.json({ success: true, message: 'KOL 创建成功', data: { id, youtube_snapshot } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/youtube-snapshot', async (req, res) => {
  try {
    const data = await runYoutubeIntakeSnapshot(Number(req.params.id));
    let feishu_sync = null;
    try {
      const { syncRefreshedKolAndCandidates } = require('./sync');
      feishu_sync = await syncRefreshedKolAndCandidates(Number(req.params.id));
    } catch (error) {
      feishu_sync = { error: error.message };
    }
    res.json({ success: true, data: { ...data, feishu_sync } });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.get('/:id/youtube-snapshot', async (req, res) => {
  try {
    const customer = await dbOperations.get(
      `SELECT youtube_avg_views_30d avg_views_30d, youtube_median_views_30d median_views_30d,
       youtube_posts_30d posts_30d, youtube_engagement_rate_30d engagement_rate_30d,
       youtube_snapshot_status status, youtube_snapshot_error error, youtube_snapshot_updated_at updated_at
       FROM customers WHERE id = ?`,
      [req.params.id]
    );
    if (!customer) return res.status(404).json({ success: false, error: 'KOL 不存在' });
    const videos = await dbOperations.query(
      `SELECT youtube_video_id, title, video_url, published_at, duration_seconds, play_count, like_count,
       comment_count, is_short, is_live, included_in_aggregate, exclusion_reason, snapshot_at
       FROM kol_youtube_snapshot_videos WHERE customer_id = ? ORDER BY published_at DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: { ...customer, videos } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const data = { ...req.body };
    data.group_id = data.group_id || null;
    validateCooperationStatus(data);

    if (!data.name) {
      return res.status(400).json({ success: false, error: 'KOL 名称为必填字段' });
    }

    const existing = await findExistingKol(data, req.params.id);
    if (existing) {
      return res.status(400).json({ success: false, error: '该 KOL 或邮箱已被其他记录使用' });
    }

    await updateKol(req.params.id, data);
    res.json({ success: true, message: 'KOL 更新成功' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/batch', async (req, res) => {
  try {
    const ids = (req.body.ids || req.body.customerIds || []).map((id) => Number(id)).filter(Boolean);
    if (!ids.length) {
      return res.status(400).json({ success: false, error: '请选择要删除的 KOL' });
    }

    const placeholders = ids.map(() => '?').join(',');
    await dbOperations.run(`DELETE FROM campaign_kols WHERE customer_id IN (${placeholders})`, ids);
    await dbOperations.run(`DELETE FROM customers WHERE id IN (${placeholders})`, ids);
    res.json({ success: true, message: `已删除 ${ids.length} 个 KOL` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await dbOperations.run('DELETE FROM campaign_kols WHERE customer_id = ?', [req.params.id]);
    await dbOperations.run('DELETE FROM customers WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'KOL 删除成功' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:id/project-history', async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) {
      return res.status(400).json({ success: false, error: '无效的 KOL ID' });
    }
    const customer = await dbOperations.get('SELECT id FROM customers WHERE id = ?', [req.params.id]);
    if (!customer) return res.status(404).json({ success: false, error: 'KOL 不存在' });
    const rows = await dbOperations.query(
      `SELECT ck.*, c.name campaign_name FROM campaign_kols ck
       JOIN campaigns c ON c.id = ck.campaign_id
       WHERE ck.customer_id = ? ORDER BY ck.updated_at DESC, ck.id DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: rows.map(toProjectHistory) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const customer = await dbOperations.get(
      `SELECT c.*, g.name as group_name
       FROM customers c
       LEFT JOIN customer_groups g ON c.group_id = g.id
       WHERE c.id = ?`,
      [req.params.id]
    );

    if (!customer) {
      return res.status(404).json({ success: false, error: 'KOL 不存在' });
    }

    const [withAccounts] = await attachPlatformAccounts([customer]);
    const [data] = await attachKolInsights([withAccounts]);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
module.exports.mergePlatformAccounts = mergePlatformAccounts;
module.exports.toProjectHistory = toProjectHistory;
module.exports.attachPlatformAccounts = attachPlatformAccounts;
module.exports.attachKolInsights = attachKolInsights;
module.exports.parseEvidenceSummary = parseEvidenceSummary;
module.exports.isHistoricalCooperation = isHistoricalCooperation;
module.exports.isActiveProject = isActiveProject;
module.exports.projectStatusLabel = projectStatusLabel;
module.exports.selectBestFit = selectBestFit;
module.exports.creatorGrade = creatorGrade;
