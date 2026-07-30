// 跟进自动化：48h 未回复生成跟进草稿进审批队列；≥5 天未回复不再自动起草，仅标记"建议转下一批"（P1 只记日志，不做候选池降级回写）。
// 注：emailDrafter 通过模块对象引用（非解构），便于测试 monkey-patch。
const { dbOperations } = require('../database');
const emailDrafter = require('./emailDrafter');

const FOLLOW_UP_AFTER_HOURS = 48;
const GIVE_UP_AFTER_DAYS = 5;
const MAX_FOLLOW_UPS = 2;
const SCAN_INTERVAL_MINUTES = Number(process.env.EMAIL_FOLLOWUP_INTERVAL_MINUTES) || 30;

// 返回 { drafted, giveUps }，便于测试与日志核对。
async function scanOnce() {
  const candidates = await dbOperations.query(
    `SELECT ck.campaign_id, ck.customer_id,
       MAX(ck.follow_up_count) AS follow_up_count,
       MAX(ck.last_outreach_at) AS last_outreach_at
     FROM campaign_kols ck
     WHERE ck.last_outreach_at IS NOT NULL
       AND ck.last_outreach_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND ck.last_outreach_at > DATE_SUB(NOW(), INTERVAL ? DAY)
       AND COALESCE(ck.follow_up_count, 0) < ?
       AND EXISTS (
         SELECT 1 FROM email_records er
         WHERE er.campaign_id = ck.campaign_id AND er.customer_id = ck.customer_id
           AND er.status = 'success'
       )
       AND NOT EXISTS (
         SELECT 1 FROM email_replies r
         WHERE r.campaign_id = ck.campaign_id AND r.customer_id = ck.customer_id
           AND r.confirm_status = 'confirmed'
       )
       AND NOT EXISTS (
         SELECT 1 FROM email_drafts d
         WHERE d.campaign_id = ck.campaign_id AND d.customer_id = ck.customer_id
           AND d.kind = 'follow_up' AND d.status IN ('pending_review', 'approved')
       )
       AND NOT EXISTS (
         SELECT 1 FROM email_drafts d
         WHERE d.campaign_id = ck.campaign_id AND d.customer_id = ck.customer_id
           AND d.kind = 'follow_up' AND d.status = 'rejected'
           AND d.updated_at >= ck.last_outreach_at
       )
       AND NOT EXISTS (
         SELECT 1 FROM email_bounces eb
         WHERE eb.campaign_id = ck.campaign_id AND eb.customer_id = ck.customer_id
           AND eb.bounce_type = 'hard'
       )
     GROUP BY ck.campaign_id, ck.customer_id`,
    [FOLLOW_UP_AFTER_HOURS, GIVE_UP_AFTER_DAYS, MAX_FOLLOW_UPS]
  );

  let drafted = 0;
  for (const item of candidates) {
    const result = await emailDrafter.draftForCustomer({
      campaignId: item.campaign_id,
      customerId: item.customer_id,
      kind: 'follow_up'
    });
    if (result.ok && !result.skipped) {
      drafted += 1;
      await dbOperations.run(
        'UPDATE campaign_kols SET follow_up_count = COALESCE(follow_up_count, 0) + 1, updated_at = NOW() WHERE campaign_id = ? AND customer_id = ?',
        [item.campaign_id, item.customer_id]
      );
      console.log(`[email] 已生成跟进草稿：customer ${item.customer_id}`);
    } else {
      console.error(`[email] 跟进草稿生成失败 (customer ${item.customer_id}):`, result.error);
    }
  }

  // ≥5 天未回复：不再自动起草，标记"建议转下一批"（P1 仅日志，UI/回写后续做）
  const giveUps = await dbOperations.query(
    `SELECT ck.campaign_id, ck.customer_id, MAX(ck.last_outreach_at) AS last_outreach_at
     FROM campaign_kols ck
     WHERE ck.last_outreach_at IS NOT NULL
       AND ck.last_outreach_at <= DATE_SUB(NOW(), INTERVAL ? DAY)
       AND EXISTS (
         SELECT 1 FROM email_records er
         WHERE er.campaign_id = ck.campaign_id AND er.customer_id = ck.customer_id
           AND er.status = 'success'
       )
       AND NOT EXISTS (
         SELECT 1 FROM email_replies r
         WHERE r.campaign_id = ck.campaign_id AND r.customer_id = ck.customer_id
           AND r.confirm_status = 'confirmed'
       )
       AND NOT EXISTS (
         SELECT 1 FROM email_bounces eb
         WHERE eb.campaign_id = ck.campaign_id AND eb.customer_id = ck.customer_id
           AND eb.bounce_type = 'hard'
       )
     GROUP BY ck.campaign_id, ck.customer_id`,
    [GIVE_UP_AFTER_DAYS]
  );
  for (const item of giveUps) {
    console.log(`[email] 建议转下一批：customer ${item.customer_id}（campaign ${item.campaign_id}）已 ≥${GIVE_UP_AFTER_DAYS} 天未回复`);
  }

  return { drafted, giveUps: giveUps.length };
}

let timer = null;

function startFollowUpTimer() {
  if (timer) return;
  console.log(`[email] 跟进自动化已启动，每 ${SCAN_INTERVAL_MINUTES} 分钟扫描一次。`);
  timer = setInterval(() => scanOnce().catch((e) => console.error('[email] 跟进扫描异常:', e.message)), SCAN_INTERVAL_MINUTES * 60 * 1000);
  timer.unref();
}

module.exports = { startFollowUpTimer, scanOnce, FOLLOW_UP_AFTER_HOURS, GIVE_UP_AFTER_DAYS, MAX_FOLLOW_UPS, SCAN_INTERVAL_MINUTES };
