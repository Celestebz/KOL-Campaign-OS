const xlsx = require('xlsx');
const { normalizeVideoUrl } = require('../utils/videoUrlNormalizer');

const CURRENCIES = ['USD', 'CNY', 'EUR', 'GBP', 'JPY', 'HKD', 'CAD', 'AUD', 'SGD'];
const HEADERS = ['视频链接', '合作报价', '达人名称', '备注'];
const MAX_ROWS = 500;
const text = value => String(value ?? '').trim();

function parseQuote(value, defaultCurrency = 'USD') {
  const raw = text(value);
  if (!raw) return null;
  const aliases = { 美元: 'USD', 美金: 'USD', 人民币: 'CNY', 元: 'CNY', 欧元: 'EUR', 英镑: 'GBP', 日元: 'JPY', 港币: 'HKD', 港元: 'HKD', 加元: 'CAD', 澳元: 'AUD', 新加坡元: 'SGD' };
  let normalized = raw.toUpperCase().replace(/人民币|新加坡元|美元|美金|欧元|英镑|日元|港币|港元|加元|澳元|元/g, v => aliases[v]);
  const codes = normalized.match(/[A-Z]{3}/g) || [];
  if (codes.length > 1 || (codes[0] && !CURRENCIES.includes(codes[0]))) throw new Error('报价币种无法识别，请使用 USD 500 或 3000元');
  const currency = codes[0] || defaultCurrency;
  if (!CURRENCIES.includes(currency)) throw new Error('请选择有效的默认币种');
  if (codes[0] && !(normalized.startsWith(codes[0]) || normalized.endsWith(codes[0]))) throw new Error('币种请放在金额前或金额后');
  normalized = normalized.replace(/[A-Z]{3}/g, '').trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(normalized)) throw new Error('报价需为非负金额，最多两位小数；$、¥ 等符号请改为明确币种');
  const amount = Number(normalized.replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount > 999999999999.99) throw new Error('报价金额过大');
  return { amount: amount.toFixed(2), currency, display: `${currency} ${amount.toFixed(2)}` };
}

function readImportFile(file) {
  if (!file || !/\.(xlsx|csv)$/i.test(file.originalname)) throw new Error('请上传 .xlsx 或 .csv 文件');
  const csv = /\.csv$/i.test(file.originalname);
  const source = csv ? file.buffer.toString(file.buffer[0] === 0xff && file.buffer[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '') : file.buffer;
  if (csv && source.includes('\uFFFD')) throw new Error('CSV 编码无法识别，请另存为 UTF-8 CSV 或使用 Excel 文件');
  const workbook = xlsx.read(source, { type: csv ? 'string' : 'buffer', sheetRows: MAX_ROWS + 2 });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('表格没有工作表');
  const matrix = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: true, raw: false });
  const headers = (matrix.shift() || []).map(text);
  if (!headers.includes('视频链接')) throw new Error('缺少「视频链接」列，请下载导入模板');
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) throw new Error('表头存在重复列');
  if (matrix.length > MAX_ROWS || (sheet['!fullref'] && xlsx.utils.decode_range(sheet['!fullref']).e.r > MAX_ROWS)) throw new Error(`每次最多导入 ${MAX_ROWS} 行`);
  return matrix.map((cells, index) => ({
    row_number: index + 2,
    source_url: text(cells[headers.indexOf('视频链接')]),
    quote: text(cells[headers.indexOf('合作报价')]),
    kol_name: text(cells[headers.indexOf('达人名称')]),
    notes: text(cells[headers.indexOf('备注')])
  })).filter(row => row.source_url || row.quote || row.kol_name || row.notes);
}

async function previewImport(rows, options, db) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) throw new Error(`请提供 1–${MAX_ROWS} 行数据`);
  const defaultCurrency = options.default_currency || 'USD';
  if (!CURRENCIES.includes(defaultCurrency)) throw new Error('默认币种无效');
  if (!['skip', 'update'].includes(options.duplicate_mode || 'skip')) throw new Error('重复处理方式无效');
  const campaignId = options.campaign_id ? Number(options.campaign_id) : null;
  if (campaignId && (!Number.isSafeInteger(campaignId) || campaignId < 1)) throw new Error('所属项目无效');
  if (options.campaign_id && !campaignId) throw new Error('所属项目无效');
  if (campaignId && !await db.get('SELECT id FROM campaigns WHERE id = ?', [campaignId])) throw new Error('所属项目不存在');
  const seen = new Set();
  const result = [];
  for (const [index, input] of rows.entries()) {
    const row = { row_number: Number(input?.row_number) || index + 2, source_url: text(input?.source_url), quote: text(input?.quote), kol_name: text(input?.kol_name), notes: text(input?.notes) };
    try {
      if (!row.source_url) throw new Error('视频链接不能为空');
      if (row.source_url.length > 2048 || row.kol_name.length > 255 || row.notes.length > 10000) throw new Error('链接、达人名称或备注过长');
      row.normalized = normalizeVideoUrl(row.source_url);
      if (row.normalized.platform === 'unknown') throw new Error('请填写 YouTube、Instagram 或 TikTok 的完整视频链接');
      row.price = parseQuote(row.quote, defaultCurrency);
      const hash = row.normalized.canonicalUrlHash;
      if (seen.has(hash)) { row.status = 'skip'; row.reason = '表格内重复链接'; }
      else {
        seen.add(hash);
        const existing = await db.get('SELECT id FROM video_sources WHERE canonical_url_hash = ?', [hash]);
        row.status = existing ? (options.duplicate_mode === 'update' ? 'update' : 'skip') : 'new';
        row.reason = existing ? (row.status === 'skip' ? '链接已存在' : '仅更新非空信息，保留抓取和分析结果') : '';
      }
    } catch (error) { row.status = 'invalid'; row.reason = error.message; }
    result.push(row);
  }
  return { rows: result, campaign_id: campaignId, summary: Object.fromEntries(['new', 'update', 'skip', 'invalid'].map(status => [status, result.filter(row => row.status === status).length])) };
}

// Each row is atomic: metadata and its optional project association succeed together.
async function saveImportRow(row, options, sequelize) {
  return sequelize.transaction(async transaction => {
    const select = (sql, replacements) => sequelize.query(sql, { replacements, transaction, type: 'SELECT' });
    const run = (sql, replacements) => sequelize.query(sql, { replacements, transaction });
    const hash = row.normalized.canonicalUrlHash;
    const existing = (await select('SELECT id FROM video_sources WHERE canonical_url_hash = ? FOR UPDATE', [hash]))[0];
    if (existing && options.duplicate_mode !== 'update') return { status: 'skip', id: existing.id, reason: '链接已存在' };
    let id = existing?.id;
    if (existing) {
      const fields = []; const values = [];
      for (const key of ['kol_name', 'notes']) if (row[key]) { fields.push(`${key} = ?`); values.push(row[key]); }
      if (row.price) {
        fields.push('cooperation_price = ?', 'cooperation_amount = ?', 'cooperation_currency = ?');
        values.push(row.price.display, row.price.amount, row.price.currency);
      }
      if (fields.length) await run(`UPDATE video_sources SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...values, id]);
    } else {
      await run(`INSERT INTO video_sources (platform, platform_video_id, source_url, canonical_url, canonical_url_hash, kol_name, cooperation_price, cooperation_amount, cooperation_currency, notes, status, crawl_status, analysis_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', 'not_analyzed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [row.normalized.platform, row.normalized.platformVideoId, row.source_url, row.normalized.canonicalUrl, hash, row.kol_name, row.price?.display || '', row.price?.amount ?? null, row.price?.currency ?? null, row.notes]);
      id = (await select('SELECT id FROM video_sources WHERE canonical_url_hash = ?', [hash]))[0].id;
    }
    if (options.campaign_id) await run(`INSERT INTO campaign_videos (campaign_id, video_source_id, added_reason, created_at, updated_at)
      VALUES (?, ?, 'manual', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON DUPLICATE KEY UPDATE added_reason = IF(added_reason = 'finder', 'manual', added_reason), updated_at = CURRENT_TIMESTAMP`, [options.campaign_id, id]);
    return { status: existing ? 'updated' : 'imported', id };
  });
}

module.exports = { CURRENCIES, HEADERS, MAX_ROWS, parseQuote, readImportFile, previewImport, saveImportRow };
