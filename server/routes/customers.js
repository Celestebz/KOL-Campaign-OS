const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const { dbOperations } = require('../database');

const router = express.Router();

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
    const { group_id, status, cooperation_status, search } = req.query;
    let sql = `
      SELECT c.*, g.name as group_name
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
    res.json({ success: true, data: customers });
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
    res.json({ success: true, message: 'KOL 创建成功', data: { id } });
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

    res.json({ success: true, data: customer });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
