// 上海时区（Asia/Shanghai，固定 UTC+8，无夏令时）边界计算工具。
// 全部以 UTC Date 对象返回，便于作为 SQL 参数（与 DATETIME 列对照）。
// 入参 `now` 是"墙钟当前时刻"的 UTC Date；为方便测试，函数接受任意 Date。

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// 给定一个 UTC Date，返回"该时刻在上海时区的年/月/日"。
// 注意：仅用于读取 Y/M/D 三个分量，不应再用其内部时间。
function shanghaiWallClockParts(now) {
  const sh = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: sh.getUTCFullYear(),
    month: sh.getUTCMonth(),
    day: sh.getUTCDate(),
    weekday: sh.getUTCDay()
  };
}

// 上海当日 00:00:00 对应的 UTC Date（瞬时点）。
function shanghaiDayStart(now) {
  const { year, month, day } = shanghaiWallClockParts(now);
  // 上海 Y-M-D 00:00:00 = UTC (Y-M-D - 8h)
  return new Date(Date.UTC(year, month, day) - SHANGHAI_OFFSET_MS);
}

// 上海本周一 00:00:00 对应的 UTC Date。本周从周一开始。
function shanghaiWeekStart(now) {
  const dayStart = shanghaiDayStart(now);
  const { weekday } = shanghaiWallClockParts(now);
  // JavaScript: getUTCDay() 0=周日..6=周六；上海周一 → 偏移 0，周日 → 偏移 6
  const daysSinceMonday = (weekday + 6) % 7;
  return new Date(dayStart.getTime() - daysSinceMonday * DAY_MS);
}

// 上一自然周（周一 00:00 ~ 本周一 00:00）的起止 UTC Date。
function shanghaiPreviousWeekBounds(now) {
  const currentWeekStart = shanghaiWeekStart(now);
  const previousWeekStart = new Date(currentWeekStart.getTime() - 7 * DAY_MS);
  return { previousWeekStart, currentWeekStart };
}

// 滚动窗口起点：当前时刻向前 N 天。
function rollingWindowStart(now, days) {
  return new Date(now.getTime() - days * DAY_MS);
}

module.exports = {
  SHANGHAI_OFFSET_MS,
  DAY_MS,
  shanghaiWallClockParts,
  shanghaiDayStart,
  shanghaiWeekStart,
  shanghaiPreviousWeekBounds,
  rollingWindowStart
};