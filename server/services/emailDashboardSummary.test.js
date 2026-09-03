const assert = require('node:assert/strict');
const test = require('node:test');
const { buildSummary } = require('./emailDashboardSummary');
const { runWithUser } = require('../utils/requestContext');

const buildOwnedSummary = (db, now) => runWithUser({ id: 27 }, () => buildSummary(db, now));

// 上海周二 2026-07-28 09:30 (UTC+8) = UTC 2026-07-28 01:30
const NOW = new Date('2026-07-28T01:30:00.000Z');

function makeDbStub(rowsBySql) {
  // 通过 SQL 关键字片段匹配返回行：rowsBySql[signature] -> rows[]；
  // 每个 SQL 内部以 `${signature}` 占位符区分（这里简化为单签名匹配）
  const calls = [];
  return {
    calls,
    async get(sql, params) {
      calls.push({ sql: String(sql), params });
      const signatures = Object.keys(rowsBySql);
      for (const sig of signatures) {
        if (String(sql).includes(sig)) {
          return rowsBySql[sig] === undefined ? null : rowsBySql[sig];
        }
      }
      return null;
    }
  };
}

test('buildSummary aggregates today/week/previous/reply window in parallel and computes deltas', async () => {
  const db = makeDbStub({
    'NOT EXISTS': [{ total: 7 }], // today / week / previous 共用同一签名，按调用顺序解释
    'COUNT(DISTINCT er.customer_id)': [{ total: 60 }],
    'COUNT(DISTINCT r.customer_id)': [{ total: 9 }]
  });
  // 今日联络返回 5；本周/上周首次联络分别返回 12、9
  let firstTouchIdx = 0;
  const firstTouchReturns = [12, 9];
  db.get = async (sql, params) => {
    db.calls.push({ sql: String(sql), params });
    if (sql.includes('campaign_kol_events')) return { total: 5 };
    if (sql.includes('NOT EXISTS')) {
      return { total: firstTouchReturns[firstTouchIdx++] };
    }
    if (sql.includes('COUNT(DISTINCT er.customer_id)')) return { total: 60 };
    if (sql.includes('COUNT(DISTINCT r.customer_id)')) return { total: 9 };
    return null;
  };

  const summary = await buildOwnedSummary(db, NOW);

  assert.equal(summary.todayContactedKols, 5);
  assert.equal(summary.weekContactedKols, 12);
  assert.equal(summary.previousWeekContactedKols, 9);
  assert.equal(summary.weekDifference, 3);
  assert.equal(summary.deliveredKols30d, 60);
  assert.equal(summary.repliedKols30d, 9);
  // 9 / 60 = 0.15 → 15.0%
  assert.equal(summary.replyRate30d, 15);
  assert.equal(summary.denominatorType, 'sent_success');
  assert.equal(summary.timezone, 'Asia/Shanghai');
});

test('buildSummary returns null replyRate30d when deliveredKols30d is 0', async () => {
  const db = makeDbStub({
    'NOT EXISTS': [{ total: 0 }],
    'COUNT(DISTINCT er.customer_id)': [{ total: 0 }],
    'COUNT(DISTINCT r.customer_id)': [{ total: 0 }]
  });
  const summary = await buildOwnedSummary(db, NOW);
  assert.equal(summary.replyRate30d, null);
  assert.equal(summary.deliveredKols30d, 0);
  assert.equal(summary.repliedKols30d, 0);
});

test('buildSummary reports negative weekDifference when this week lags', async () => {
  let idx = 0;
  const returns = [6, 12]; // week=6, previous=12
  const db = {
    async get(sql) {
      if (sql.includes('campaign_kol_events')) return { total: 3 };
      if (sql.includes('NOT EXISTS')) return { total: returns[idx++] };
      if (sql.includes('COUNT(DISTINCT er.customer_id)')) return { total: 0 };
      if (sql.includes('COUNT(DISTINCT r.customer_id)')) return { total: 0 };
      return null;
    }
  };
  const summary = await buildOwnedSummary(db, NOW);
  assert.equal(summary.weekDifference, -6);
});

test('buildSummary computes weekDifference=0 when week matches previous', async () => {
  let idx = 0;
  const returns = [8, 8];
  const db = {
    async get(sql) {
      if (sql.includes('campaign_kol_events')) return { total: 2 };
      if (sql.includes('NOT EXISTS')) return { total: returns[idx++] };
      if (sql.includes('COUNT(DISTINCT er.customer_id)')) return { total: 0 };
      if (sql.includes('COUNT(DISTINCT r.customer_id)')) return { total: 0 };
      return null;
    }
  };
  const summary = await buildOwnedSummary(db, NOW);
  assert.equal(summary.weekDifference, 0);
});

test('buildSummary passes Shanghai-day-start ISO timestamp as the SQL parameter', async () => {
  const seenStarts = [];
  const db = {
    async get(sql, params = []) {
      if (sql.includes('campaign_kol_events')) {
        seenStarts.push(params[1]);
        return { total: 0 };
      }
      return { total: 0 };
    }
  };
  await buildOwnedSummary(db, NOW);
  // 第一次调用：上海日界 → UTC 2026-07-27 16:00:00
  assert.equal(seenStarts[0], '2026-07-27 16:00:00');
});

test('buildSummary uses Monday as the start of the Shanghai week', async () => {
  const seenStarts = [];
  const db = {
    async get(sql, params = []) {
      if (sql.includes('NOT EXISTS')) {
        seenStarts.push(params[1]);
        return { total: 0 };
      }
      return { total: 0 };
    }
  };
  await buildOwnedSummary(db, NOW);
  // 第一次首次联络查询：上海本周一起点 = 2026-07-26 周一 16:00 UTC
  assert.equal(seenStarts[0], '2026-07-26 16:00:00');
});

test('buildSummary passes rolling 30-day window for reply rate denominator and numerator', async () => {
  const seenStarts = [];
  const db = {
    async get(sql, params = []) {
      seenStarts.push({ sql: String(sql), params });
      return { total: 0 };
    }
  };
  await buildOwnedSummary(db, NOW);
  const sent30d = seenStarts.find((s) => s.sql.includes('COUNT(DISTINCT er.customer_id)'));
  const replies30d = seenStarts.find((s) => s.sql.includes('COUNT(DISTINCT r.customer_id)'));
  assert.ok(sent30d, 'should query email_records for 30-day denominator');
  assert.ok(replies30d, 'should query email_replies for 30-day numerator');
  // NOW - 30 days = 2026-06-28 01:30 UTC
  assert.deepEqual(sent30d.params, [27, '2026-06-28 01:30:00']);
  assert.deepEqual(replies30d.params, [27, '2026-06-28 01:30:00', 27]);
});

test('buildSummary excludes auto-replies (ai_intent=other) from numerator and includes confirmed replies', async () => {
  let capturedSql = '';
  const db = {
    async get(sql, params) {
      if (sql.includes('COUNT(DISTINCT r.customer_id)')) {
        capturedSql = String(sql);
      }
      return { total: 0 };
    }
  };
  await buildOwnedSummary(db, NOW);
  assert.match(capturedSql, /ai_intent IN \('interested', 'question', 'rejected'\)/);
  assert.match(capturedSql, /confirm_status = 'confirmed'/);
  // 确保没有把 'other' 列入有效回复
  assert.doesNotMatch(capturedSql, /'other'/);
});

test('buildSummary rounds replyRate30d to one decimal place', async () => {
  let idx = 0;
  const returns = [10, 10]; // first-touch 不影响
  const db = {
    async get(sql) {
      if (sql.includes('campaign_kol_events')) return { total: 10 };
      if (sql.includes('NOT EXISTS')) return { total: returns[idx++] };
      if (sql.includes('COUNT(DISTINCT er.customer_id)')) return { total: 70 };
      if (sql.includes('COUNT(DISTINCT r.customer_id)')) return { total: 6 };
      return null;
    }
  };
  const summary = await buildOwnedSummary(db, NOW);
  // 6 / 70 = 0.085714... → 8.6%
  assert.equal(summary.replyRate30d, 8.6);
});

test('buildSummary computes 30-day bounce rate and hard/soft counts by sent record', async () => {
  let idx = 0;
  const db = {
    async get(sql) {
      if (sql.includes('campaign_kol_events')) return { total: 1 };
      if (sql.includes('NOT EXISTS')) return { total: [2, 1][idx++] };
      if (sql.includes('COUNT(DISTINCT er.customer_id)')) return { total: 20 };
      if (sql.includes('COUNT(DISTINCT r.customer_id)')) return { total: 4 };
      if (sql.includes('COUNT(DISTINCT er.id) AS sent_total')) {
        return { sent_total: 50, bounced_total: 3, hard_total: 2, soft_total: 1 };
      }
      return null;
    }
  };
  const summary = await buildOwnedSummary(db, NOW);
  assert.equal(summary.bounceRate30d, 6);
  assert.equal(summary.bouncedEmails30d, 3);
  assert.equal(summary.hardBounces30d, 2);
  assert.equal(summary.softBounces30d, 1);
  assert.equal(summary.sentEmails30d, 50);
});

test('today contacted KOLs combine successful sends and manual outreach by system customer id', async () => {
  let capturedSql = '';
  let capturedParams = [];
  const db = {
    async get(sql, params = []) {
      if (sql.includes('campaign_kol_events')) {
        capturedSql = String(sql);
        capturedParams = params;
        return { total: 4 };
      }
      return { total: 0 };
    }
  };

  const summary = await buildOwnedSummary(db, NOW);

  assert.equal(summary.todayContactedKols, 4);
  assert.match(capturedSql, /email_records/);
  assert.match(capturedSql, /event_type = 'manual_outreach'/);
  assert.match(capturedSql, /source_type = 'manual'/);
  assert.match(capturedSql, /INNER JOIN campaign_kols/);
  assert.match(capturedSql, /COUNT\(DISTINCT contacted\.customer_id\)/);
  assert.deepEqual(capturedParams, [27, '2026-07-27 16:00:00', '2026-07-27 16:00:00']);
});
