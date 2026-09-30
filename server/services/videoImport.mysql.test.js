const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { previewImport, saveImportRow } = require('./videoImport');

test('MySQL migration and import preserve existing analysis and optional project association', { skip: process.env.VIDEO_IMPORT_MYSQL_TEST !== '1' }, async () => {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
  const Sequelize = require('sequelize');
  const config = require('../config/database');
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(config.host), 'This test only runs against local MySQL');
  const db = new Sequelize.Sequelize({ ...config, logging: false });
  const transaction = await db.transaction();
  const query = (sql, replacements = [], type) => db.query(sql, { replacements, transaction, type });
  try {
    // Session-scoped temporary tables shadow the real tables; no application data is written.
    await query(`CREATE TEMPORARY TABLE video_sources (
      id INT AUTO_INCREMENT PRIMARY KEY, platform VARCHAR(100), platform_video_id VARCHAR(255),
      source_url VARCHAR(2048), canonical_url VARCHAR(2048), canonical_url_hash CHAR(64) UNIQUE,
      kol_name VARCHAR(255), cooperation_price VARCHAR(255), notes TEXT, title TEXT,
      status VARCHAR(50), crawl_status VARCHAR(50), analysis_status VARCHAR(50),
      created_at DATETIME, updated_at DATETIME)`);
    await query(`CREATE TEMPORARY TABLE campaign_videos (
      campaign_id INT, video_source_id INT, added_reason VARCHAR(100),
      created_at DATETIME, updated_at DATETIME, UNIQUE KEY (campaign_id, video_source_id))`);
    await query('CREATE TEMPORARY TABLE campaigns (id INT PRIMARY KEY, name VARCHAR(255))');
    await query("INSERT INTO campaigns VALUES (7, '项目A'), (8, '项目B')");
    const qi = db.getQueryInterface();
    await require('../migrations/20260930000001-add-video-cooperation-amount').up({
      describeTable: table => qi.describeTable(table, { transaction }),
      addColumn: (table, column, type) => qi.addColumn(table, column, type, { transaction })
    }, Sequelize);
    const dbOperations = { get: async (sql, args) => (await query(sql, args, 'SELECT'))[0], query: (sql, args) => query(sql, args, 'SELECT') };
    const scoped = { transaction: callback => callback(transaction), query: (sql, options) => db.query(sql, { ...options, transaction }) };
    const source_url = 'https://youtu.be/dQw4w9WgXcQ';
    const row = (await previewImport([{ source_url, quote: '3000元', notes: 'original' }], {}, dbOperations)).rows[0];
    const created = await saveImportRow(row, {}, scoped);
    assert.equal(created.status, 'imported');
    let saved = await dbOperations.get('SELECT * FROM video_sources WHERE id = ?', [created.id]);
    assert.equal(saved.cooperation_amount, '3000.00');
    assert.equal(saved.cooperation_currency, 'CNY');
    assert.equal((await query('SELECT * FROM campaign_videos', [], 'SELECT')).length, 0);
    await query("UPDATE video_sources SET title = 'Fetched title', analysis_status = 'success' WHERE id = ?", [created.id]);
    const update = (await previewImport([{ source_url, quote: '', kol_name: 'Creator', campaign_name: '项目A' }], { duplicate_mode: 'update' }, dbOperations)).rows[0];
    await saveImportRow(update, { duplicate_mode: 'update' }, scoped);
    saved = await dbOperations.get('SELECT * FROM video_sources WHERE id = ?', [created.id]);
    assert.equal(saved.cooperation_amount, '3000.00');
    assert.equal(saved.notes, 'original');
    assert.equal(saved.title, 'Fetched title');
    assert.equal(saved.analysis_status, 'success');
    assert.equal(saved.kol_name, 'Creator');
    assert.equal((await query('SELECT * FROM campaign_videos', [], 'SELECT'))[0].campaign_id, 7);
    const link = (await previewImport([{ source_url, quote: 'USD 900', campaign_name: '项目B' }], {}, dbOperations)).rows[0];
    assert.equal((await saveImportRow(link, {}, scoped)).status, 'linked');
    assert.equal((await query('SELECT * FROM campaign_videos', [], 'SELECT')).length, 2);
    assert.equal((await dbOperations.get('SELECT * FROM video_sources WHERE id = ?', [created.id])).cooperation_amount, '3000.00');
    assert.equal((await previewImport([{ source_url, campaign_name: '项目B' }], {}, dbOperations)).rows[0].status, 'skip');
    assert.equal((await saveImportRow(row, {}, scoped)).status, 'skip');
  } finally {
    await query('DROP TEMPORARY TABLE IF EXISTS campaign_videos');
    await query('DROP TEMPORARY TABLE IF EXISTS campaigns');
    await query('DROP TEMPORARY TABLE IF EXISTS video_sources');
    await transaction.rollback();
    await db.close();
  }
});
