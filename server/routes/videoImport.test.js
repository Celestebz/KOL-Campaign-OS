const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const xlsx = require('xlsx');
const createRouter = require('./videoImport');
const url = 'https://youtu.be/dQw4w9WgXcQ';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/import', createRouter({ dbOperations: { get: async () => null }, sequelize: {
    transaction: async callback => callback({}),
    query: async sql => sql.startsWith('SELECT') && !sql.includes('FOR UPDATE') ? [{ id: 8 }] : []
  } }));
  return instance;
}

test('template has exactly four input columns and no sample records', async () => {
  const response = await request(app()).get('/import/template').buffer(true).parse((res, callback) => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => callback(null, Buffer.concat(chunks)));
  }).expect(200);
  const workbook = xlsx.read(response.body, { type: 'buffer' });
  assert.deepEqual(xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 }), [['视频链接', '合作报价', '达人名称', '备注']]);
});
test('preview CSV and confirm report partial success and IDs for follow-up crawling', async () => {
  const preview = await request(app()).post('/import/preview').field('default_currency', 'CNY').attach('file', Buffer.from(`视频链接,合作报价\n${url},500\nbad,20`), 'input.csv').expect(200);
  assert.equal(preview.body.data.rows[0].price.currency, 'CNY');
  const result = await request(app()).post('/import/confirm').send({ default_currency: 'CNY', rows: preview.body.data.rows }).expect(200);
  assert.equal(result.body.data.imported, 1);
  assert.equal(result.body.data.failed, 1);
  assert.deepEqual(result.body.data.ids, [8]);
});
test('confirm revalidates forged rows and malformed requests', async () => {
  const result = await request(app()).post('/import/confirm').send({ rows: [{ source_url: 'not-a-video', status: 'new', price: { amount: '1', currency: 'USD' } }] }).expect(200);
  assert.equal(result.body.data.failed, 1);
  await request(app()).post('/import/confirm').send({ rows: [] }).expect(400);
  await request(app()).post('/import/preview').attach('file', Buffer.from('x'), 'bad.txt').expect(400);
});
