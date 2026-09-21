// Opt-in, isolated loopback database only. Never uses DB_NAME/DB_HOST from configuration.
const test = require('node:test');
const assert = require('node:assert/strict');
test('MySQL migration, concurrent claims, rollback and resume', { skip: process.env.DISCOVERY_MYSQL_TEST !== '1' }, async () => {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
  const mysql = require('mysql2/promise');
  const schema = `kol_discovery_test_${process.pid}`;
  assert.match(schema, /^kol_discovery_test_[0-9]+$/);
  const admin = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: process.env.DB_ROOT_PASSWORD || 'root_password' });
  let sequelize;
  try {
    // CREATE (not DROP/replace) ensures an unexpected pre-existing schema is never removed.
    await admin.query(`CREATE DATABASE ${schema}`);
    process.env.DB_HOST = '127.0.0.1'; process.env.DB_PORT = '3306';
    process.env.DB_NAME = schema; process.env.DB_USER = 'root';
    process.env.DB_PASSWORD = process.env.DB_ROOT_PASSWORD || 'root_password';
    process.env.NODE_ENV = 'test';
    const db = require('../database');
    sequelize = db.sequelize;
    const q = (sql, replacements = []) => sequelize.query(sql, { replacements, logging: false });
    await q('CREATE TABLE campaigns (id INT PRIMARY KEY, name VARCHAR(100), brand VARCHAR(100), product VARCHAR(100), status VARCHAR(20))');
    await q('CREATE TABLE products (id INT PRIMARY KEY, name VARCHAR(100), brand VARCHAR(100), sku VARCHAR(100), category VARCHAR(100), product_url TEXT, price DECIMAL(10,2), currency VARCHAR(10), description TEXT, selling_points TEXT, status VARCHAR(20))');
    await q('CREATE TABLE campaign_products (id INT PRIMARY KEY, campaign_id INT, product_id INT, role VARCHAR(50), priority INT, campaign_brief TEXT, status VARCHAR(20))');
    await q('CREATE TABLE kol_strategies (id INT PRIMARY KEY, campaign_id INT, campaign_product_id INT, name VARCHAR(100), status VARCHAR(20))');
    await q(`CREATE TABLE finder_tasks (id INT AUTO_INCREMENT PRIMARY KEY, campaign_id INT, campaign_product_id INT, strategy_id INT,
      name VARCHAR(255), platform VARCHAR(100), keywords TEXT, status VARCHAR(50), search_sources TEXT, discovery_routes TEXT,
      raw_request TEXT, notes TEXT, source_agent VARCHAR(255))`);
    await q('CREATE TABLE raw_candidates (id INT PRIMARY KEY, finder_task_id INT, status VARCHAR(50))');
    await require('../migrations/20260918000001-create-discovery-requests').up(sequelize.getQueryInterface(), db.Sequelize);
    await require('../migrations/20260918000002-discovery-without-strategy').up(sequelize.getQueryInterface(), db.Sequelize);
    await q("INSERT INTO campaigns VALUES (1, 'Test campaign', 'Brand', 'Tree', 'active')");
    await q("INSERT INTO products (id, name, status) VALUES (1, 'Tree', 'active')");
    await q("INSERT INTO campaign_products (id, campaign_id, product_id, status) VALUES (1, 1, 1, 'active')");
    const { getService, createDiscoveryService } = require('./discoveryRequests');
    const service = getService();
    const body = { request_key: 'integration-1', campaign_id: 1, campaign_product_id: 1, target_platform: 'tiktok', target_count: 10, requirements: 'US home creators' };
    const created = await Promise.all([service.create(1, body), service.create(1, body)]);
    assert.equal(created[0].id, created[1].id);
    const id = created[0].id;
    const claimed = await Promise.allSettled(['runner-0001', 'runner-0002'].map((execution_id) => service.claim(1, id, { execution_id })));
    assert.equal(claimed.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(claimed.find((r) => r.status === 'rejected').reason.statusCode, 409);
    const [tasks] = await q('SELECT * FROM finder_tasks');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, 'draft');
    assert.equal(tasks[0].strategy_id, null);
    assert.equal((await q('SELECT * FROM kol_strategies'))[0].length, 0);
    const taskContext = await require('../routes/finderTasks').getFinderTaskContext(tasks[0]);
    assert.equal(taskContext.id, null);
    assert.equal(taskContext.requirements, body.requirements);
    assert.equal(taskContext.product_name, 'Tree');
    assert.deepEqual(taskContext.finder_handoff, { requirements: body.requirements });
    assert.equal((await service.catalog()).length, 1);
    await assert.rejects(service.create(1, { ...body, request_key: 'wrong-product', campaign_product_id: 999 }), { statusCode: 409 });
    await assert.rejects(service.get(2, id), { statusCode: 404 });
    assert.equal((await service.list(1)).length, 1);
    assert.deepEqual(await service.list(2), []);
    await service.control(1, id, 'cancel');
    await service.control(1, id, 'retry');
    await service.claim(1, id, { execution_id: 'runner-0003' });
    assert.equal((await q('SELECT * FROM finder_tasks'))[0].length, 1);
    // The request claim and Finder creation share the same real MySQL transaction.
    const failingService = createDiscoveryService({ model: db.models.DiscoveryRequest, sequelize,
      query: (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: db.Sequelize.QueryTypes.SELECT, logging: false }),
      createFinderTask: async (options) => { await require('../routes/finderTasks').createFinderTask(options); throw new Error('simulated interruption'); } });
    const other = await service.create(1, { ...body, request_key: 'integration-2' });
    await assert.rejects(failingService.claim(1, other.id, { execution_id: 'runner-0004' }), /simulated interruption/);
    assert.equal((await service.get(1, other.id)).status, 'queued');
    assert.equal((await q('SELECT * FROM finder_tasks'))[0].length, 1);
  } finally {
    if (sequelize) {
      await sequelize.close();
      await admin.query(`DROP DATABASE ${schema}`);
    }
    await admin.end();
  }
});
