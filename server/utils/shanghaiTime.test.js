const assert = require('node:assert/strict');
const test = require('node:test');
const {
  shanghaiDayStart,
  shanghaiWeekStart,
  shanghaiPreviousWeekBounds,
  rollingWindowStart,
  SHANGHAI_OFFSET_MS
} = require('./shanghaiTime');

// 构造一个指定 UTC 时刻的 Date，避免时区歧义。
function utc(...parts) {
  // parts: [year, monthIndex, day, hour=0, minute=0, second=0, ms=0]
  return new Date(Date.UTC(...parts));
}

test('shanghaiDayStart returns UTC instant for Shanghai midnight of the same civil date', () => {
  // 北京时间 2026-07-28 10:30 = UTC 2026-07-28 02:30 → 当日起点应为 UTC 2026-07-27 16:00
  const now = utc(2026, 6, 28, 2, 30, 0);
  const start = shanghaiDayStart(now);
  assert.equal(start.toISOString(), '2026-07-27T16:00:00.000Z');
});

test('shanghaiDayStart handles early morning UTC that is still previous Shanghai day', () => {
  // 北京时间 2026-07-28 06:00 = UTC 2026-07-27 22:00 → 当日起点仍为 UTC 2026-07-27 16:00
  const now = utc(2026, 6, 27, 22, 0, 0);
  const start = shanghaiDayStart(now);
  assert.equal(start.toISOString(), '2026-07-27T16:00:00.000Z');
});

test('shanghaiWeekStart rolls back to Monday of the Shanghai week', () => {
  // 北京时间 2026-07-28（周二）09:00 = UTC 2026-07-28 01:00 → 本周一应为 UTC 2026-07-26 16:00
  const now = utc(2026, 6, 28, 1, 0, 0);
  const start = shanghaiWeekStart(now);
  assert.equal(start.toISOString(), '2026-07-26T16:00:00.000Z');
});

test('shanghaiWeekStart returns the same Monday when called on a Monday in Shanghai', () => {
  // 北京时间 2026-07-27（周一）10:00 = UTC 2026-07-27 02:00
  const now = utc(2026, 6, 27, 2, 0, 0);
  const start = shanghaiWeekStart(now);
  assert.equal(start.toISOString(), '2026-07-26T16:00:00.000Z');
});

test('shanghaiWeekStart handles Sunday in Shanghai by rolling back 6 days', () => {
  // 北京时间 2026-08-02（周日）09:00 = UTC 2026-08-02 01:00 → 本周一应为 UTC 2026-07-26 16:00
  const now = utc(2026, 7, 2, 1, 0, 0);
  const start = shanghaiWeekStart(now);
  assert.equal(start.toISOString(), '2026-07-26T16:00:00.000Z');
});

test('shanghaiPreviousWeekBounds returns prior full Monday-Monday window', () => {
  // 当前为上海周二 2026-07-28 → 上一完整周 = 2026-07-13 周一 ~ 2026-07-20 周一
  const now = utc(2026, 6, 28, 1, 0, 0);
  const { previousWeekStart, currentWeekStart } = shanghaiPreviousWeekBounds(now);
  assert.equal(previousWeekStart.toISOString(), '2026-07-19T16:00:00.000Z');
  assert.equal(currentWeekStart.toISOString(), '2026-07-26T16:00:00.000Z');
  // 恰好相差 7 天
  assert.equal(currentWeekStart.getTime() - previousWeekStart.getTime(), 7 * 24 * 60 * 60 * 1000);
});

test('rollingWindowStart returns now minus the requested number of days', () => {
  const now = utc(2026, 6, 28, 1, 0, 0);
  const start = rollingWindowStart(now, 30);
  assert.equal(now.getTime() - start.getTime(), 30 * 24 * 60 * 60 * 1000);
});

test('SHANGHAI_OFFSET_MS is exactly 8 hours', () => {
  assert.equal(SHANGHAI_OFFSET_MS, 8 * 60 * 60 * 1000);
});