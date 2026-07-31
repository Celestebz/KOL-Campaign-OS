// emailContextBuilder 纯逻辑单测：db 全部走内存 stub，不连真实数据库。
const test = require('node:test');
const assert = require('node:assert/strict');
const aiClient = require('./aiClient');
const emailContextBuilder = require('./emailContextBuilder');

function withPatched(target, patch, fn) {
  const originals = {};
  for (const key of Object.keys(patch)) {
    originals[key] = target[key];
    target[key] = patch[key];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of Object.keys(originals)) target[key] = originals[key];
  });
}

function mkReply(id, { at, body, clean, messageId, subject = 'Re: Hi', from = 'kol@x.com' }) {
  return {
    id, message_id: messageId || `<reply-${id}@x>`, subject, from_address: from,
    received_at: at, body_text: body, clean_body_text: clean ?? null,
    body_html: null, quoted_body_text: null, signature_text: null,
    parse_status: 'ok', ai_summary: null, confirm_status: 'pending'
  };
}

function mkRecord(id, { at, body, messageId, subject = 'Hi', to = 'kol@x.com' }) {
  return {
    id, smtp_message_id: messageId || `<sent-${id}@smtp>`, subject, to_address: to,
    created_at: at, body_text: body, status: 'success'
  };
}

// 内存版最小仓库：按 SQL 形态路由到固定数据，run 只记录
function createFakeDb({ thread, replies = [], records = [], campaign = null, customer = null, campaignKol = null, strategy = null }) {
  const statements = [];
  const get = async (sql) => {
    if (/FROM email_threads WHERE id = \?/.test(sql)) return thread;
    if (/FROM campaigns WHERE id = \?/.test(sql)) return campaign;
    if (/FROM customers WHERE id = \?/.test(sql)) return customer;
    if (/FROM campaign_kols WHERE campaign_id = \?/.test(sql)) return campaignKol;
    if (/FROM kol_strategies WHERE campaign_id = \?/.test(sql)) return strategy;
    throw new Error(`Unexpected get: ${sql}`);
  };
  const query = async (sql) => {
    if (/FROM email_replies WHERE thread_id = \?/.test(sql)) return replies;
    if (/FROM email_records WHERE thread_id = \?/.test(sql)) return records;
    throw new Error(`Unexpected query: ${sql}`);
  };
  const run = async (sql, params = []) => {
    statements.push({ sql, params });
    return { id: 0, changes: 1 };
  };
  return { get, query, run, statements };
}

const baseThread = { id: 33, campaign_id: 5, customer_id: 7, normalized_subject: 'Hi', context_summary: null, summary_through_message_id: null };
const baseCampaign = { id: 5, name: 'Everglow', brand: 'BILT HARD', product: 'Tree collar', period: '2026Q3', status: 'active' };
const baseCustomer = { id: 7, name: 'Casey', platform: 'instagram', country_region: 'US', email: 'kol@x.com' };

test('≤6 封：全部给完整清洗正文，方向/时间/发件人标记齐全，不调 AI', async () => {
  const fake = createFakeDb({
    thread: baseThread,
    campaign: baseCampaign,
    customer: baseCustomer,
    campaignKol: { cooperation_type: 'product_exchange', deliverables: '1 条视频', final_fee: '500', currency: 'USD', outreach_status: 'negotiating', internal_notes: '内部备注不应出现' },
    strategy: { product_context: 'tree collar', target_market: 'US' },
    replies: [
      mkReply(1, { at: '2026-07-20T01:00:00Z', body: 'raw 1', clean: 'clean 来信1' }),
      mkReply(2, { at: '2026-07-22T01:00:00Z', body: 'raw 2', clean: 'clean 来信2' })
    ],
    records: [
      mkRecord(1, { at: '2026-07-21T01:00:00Z', body: '我方邮件1' })
    ]
  });
  const noAi = async () => { throw new Error('AI should not be called'); };
  await withPatched(aiClient, { callActiveAi: noAi }, async () => {
    const ctx = await emailContextBuilder.buildThreadContext(33, {}, fake);
    assert.equal(ctx.messagesBlock.messages.length, 3);
    assert.equal(ctx.summaryUsed, null);
    const text = ctx.messagesBlock.text;
    assert.ok(text.includes('clean 来信1'), '来信优先 clean_body_text');
    assert.ok(!text.includes('raw 1'), '有清洗正文时不回退 body_text');
    assert.ok(text.includes('我方邮件1'));
    assert.ok(text.includes('[KOL 来信]') && text.includes('[我方发出]'), '方向标记');
    assert.ok(text.includes('发件人: kol@x.com'));
    assert.ok(text.includes('2026-07-20 01:00'), '时间标记');
    assert.deepEqual(ctx.contextMessageIds, ['<reply-1@x>', '<sent-1@smtp>', '<reply-2@x>']);
    assert.equal(ctx.latestInboundMessageId, '<reply-2@x>');
    assert.equal(ctx.latestInboundReplyId, 2);
    assert.ok(ctx.projectBlock.includes('Everglow'));
    assert.ok(ctx.kolBlock.includes('Casey'));
    assert.ok(ctx.factsBlock.includes('product_exchange') && ctx.factsBlock.includes('500 USD'));
    assert.ok(!ctx.factsBlock.includes('内部备注'), '内部备注不进入上下文');
  });
});

test('>6 封且摘要新鲜：较早邮件走摘要，最近 6 封完整，不调 AI', async () => {
  const replies = [];
  for (let i = 1; i <= 8; i++) {
    replies.push(mkReply(i, { at: `2026-07-2${i}T01:00:00Z`, body: `old body ${i}`, clean: `old clean ${i}` }));
  }
  const thread = { ...baseThread, context_summary: '滚动摘要内容', summary_through_message_id: '<reply-2@x>' };
  const fake = createFakeDb({ thread, replies, campaign: baseCampaign, customer: baseCustomer });
  const noAi = async () => { throw new Error('AI should not be called'); };
  await withPatched(aiClient, { callActiveAi: noAi }, async () => {
    const ctx = await emailContextBuilder.buildThreadContext(33, {}, fake);
    assert.equal(ctx.summaryUsed, '滚动摘要内容');
    assert.equal(ctx.summaryThroughMessageId, '<reply-2@x>');
    assert.equal(ctx.messagesBlock.messages.length, 6);
    const text = ctx.messagesBlock.text;
    assert.ok(text.includes('滚动摘要内容'));
    assert.ok(!text.includes('old clean 1') && !text.includes('old clean 2'), '摘要区正文不重复出现');
    assert.ok(text.includes('old clean 3') && text.includes('old clean 8'), '最近 6 封完整');
  });
});

test('>6 封且摘要缺失：增量生成滚动摘要并落库（幂等）', async () => {
  const replies = [];
  for (let i = 1; i <= 8; i++) {
    replies.push(mkReply(i, { at: `2026-07-2${i}T01:00:00Z`, body: `old clean ${i}` }));
  }
  const fake = createFakeDb({ thread: baseThread, replies, campaign: baseCampaign, customer: baseCustomer });
  const aiCalls = [];
  const fakeAi = async (system, user) => {
    aiCalls.push(user);
    return { parsed: { summary: '新滚动摘要' }, model: 'test-model' };
  };
  await withPatched(aiClient, { callActiveAi: fakeAi }, async () => {
    const ctx = await emailContextBuilder.buildThreadContext(33, {}, fake);
    assert.equal(ctx.summaryUsed, '新滚动摘要');
    const update = fake.statements.find((s) => /UPDATE email_threads SET context_summary/.test(s.sql));
    assert.ok(update, '摘要应写回 email_threads');
    assert.equal(update.params[0], '新滚动摘要');
    assert.equal(update.params[1], '<reply-2@x>', '摘要覆盖到摘要区末尾（最近 6 封之前的最后一封）');

    // 幂等：摘要已新鲜时不再调 AI
    const freshThread = { ...baseThread, context_summary: '新滚动摘要', summary_through_message_id: '<reply-2@x>' };
    const fake2 = createFakeDb({ thread: freshThread, replies, campaign: baseCampaign, customer: baseCustomer });
    const callsBefore = aiCalls.length;
    await emailContextBuilder.buildThreadContext(33, {}, fake2);
    assert.equal(aiCalls.length, callsBefore, '摘要新鲜时不重复调 AI');
  });
  assert.equal(aiCalls.length, 1);
  assert.ok(aiCalls[0].includes('old clean 1') && aiCalls[0].includes('old clean 2'), '摘要输入为较早邮件');
  assert.ok(!aiCalls[0].includes('old clean 3'), '最近 6 封不进摘要输入');
  assert.ok(/untrusted external email content/.test(aiCalls[0]), '摘要 prompt 声明邮件内容不可信');
});

test('最新一封来信之后我方连发多封：最新来信仍完整包含', async () => {
  const replies = [
    mkReply(1, { at: '2026-07-20T01:00:00Z', body: '第一封信' }),
    mkReply(2, { at: '2026-07-21T01:00:00Z', body: '最新来信正文-必须保留' })
  ];
  const records = [];
  for (let i = 1; i <= 6; i++) {
    records.push(mkRecord(i, { at: `2026-07-2${2 + i}T01:00:00Z`, body: `我方第${i}封` }));
  }
  const fake = createFakeDb({ thread: baseThread, replies, records, campaign: baseCampaign, customer: baseCustomer });
  await withPatched(aiClient, { callActiveAi: async () => ({ parsed: { summary: 's' } }) }, async () => {
    const ctx = await emailContextBuilder.buildThreadContext(33, {}, fake);
    assert.equal(ctx.latestInboundMessageId, '<reply-2@x>');
    assert.ok(ctx.messagesBlock.text.includes('最新来信正文-必须保留'));
    assert.ok(ctx.contextMessageIds.includes('<reply-2@x>'));
  });
});

test('单封正文超 6000 字符截断并标注；解析阶段不截断', async () => {
  const longBody = '长'.repeat(7000);
  const fake = createFakeDb({
    thread: baseThread,
    replies: [mkReply(1, { at: '2026-07-20T01:00:00Z', body: longBody })],
    campaign: baseCampaign,
    customer: baseCustomer
  });
  const ctx = await emailContextBuilder.buildThreadContext(33, {}, fake);
  assert.match(ctx.messagesBlock.text, /正文过长，已截断，原文共 7000 字符/);
  // 原始行保留完整正文（截断只发生在上下文渲染）
  assert.equal(ctx.messagesBlock.messages[0].reply.body_text.length, 7000);
});

test('AI 失败：generateThreadSummary 返回 null 不抛异常，buildThreadContext 回退旧摘要', async () => {
  const replies = [];
  for (let i = 1; i <= 8; i++) {
    replies.push(mkReply(i, { at: `2026-07-2${i}T01:00:00Z`, body: `old clean ${i}` }));
  }
  const thread = { ...baseThread, context_summary: '过期摘要', summary_through_message_id: '<reply-1@x>' };
  const fake = createFakeDb({ thread, replies, campaign: baseCampaign, customer: baseCustomer });
  const failAi = async () => { throw new Error('AI 超时'); };
  await withPatched(aiClient, { callActiveAi: failAi }, async () => {
    const result = await emailContextBuilder.generateThreadSummary(33, {}, fake);
    assert.equal(result, null);
    const ctx = await emailContextBuilder.buildThreadContext(33, {}, fake);
    assert.equal(ctx.summaryUsed, '过期摘要', 'AI 失败回退已存摘要，起草不受影响');
  });
});

test('generateThreadSummary：会话不存在抛 404；摘要已最新时不调 AI', async () => {
  const fakeMissing = createFakeDb({ thread: null });
  await assert.rejects(
    () => emailContextBuilder.generateThreadSummary(999, {}, fakeMissing),
    (error) => error.statusCode === 404
  );

  const replies = [];
  for (let i = 1; i <= 8; i++) {
    replies.push(mkReply(i, { at: `2026-07-2${i}T01:00:00Z`, body: `old clean ${i}` }));
  }
  const thread = { ...baseThread, context_summary: '已是最新', summary_through_message_id: '<reply-2@x>' };
  const fake = createFakeDb({ thread, replies });
  await withPatched(aiClient, { callActiveAi: async () => { throw new Error('AI should not be called'); } }, async () => {
    const result = await emailContextBuilder.generateThreadSummary(33, {}, fake);
    assert.equal(result.updated, false);
    assert.equal(result.summary, '已是最新');
    assert.equal(result.throughMessageId, '<reply-2@x>');
  });
});

test('buildThreadContext：thread 不存在返回 null（调用方回退单邮件行为）', async () => {
  const fake = createFakeDb({ thread: null });
  const ctx = await emailContextBuilder.buildThreadContext(999, {}, fake);
  assert.equal(ctx, null);
});
