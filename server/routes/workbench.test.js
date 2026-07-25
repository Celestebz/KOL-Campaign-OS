const assert = require('node:assert/strict');
const test = require('node:test');
const { dbOperations } = require('../database');

function findHandler(router, method, path) {
  const layer = router.stack.find((item) => (
    item.route?.path === path && item.route?.methods?.[method]
  ));
  assert.ok(layer, `Missing ${method.toUpperCase()} ${path} handler`);
  return layer.route.stack[0].handle;
}

function callHandler(handler, { body = {}, params = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; resolve(this); return this; }
    };
    Promise.resolve(handler({ body, params, query }, response, reject)).catch(reject);
  });
}

function withPatchedDb(patch, fn) {
  const originals = {};
  for (const key of Object.keys(patch)) {
    originals[key] = dbOperations[key];
    dbOperations[key] = patch[key];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of Object.keys(originals)) dbOperations[key] = originals[key];
  });
}

// 按 SQL 内容分发假数据，模拟六类数据源 + handled_today 计数 + recent_decisions
function fakeDb({ rows = {}, counts = {} } = {}) {
  const query = async (sql) => {
    if (/FROM kol_strategies/.test(sql)) return rows.strategies || [];
    if (/FROM campaign_kols/.test(sql) && /budget_approval_status = 'pending'/.test(sql)) return rows.budgets || [];
    if (/FROM campaign_kols/.test(sql) && /ck\.status = 'candidate'/.test(sql)) return rows.candidates || [];
    if (/FROM finder_tasks/.test(sql)) return rows.finderExceptions || [];
    if (/FROM email_drafts/.test(sql) && /d\.status = 'pending_review'/.test(sql)) return rows.outreaches || [];
    if (/FROM email_drafts/.test(sql) && /send_failed/.test(sql)) return rows.emailExceptions || [];
    if (/FROM email_drafts/.test(sql) && /'approved', 'rejected', 'sent'/.test(sql)) return rows.recentDrafts || [];
    if (/FROM email_replies/.test(sql) && /confirm_status = 'pending'/.test(sql)) return rows.replies || [];
    if (/FROM email_replies/.test(sql) && /'confirmed', 'ignored'/.test(sql)) return rows.recentReplies || [];
    throw new Error(`Unexpected query: ${sql}`);
  };
  const get = async (sql) => {
    if (/COUNT\(\*\)/.test(sql) && /FROM email_drafts/.test(sql)) return { n: counts.drafts ?? 0 };
    if (/COUNT\(\*\)/.test(sql) && /FROM email_replies/.test(sql)) return { n: counts.replies ?? 0 };
    if (/COUNT\(\*\)/.test(sql) && /FROM campaign_kols/.test(sql)) return { n: counts.kols ?? 0 };
    throw new Error(`Unexpected get: ${sql}`);
  };
  return { query, get };
}

const fullRows = {
  strategies: [{
    id: 1, campaign_id: 10, campaign_name: '春季推广', name: 'TRA 策略', brand: 'MOOER', product: '碎枝机',
    category: '园林工具', target_market: '美国', campaign_goal: '提升新品曝光', finder_handoff: null,
    source_material_summary: null, updated_at: '2026-07-25 08:00:00'
  }],
  candidates: [{
    id: 2, campaign_id: 10, customer_id: 20, campaign_name: '春季推广', kol_name: 'Alice',
    kol_name_snapshot: 'Alice', target_platform: 'youtube', youtube_followers_snapshot: '12.3万',
    instagram_followers_snapshot: null, tiktok_followers_snapshot: null, country_region_snapshot: 'US',
    median_views_30d_snapshot: 8400, posts_30d_snapshot: 4,
    evidence_summary: JSON.stringify({ match_reason: '真实农场场景', videos: [{ id: 1 }] }),
    priority_level: 't1', candidate_priority_score: 88, updated_at: '2026-07-25 07:00:00'
  }],
  budgets: [{
    id: 3, campaign_id: 10, customer_id: 21, campaign_name: '春季推广', kol_name: 'Bob',
    kol_name_snapshot: 'Bob', quoted_fee: '500', final_fee: null, currency: 'USD',
    cooperation_type: 'paid_product', deliverables: '1 条视频', estimated_total_cost_usd: 500,
    expected_views: 50000, estimated_cpm: 10, updated_at: '2026-07-25 06:00:00'
  }],
  outreaches: [{
    id: 4, campaign_id: 10, customer_id: 22, campaign_name: '春季推广', kol_name: 'Carol',
    kind: 'first_touch', subject: '合作邀请', risk_level: 'high',
    risk_reasons: JSON.stringify([{ code: 'NO_EMAIL', message: '达人邮箱缺失' }]),
    evidence: JSON.stringify({
      snapshot_date: '2026-07-20',
      videos: [{ youtube_video_id: 'v1' }, { youtube_video_id: 'v2' }],
      match_reason: '频道与产品高度匹配',
      metrics: { followers: '5.6万', avg_views_30d: 9000, median_views_30d: 8000, posts_30d: 5 }
    }),
    generated_at: '2026-07-25 05:00:00', updated_at: '2026-07-25 05:00:00'
  }],
  replies: [{
    id: 5, campaign_id: 10, customer_id: 23, campaign_name: '春季推广', kol_name: 'Dave',
    subject: 'Re: 合作邀请', body_text: '我对合作很感兴趣，想了解一下佣金细节。',
    received_at: '2026-07-25 04:00:00', ai_summary: '询问佣金细节', ai_intent: 'question',
    updated_at: '2026-07-25 04:00:00'
  }],
  finderExceptions: [{
    id: 6, campaign_id: 10, campaign_name: '春季推广', name: 'Finder-美国', platform: 'youtube',
    status: 'failed', error_message: 'API quota exceeded', success_count: 0, failed_count: 5,
    updated_at: '2026-07-25 03:00:00'
  }],
  recentDrafts: [{
    id: 7, status: 'approved', subject: '合作邀请', reviewed_at: '2026-07-25 02:00:00',
    kol_name: 'Eve', campaign_name: '春季推广'
  }],
  recentReplies: [{
    id: 8, confirm_status: 'ignored', updated_at: '2026-07-25 01:00:00',
    kol_name: 'Frank', campaign_name: '春季推广'
  }]
};

test('GET / 聚合六类待办并输出 summary 计数', async () => {
  await withPatchedDb(fakeDb({ rows: fullRows, counts: { drafts: 2, replies: 1, kols: 0 } }), async () => {
    const handler = findHandler(require('./workbench'), 'get', '/');
    const response = await callHandler(handler);
    const { summary, items, recent_decisions } = response.payload;

    const types = items.map((item) => item.type);
    for (const type of ['strategy', 'candidate', 'outreach', 'reply', 'budget', 'exception']) {
      assert.ok(types.includes(type), `missing type ${type}`);
    }
    // 六类各 1 条，exception 不计入 pending
    assert.equal(items.length, 6);
    assert.deepEqual(summary, { pending: 5, high_risk: 1, exceptions: 1, handled_today: 3 });

    const outreach = items.find((item) => item.type === 'outreach');
    assert.equal(outreach.id, 'outreach:4');
    assert.equal(outreach.risk_level, 'high');
    assert.deepEqual(outreach.risks, ['达人邮箱缺失']);
    assert.ok(outreach.facts.some((f) => f.includes('引用视频数：2')));
    assert.ok(outreach.facts.some((f) => f.includes('快照日期：2026-07-20')));
    assert.ok(outreach.opinion.includes('合作邀请'));
    assert.deepEqual(outreach.actions, [{ key: 'open', label: '去处理', href: '/emails' }]);

    const candidate = items.find((item) => item.type === 'candidate');
    assert.equal(candidate.id, 'candidate:2');
    assert.ok(candidate.facts.some((f) => f.includes('Alice')));
    assert.ok(candidate.facts.some((f) => f.includes('12.3万')));
    // 仅 1 条证据视频 → 样本少风险，risk_level 升级为 low
    assert.ok(candidate.risks.some((r) => r.includes('样本较少')));
    assert.equal(candidate.risk_level, 'low');
    assert.equal(candidate.actions[0].href, '/campaign-kols');

    const reply = items.find((item) => item.type === 'reply');
    assert.ok(reply.opinion.includes('有疑问'));
    assert.ok(reply.facts.some((f) => f.includes('佣金细节')));

    const budget = items.find((item) => item.type === 'budget');
    assert.ok(budget.facts.some((f) => f.includes('报价：500 USD')));

    const exception = items.find((item) => item.type === 'exception');
    assert.equal(exception.id, 'exception:finder:6');
    assert.ok(exception.facts.some((f) => f.includes('API quota exceeded')));
    assert.equal(exception.actions[0].href, '/finder');

    assert.equal(recent_decisions.length, 2);
    assert.equal(recent_decisions[0].decision, '已通过');
    assert.equal(recent_decisions[1].decision, '已忽略');
    assert.equal(recent_decisions[0].href, '/emails');
  });
});

test('GET / 空库返回全零 summary 且不报错', async () => {
  await withPatchedDb(fakeDb(), async () => {
    const handler = findHandler(require('./workbench'), 'get', '/');
    const response = await callHandler(handler);
    assert.deepEqual(response.payload.summary, { pending: 0, high_risk: 0, exceptions: 0, handled_today: 0 });
    assert.deepEqual(response.payload.items, []);
    assert.deepEqual(response.payload.recent_decisions, []);
  });
});

test('GET / recent_decisions 合并草稿与回复并按时间倒序取前 10', async () => {
  const recentDrafts = Array.from({ length: 8 }, (_, i) => ({
    id: 100 + i, status: i % 2 ? 'rejected' : 'sent', subject: `主题${i}`,
    reviewed_at: `2026-07-25 10:0${i}:00`, kol_name: `K${i}`, campaign_name: 'C'
  }));
  const recentReplies = Array.from({ length: 8 }, (_, i) => ({
    id: 200 + i, confirm_status: 'confirmed', updated_at: `2026-07-25 09:0${i}:00`,
    kol_name: `R${i}`, campaign_name: 'C'
  }));
  await withPatchedDb(fakeDb({ rows: { recentDrafts, recentReplies } }), async () => {
    const handler = findHandler(require('./workbench'), 'get', '/');
    const response = await callHandler(handler);
    const decisions = response.payload.recent_decisions;
    assert.equal(decisions.length, 10);
    const times = decisions.map((d) => d.decided_at);
    const sorted = [...times].sort((a, b) => String(b).localeCompare(String(a)));
    assert.deepEqual(times, sorted);
    assert.ok(decisions.some((d) => d.decision === '已驳回'));
    assert.ok(decisions.some((d) => d.decision === '已发送'));
    assert.ok(decisions.some((d) => d.decision === '已确认'));
  });
});

test('GET / 邮件发送失败计入 exception 且指向 /emails', async () => {
  await withPatchedDb(fakeDb({
    rows: {
      emailExceptions: [{
        id: 9, campaign_id: 10, customer_id: 24, campaign_name: '春季推广', kol_name: 'Grace',
        subject: '合作邀请', send_error: 'SMTP 535 认证失败', updated_at: '2026-07-25 03:00:00'
      }]
    }
  }), async () => {
    const handler = findHandler(require('./workbench'), 'get', '/');
    const response = await callHandler(handler);
    assert.equal(response.payload.summary.exceptions, 1);
    assert.equal(response.payload.summary.pending, 0);
    const item = response.payload.items[0];
    assert.equal(item.id, 'exception:email:9');
    assert.ok(item.facts.some((f) => f.includes('SMTP 535 认证失败')));
    assert.equal(item.actions[0].href, '/emails');
  });
});
