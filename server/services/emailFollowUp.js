// 跟进自动化：48h 未回复生成跟进草稿进审批队列；≥5 天未回复不再自动起草，仅标记"建议转下一批"（P1 只记日志，不做候选池降级回写）。
// 注：emailDrafter 通过模块对象引用（非解构），便于测试 monkey-patch。
const { dbOperations } = require('../database');
const { currentUserId, runWithUser } = require('../utils/requestContext');
const emailDrafter = require('./emailDrafter');

const FOLLOW_UP_AFTER_HOURS = 48;
const GIVE_UP_AFTER_DAYS = 5;
const MAX_FOLLOW_UPS = 2;
const SCAN_INTERVAL_MINUTES = Number(process.env.EMAIL_FOLLOWUP_INTERVAL_MINUTES) || 30;

// 返回 { drafted, giveUps }，便于测试与日志核对。
async function scanOnce() {
  const candidates = await dbOperations.query(
    `SELECT ck.campaign_id, ck.customer_id, er_owner.owner_user_id,
       MAX(ck.follow_up_count) AS follow_up_count,
       MAX(ck.last_outreach_at) AS last_outreach_at
     FROM campaign_kols ck
     INNER JOIN (
       SELECT campaign_id, customer_id, owner_user_id
       FROM email_records
       WHERE status = 'success' AND owner_user_id IS NOT NULL
       GROUP BY campaign_id, customer_id, owner_user_id
     ) er_owner ON er_owner.campaign_id = ck.campaign_id AND er_owner.customer_id = ck.customer_id
     WHERE ck.last_outreach_at IS NOT NULL
       AND ck.last_outreach_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND ck.last_outreach_at > DATE_SUB(NOW(), INTERVAL ? DAY)
       AND COALESCE(ck.follow_up_count, 0) < ?
       AND EXISTS (
         SELECT 1 FROM email_records er
         WHERE er.campaign_id = ck.campaign_id AND er.customer_id = ck.customer_id
           AND er.owner_user_id = er_owner.owner_user_id
           AND er.status = 'success'
       )
       AND NOT EXISTS (
         SELECT 1 FROM email_replies r
         WHERE r.campaign_id = ck.campaign_id AND r.customer_id = ck.customer_id
           AND r.owner_user_id = er_owner.owner_user_id
           AND r.confirm_status = 'confirmed'
       )
       AND NOT EXISTS (
         SELECT 1 FROM email_drafts d
         WHERE d.campaign_id = ck.campaign_id AND d.customer_id = ck.customer_id
           AND d.owner_user_id = er_owner.owner_user_id
           AND d.kind = 'follow_up' AND d.status IN ('pending_review', 'approved')
       )
       AND NOT EXISTS (
         SELECT 1 FROM email_drafts d
         WHERE d.campaign_id = ck.campaign_id AND d.customer_id = ck.customer_id
           AND d.owner_user_id = er_owner.owner_user_id
           AND d.kind = 'follow_up' AND d.status = 'rejected'
           AND d.updated_at >= ck.last_outreach_at
       )
       AND NOT EXISTS (
         SELECT 1 FROM email_bounces eb
         WHERE eb.campaign_id = ck.campaign_id AND eb.customer_id = ck.customer_id
           AND eb.owner_user_id = er_owner.owner_user_id
           AND eb.bounce_type = 'hard'
       )
     GROUP BY ck.campaign_id, ck.customer_id, er_owner.owner_user_id`,
    [FOLLOW_UP_AFTER_HOURS, GIVE_UP_AFTER_DAYS, MAX_FOLLOW_UPS]
  );

  let drafted = 0;
  for (const item of candidates) {
    const result = await runWithUser({ id: item.owner_user_id }, () => emailDrafter.draftForCustomer({
      campaignId: item.campaign_id,
      customerId: item.customer_id,
      kind: 'follow_up'
    }));
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

// 纯人工跟进（无草稿）：运营在网页邮箱/IM 自行给达人发了跟进邮件后，
// 在系统里登记一次：更新 last_outreach_at、follow_up_count +1、可选写入 email_records + 事件时间线。
// 这样 48h 后的自动起草扫描会自然跳过此达人，避免系统再起草一封重复邮件。
async function recordManualOutreach({ campaignKolId, subject = null, bodyText = null, note = null, actor = 'ops' }) {
  const row = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [campaignKolId]);
  if (!row) {
    const error = new Error('项目候选不存在');
    error.statusCode = 404;
    throw error;
  }
  if (!row.customer_id || !row.campaign_id) {
    const error = new Error('项目候选缺少达人/项目关联，无法登记');
    error.statusCode = 409;
    throw error;
  }

  const customer = await dbOperations.get(
    'SELECT id, name, email FROM customers WHERE id = ?',
    [row.customer_id]
  );

  // 已有确认回复 / 硬退信 / 跟进已封顶：不接受再登记（防误操作把封顶状态回退）
  const confirmedReply = await dbOperations.get(
    `SELECT id FROM email_replies
     WHERE campaign_id = ? AND customer_id = ? AND confirm_status = 'confirmed' LIMIT 1`,
    [row.campaign_id, row.customer_id]
  );
  if (confirmedReply) {
    const error = new Error('该达人已有确认回复，无需再登记跟进');
    error.statusCode = 409;
    throw error;
  }
  const hardBounce = await dbOperations.get(
    `SELECT id FROM email_bounces
     WHERE campaign_id = ? AND customer_id = ? AND bounce_type = 'hard' LIMIT 1`,
    [row.campaign_id, row.customer_id]
  );
  if (hardBounce) {
    const error = new Error('该达人已硬退信，无法再登记跟进');
    error.statusCode = 409;
    throw error;
  }
  if ((row.follow_up_count || 0) >= MAX_FOLLOW_UPS) {
    const error = new Error(`该达人已跟进 ${row.follow_up_count}/${MAX_FOLLOW_UPS} 次，达到上限`);
    error.statusCode = 409;
    throw error;
  }

  // last_outreach_at + follow_up_count + outreach_status（与自动跟进语义一致）
  await dbOperations.run(
    `UPDATE campaign_kols
     SET last_outreach_at = NOW(),
         follow_up_count = COALESCE(follow_up_count, 0) + 1,
         outreach_status = CASE
           WHEN outreach_status IN ('interested', 'confirmed', 'terminated', 'rejected') THEN outreach_status
           ELSE 'waiting_reply'
         END,
         sync_status = 'sync_pending', updated_at = NOW()
     WHERE id = ?`,
    [campaignKolId]
  );

  // 可选：把人工跟进也写成一次 email_records，便于后续审计/会话组装
  if (subject || bodyText || note) {
    const recordNote = note || '已由人工手动跟进（外部渠道）';
    try {
      await dbOperations.run(
        `INSERT INTO email_records
         (draft_id, campaign_id, customer_id, kol_name, to_address, subject, body_text, status, error, owner_user_id, created_at)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, 'success', ?, ?, NOW())`,
        [row.campaign_id, row.customer_id, customer?.name || null, customer?.email || null,
         subject || '(人工跟进，未填写主题)', bodyText || null, recordNote, currentUserId()]
      );
    } catch (error) {
      // 记录失败不影响主流程（last_outreach_at / follow_up_count 已经回写）
      console.error(`[email] 人工跟进审计记录写入失败 (campaignKol ${campaignKolId}):`, error.message);
    }
  }

  // 事件时间线：和 reply_confirmed 类似，由前端/审计追溯
  try {
    const timeline = require('./campaignKolTimeline');
    await timeline.appendEvent({
      campaignKol: row,
      eventType: 'manual_outreach',
      summary: note || '运营在外部渠道手动跟进',
      sourceType: 'manual',
      outreachStatus: 'waiting_reply',
      actor
    });
  } catch (error) {
    console.error(`[email] 人工跟进事件流水写入失败 (campaignKol ${campaignKolId}):`, error.message);
  }

  const updated = await dbOperations.get('SELECT * FROM campaign_kols WHERE id = ?', [campaignKolId]);
  return { campaign_kol_id: campaignKolId, follow_up_count: updated.follow_up_count, last_outreach_at: updated.last_outreach_at };
}

function startFollowUpTimer() {
  if (timer) return;
  console.log(`[email] 跟进自动化已启动，每 ${SCAN_INTERVAL_MINUTES} 分钟扫描一次。`);
  timer = setInterval(() => scanOnce().catch((e) => console.error('[email] 跟进扫描异常:', e.message)), SCAN_INTERVAL_MINUTES * 60 * 1000);
  timer.unref();
}

module.exports = { startFollowUpTimer, scanOnce, recordManualOutreach, FOLLOW_UP_AFTER_HOURS, GIVE_UP_AFTER_DAYS, MAX_FOLLOW_UPS, SCAN_INTERVAL_MINUTES };
