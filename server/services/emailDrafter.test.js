const test = require('node:test');
const assert = require('node:assert/strict');
const { dbOperations } = require('../database');
const aiClient = require('./aiClient');
const emailDrafter = require('./emailDrafter');
const { evaluateDraft } = require('./emailRiskRules');

// 与 workflowOrchestrator.test.js 相同的 monkey-patch 惯例
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

const igCustomer = {
  id: 7, name: 'callithome__', email: 'calli@example.com', country_region: 'US',
  platform: 'instagram', profile_url: 'https://www.instagram.com/callithome__/',
  youtube_url: null, instagram_url: 'https://www.instagram.com/callithome__/', tiktok_url: null,
  instagram_followers: '93358'
};

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

// 内存版最小仓库：按 SQL 形态路由到固定数据，run 只记录
function createFakeDb({ customer = igCustomer, campaignKol = null, finderVideos = [], aiParsed } = {}) {
  const statements = [];
  const get = async (sql) => {
    if (/FROM campaigns WHERE id = \?/.test(sql)) return { id: 5, name: 'Everglow', product: 'Tree collar' };
    if (/FROM customers WHERE id = \?/.test(sql)) return customer;
    if (/FROM campaign_kols WHERE campaign_id = \?/.test(sql)) return campaignKol;
    if (/FROM kol_strategies WHERE campaign_id = \?/.test(sql)) return { target_market: 'US', product_context: 'tree collar' };
    if (/FROM email_templates/.test(sql)) return { id: 3, body_html: 'be brief' };
    if (/FROM email_settings/.test(sql)) return { sender_name: 'Celeste' };
    if (/FROM email_bounces/.test(sql)) return null;
    if (/FROM email_drafts/.test(sql)) return null;
    throw new Error(`Unexpected get: ${sql}`);
  };
  const query = async (sql) => {
    if (/FROM video_sources/.test(sql)) return finderVideos;
    if (/FROM kol_youtube_snapshot_videos/.test(sql)) return [];
    throw new Error(`Unexpected query: ${sql}`);
  };
  const run = async (sql, params = []) => {
    statements.push({ sql, params });
    if (/INSERT INTO email_drafts\b/.test(sql)) return { id: 55 };
    return { id: 0, changes: 1 };
  };
  const ai = async () => ({
    parsed: aiParsed || {
      subject: 'Loved your Christmas reel',
      body_text: 'Hi, your reel "Reel A" with 300K views was great. We offer a free unit plus 5% commission, no fixed fee.',
      cited_video_ids: ['DQkl3XSDlyV'],
      personalization_note: 'Christmas decor fit'
    },
    model: 'test-model'
  });
  return { get, query, run, statements, ai };
}

function draftInsert(statements) {
  return statements.find((s) => /INSERT INTO email_drafts\b/.test(s.sql));
}

async function runDraft(fake, overrides = {}) {
  return withPatched(dbOperations, { get: fake.get, query: fake.query, run: fake.run }, () =>
    withPatched(aiClient, { callActiveAi: fake.ai }, () =>
      emailDrafter.draftForCustomer({ campaignId: 5, customerId: 7, ...overrides })));
}

test('first-touch prompt uses configured sender and asks interest before commercial terms', () => {
  const prompt = emailDrafter.buildUserPrompt({
    customer: { name: 'Casey', country_region: 'US' },
    campaign: { name: 'TRA-0429', product: 'Wood chipper' },
    strategy: null,
    styleGuide: 'Mention free shipping and a deadline.',
    videos: [{ youtube_video_id: 'v1', title: 'A real project', play_count: 1000 }],
    senderName: 'Celeste',
    kind: 'first_touch'
  });
  assert.match(prompt, /Sender name: Celeste/);
  assert.match(prompt, /only goal is to ask whether the creator is interested/);
  assert.match(prompt, /Do not state or promise shipping/);
  assert.match(prompt, /Never output placeholders such as \[Name\]/);
  assert.match(prompt, /greeting such as "Hi Creator Name," on its own line/);
  assert.match(prompt, /never continue the first sentence on the greeting line/);
  assert.match(prompt, /one blank line between every paragraph/);
  assert.match(prompt, /override any conflicting general style-guide instruction/);
});

test('normalizeGreetingLine puts a blank line after a greeting without changing formatted bodies', () => {
  assert.equal(
    emailDrafter.normalizeGreetingLine('Hi Walker Farm Fam, this is Celeste with BILT HARD.\n\nSecond paragraph.'),
    'Hi Walker Farm Fam,\n\nthis is Celeste with BILT HARD.\n\nSecond paragraph.'
  );
  assert.equal(
    emailDrafter.normalizeGreetingLine('Dear Walker Farm Fam,\r\n\r\nThis is Celeste.\r\n\r\nSecond paragraph.'),
    'Dear Walker Farm Fam,\n\nThis is Celeste.\n\nSecond paragraph.'
  );
});

test('generated draft stores the greeting on its own line', async () => {
  const fake = createFakeDb({
    finderVideos: [{ video_id: 'DQkl3XSDlyV', title: 'Reel A', play_count: 300000, published_at: daysAgo(3) }],
    aiParsed: {
      subject: 'Following up',
      body_text: 'Hello Walker Farm Fam, this is Celeste. I enjoyed "Reel A".',
      cited_video_ids: ['DQkl3XSDlyV'],
      personalization_note: ''
    }
  });
  const result = await runDraft(fake);
  assert.equal(result.ok, true);
  assert.equal(draftInsert(fake.statements).params[4], 'Hello Walker Farm Fam,\n\nthis is Celeste. I enjoyed "Reel A".');
});

test('existing first-touch draft is reused without calling AI or inserting another draft', async () => {
  const fake = createFakeDb({
    campaignKol: { target_platform: 'instagram', instagram_followers_snapshot: '90000' }
  });
  const originalGet = fake.get;
  fake.get = async (sql, params) => {
    if (/FROM email_drafts/.test(sql)) return { id: 88, status: 'pending_review' };
    return originalGet(sql, params);
  };
  fake.ai = async () => { throw new Error('AI should not be called'); };
  const result = await runDraft(fake);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.draftId, 88);
  assert.equal(draftInsert(fake.statements), undefined);
});

test('detectPlatform：target_platform 优先，其次平台 url，再次 platform+profile_url', () => {
  assert.equal(emailDrafter.detectPlatform(igCustomer, { target_platform: 'tiktok' }), 'tiktok');
  assert.equal(emailDrafter.detectPlatform(igCustomer, { target_platform: 'podcast' }), 'instagram');
  assert.equal(emailDrafter.detectPlatform({ youtube_url: 'https://youtube.com/@x' }, null), 'youtube');
  assert.equal(
    emailDrafter.detectPlatform({ name: 'makeupshayla', platform: 'tiktok', profile_url: 'https://www.tiktok.com/@makeupshayla' }, null),
    'tiktok'
  );
  assert.equal(emailDrafter.detectPlatform({ name: 'nobody' }, null), null);
});

test('Instagram 达人起草成功：证据结构泛化、metrics 由证据视频计算', async () => {
  const fake = createFakeDb({
    campaignKol: { target_platform: 'instagram', instagram_followers_snapshot: '90000' },
    finderVideos: [
      { video_id: 'DQkl3XSDlyV', title: 'Reel A', play_count: 300000, published_at: daysAgo(3) },
      { video_id: 'DSabc123XYZ', title: 'Reel B', play_count: 100000, published_at: daysAgo(10) }
    ]
  });
  const result = await runDraft(fake);
  assert.equal(result.ok, true);
  assert.equal(result.draftId, 55);

  const insert = draftInsert(fake.statements);
  assert.ok(insert, '应写入 email_drafts');
  const evidence = JSON.parse(insert.params[7]);
  assert.equal(evidence.platform, 'instagram');
  assert.deepEqual(evidence.videos.map((v) => v.video_id), ['DQkl3XSDlyV', 'DSabc123XYZ']);
  assert.equal(evidence.videos[0].youtube_video_id, undefined);
  assert.equal(evidence.metrics.followers, '93358'); // customers 当前值优先于快照
  assert.equal(evidence.metrics.avg_views_30d, 200000);
  assert.equal(evidence.metrics.median_views_30d, 200000);
  assert.equal(evidence.metrics.posts_30d, 2);
  assert.ok(evidence.snapshot_date);

  const riskReasons = JSON.parse(insert.params[6]);
  assert.equal(riskReasons.length, 0);
  assert.equal(insert.params[5], 'none');
});

test('无证据视频的 IG 达人起草失败并给出明确原因', async () => {
  const fake = createFakeDb({ finderVideos: [] });
  const result = await runDraft(fake);
  assert.equal(result.ok, false);
  assert.match(result.error, /暂无 Instagram 视频证据/);
  assert.equal(draftInsert(fake.statements), undefined);
});

test('无任何平台主页信息的达人起草失败', async () => {
  const fake = createFakeDb({ customer: { id: 7, name: 'nobody', email: 'n@x.com' } });
  const result = await runDraft(fake);
  assert.equal(result.ok, false);
  assert.match(result.error, /无法识别平台/);
});

test('AI 引用证据外视频 id → FABRICATED_EVIDENCE 高风险', async () => {
  const fake = createFakeDb({
    finderVideos: [{ video_id: 'DQkl3XSDlyV', title: 'Reel A', play_count: 300000, published_at: daysAgo(3) }],
    aiParsed: {
      subject: 's', body_text: '5% commission, no fixed fee. Loved "Reel A".',
      cited_video_ids: ['FAKE-REEL-999'], personalization_note: ''
    }
  });
  const result = await runDraft(fake);
  assert.equal(result.ok, true);
  assert.equal(result.riskLevel, 'high');
  const riskReasons = JSON.parse(draftInsert(fake.statements).params[6]);
  assert.ok(riskReasons.some((r) => r.code === 'FABRICATED_EVIDENCE'));
});

test('STALE_SNAPSHOT：IG/TT 证据最新发布超过 30 天标 low risk，fresh 则不标', async () => {
  const base = {
    customer: igCustomer, strategy: { target_market: 'US' },
    bodyText: 'Loved "Reel A" with 300K views. 5% commission, no fixed fee.',
    citedVideoIds: ['DQkl3XSDlyV'], hasEmail: true
  };
  const videos = [{ video_id: 'DQkl3XSDlyV', title: 'Reel A', play_count: 300000 }];
  const stale = evaluateDraft({ ...base, evidenceVideos: videos, snapshotDate: daysAgo(45), staleDays: 30 });
  assert.ok(stale.riskReasons.some((r) => r.code === 'STALE_SNAPSHOT'));
  assert.equal(stale.riskLevel, 'low');
  const fresh = evaluateDraft({ ...base, evidenceVideos: videos, snapshotDate: daysAgo(5), staleDays: 30 });
  assert.ok(!fresh.riskReasons.some((r) => r.code === 'STALE_SNAPSHOT'));

  // 默认阈值仍是 7 天（YouTube 路径行为不变）
  const ytStale = evaluateDraft({ ...base, evidenceVideos: [{ youtube_video_id: 'DQkl3XSDlyV' }], snapshotDate: daysAgo(10) });
  assert.ok(ytStale.riskReasons.some((r) => r.code === 'STALE_SNAPSHOT'));
});

test('metrics 算不出时为 null 不编造', () => {
  const metrics = emailDrafter.computeFinderMetrics([
    { video_id: 'a', play_count: null, published_at: daysAgo(3) },
    { video_id: 'b', play_count: null, published_at: null }
  ]);
  assert.equal(metrics.avg_views_30d, null);
  assert.equal(metrics.median_views_30d, null);
  assert.equal(metrics.posts_30d, 1); // 有一条带日期且在 30 天内
  const noDates = emailDrafter.computeFinderMetrics([{ video_id: 'a', play_count: 100, published_at: null }]);
  assert.equal(noDates.posts_30d, null);
});

test('loadFinderEvidenceVideos 生成按 url/姓名匹配、近 30 天优先的 SQL', async () => {
  const seen = [];
  const fakeQuery = async (sql, params) => { seen.push({ sql, params }); return []; };
  await withPatched(dbOperations, { query: fakeQuery }, () =>
    emailDrafter.loadFinderEvidenceVideos({
      customer: igCustomer,
      campaignKol: { instagram_url_snapshot: 'https://www.instagram.com/callithome__/' },
      platform: 'instagram'
    }));
  assert.equal(seen.length, 1);
  const { sql, params } = seen[0];
  assert.match(sql, /finder_video_evidence/);
  assert.match(sql, /author_profile_url/);
  assert.equal(params[0], 'instagram');
  assert.ok(params.includes('https://www.instagram.com/callithome__/'));
  assert.equal(params[params.length - 1], 10); // LIMIT
});

test('TikTok 达人走 finder 证据路径起草成功', async () => {
  const ttCustomer = {
    id: 13, name: 'makeupshayla', email: 'mk@example.com', country_region: 'US',
    platform: 'tiktok', profile_url: 'https://www.tiktok.com/@makeupshayla',
    youtube_url: null, instagram_url: null, tiktok_url: null, tiktok_followers: '402203'
  };
  const fake = createFakeDb({
    customer: ttCustomer,
    finderVideos: [{ video_id: '7661681242777210126', title: 'TT Video', play_count: 41697, published_at: daysAgo(2) }],
    aiParsed: {
      subject: 's', body_text: '5% commission, no fixed fee. Loved "TT Video".',
      cited_video_ids: ['7661681242777210126'], personalization_note: ''
    }
  });
  const result = await runDraft(fake);
  assert.equal(result.ok, true);
  const evidence = JSON.parse(draftInsert(fake.statements).params[7]);
  assert.equal(evidence.platform, 'tiktok');
  assert.equal(evidence.videos[0].video_id, '7661681242777210126');
  assert.equal(evidence.metrics.followers, '402203');
});

// ---- kind='reply' 会话上下文（p2.0）----

const emailContextBuilder = require('./emailContextBuilder');

function withReplyFakeDb(fake, reply) {
  const originalGet = fake.get;
  fake.get = async (sql, params) => {
    if (/FROM email_replies WHERE id = \?/.test(sql)) return reply;
    return originalGet(sql, params);
  };
  return fake;
}

test('reply 起草：有 thread 时走会话上下文并落库新列', async () => {
  const fake = withReplyFakeDb(createFakeDb({
    campaignKol: { target_platform: 'instagram', instagram_followers_snapshot: '90000' },
    finderVideos: [{ video_id: 'DQkl3XSDlyV', title: 'Reel A', play_count: 300000, published_at: daysAgo(3) }]
  }), { id: 5, thread_id: 33, message_id: '<r2@x>', body_text: '来信原文', clean_body_text: '清洗后来信' });

  const cannedContext = {
    thread: { id: 33 },
    projectBlock: '项目名称：Everglow',
    kolBlock: 'KOL：Casey',
    strategyBlock: '',
    factsBlock: '合作方式：product_exchange',
    messagesBlock: { messages: [], text: '较早邮件摘要：\n滚动摘要文本\n\n[KOL 来信] 2026-07-29 10:00\n佣金是多少？' },
    contextMessageIds: ['<r1@x>', '<r2@x>'],
    summaryUsed: '滚动摘要文本',
    summaryThroughMessageId: '<r1@x>',
    latestInboundMessageId: '<r2@x>',
    latestInboundReplyId: 5
  };
  const originalBuild = emailContextBuilder.buildThreadContext;
  emailContextBuilder.buildThreadContext = async (threadId) => {
    assert.equal(threadId, 33);
    return cannedContext;
  };
  let seenPrompt = '';
  const originalAi = fake.ai;
  fake.ai = async (system, user) => { seenPrompt = user; return originalAi(system, user); };
  try {
    const result = await runDraft(fake, { kind: 'reply', sourceReplyId: 5, feedback: '语气随和一点' });
    assert.equal(result.ok, true);
  } finally {
    emailContextBuilder.buildThreadContext = originalBuild;
  }

  assert.ok(seenPrompt.includes('佣金是多少？'), 'prompt 含会话时间线');
  assert.ok(seenPrompt.includes('滚动摘要文本'), 'prompt 含滚动摘要');
  assert.ok(seenPrompt.includes('untrusted external content'), 'prompt 声明邮件内容不可信');
  assert.ok(seenPrompt.includes('Do not re-ask questions'), '回复规则：不重复提问');
  assert.ok(seenPrompt.includes('quoting is appended by the sending service'), '回复规则：不生成历史引用');
  assert.ok(seenPrompt.includes('Human feedback on previous version (address it): 语气随和一点'), 'feedback 仅承载人工意见');
  assert.ok(!seenPrompt.includes('Human feedback on previous version (address it): 语气随和一点\n来信原文'), '邮件原文不混入 feedback');

  const insert = draftInsert(fake.statements);
  assert.equal((insert.sql.match(/\?/g) || []).length, insert.params.length, 'INSERT 占位符与参数数量一致');
  assert.equal(insert.params[10], 'p2.0', 'prompt_version 升级');
  assert.equal(insert.params[13], 33, 'thread_id');
  assert.equal(insert.params[14], '<r2@x>', 'reply_to_message_id 为最新来信');
  assert.deepEqual(JSON.parse(insert.params[15]), ['<r1@x>', '<r2@x>'], 'context_message_ids');
  assert.equal(insert.params[16], '滚动摘要文本', 'context_summary_snapshot');
});

test('reply 起草：旧数据无 thread 回退单邮件上下文，不报错', async () => {
  const fake = withReplyFakeDb(createFakeDb({
    campaignKol: { target_platform: 'instagram', instagram_followers_snapshot: '90000' },
    finderVideos: [{ video_id: 'DQkl3XSDlyV', title: 'Reel A', play_count: 300000, published_at: daysAgo(3) }]
  }), { id: 5, thread_id: null, message_id: '<r9@x>', body_text: '无会话的旧来信', clean_body_text: null });

  const originalBuild = emailContextBuilder.buildThreadContext;
  let buildCalled = false;
  emailContextBuilder.buildThreadContext = async () => { buildCalled = true; return null; };
  let seenPrompt = '';
  const originalAi = fake.ai;
  fake.ai = async (system, user) => { seenPrompt = user; return originalAi(system, user); };
  try {
    const result = await runDraft(fake, { kind: 'reply', sourceReplyId: 5 });
    assert.equal(result.ok, true);
  } finally {
    emailContextBuilder.buildThreadContext = originalBuild;
  }
  assert.equal(buildCalled, false, '无 thread_id 不调 buildThreadContext');
  assert.ok(seenPrompt.includes('无会话的旧来信'), '回退到单邮件上下文');
  assert.ok(seenPrompt.includes('<<<EMAIL>>>'), '回退内容同样按不可信内容包裹');

  const insert = draftInsert(fake.statements);
  assert.equal(insert.params[13], null, '无 thread 时 thread_id 为 NULL');
  assert.equal(insert.params[14], '<r9@x>', 'reply_to_message_id 回退为该来信 message_id');
  assert.equal(insert.params[15], null);
  assert.equal(insert.params[16], null);
});
