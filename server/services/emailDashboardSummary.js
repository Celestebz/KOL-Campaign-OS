// 邮件审批台顶部统计：今日/本周独立 KOL 联络数、30天回复率。
// 全部聚合在数据库端完成；SQL 参数由调用方注入（默认 = 当前时刻）。
// 当前数据结构尚无"投递失败/退信"字段 → denominatorType = 'sent_success'，
// 副标题显示 "X人回复 / Y人发送成功"，避免对未确认的送达做过度承诺。

const { dbOperations } = require('../database');
const {
  shanghaiDayStart,
  shanghaiWeekStart,
  shanghaiPreviousWeekBounds,
  rollingWindowStart
} = require('../utils/shanghaiTime');

const TIMEZONE = 'Asia/Shanghai';
const REPLY_WINDOW_DAYS = 30;

// 把 Date 序列化成 MySQL DATETIME 字符串（与 NOW() 输出格式一致）。
function toMysqlDatetime(value) {
  return value.toISOString().slice(0, 19).replace('T', ' ');
}

// 计算窗口 [windowStart, +∞)（或 [windowStart, windowEndExclusive)）内"首次成功发送"
// 落在窗口内的独立 customer_id 数（KOL 维度）。用于今日联络、本周联络、上周对比。
//
// 核心思路：
//   1. 在 email_records 里筛选 status='success' 且 created_at 落在窗口内的记录；
//   2. 按 customer_id 分组，仅保留"窗口起点之前从未发送成功过"的桶；
//   3. 对剩余桶按 customer_id 去重计数。
async function countFirstTouchKols(db, windowStart, windowEndExclusive) {
  const startParam = toMysqlDatetime(windowStart);
  const sql = windowEndExclusive
    ? `SELECT COUNT(*) AS total FROM (
         SELECT er.customer_id
         FROM email_records er
         WHERE er.status = 'success'
           AND er.customer_id IS NOT NULL
           AND er.created_at >= ?
           AND er.created_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM email_records er2
             WHERE er2.customer_id = er.customer_id
               AND er2.status = 'success'
               AND er2.created_at < ?
           )
         GROUP BY er.customer_id
       ) t`
    : `SELECT COUNT(*) AS total FROM (
         SELECT er.customer_id
         FROM email_records er
         WHERE er.status = 'success'
           AND er.customer_id IS NOT NULL
           AND er.created_at >= ?
           AND NOT EXISTS (
             SELECT 1 FROM email_records er2
             WHERE er2.customer_id = er.customer_id
               AND er2.status = 'success'
               AND er2.created_at < ?
           )
         GROUP BY er.customer_id
       ) t`;
  const params = windowEndExclusive
    ? [startParam, toMysqlDatetime(windowEndExclusive), startParam]
    : [startParam, startParam];
  const row = await db.get(sql, params);
  return Number(row?.total || 0);
}

// 30 天回复率分母：窗口内至少有一封 status='success' 记录的独立 customer_id 数。
// 当前没有退信字段；待退信匹配完成后，应在此处剔除"已知硬退信"的 KOL。
async function countDeliveredKols(db, windowStart) {
  const startParam = toMysqlDatetime(windowStart);
  const row = await db.get(
    `SELECT COUNT(DISTINCT er.customer_id) AS total
     FROM email_records er
     WHERE er.status = 'success'
       AND er.customer_id IS NOT NULL
       AND er.created_at >= ?`,
    [startParam]
  );
  return Number(row?.total || 0);
}

// 30 天回复率分子：分母 KOL 集合中，窗口内收到"有效回复"的独立 customer_id 数。
// 有效回复：confirm_status='confirmed'（人工确认），或 ai_intent 落在
// {interested, question, rejected} 三类真实意图（排除 ai_intent='other' 即自动回复）。
async function countRepliedKols(db, windowStart) {
  const startParam = toMysqlDatetime(windowStart);
  const row = await db.get(
    `SELECT COUNT(DISTINCT r.customer_id) AS total
     FROM email_replies r
     INNER JOIN (
       SELECT DISTINCT customer_id
       FROM email_records
       WHERE status = 'success'
         AND customer_id IS NOT NULL
         AND created_at >= ?
     ) sent ON sent.customer_id = r.customer_id
     WHERE r.customer_id IS NOT NULL
       AND r.received_at >= ?
       AND (
         r.confirm_status = 'confirmed'
         OR r.ai_intent IN ('interested', 'question', 'rejected')
       )`,
    [startParam, startParam]
  );
  return Number(row?.total || 0);
}

async function countBounceSummary(db, windowStart) {
  const row = await db.get(
    `SELECT COUNT(DISTINCT er.id) AS sent_total,
       COUNT(DISTINCT eb.email_record_id) AS bounced_total,
       COUNT(DISTINCT CASE WHEN eb.bounce_type = 'hard' THEN eb.email_record_id END) AS hard_total,
       COUNT(DISTINCT CASE WHEN eb.bounce_type = 'soft' THEN eb.email_record_id END) AS soft_total
     FROM email_records er
     LEFT JOIN email_bounces eb ON eb.email_record_id = er.id
     WHERE er.status = 'success' AND er.created_at >= ?`,
    [toMysqlDatetime(windowStart)]
  );
  return {
    sent: Number(row?.sent_total || 0),
    bounced: Number(row?.bounced_total || 0),
    hard: Number(row?.hard_total || 0),
    soft: Number(row?.soft_total || 0)
  };
}

// 组装最终返回体，附带时区标记与分母类型。
// `db` 形参为 {get} 最小集合（生产 = dbOperations，测试可注入 mock）。
async function buildSummary(db = dbOperations, now = new Date()) {
  const todayStart = shanghaiDayStart(now);
  const weekStart = shanghaiWeekStart(now);
  const { previousWeekStart, currentWeekStart } = shanghaiPreviousWeekBounds(now);
  const replyWindowStart = rollingWindowStart(now, REPLY_WINDOW_DAYS);

  const [todayContactedKols, weekContactedKols, previousWeekContactedKols,
    deliveredKols30d, repliedKols30d, bounceSummary30d] = await Promise.all([
    countFirstTouchKols(db, todayStart),
    countFirstTouchKols(db, weekStart),
    countFirstTouchKols(db, previousWeekStart, currentWeekStart),
    countDeliveredKols(db, replyWindowStart),
    countRepliedKols(db, replyWindowStart),
    countBounceSummary(db, replyWindowStart)
  ]);

  const weekDifference = weekContactedKols - previousWeekContactedKols;
  // 分母为 0 时显示 — 而非 0%，符合验收标准
  const replyRate30d = deliveredKols30d > 0
    ? Math.round((repliedKols30d / deliveredKols30d) * 1000) / 10
    : null;
  const bounceRate30d = bounceSummary30d.sent > 0
    ? Math.round((bounceSummary30d.bounced / bounceSummary30d.sent) * 1000) / 10
    : null;

  return {
    todayContactedKols,
    weekContactedKols,
    previousWeekContactedKols,
    weekDifference,
    replyRate30d,
    repliedKols30d,
    deliveredKols30d,
    bounceRate30d,
    bouncedEmails30d: bounceSummary30d.bounced,
    hardBounces30d: bounceSummary30d.hard,
    softBounces30d: bounceSummary30d.soft,
    sentEmails30d: bounceSummary30d.sent,
    denominatorType: 'sent_success',
    timezone: TIMEZONE,
    replyWindowDays: REPLY_WINDOW_DAYS,
    generatedAt: now.toISOString()
  };
}

module.exports = {
  buildSummary,
  // 导出供单测覆盖边界 / 复用
  countFirstTouchKols,
  countDeliveredKols,
  countRepliedKols,
  countBounceSummary
};
