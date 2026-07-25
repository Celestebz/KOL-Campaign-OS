const express = require('express');
const { dbOperations } = require('../database');

const router = express.Router();

// 老板工作台聚合接口（阶段 B）：只聚合现有待办，不新建表、不改业务逻辑。
// 响应契约（前端并行开发，字段名严格固定）：
// { summary: { pending, high_risk, exceptions, handled_today }, items: [...], recent_decisions: [...] }

const INTENT_LABELS = {
  interested: '有意向',
  question: '有疑问',
  rejected: '拒绝',
  other: '其他'
};

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function truncate(value, max) {
  const text = clean(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function openAction(href) {
  return [{ key: 'open', label: '去处理', href }];
}

// ---- 1. 策略审核：kol_strategies 待人工确认（status='draft'，人工 mark-ready 后才变 'ready'） ----
async function loadStrategyItems() {
  const rows = await dbOperations.query(
    `SELECT ks.id, ks.campaign_id, ks.name, ks.brand, ks.product, ks.category, ks.target_market,
            ks.language, ks.primary_platform, ks.campaign_goal, ks.finder_handoff,
            ks.source_material_summary, ks.updated_at, c.name AS campaign_name
     FROM kol_strategies ks
     LEFT JOIN campaigns c ON c.id = ks.campaign_id
     WHERE ks.status = 'draft'
     ORDER BY ks.updated_at DESC
     LIMIT 50`
  );
  return rows.map((row) => {
    const handoff = parseJson(row.finder_handoff, {});
    const facts = [];
    const productLabel = [clean(row.brand), clean(row.product)].filter(Boolean).join(' / ');
    if (productLabel) facts.push(`产品：${productLabel}`);
    if (clean(row.category)) facts.push(`品类：${clean(row.category)}`);
    if (clean(row.target_market)) facts.push(`目标市场：${clean(row.target_market)}`);
    const handoffSummary = summarizeFinderHandoff(handoff);
    if (handoffSummary) facts.push(`搜索条件：${handoffSummary}`);
    if (!facts.length) facts.push('策略草稿已生成，等待人工确认');
    return {
      id: `strategy:${row.id}`,
      type: 'strategy',
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${clean(row.name) || '未命名策略'} · 策略待确认`,
      risk_level: 'none',
      facts,
      opinion: truncate(row.campaign_goal || row.source_material_summary, 200),
      risks: [],
      actions: openAction('/strategy'),
      updated_at: iso(row.updated_at)
    };
  });
}

function summarizeFinderHandoff(handoff) {
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) return '';
  const parts = [];
  const keywords = handoff.keywords || handoff.search_keywords || handoff.queries;
  if (Array.isArray(keywords) && keywords.length) {
    parts.push(`关键词 ${keywords.slice(0, 5).map((k) => clean(typeof k === 'object' ? (k.keyword || k.query || k.text) : k)).filter(Boolean).join('、')}`);
  }
  const platforms = handoff.platforms || handoff.target_platforms;
  if (Array.isArray(platforms) && platforms.length) parts.push(`平台 ${platforms.join('、')}`);
  if (!parts.length) {
    const keys = Object.keys(handoff);
    if (keys.length) parts.push(`含 ${keys.slice(0, 4).join('、')} 配置`);
  }
  return parts.join('；');
}

// ---- 2. 候选达人审核：campaign_kols status='candidate' ----
async function loadCandidateItems() {
  const rows = await dbOperations.query(
    `SELECT ck.id, ck.campaign_id, ck.customer_id, ck.target_platform,
            ck.kol_name_snapshot, ck.country_region_snapshot,
            ck.youtube_followers_snapshot, ck.instagram_followers_snapshot, ck.tiktok_followers_snapshot,
            ck.median_views_30d_snapshot, ck.posts_30d_snapshot, ck.evidence_summary,
            ck.priority_level, ck.candidate_priority_score, ck.updated_at,
            c.name AS campaign_name, k.name AS kol_name
     FROM campaign_kols ck
     LEFT JOIN campaigns c ON c.id = ck.campaign_id
     LEFT JOIN customers k ON k.id = ck.customer_id
     WHERE ck.status = 'candidate'
     ORDER BY ck.candidate_priority_score DESC, ck.updated_at DESC
     LIMIT 100`
  );
  return rows.map((row) => {
    const kolName = clean(row.kol_name) || clean(row.kol_name_snapshot) || `达人 #${row.customer_id}`;
    const evidence = parseJson(row.evidence_summary, null);
    const facts = [`达人：${kolName}`];
    if (clean(row.target_platform)) facts.push(`平台：${clean(row.target_platform)}`);
    const followers = clean(row.youtube_followers_snapshot)
      || clean(row.instagram_followers_snapshot)
      || clean(row.tiktok_followers_snapshot);
    if (followers) facts.push(`粉丝数：${followers}`);
    if (row.median_views_30d_snapshot != null) facts.push(`近30天播放中位数：${row.median_views_30d_snapshot}`);
    const matchReason = clean(evidence?.match_reason || evidence?.reason || evidence?.summary);
    if (matchReason) facts.push(`匹配理由：${truncate(matchReason, 120)}`);

    const risks = [];
    const videoCount = Array.isArray(evidence?.videos) ? evidence.videos.length : null;
    if (videoCount !== null && videoCount < 3) risks.push(`相关视频样本较少（仅 ${videoCount} 条）`);
    if (row.median_views_30d_snapshot == null) risks.push('近 30 天播放数据不完整');
    if (!clean(row.target_platform)) risks.push('目标平台未明确');

    return {
      id: `candidate:${row.id}`,
      type: 'candidate',
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${kolName} · 候选达人待审核`,
      risk_level: risks.length ? 'low' : 'none',
      facts,
      opinion: '',
      risks,
      actions: openAction('/campaign-kols'),
      updated_at: iso(row.updated_at)
    };
  });
}

// ---- 3. 预算审核：campaign_kols budget_approval_status='pending'（取值见前端预算审批下拉：pending/approved/rejected） ----
async function loadBudgetItems() {
  const rows = await dbOperations.query(
    `SELECT ck.id, ck.campaign_id, ck.customer_id, ck.kol_name_snapshot,
            ck.quoted_fee, ck.final_fee, ck.currency, ck.cooperation_type, ck.deliverables,
            ck.estimated_total_cost_usd, ck.expected_views, ck.estimated_cpm, ck.updated_at,
            c.name AS campaign_name, k.name AS kol_name
     FROM campaign_kols ck
     LEFT JOIN campaigns c ON c.id = ck.campaign_id
     LEFT JOIN customers k ON k.id = ck.customer_id
     WHERE ck.budget_approval_status = 'pending'
     ORDER BY ck.updated_at DESC
     LIMIT 100`
  );
  return rows.map((row) => {
    const kolName = clean(row.kol_name) || clean(row.kol_name_snapshot) || `达人 #${row.customer_id}`;
    const facts = [];
    const fee = clean(row.final_fee) || clean(row.quoted_fee);
    if (fee) facts.push(`报价：${fee}${clean(row.currency) ? ` ${clean(row.currency)}` : ''}`);
    if (clean(row.cooperation_type)) facts.push(`合作形式：${clean(row.cooperation_type)}`);
    if (row.estimated_total_cost_usd != null) facts.push(`总预计成本：${row.estimated_total_cost_usd} USD`);
    if (row.expected_views != null) facts.push(`预计合作曝光：${row.expected_views}`);
    if (row.estimated_cpm != null) facts.push(`预估 CPM：${row.estimated_cpm}`);
    if (clean(row.deliverables)) facts.push(`交付内容：${truncate(row.deliverables, 100)}`);
    if (!facts.length) facts.push('预算信息待补充');
    return {
      id: `budget:${row.id}`,
      type: 'budget',
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${kolName} · 预算待审批`,
      risk_level: 'none',
      facts,
      opinion: '',
      risks: [],
      actions: openAction('/campaign-kols'),
      updated_at: iso(row.updated_at)
    };
  });
}

// ---- 4. 触达邮件审核：email_drafts status='pending_review' ----
async function loadOutreachItems() {
  const rows = await dbOperations.query(
    `SELECT d.id, d.campaign_id, d.customer_id, d.kind, d.subject,
            d.risk_level, d.risk_reasons, d.evidence, d.generated_at, d.updated_at,
            k.name AS kol_name, c.name AS campaign_name
     FROM email_drafts d
     LEFT JOIN customers k ON k.id = d.customer_id
     LEFT JOIN campaigns c ON c.id = d.campaign_id
     WHERE d.status = 'pending_review'
     ORDER BY d.generated_at DESC
     LIMIT 100`
  );
  return rows.map((row) => {
    const kolName = clean(row.kol_name) || `达人 #${row.customer_id}`;
    const evidence = parseJson(row.evidence, null);
    const riskReasons = parseJson(row.risk_reasons, []);
    const facts = [];
    const metrics = evidence?.metrics || {};
    if (metrics.followers) facts.push(`粉丝数：${metrics.followers}`);
    if (metrics.avg_views_30d != null) facts.push(`近30天平均播放：${metrics.avg_views_30d}`);
    if (Array.isArray(evidence?.videos)) facts.push(`引用视频数：${evidence.videos.length}`);
    if (clean(evidence?.snapshot_date)) facts.push(`数据快照日期：${clean(evidence.snapshot_date)}`);
    if (!facts.length) facts.push('邮件草稿已生成，等待人工审批');
    const risks = (Array.isArray(riskReasons) ? riskReasons : [])
      .map((r) => clean(typeof r === 'object' ? r.message : r))
      .filter(Boolean);
    const opinionParts = [];
    if (clean(row.subject)) opinionParts.push(`主题：${clean(row.subject)}`);
    if (clean(evidence?.match_reason)) opinionParts.push(truncate(evidence.match_reason, 150));
    const riskLevel = ['none', 'low', 'high'].includes(row.risk_level) ? row.risk_level : 'none';
    return {
      id: `outreach:${row.id}`,
      type: 'outreach',
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${kolName} · 触达邮件待审批`,
      risk_level: riskLevel,
      facts,
      opinion: opinionParts.join('；'),
      risks,
      actions: openAction('/emails'),
      updated_at: iso(row.generated_at || row.updated_at)
    };
  });
}

// ---- 5. 达人回复审核：email_replies confirm_status='pending' ----
async function loadReplyItems() {
  const rows = await dbOperations.query(
    `SELECT er.id, er.campaign_id, er.customer_id, er.subject, er.body_text, er.received_at,
            er.ai_summary, er.ai_intent, er.updated_at,
            k.name AS kol_name, c.name AS campaign_name
     FROM email_replies er
     LEFT JOIN customers k ON k.id = er.customer_id
     LEFT JOIN campaigns c ON c.id = er.campaign_id
     WHERE er.confirm_status = 'pending'
     ORDER BY er.received_at DESC
     LIMIT 100`
  );
  return rows.map((row) => {
    const kolName = clean(row.kol_name) || `达人 #${row.customer_id}`;
    const facts = [`达人：${kolName}`];
    if (row.received_at) facts.push(`收到时间：${iso(row.received_at)}`);
    if (clean(row.body_text)) facts.push(`回复原文：${truncate(row.body_text, 120)}`);
    const opinionParts = [];
    if (clean(row.ai_summary)) opinionParts.push(truncate(row.ai_summary, 150));
    if (INTENT_LABELS[row.ai_intent]) opinionParts.push(`意向判断：${INTENT_LABELS[row.ai_intent]}`);
    return {
      id: `reply:${row.id}`,
      type: 'reply',
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${kolName} · 回复待确认`,
      risk_level: 'none',
      facts,
      opinion: opinionParts.join('；'),
      risks: [],
      actions: openAction('/emails'),
      updated_at: iso(row.received_at || row.updated_at)
    };
  });
}

// ---- 6. 异常处理：finder_tasks 失败（failed/partial_failed） + email_drafts 发送失败（send_failed） ----
async function loadExceptionItems() {
  const finderRows = await dbOperations.query(
    `SELECT ft.id, ft.campaign_id, ft.name, ft.platform, ft.status,
            ft.error_message, ft.success_count, ft.failed_count, ft.updated_at,
            c.name AS campaign_name
     FROM finder_tasks ft
     LEFT JOIN campaigns c ON c.id = ft.campaign_id
     WHERE ft.status IN ('failed', 'partial_failed')
     ORDER BY ft.updated_at DESC
     LIMIT 50`
  );
  const emailRows = await dbOperations.query(
    `SELECT d.id, d.campaign_id, d.customer_id, d.subject, d.updated_at,
            k.name AS kol_name, c.name AS campaign_name,
            (SELECT r.error FROM email_records r
             WHERE r.draft_id = d.id AND r.status = 'failed'
             ORDER BY r.id DESC LIMIT 1) AS send_error
     FROM email_drafts d
     LEFT JOIN customers k ON k.id = d.customer_id
     LEFT JOIN campaigns c ON c.id = d.campaign_id
     WHERE d.status = 'send_failed'
     ORDER BY d.updated_at DESC
     LIMIT 50`
  );

  const finderItems = finderRows.map((row) => {
    const facts = [`失败节点：Finder 任务（${clean(row.platform) || '未知平台'}）`];
    if (clean(row.error_message)) facts.push(`错误信息：${truncate(row.error_message, 200)}`);
    if (row.status === 'partial_failed') {
      facts.push(`部分完成：成功 ${row.success_count || 0} 条，失败 ${row.failed_count || 0} 条`);
    }
    return {
      id: `exception:finder:${row.id}`,
      type: 'exception',
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${clean(row.name) || `Finder 任务 #${row.id}`} · 执行失败`,
      risk_level: 'high',
      facts,
      opinion: '建议重试失败节点；如多次失败请人工处理。',
      risks: ['任务中断，后续达人搜索/分析流程未推进'],
      actions: openAction('/finder'),
      updated_at: iso(row.updated_at)
    };
  });

  const emailItems = emailRows.map((row) => {
    const kolName = clean(row.kol_name) || `达人 #${row.customer_id}`;
    const facts = ['失败节点：邮件发送'];
    if (clean(row.send_error)) facts.push(`错误信息：${truncate(row.send_error, 200)}`);
    if (clean(row.subject)) facts.push(`邮件主题：${truncate(row.subject, 80)}`);
    return {
      id: `exception:email:${row.id}`,
      type: 'exception',
      campaign_id: row.campaign_id,
      campaign_name: clean(row.campaign_name),
      title: `${kolName} · 邮件发送失败`,
      risk_level: 'high',
      facts,
      opinion: '建议检查 SMTP 配置后重新发送。',
      risks: ['达人触达中断'],
      actions: openAction('/emails'),
      updated_at: iso(row.updated_at)
    };
  });

  return [...finderItems, ...emailItems];
}

// ---- summary.handled_today：今日已处理 ----
async function countHandledToday() {
  // 口径 1：今日审批过的邮件草稿（approved/rejected/sent，按 reviewed_at 归属当日）
  const drafts = await dbOperations.get(
    `SELECT COUNT(*) AS n FROM email_drafts
     WHERE status IN ('approved', 'rejected', 'sent')
       AND reviewed_at IS NOT NULL
       AND DATE(reviewed_at) = CURDATE()`
  );
  // 口径 2：今日确认/忽略过的达人回复（email_replies 无 confirmed_at 列，用 updated_at 近似）
  const replies = await dbOperations.get(
    `SELECT COUNT(*) AS n FROM email_replies
     WHERE confirm_status IN ('confirmed', 'ignored')
       AND DATE(updated_at) = CURDATE()`
  );
  // 口径 3：今日从 candidate 变为非 candidate 的 campaign_kols。
  // 注意：当前 server 端没有任何路由会把 campaign_kols.status 从 'candidate' 改为其他值
  // （candidate 流转发生在飞书回写/人工操作路径），因此该口径通常贡献 0，仅作可实现近似。
  const kols = await dbOperations.get(
    `SELECT COUNT(*) AS n FROM campaign_kols
     WHERE status <> 'candidate'
       AND DATE(updated_at) = CURDATE()`
  );
  return Number(drafts?.n || 0) + Number(replies?.n || 0) + Number(kols?.n || 0);
}

// ---- recent_decisions：最近 10 条人工决定 ----
async function loadRecentDecisions() {
  const DRAFT_DECISIONS = { approved: '已通过', rejected: '已驳回', sent: '已发送' };
  const REPLY_DECISIONS = { confirmed: '已确认', ignored: '已忽略' };
  const draftRows = await dbOperations.query(
    `SELECT d.id, d.status, d.subject, d.reviewed_at,
            k.name AS kol_name, c.name AS campaign_name
     FROM email_drafts d
     LEFT JOIN customers k ON k.id = d.customer_id
     LEFT JOIN campaigns c ON c.id = d.campaign_id
     WHERE d.status IN ('approved', 'rejected', 'sent')
       AND d.reviewed_at IS NOT NULL
     ORDER BY d.reviewed_at DESC
     LIMIT 10`
  );
  const replyRows = await dbOperations.query(
    `SELECT er.id, er.confirm_status, er.updated_at,
            k.name AS kol_name, c.name AS campaign_name
     FROM email_replies er
     LEFT JOIN customers k ON k.id = er.customer_id
     LEFT JOIN campaigns c ON c.id = er.campaign_id
     WHERE er.confirm_status IN ('confirmed', 'ignored')
     ORDER BY er.updated_at DESC
     LIMIT 10`
  );
  const decisions = [
    ...draftRows.map((row) => ({
      title: `${clean(row.kol_name) || '达人'} 触达邮件${row.subject ? `：${truncate(row.subject, 50)}` : ''}`,
      decision: DRAFT_DECISIONS[row.status] || row.status,
      decided_at: iso(row.reviewed_at),
      href: '/emails'
    })),
    ...replyRows.map((row) => ({
      title: `${clean(row.kol_name) || '达人'} 回复处理`,
      decision: REPLY_DECISIONS[row.confirm_status] || row.confirm_status,
      decided_at: iso(row.updated_at),
      href: '/emails'
    }))
  ];
  return decisions
    .sort((a, b) => String(b.decided_at || '').localeCompare(String(a.decided_at || '')))
    .slice(0, 10);
}

router.get('/', async (req, res) => {
  try {
    const [strategies, candidates, budgets, outreaches, replies, exceptions, handledToday, recentDecisions] = await Promise.all([
      loadStrategyItems(),
      loadCandidateItems(),
      loadBudgetItems(),
      loadOutreachItems(),
      loadReplyItems(),
      loadExceptionItems(),
      countHandledToday(),
      loadRecentDecisions()
    ]);

    const items = [...strategies, ...candidates, ...budgets, ...outreaches, ...replies, ...exceptions];
    const nonExceptions = items.filter((item) => item.type !== 'exception');
    res.json({
      summary: {
        pending: nonExceptions.length,
        high_risk: nonExceptions.filter((item) => item.risk_level === 'high').length,
        exceptions: exceptions.length,
        handled_today: handledToday
      },
      items,
      recent_decisions: recentDecisions
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
