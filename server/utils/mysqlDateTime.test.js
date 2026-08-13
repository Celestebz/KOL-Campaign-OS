// replacements 时区回归：sequelize 的 injectReplacements 序列化 Date 时忽略 timezone 配置，
// 会按 Node 进程本地时区写库（读路径按 UTC 解析，前端再转本地 → 显示晚 8 小时）。
// dbOperations 必须在入口处把 Date 参数统一转成 UTC 墙钟字符串。
const test = require('node:test');
const assert = require('node:assert/strict');
const { toMysqlDatetime, sanitizeBindParams } = require('./mysqlDateTime');
const { dbOperations, sequelize } = require('../database');

const originalQuery = sequelize.query;

test.afterEach(() => {
  sequelize.query = originalQuery;
});

test('sanitizeBindParams converts Date params to UTC wall-clock strings', () => {
  const out = sanitizeBindParams([new Date('2026-08-03T01:21:19.000Z'), 'plain', 42, null]);
  assert.equal(out[0], '2026-08-03 01:21:19');
  assert.equal(out[1], 'plain');
  assert.equal(out[2], 42);
  assert.equal(out[3], null);
});

test('sanitizeBindParams converts Date values in named params but leaves strings untouched', () => {
  const out = sanitizeBindParams({
    at: new Date('2026-08-03T01:21:19.000Z'),
    since: '2026-08-01',
    name: 'x'
  });
  assert.equal(out.at, '2026-08-03 01:21:19');
  assert.equal(out.since, '2026-08-01');
  assert.equal(out.name, 'x');
});

test('sanitizeBindParams passes through non-date params unchanged', () => {
  assert.equal(sanitizeBindParams(undefined), undefined);
  assert.deepEqual(sanitizeBindParams(['2026-08-03 01:21:19']), ['2026-08-03 01:21:19']);
});

test('dbOperations.run converts Date replacements to UTC wall-clock strings', async () => {
  let captured;
  sequelize.query = async (sql, options) => {
    captured = options.replacements;
    return [1, 1];
  };
  await dbOperations.run('INSERT INTO t (d, name) VALUES (?, ?)', [new Date('2026-08-03T01:21:19.000Z'), 'a']);
  assert.equal(captured[0], '2026-08-03 01:21:19');
  assert.equal(captured[1], 'a');
});

test('dbOperations.query converts Date replacements to UTC wall-clock strings', async () => {
  let captured;
  sequelize.query = async (sql, options) => {
    captured = options.replacements;
    return [];
  };
  await dbOperations.query('SELECT * FROM t WHERE d >= ?', [new Date('2026-08-03T01:21:19.000Z')]);
  assert.equal(captured[0], '2026-08-03 01:21:19');
});

test('toMysqlDatetime keeps existing UTC conversion behavior', () => {
  assert.equal(toMysqlDatetime(new Date('2026-08-03T01:21:19.000Z')), '2026-08-03 01:21:19');
});
