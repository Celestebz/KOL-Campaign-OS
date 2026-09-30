const test = require('node:test');
const assert = require('node:assert/strict');
const xlsx = require('xlsx');
const { parseQuote, readImportFile, previewImport, saveImportRow } = require('./videoImport');
const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const emptyDb = { get: async () => null };

test('quote parsing preserves explicit currencies, zero and default currency', () => {
  for (const [input, currency, amount] of [['USD 500', 'USD', '500.00'], ['500美元', 'USD', '500.00'], ['3000元', 'CNY', '3000.00'], ['EUR 1,234.56', 'EUR', '1234.56'], ['0', 'GBP', '0.00'], ['500', 'GBP', '500.00'], ['日元 300', 'JPY', '300.00']]) {
    assert.deepEqual(parseQuote(input, 'GBP'), { amount, currency, display: `${currency} ${amount}` });
  }
  assert.equal(parseQuote(''), null);
  for (const input of ['$500', '¥3000', '-5', '5.555', '12,34', 'USD EUR 4', '5USD00', 'NaN', '1000000000000']) assert.throws(() => parseQuote(input));
});

function file(matrix) {
  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet(matrix), '导入模板');
  return { originalname: 'test.xlsx', buffer: xlsx.write(book, { type: 'buffer', bookType: 'xlsx' }) };
}
test('Excel and UTF-8 CSV parsing retain physical row numbers and optional fields', () => {
  const rows = readImportFile(file([['视频链接', '合作报价', '达人名称', '备注'], [], [url, '3000元', '小明', '说明']]));
  assert.deepEqual(rows, [{ row_number: 3, source_url: url, quote: '3000元', kol_name: '小明', notes: '说明' }]);
  const csv = readImportFile({ originalname: 'test.csv', buffer: Buffer.from(`\uFEFF视频链接,合作报价,达人名称,备注\n${url},USD 500,小明,备注`) });
  assert.equal(csv[0].kol_name, '小明');
  assert.throws(() => readImportFile(file([['错误列'], [url]])), /视频链接/);
  assert.throws(() => readImportFile(file([['视频链接'], ...Array.from({ length: 501 }, () => [url])])), /500/);
});

test('preview detects normalized duplicates and invalid rows without writes', async () => {
  const preview = await previewImport([{ source_url: url, quote: '500' }, { source_url: 'https://youtu.be/dQw4w9WgXcQ' }, { source_url: 'bad' }, { source_url: 'https://www.instagram.com/p/abc/', quote: '$12' }], { default_currency: 'EUR' }, emptyDb);
  assert.deepEqual(preview.summary, { new: 1, update: 0, skip: 1, invalid: 2 });
  assert.equal(preview.rows[0].price.currency, 'EUR');
  assert.equal(preview.campaign_id, null);
  assert.equal((await previewImport([{ source_url: url }], {}, { get: async () => ({ id: 1 }) })).rows[0].status, 'skip');
  assert.equal((await previewImport([{ source_url: url }], { duplicate_mode: 'update' }, { get: async () => ({ id: 1 }) })).rows[0].status, 'update');
  await assert.rejects(() => previewImport([{ source_url: url }], { campaign_id: 99 }, emptyDb), /项目不存在/);
});

function fakeSequelize(existing) {
  const queries = [];
  return {
    queries,
    transaction: async callback => callback({ test: true }),
    query: async (sql, opts) => {
      assert.ok(opts.transaction);
      queries.push({ sql, values: opts.replacements });
      if (sql.startsWith('SELECT')) return existing || !sql.includes('FOR UPDATE') ? [{ id: 42 }] : [];
      return [];
    }
  };
}
test('new imports store separate price fields and do not assign a default project', async () => {
  const row = (await previewImport([{ source_url: url, quote: 'USD 500' }], {}, emptyDb)).rows[0];
  const db = fakeSequelize(false);
  assert.deepEqual(await saveImportRow(row, {}, db), { status: 'imported', id: 42 });
  assert.ok(db.queries.some(query => query.sql.includes('cooperation_amount') && query.values.includes('500.00') && query.values.includes('USD')));
  assert.ok(!db.queries.some(query => query.sql.includes('campaign_videos')));
});
test('concurrent existing rows are skipped; updates preserve empty fields and analysis', async () => {
  const row = (await previewImport([{ source_url: url, notes: 'new note' }], {}, emptyDb)).rows[0];
  const skipped = fakeSequelize(true);
  assert.equal((await saveImportRow(row, {}, skipped)).status, 'skip');
  assert.equal(skipped.queries.length, 1);
  const updated = fakeSequelize(true);
  await saveImportRow(row, { duplicate_mode: 'update', campaign_id: 7 }, updated);
  const sql = updated.queries.find(query => query.sql.startsWith('UPDATE')).sql;
  assert.ok(sql.includes('notes = ?'));
  for (const field of ['kol_name', 'cooperation_price', 'analysis_status', 'title']) assert.ok(!sql.includes(field));
  assert.ok(updated.queries.some(query => query.sql.includes('campaign_videos') && query.values[0] === 7));
});

test('additive migration can resume after partial completion', async () => {
  const migration = require('../migrations/20260930000001-add-video-cooperation-amount');
  const added = [];
  await migration.up({ describeTable: async () => ({ cooperation_amount: {} }), addColumn: async (_, column) => added.push(column) }, require('sequelize'));
  assert.deepEqual(added, ['cooperation_currency']);
});
