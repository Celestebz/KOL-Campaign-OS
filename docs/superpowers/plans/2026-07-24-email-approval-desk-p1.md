# 邮件审批台 P1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按《邮件审批台 P1 开发方案》实现 AI 起草 + 人工审批 + 发送 + 回复追踪 + 飞书回写的完整外联闭环。

**Architecture:** 新建 `server/routes/emails.js` 与 `server/services/emailDrafter.js / emailRiskRules.js / mailer.js / emailReplyPoller.js / emailFollowUp.js / aiClient.js`，全部用 `dbOperations` 裸 SQL（仓库惯例）。AI 调用抽到 `aiClient.js` 供 finderTasks/videos/邮件三方共用。前端 `Emails.js` 已是确认过的 UI，`emailApi.js` 去掉 mock 接真实接口。

**Tech Stack:** Express + Sequelize(MySQL) + Umzug + nodemailer（已有）+ imapflow（新增）；前端 React + antd。

**Spec:** `docs/superpowers/specs/2026-07-24-email-approval-desk-p1-design.md`

## Global Constraints

- 服务端测试：`cd server && npm test`（node:test）。路由测试惯例：monkey-patch `dbOperations`，`findHandler`/`callHandler` 调 handler（参照 `server/routes/settings.test.js`）。
- 不新增 Sequelize 模型；新路由全部 `dbOperations` 裸 SQL。
- `outreach_status` 存英文编码：`contacted`（已联络）/`replied`（已回复）/`negotiating`（沟通中）；中文标签只在 UI 与飞书映射层。
- P1 铁律：AI 草稿一律人工批准后才能发送；`/drafts/:id/send` 对非 `approved` 状态返回 409。
- 密钥脱敏：邮箱密码 GET 返回 `••••••••`，提交该掩码值时保留原值；日志/响应不输出密码与 API key。
- 迁移文件名 `YYYYMMDDHHMMSS-<name>.js`；表/列 snake_case，中文 COMMENT。
- 提交信息参照仓库历史（`feat: ...` 等）。

---

### Task 1: 迁移——邮件六表 + campaign_kols 加列 + seed 写作规范

**Files:**
- Create: `server/migrations/20260724000001-create-email-center-tables.js`

**Interfaces:**
- Produces: 表 `email_settings`、`email_templates`（含 `kind`）、`email_drafts`、`email_records`、`email_replies`、`email_draft_versions`；`campaign_kols` 加列 `last_outreach_at`、`follow_up_count`、`last_reply_summary`；seed 一条 `kind='style_guide'` 写作规范模板。后续全部任务依赖。

- [ ] **Step 1: 写迁移文件**

创建 `server/migrations/20260724000001-create-email-center-tables.js`：

```js
// 邮件审批台 P1：邮箱配置、模板（写作规范/固定模板）、AI草稿、发送记录、回复、草稿版本六张表；
// campaign_kols 增加最近外联时间、跟进次数、最近回复摘要三列。
const STYLE_GUIDE_BODY = `三段式：第一句自我介绍加来意并引用达人1-2条真实视频；中段说清能提供什么（免费寄样归达人、5%佣金、明确说明无固定费、一条完播视频及截止日期）；最后一句call to action（回复即发规格，或确认设备兼容性）。
自然语言连贯段落，不用列表符号、不用破折号，简单口语化表达，正文不超过120个英文单词。
只允许引用上下文里给出的真实视频标题和数据，禁止编造。
草坪养护类达人必须在CTA中确认是否有15-45HP PTO拖拉机。`;

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const tables = (await queryInterface.showAllTables()).map(String);
    const has = (name) => tables.includes(name);

    if (!has('email_settings')) {
      await queryInterface.createTable('email_settings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        smtp_host: { type: DataTypes.STRING(255), comment: 'SMTP服务器' },
        smtp_port: { type: DataTypes.INTEGER, defaultValue: 465, comment: 'SMTP端口' },
        smtp_secure: { type: DataTypes.BOOLEAN, defaultValue: true, comment: 'SMTP是否SSL' },
        imap_host: { type: DataTypes.STRING(255), comment: 'IMAP服务器' },
        imap_port: { type: DataTypes.INTEGER, defaultValue: 993, comment: 'IMAP端口' },
        imap_secure: { type: DataTypes.BOOLEAN, defaultValue: true, comment: 'IMAP是否TLS' },
        username: { type: DataTypes.STRING(255), comment: '邮箱账号' },
        password: { type: DataTypes.TEXT, comment: '三方客户端安全密码' },
        sender_name: { type: DataTypes.STRING(255), comment: '发件人显示名' },
        default_cc: { type: DataTypes.TEXT, comment: '默认抄送' },
        poll_interval_minutes: { type: DataTypes.INTEGER, defaultValue: 5, comment: 'IMAP轮询间隔分钟，0关闭' },
        last_poll_at: { type: DataTypes.DATE, comment: '最近轮询时间' },
        created_at: { type: DataTypes.DATE },
        updated_at: { type: DataTypes.DATE }
      });
    }

    if (!has('email_templates')) {
      await queryInterface.createTable('email_templates', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: DataTypes.STRING(255), allowNull: false, comment: '模板名称' },
        kind: { type: DataTypes.STRING(20), defaultValue: 'fixed', comment: 'style_guide写作规范/fixed固定模板' },
        subject: { type: DataTypes.STRING(500), comment: '邮件主题（fixed用）' },
        body_html: { type: DataTypes.TEXT, allowNull: false, comment: '写作规范内容或正文HTML' },
        created_at: { type: DataTypes.DATE },
        updated_at: { type: DataTypes.DATE }
      });
    }

    if (!has('email_drafts')) {
      await queryInterface.createTable('email_drafts', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        campaign_id: { type: DataTypes.INTEGER, allowNull: false, comment: '项目ID' },
        customer_id: { type: DataTypes.INTEGER, allowNull: false, comment: '达人ID' },
        kind: { type: DataTypes.STRING(20), allowNull: false, comment: 'first_touch/follow_up/reply' },
        subject: { type: DataTypes.STRING(500), comment: '邮件主题' },
        body_text: { type: DataTypes.TEXT, comment: '邮件正文纯文本' },
        status: { type: DataTypes.STRING(20), defaultValue: 'pending_review', comment: 'pending_review/approved/rejected/sent/send_failed' },
        risk_level: { type: DataTypes.STRING(10), defaultValue: 'none', comment: 'none/low/high' },
        risk_reasons: { type: DataTypes.TEXT, comment: 'JSON数组 [{code,message}]' },
        evidence: { type: DataTypes.TEXT, comment: 'JSON 证据：快照日期/引用视频/指标/匹配理由' },
        source_reply_id: { type: DataTypes.INTEGER, comment: 'reply类草稿来源回复ID' },
        template_id: { type: DataTypes.INTEGER, comment: '使用的写作规范模板ID' },
        prompt_version: { type: DataTypes.STRING(50), comment: '提示词版本' },
        ai_model: { type: DataTypes.STRING(100), comment: '生成所用模型' },
        reviewer_note: { type: DataTypes.TEXT, comment: '审批备注/驳回原因' },
        generated_at: { type: DataTypes.DATE, comment: 'AI生成时间' },
        reviewed_at: { type: DataTypes.DATE, comment: '人工审批时间' },
        created_at: { type: DataTypes.DATE },
        updated_at: { type: DataTypes.DATE }
      });
      await queryInterface.addIndex('email_drafts', ['campaign_id', 'status']);
      await queryInterface.addIndex('email_drafts', ['customer_id']);
    }

    if (!has('email_records')) {
      await queryInterface.createTable('email_records', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        draft_id: { type: DataTypes.INTEGER, comment: '来源草稿ID' },
        campaign_id: { type: DataTypes.INTEGER, comment: '项目ID' },
        customer_id: { type: DataTypes.INTEGER, comment: '达人ID' },
        kol_name: { type: DataTypes.STRING(255), comment: '达人名称快照' },
        to_address: { type: DataTypes.STRING(255), comment: '收件人' },
        cc: { type: DataTypes.TEXT, comment: '实际抄送' },
        subject: { type: DataTypes.STRING(500), comment: '实际发送主题' },
        body_text: { type: DataTypes.TEXT, comment: '实际发送正文' },
        status: { type: DataTypes.STRING(20), allowNull: false, comment: 'success/failed' },
        error: { type: DataTypes.TEXT, comment: '失败原因' },
        smtp_message_id: { type: DataTypes.STRING(500), comment: 'SMTP返回Message-ID' },
        created_at: { type: DataTypes.DATE }
      });
      await queryInterface.addIndex('email_records', ['customer_id']);
      await queryInterface.addIndex('email_records', ['to_address']);
    }

    if (!has('email_replies')) {
      await queryInterface.createTable('email_replies', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        email_record_id: { type: DataTypes.INTEGER, comment: '匹配到的发送记录' },
        campaign_id: { type: DataTypes.INTEGER, comment: '项目ID' },
        customer_id: { type: DataTypes.INTEGER, allowNull: false, comment: '达人ID' },
        from_address: { type: DataTypes.STRING(255), allowNull: false, comment: '发件人' },
        message_id: { type: DataTypes.STRING(500), comment: '邮件Message-ID，幂等去重' },
        subject: { type: DataTypes.STRING(500), comment: '回复主题' },
        body_text: { type: DataTypes.TEXT, comment: '纯文本正文，截断8000字符' },
        received_at: { type: DataTypes.DATE, comment: '收信时间' },
        ai_status: { type: DataTypes.STRING(20), defaultValue: 'pending', comment: 'pending/success/failed' },
        ai_summary: { type: DataTypes.TEXT, comment: 'AI摘要' },
        ai_intent: { type: DataTypes.STRING(20), comment: 'interested/question/rejected/other' },
        confirm_status: { type: DataTypes.STRING(20), defaultValue: 'pending', comment: 'pending/confirmed/ignored' },
        confirmed_summary: { type: DataTypes.TEXT, comment: '人工确认后的摘要' },
        created_at: { type: DataTypes.DATE },
        updated_at: { type: DataTypes.DATE }
      });
      await queryInterface.addIndex('email_replies', ['customer_id']);
      await queryInterface.addIndex('email_replies', ['confirm_status']);
      await queryInterface.addIndex('email_replies', ['message_id']);
    }

    if (!has('email_draft_versions')) {
      await queryInterface.createTable('email_draft_versions', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        draft_id: { type: DataTypes.INTEGER, allowNull: false, comment: '草稿ID' },
        subject: { type: DataTypes.STRING(500) },
        body_text: { type: DataTypes.TEXT },
        source: { type: DataTypes.STRING(20), comment: 'ai/human/regenerate' },
        feedback: { type: DataTypes.TEXT, comment: '重新生成时的人工反馈' },
        created_at: { type: DataTypes.DATE }
      });
      await queryInterface.addIndex('email_draft_versions', ['draft_id']);
    }

    const ck = await queryInterface.describeTable('campaign_kols');
    if (!ck.last_outreach_at) {
      await queryInterface.addColumn('campaign_kols', 'last_outreach_at', { type: DataTypes.DATE, comment: '最近一次外联发送时间' });
    }
    if (!ck.follow_up_count) {
      await queryInterface.addColumn('campaign_kols', 'follow_up_count', { type: DataTypes.INTEGER, defaultValue: 0, comment: '跟进邮件次数' });
    }
    if (!ck.last_reply_summary) {
      await queryInterface.addColumn('campaign_kols', 'last_reply_summary', { type: DataTypes.TEXT, comment: '最近一封已确认回复的摘要，同步飞书跟进记录' });
    }

    const [styleGuide] = await queryInterface.sequelize.query(
      "SELECT id FROM email_templates WHERE kind = 'style_guide' LIMIT 1"
    );
    if (!styleGuide.length) {
      await queryInterface.sequelize.query(
        `INSERT INTO email_templates (name, kind, subject, body_html, created_at, updated_at)
         VALUES ('外联邮件写作规范 v1', 'style_guide', '', ?, NOW(), NOW())`,
        { replacements: [STYLE_GUIDE_BODY] }
      );
    }
  },

  async down(queryInterface) {
    const ck = await queryInterface.describeTable('campaign_kols');
    for (const col of ['last_outreach_at', 'follow_up_count', 'last_reply_summary']) {
      if (ck[col]) await queryInterface.removeColumn('campaign_kols', col);
    }
    for (const table of ['email_draft_versions', 'email_replies', 'email_records', 'email_drafts', 'email_templates', 'email_settings']) {
      await queryInterface.dropTable(table, { cascade: true }).catch(() => {});
    }
  }
};
```

- [ ] **Step 2: 跑迁移 + 回归**

Run: `cd server && npm run db:migrate`
Expected: `20260724000001-create-email-center-tables.js ... migrated`，无报错。

Run: `cd server && npm test`
Expected: 全部通过。

- [ ] **Step 3: Commit**

```bash
git add server/migrations/20260724000001-create-email-center-tables.js
git commit -m "feat: add email approval desk tables migration"
```

---

### Task 2: aiClient 抽取（finderTasks、videos 改引用）

**Files:**
- Create: `server/services/aiClient.js`
- Modify: `server/routes/finderTasks.js`、`server/routes/videos.js`（删除本地 AI 调用副本，改为引用）
- Test: 复用现有 `finderTasks.test.js`、`videos.test.js`

**Interfaces:**
- Produces: `require('../services/aiClient')` 导出：
  - `parseAiContentRobust(content)` — 容错解析 AI 返回的 JSON。
  - `callAi(setting, provider, systemPrompt, userPrompt)` — 按 provider 分发（minimax/openai/deepseek/custom_openai_compatible），返回 `{ parsed, raw, model }`。
  - `getActiveAiSetting()` — 读 `system.provider_selection` 的 `aiModels.active` + `api_settings` 对应行（含 legacy key `'ai'` 兜底），返回 `{ provider, setting }`。
  - `callActiveAi(systemPrompt, userPrompt)` — 上面两步合一，邮件模块（Task 5、8）直接用。
  - `providerKey(scope, provider)`、`legacyKeysFor(scope, provider)`、`getSetting(key, legacyKeys)`、`fetchJson(url, options)`、`PROVIDER_LABELS`。

- [ ] **Step 1: 基线测试**

Run: `cd server && npm test`
Expected: 全部通过。

- [ ] **Step 2: 创建 server/services/aiClient.js**

把 `server/routes/finderTasks.js` 的 `callFinderAi`（约 411–470 行，minimax legacy/modern 双报文 + openai 兼容分发）与 `server/routes/videos.js` 的 `parseAiContentRobust`（738–761）、`getSelection/getSetting/providerKey/legacyKeysFor`（291–331）、`fetchJson`（337–356）、`PROVIDER_LABELS`（28–40）、`DEFAULT_SELECTION`（13–26）、`SYSTEM_SELECTION_KEY` 合并为一份。要点：

- `callAi` 以 `callFinderAi` 的报文逻辑为准（它同时覆盖 minimax 新旧两种 endpoint，videos.js 的 `callMiniMax` 是同逻辑副本）；provider 为 `openai/deepseek/custom_openai_compatible` 时走 `/chat/completions`，base_url 默认值同 videos.js 的 `callOpenAiCompatible`。
- `parseAiContentRobust` 原样保留 videos.js 版本。
- 文件头：`const { dbOperations } = require('../database');`
- 新增：

```js
async function getActiveAiSetting() {
  const selection = await getSelection();
  const provider = selection.aiModels.active || 'deepseek';
  const setting = await getSetting(providerKey('ai', provider), legacyKeysFor('ai', provider));
  return { provider, setting };
}

async function callActiveAi(systemPrompt, userPrompt) {
  const { provider, setting } = await getActiveAiSetting();
  if (provider === 'custom_http_api') throw new Error('Custom HTTP API 当前仅预留，暂不可用于分析');
  if (!['minimax', 'openai', 'deepseek', 'custom_openai_compatible'].includes(provider)) {
    throw new Error(`${PROVIDER_LABELS[provider] || provider} 当前暂不可用于 AI 分析`);
  }
  return callAi(setting, provider, systemPrompt, userPrompt);
}
```

- [ ] **Step 3: finderTasks.js、videos.js 改引用**

两个文件删除各自被搬走的函数/常量定义，顶部改为：

```js
const {
  SYSTEM_SELECTION_KEY, DEFAULT_SELECTION, PROVIDER_LABELS,
  parseJson, providerKey, mergeSelection, getSelection, getSetting, legacyKeysFor,
  fetchJson, parseAiContentRobust, callAi, getActiveAiSetting, callActiveAi
} = require('../services/aiClient');
```

（按各文件实际用到的名字删减 import；`mergeSelection`/`parseJson` 若在 aiClient.js 未导出则补齐导出。）

- finderTasks.js 中 `callFinderAi(...)` 的调用点改为 `callAi(...)`；`parseJson` 若 finderTasks 本地还有定义且语义相同则一并删除改引用。
- videos.js 中 `callOpenAiCompatible(setting, provider, sys, usr)` 调用点改为 `callAi(setting, provider, sys, usr)`；`callMiniMax(setting, sys, usr)` 改为 `callAi(setting, 'minimax', sys, usr)`；`runAiAnalysis` 里 provider 校验逻辑保留在 videos.js（行为不变）。
- 两文件各自平台抓取专用的 `fetchFirstJson` 留在原文件，其内部 `fetchJson` 来自 import。

- [ ] **Step 4: 回归 + smoke**

Run: `cd server && npm test`
Expected: 全部通过，无回归。

Run: `cd server && node -e "const a=require('./services/aiClient');console.log(Object.keys(a).join(','))"`
Expected: 输出含 `callActiveAi,callAi,parseAiContentRobust,getActiveAiSetting`。

- [ ] **Step 5: Commit**

```bash
git add server/services/aiClient.js server/routes/finderTasks.js server/routes/videos.js
git commit -m "refactor: extract shared AI client into services/aiClient.js"
```

---

### Task 3: mailer 服务

**Files:**
- Create: `server/services/mailer.js`
- Test: `server/services/mailer.test.js`

**Interfaces:**
- Produces: `createTransporter(settings)`、`parseCc(text)`、`verifySettings(settings)`（失败抛中文错误）、`sendMail({ settings, to, cc, subject, text })`（返回 `{ messageId }`；正文用纯文本 `text`，同时附 `html: text.replace(/\n/g,'<br>')` 简单包装）。Task 6 发送草稿时用。

- [ ] **Step 1: 写失败测试**

创建 `server/services/mailer.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCc } = require('./mailer');

test('parseCc splits by comma/semicolon/newline incl. Chinese separators', () => {
  assert.deepEqual(parseCc('a@x.com, b@x.com;c@x.com\nd@x.com，e@x.com； f@x.com '), [
    'a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com'
  ]);
  assert.deepEqual(parseCc(''), []);
  assert.deepEqual(parseCc(null), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test services/mailer.test.js`
Expected: FAIL，`Cannot find module './mailer'`。

- [ ] **Step 3: 实现 server/services/mailer.js**

```js
// SMTP 发送封装（nodemailer 已在依赖中）。
const nodemailer = require('nodemailer');

function createTransporter(settings) {
  return nodemailer.createTransport({
    host: settings.smtp_host,
    port: Number(settings.smtp_port) || 465,
    secure: settings.smtp_secure === undefined ? true : Boolean(settings.smtp_secure),
    auth: { user: settings.username, pass: settings.password }
  });
}

function parseCc(text) {
  if (!text || typeof text !== 'string') return [];
  return text.split(/[,;\n，；]/).map((s) => s.trim()).filter(Boolean);
}

async function verifySettings(settings) {
  if (!settings || !settings.smtp_host || !settings.username) {
    throw new Error('请先配置邮箱设置');
  }
  try {
    await createTransporter(settings).verify();
  } catch (error) {
    throw new Error(`SMTP 连接失败：${error.message}`);
  }
}

function textToHtml(text) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">${escaped.replace(/\n/g, '<br>')}</div>`;
}

// 发送单封并返回 { messageId }
async function sendMail({ settings, to, cc = [], subject, text }) {
  const from = settings.sender_name
    ? `"${settings.sender_name}" <${settings.username}>`
    : settings.username;
  const info = await createTransporter(settings).sendMail({
    from,
    to,
    cc: cc.length ? cc.join(',') : undefined,
    subject,
    text,
    html: textToHtml(text)
  });
  return { messageId: info.messageId || null };
}

module.exports = { createTransporter, parseCc, verifySettings, sendMail, textToHtml };
```

- [ ] **Step 4: 跑测试确认通过 + Commit**

Run: `cd server && node --test services/mailer.test.js`
Expected: PASS。

```bash
git add server/services/mailer.js server/services/mailer.test.js
git commit -m "feat: add SMTP mailer service"
```

---

### Task 4: routes/emails.js——settings / templates / records

**Files:**
- Create: `server/routes/emails.js`
- Test: `server/routes/emails.test.js`
- Modify: `server/index.js`（挂载 `/api/emails`）

**Interfaces:**
- Consumes: Task 1 表、Task 3 `verifySettings`。
- Produces: `GET/PUT /settings`、`POST /settings/test`、`GET/POST/PUT/DELETE /templates`、`GET /templates/variables`、`GET /records`。统一 `{ success, data?, error? }`。后续 Task 6、8 往同一文件追加 drafts/replies 路由。`getEmailSettings()`（内部函数）供 Task 6/8 复用。

- [ ] **Step 1: 写失败测试**

创建 `server/routes/emails.test.js`（辅助函数复制 settings.test.js 惯例）：

```js
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

test('GET /settings masks stored password', async () => {
  await withPatchedDb({
    get: async () => ({ id: 1, smtp_host: 'smtp.qiye.aliyun.com', username: 'u@x.com', password: 'secret' })
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/settings');
    const response = await callHandler(handler);
    assert.equal(response.payload.data.password, '••••••••');
  });
});

test('PUT /settings keeps stored password when masked value submitted', async () => {
  const statements = [];
  await withPatchedDb({
    get: async () => ({ id: 1, password: 'real-secret' }),
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'put', '/settings');
    await callHandler(handler, { body: { smtp_host: 'smtp.qiye.aliyun.com', username: 'u@x.com', password: '••••••••' } });
    const update = statements.find((s) => /UPDATE email_settings/.test(s.sql));
    assert.ok(update, 'should update existing row');
    assert.ok(update.params.includes('real-secret'));
  });
});

test('POST /templates validates kind and required fields', async () => {
  await withPatchedDb({ run: async () => ({ id: 1, changes: 1 }) }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/templates');
    const bad = await callHandler(handler, { body: { name: 'x', kind: 'fixed' } });
    assert.equal(bad.statusCode, 400);
    const ok = await callHandler(handler, { body: { name: 'x', kind: 'style_guide', body_html: '规范内容' } });
    assert.equal(ok.payload.success, true);
  });
});

test('GET /records joins draft kol name and filters status', async () => {
  let seenSql = '';
  await withPatchedDb({
    get: async () => ({ total: 1 }),
    query: async (sql, params) => {
      seenSql = sql;
      assert.deepEqual(params, ['failed']);
      return [{ id: 1, kol_name: 'Alice', status: 'failed' }];
    }
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/records');
    const response = await callHandler(handler, { query: { status: 'failed' } });
    assert.equal(response.payload.data.total, 1);
    assert.match(seenSql, /LEFT JOIN email_drafts/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test routes/emails.test.js`
Expected: FAIL，`Cannot find module './emails'`。

- [ ] **Step 3: 实现 server/routes/emails.js（本任务部分）**

```js
const express = require('express');
const { dbOperations } = require('../database');
const mailer = require('../services/mailer');

const router = express.Router();

const MASKED_SECRET = '••••••••';
const TEMPLATE_KINDS = new Set(['style_guide', 'fixed']);

const VARIABLE_LABELS = {
  kol_name: 'KOL名称',
  contact_name: '联系人姓名',
  campaign_name: '项目名称',
  product_names: '合作产品',
  cooperation_type: '合作方式',
  sender_name: '发件人署名'
};

async function getEmailSettings() {
  return dbOperations.get('SELECT * FROM email_settings ORDER BY id LIMIT 1');
}

// ---- 邮箱配置 ----

router.get('/settings', async (req, res) => {
  try {
    const settings = await getEmailSettings();
    if (!settings) return res.json({ success: true, data: null });
    res.json({ success: true, data: { ...settings, password: settings.password ? MASKED_SECRET : '' } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const body = req.body || {};
    const existing = await getEmailSettings();
    const password = body.password === MASKED_SECRET || body.password === undefined
      ? (existing?.password || null)
      : body.password;
    const values = [
      body.smtp_host || null, Number(body.smtp_port) || 465, body.smtp_secure === undefined ? 1 : (body.smtp_secure ? 1 : 0),
      body.imap_host || null, Number(body.imap_port) || 993, body.imap_secure === undefined ? 1 : (body.imap_secure ? 1 : 0),
      body.username || null, password,
      body.sender_name || null, body.default_cc || null,
      Number(body.poll_interval_minutes ?? 5)
    ];
    if (existing) {
      await dbOperations.run(
        `UPDATE email_settings SET smtp_host=?, smtp_port=?, smtp_secure=?, imap_host=?, imap_port=?, imap_secure=?,
         username=?, password=?, sender_name=?, default_cc=?, poll_interval_minutes=?, updated_at=NOW() WHERE id=?`,
        [...values, existing.id]
      );
    } else {
      await dbOperations.run(
        `INSERT INTO email_settings (smtp_host, smtp_port, smtp_secure, imap_host, imap_port, imap_secure,
         username, password, sender_name, default_cc, poll_interval_minutes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        values
      );
    }
    res.json({ success: true, message: '邮箱设置已保存' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/settings/test', async (req, res) => {
  try {
    const settings = await getEmailSettings();
    if (!settings) return res.status(400).json({ success: false, error: '请先配置邮箱设置' });
    await mailer.verifySettings(settings);
    res.json({ success: true, message: 'SMTP 连接成功' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---- 模板（写作规范 / 固定模板） ----

router.get('/templates', async (req, res) => {
  try {
    const templates = await dbOperations.query('SELECT * FROM email_templates ORDER BY created_at DESC');
    res.json({ success: true, data: templates });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/templates/variables', async (req, res) => {
  res.json({ success: true, data: VARIABLE_LABELS });
});

function validateTemplateBody(body) {
  if (!body.name) return '模板名称为必填字段';
  if (body.kind && !TEMPLATE_KINDS.has(body.kind)) return '模板类型只能是 style_guide 或 fixed';
  if (!body.body_html) return '模板内容为必填字段';
  return null;
}

router.post('/templates', async (req, res) => {
  try {
    const invalid = validateTemplateBody(req.body || {});
    if (invalid) return res.status(400).json({ success: false, error: invalid });
    const { name, kind = 'fixed', subject = '', body_html } = req.body;
    const result = await dbOperations.run(
      'INSERT INTO email_templates (name, kind, subject, body_html, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
      [name, kind, subject, body_html]
    );
    res.json({ success: true, message: '模板创建成功', data: { id: result.id } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/templates/:id', async (req, res) => {
  try {
    const invalid = validateTemplateBody(req.body || {});
    if (invalid) return res.status(400).json({ success: false, error: invalid });
    const { name, kind = 'fixed', subject = '', body_html } = req.body;
    await dbOperations.run(
      'UPDATE email_templates SET name=?, kind=?, subject=?, body_html=?, updated_at=NOW() WHERE id=?',
      [name, kind, subject, body_html, req.params.id]
    );
    res.json({ success: true, message: '模板更新成功' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    await dbOperations.run('DELETE FROM email_templates WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: '模板删除成功' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---- 发送记录 ----

router.get('/records', async (req, res) => {
  try {
    const { status } = req.query || {};
    const conditions = [];
    const params = [];
    if (status) { conditions.push('er.status = ?'); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const totalRow = await dbOperations.get(`SELECT COUNT(*) AS total FROM email_records er ${where}`, params);
    const records = await dbOperations.query(
      `SELECT er.*, d.id AS draft_exists
       FROM email_records er
       LEFT JOIN email_drafts d ON d.id = er.draft_id
       ${where}
       ORDER BY er.created_at DESC
       LIMIT 200`,
      params
    );
    res.json({ success: true, data: { records, total: totalRow?.total || 0 } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
```

（`GET /records` 的 `kol_name` 在发送时已快照进 `email_records.kol_name`，无需 join customers；`LEFT JOIN email_drafts` 仅用于测试断言与后续扩展。）

- [ ] **Step 4: 挂载路由**

`server/index.js`：顶部 require 区加 `const emailRoutes = require('./routes/emails');`，`app.use('/api/agent', agentRoutes);` 后加 `app.use('/api/emails', emailRoutes);`。

- [ ] **Step 5: 跑测试 + 全量回归 + Commit**

Run: `cd server && node --test routes/emails.test.js && npm test`
Expected: 全部通过。

```bash
git add server/routes/emails.js server/routes/emails.test.js server/index.js
git commit -m "feat: add email settings, templates and records APIs"
```

---

### Task 5: emailRiskRules + emailDrafter

**Files:**
- Create: `server/services/emailRiskRules.js`
- Test: `server/services/emailRiskRules.test.js`
- Create: `server/services/emailDrafter.js`

**Interfaces:**
- Consumes: Task 2 `callActiveAi`、Task 1 表、`runYoutubeIntakeSnapshot`（`server/services/youtubeIntakeSnapshot.js`，签名 `runYoutubeIntakeSnapshot(customerId)`）。
- Produces:
  - `evaluateDraft({ customer, strategy, bodyText, citedVideoIds, evidenceVideos, snapshotDate, hasEmail })` → `{ riskLevel, riskReasons: [{ code, message }] }`（纯函数，规则引擎）。
  - `RISK_CODES` 常量。
  - `draftForCustomer({ campaignId, customerId, kind = 'first_touch', sourceReplyId = null, feedback = null })` → 完整起草流程（快照检查→上下文→AI→校验→落库），成功返回 `{ ok: true, draftId }`，失败返回 `{ ok: false, error }`；并发由调用方控制。Task 6、8、10 依赖。

- [ ] **Step 1: 写失败测试（风险规则，纯函数）**

创建 `server/services/emailRiskRules.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateDraft, RISK_CODES } = require('./emailRiskRules');

const base = {
  customer: { id: 1, name: 'Alice', email: 'a@x.com', country_region: 'US' },
  strategy: { target_market: 'US' },
  bodyText: 'Hi, loved your video "Mower test" with 100K views. We offer a free unit plus 5% commission, no fixed fee, one video within 30 days.',
  citedVideoIds: ['v1'],
  evidenceVideos: [{ youtube_video_id: 'v1', title: 'Mower test', play_count: 100000 }],
  snapshotDate: new Date().toISOString(),
  hasEmail: true
};

test('clean draft gets risk none', () => {
  const { riskLevel, riskReasons } = evaluateDraft(base);
  assert.equal(riskLevel, 'none');
  assert.deepEqual(riskReasons, []);
});

test('fabricated video id is high risk', () => {
  const { riskLevel, riskReasons } = evaluateDraft({ ...base, citedVideoIds: ['nope'] });
  assert.equal(riskLevel, 'high');
  assert.ok(riskReasons.some((r) => r.code === 'FABRICATED_EVIDENCE'));
});

test('price commitment and no email are high risk', () => {
  const { riskReasons } = evaluateDraft({ ...base, bodyText: base.bodyText + ' We can pay $500 per video.' });
  assert.ok(riskReasons.some((r) => r.code === 'PRICE_COMMITMENT'));
  const noEmail = evaluateDraft({ ...base, hasEmail: false });
  assert.equal(noEmail.riskLevel, 'high');
  assert.ok(noEmail.riskReasons.some((r) => r.code === 'NO_EMAIL'));
});

test('market mismatch is high, stale snapshot and missing video reference are low', () => {
  const mm = evaluateDraft({ ...base, customer: { ...base.customer, country_region: 'GB' } });
  assert.ok(mm.riskReasons.some((r) => r.code === 'MARKET_MISMATCH' && mm.riskLevel === 'high'));
  const stale = evaluateDraft({ ...base, snapshotDate: '2026-07-01' });
  assert.ok(stale.riskReasons.some((r) => r.code === 'STALE_SNAPSHOT'));
  assert.equal(stale.riskLevel, 'low');
  const noRef = evaluateDraft({ ...base, citedVideoIds: [] });
  assert.ok(noRef.riskReasons.some((r) => r.code === 'MISSING_VIDEO_REFERENCE'));
});

test('metric mismatch detects wrong view counts in body', () => {
  const wrong = evaluateDraft({ ...base, bodyText: base.bodyText.replace('100K', '1.2M') });
  assert.ok(wrong.riskReasons.some((r) => r.code === 'METRIC_MISMATCH'));
});

test('missing required terms is low risk', () => {
  const missing = evaluateDraft({ ...base, bodyText: 'Hi, your content is great. Want to try our product?' });
  assert.ok(missing.riskReasons.some((r) => r.code === 'MISSING_REQUIRED_TERM'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test services/emailRiskRules.test.js`
Expected: FAIL，`Cannot find module './emailRiskRules'`。

- [ ] **Step 3: 实现 server/services/emailRiskRules.js**

```js
// 草稿风险规则引擎（纯函数）。规则先硬编码，后续可配置化。
const RISK_CODES = {
  NO_EMAIL: 'high',
  FABRICATED_EVIDENCE: 'high',
  METRIC_MISMATCH: 'high',
  MARKET_MISMATCH: 'high',
  PRICE_COMMITMENT: 'high',
  STALE_SNAPSHOT: 'low',
  MISSING_REQUIRED_TERM: 'low',
  MISSING_VIDEO_REFERENCE: 'low',
  LANGUAGE_MISMATCH: 'low'
};

const PRICE_COMMITMENT_PATTERN = /\$\s?\d|fee|rate card|guarantee|contract|固定费|报价|合同/i;
const COMMISSION_PATTERN = /commission|佣金/i;
const NO_FIXED_FEE_PATTERN = /no fixed fee|无固定费/i;

const STALE_DAYS = 7;

function normalizeNumber(text) {
  const match = String(text).match(/([\d.]+)\s*([kKmM万])?/);
  if (!match) return null;
  let value = parseFloat(match[1]);
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'k') value *= 1e3;
  else if (unit === 'm') value *= 1e6;
  else if (unit === '万') value *= 1e4;
  return value;
}

function countryMatchesMarket(country, targetMarket) {
  if (!country || !targetMarket) return true; // 数据缺失不判
  const c = String(country).toUpperCase();
  const markets = String(targetMarket).toUpperCase().split(/[,，、\s]+/).filter(Boolean);
  if (!markets.length) return true;
  return markets.some((m) => c.includes(m) || m.includes(c));
}

// 从正文提取 "数字+K/M/万 + views" 类表述并与证据视频播放量比对
function findMetricMismatch(bodyText, evidenceVideos) {
  const viewMentions = String(bodyText).matchAll(/([\d.]+\s*[kKmM万]|\d[\d,]{3,})\s*(views|播放)/gi);
  for (const mention of viewMentions) {
    const stated = normalizeNumber(mention[1]);
    if (stated === null) continue;
    const matched = evidenceVideos.some((v) => {
      const actual = Number(v.play_count);
      if (!actual) return false;
      return Math.abs(stated - actual) / actual <= 0.15; // 15% 容差
    });
    if (!matched) return mention[0];
  }
  return null;
}

function evaluateDraft({ customer, strategy, bodyText, citedVideoIds = [], evidenceVideos = [], snapshotDate, hasEmail }) {
  const reasons = [];
  const push = (code, message) => reasons.push({ code, message });

  if (!hasEmail) push('NO_EMAIL', '达人无邮箱地址');

  const knownIds = new Set(evidenceVideos.map((v) => v.youtube_video_id));
  const fabricated = citedVideoIds.filter((id) => !knownIds.has(id));
  if (fabricated.length) push('FABRICATED_EVIDENCE', `引用了快照中不存在的视频ID：${fabricated.join(', ')}`);
  if (!citedVideoIds.length) push('MISSING_VIDEO_REFERENCE', '正文未引用任何真实视频');

  const mismatch = findMetricMismatch(bodyText, evidenceVideos);
  if (mismatch) push('METRIC_MISMATCH', `正文数据「${mismatch}」与快照不符`);

  if (!countryMatchesMarket(customer?.country_region, strategy?.target_market)) {
    push('MARKET_MISMATCH', `达人国家 ${customer.country_region} 与目标市场 ${strategy.target_market} 不符`);
  }

  if (PRICE_COMMITMENT_PATTERN.test(bodyText || '')) {
    push('PRICE_COMMITMENT', '正文出现金额/fee/guarantee/contract 等承诺性表述');
  }

  if (snapshotDate) {
    const ageDays = (Date.now() - new Date(snapshotDate).getTime()) / 86400000;
    if (ageDays > STALE_DAYS) push('STALE_SNAPSHOT', `起草所用快照已 ${Math.floor(ageDays)} 天，超过 ${STALE_DAYS} 天阈值`);
  }

  if (!COMMISSION_PATTERN.test(bodyText || '') || !NO_FIXED_FEE_PATTERN.test(bodyText || '')) {
    push('MISSING_REQUIRED_TERM', '缺少佣金说明或"无固定费"表述');
  }

  const riskLevel = reasons.some((r) => RISK_CODES[r.code] === 'high') ? 'high'
    : reasons.length ? 'low' : 'none';
  return { riskLevel, riskReasons: reasons };
}

module.exports = { evaluateDraft, RISK_CODES };
```

注意：测试用例 `'clean draft gets risk none'` 中正文含 `"Mower test" with 100K views`（与证据 100000 匹配）、含 `5% commission` 和 `no fixed fee`，GB vs US 用例中 `target_market='US'` 与 `country_region='GB'` 不匹配。`countryMatchesMarket` 里 markets 为 `['US']`，c 为 `GB`，`c.includes(m)` false、`m.includes(c)` false → 不匹配，正确触发。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test services/emailRiskRules.test.js`
Expected: PASS 6 个用例。

- [ ] **Step 5: 实现 server/services/emailDrafter.js**

```js
// AI 邮件起草：快照检查 → 组装上下文 → AI 生成 → 风险校验 → 落库。
const { dbOperations } = require('../database');
const { callActiveAi } = require('./aiClient');
const { evaluateDraft } = require('./emailRiskRules');
const { runYoutubeIntakeSnapshot } = require('./youtubeIntakeSnapshot');

const PROMPT_VERSION = 'p1.0';
const SNAPSHOT_STALE_DAYS = 7;
const MAX_EVIDENCE_VIDEOS = 10;
const DRAFT_CONCURRENCY = 3;

const SYSTEM_PROMPT = 'You are an outreach copywriter for a brand marketing team. Write personalized first-touch emails to content creators. Return valid JSON only. No Markdown, no explanations.';

function buildUserPrompt({ customer, campaign, strategy, styleGuide, videos, feedback }) {
  const videoLines = videos.map((v) =>
    `- [${v.youtube_video_id}] "${v.title}" | ${Number(v.play_count || 0).toLocaleString()} views | published ${v.published_at ? new Date(v.published_at).toISOString().slice(0, 10) : 'unknown'}`
  ).join('\n');
  return `Write a first-touch outreach email (JSON: {"subject": "...", "body_text": "...", "cited_video_ids": ["..."], "personalization_note": "..."}).

Creator: ${customer.name} (${customer.country_region || 'unknown region'}), YouTube followers: ${customer.youtube_followers || 'unknown'}.
Recent real videos (ONLY these may be cited):
${videoLines || '(no videos available)'}

Campaign: ${campaign.name}. Product context: ${strategy?.product_context || campaign.product || ''}.
Writing rules (must follow strictly):
${styleGuide}
${feedback ? `\nHuman feedback on previous version (address it): ${feedback}` : ''}

Requirements: cite 1-2 videos from the list above by their exact titles; keep body under 120 English words; write in English.`;
}

async function ensureFreshSnapshot(customerId) {
  const customer = await dbOperations.get('SELECT * FROM customers WHERE id = ?', [customerId]);
  if (!customer) throw new Error('达人不存在');
  const snapshotAt = customer.youtube_snapshot_updated_at;
  const ageDays = snapshotAt ? (Date.now() - new Date(snapshotAt).getTime()) / 86400000 : Infinity;
  if (ageDays > SNAPSHOT_STALE_DAYS) {
    await runYoutubeIntakeSnapshot(customerId); // 失败会抛错，由调用方记为该达人失败
  }
  return dbOperations.get('SELECT * FROM customers WHERE id = ?', [customerId]);
}

async function loadEvidenceVideos(customerId) {
  return dbOperations.query(
    `SELECT youtube_video_id, title, play_count, published_at, snapshot_at
     FROM kol_youtube_snapshot_videos
     WHERE customer_id = ? AND included_in_aggregate = 1
     ORDER BY snapshot_at DESC, play_count DESC
     LIMIT ?`,
    [customerId, MAX_EVIDENCE_VIDEOS]
  );
}

// 完整起草一个达人；任何失败都返回 { ok:false, error }，不抛出。
async function draftForCustomer({ campaignId, customerId, kind = 'first_touch', sourceReplyId = null, feedback = null, draftId = null }) {
  try {
    const campaign = await dbOperations.get('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    if (!campaign) return { ok: false, customer_id: customerId, error: '项目不存在' };

    const customer = await ensureFreshSnapshot(customerId);
    const toAddress = customer.email;
    const strategy = await dbOperations.get(
      'SELECT * FROM kol_strategies WHERE campaign_id = ? ORDER BY updated_at DESC LIMIT 1',
      [campaignId]
    );
    const styleGuide = await dbOperations.get(
      "SELECT * FROM email_templates WHERE kind = 'style_guide' ORDER BY id LIMIT 1"
    );
    const videos = await loadEvidenceVideos(customerId);

    const userPrompt = buildUserPrompt({
      customer, campaign, strategy,
      styleGuide: styleGuide?.body_html || '',
      videos, feedback
    });
    const { parsed, model } = await callActiveAi(SYSTEM_PROMPT, userPrompt);

    const subject = String(parsed?.subject || '').trim();
    const bodyText = String(parsed?.body_text || '').trim();
    if (!subject || !bodyText) return { ok: false, customer_id: customerId, error: 'AI 未返回有效主题或正文' };

    const citedVideoIds = Array.isArray(parsed?.cited_video_ids) ? parsed.cited_video_ids.map(String) : [];
    const { riskLevel, riskReasons } = evaluateDraft({
      customer, strategy, bodyText, citedVideoIds,
      evidenceVideos: videos,
      snapshotDate: customer.youtube_snapshot_updated_at,
      hasEmail: Boolean(toAddress)
    });

    const evidence = JSON.stringify({
      snapshot_date: customer.youtube_snapshot_updated_at,
      videos: videos.map((v) => ({
        youtube_video_id: v.youtube_video_id, title: v.title,
        views: Number(v.play_count || 0),
        published_at: v.published_at ? new Date(v.published_at).toISOString().slice(0, 10) : null
      })),
      match_reason: parsed?.personalization_note || '',
      metrics: {
        followers: customer.youtube_followers || null,
        avg_views_30d: customer.avg_views_30d_snapshot ?? null,
        median_views_30d: customer.median_views_30d_snapshot ?? null,
        posts_30d: customer.posts_30d_snapshot ?? null
      }
    });

    let id = draftId;
    if (draftId) {
      // 重新生成：旧版本已在调用方存档
      await dbOperations.run(
        `UPDATE email_drafts SET subject=?, body_text=?, risk_level=?, risk_reasons=?, evidence=?,
         prompt_version=?, ai_model=?, generated_at=NOW(), updated_at=NOW() WHERE id=?`,
        [subject, bodyText, riskLevel, JSON.stringify(riskReasons), evidence, PROMPT_VERSION, model || null, draftId]
      );
    } else {
      const result = await dbOperations.run(
        `INSERT INTO email_drafts
         (campaign_id, customer_id, kind, subject, body_text, status, risk_level, risk_reasons, evidence,
          source_reply_id, template_id, prompt_version, ai_model, generated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
        [campaignId, customerId, kind, subject, bodyText, riskLevel, JSON.stringify(riskReasons), evidence,
         source_reply_id, styleGuide?.id || null, PROMPT_VERSION, model || null]
      );
      id = result.id;
      await dbOperations.run(
        `INSERT INTO email_draft_versions (draft_id, subject, body_text, source, feedback, created_at)
         VALUES (?, ?, ?, 'ai', ?, NOW())`,
        [id, subject, bodyText, feedback]
      );
    }
    return { ok: true, customer_id: customerId, draftId: id, riskLevel };
  } catch (error) {
    console.error(`起草失败 (customer ${customerId}):`, error.message);
    return { ok: false, customer_id: customerId, error: error.message };
  }
}

// 批量起草，并发 ≤ DRAFT_CONCURRENCY，单达人失败隔离
async function draftBatch(items) {
  const results = [];
  for (let i = 0; i < items.length; i += DRAFT_CONCURRENCY) {
    const chunk = items.slice(i, i + DRAFT_CONCURRENCY);
    results.push(...await Promise.all(chunk.map((item) => draftForCustomer(item))));
  }
  return results;
}

module.exports = { draftForCustomer, draftBatch, buildUserPrompt, PROMPT_VERSION };
```

（`customers.avg_views_30d_snapshot` 等快照列若 customers 表不存在则从 `campaign_kols` 快照列取——实现时先用 `describeTable`/现有列名核对，没有的指标置 null，不要导致起草失败。）

- [ ] **Step 6: 全量回归 + Commit**

Run: `cd server && npm test`
Expected: 全部通过。

```bash
git add server/services/emailRiskRules.js server/services/emailRiskRules.test.js server/services/emailDrafter.js
git commit -m "feat: add email risk rules engine and AI drafter"
```

---

### Task 6: drafts API——生成/审阅/批准/驳回/发送

**Files:**
- Modify: `server/routes/emails.js`（追加 drafts 路由）
- Test: `server/routes/emails.test.js`（追加用例）

**Interfaces:**
- Consumes: Task 5 `draftBatch/draftForCustomer`、Task 3 `mailer.sendMail/parseCc`、Task 4 `getEmailSettings`。
- Produces:
  - `POST /drafts/generate` `{ campaign_id, customer_ids[], kind? }` → `{ success, data: { results: [{ customer_id, ok, draftId?|error }] } }`
  - `GET /drafts?status&kind&risk_level&campaign_id` → `{ success, data: { drafts, counts: { pending_review, high_risk, approved } } }`（drafts 联表带 `kol_name`、`campaign_name`）
  - `GET /drafts/:id` → 单条含 evidence/risk_reasons 解析后 JSON
  - `PUT /drafts/:id`（仅 pending_review，存 human 版本）
  - `POST /drafts/:id/regenerate` `{ feedback? }`（存档 regenerate 版本后重跑 drafter）
  - `POST /drafts/:id/approve`、`POST /drafts/:id/reject` `{ reason }`
  - `POST /drafts/:id/send`（仅 approved，否则 409）
  - 辅助函数 `resolveCustomerEmail(customerId)`：customers.email。

- [ ] **Step 1: 追加失败测试**

在 `server/routes/emails.test.js` 末尾追加：

```js
test('POST /drafts/:id/send returns 409 when draft not approved', async () => {
  await withPatchedDb({
    get: async (sql) => {
      if (/email_drafts/.test(sql)) return { id: 9, status: 'pending_review', customer_id: 1, campaign_id: 1 };
      return null;
    }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/drafts/:id/send');
    const response = await callHandler(handler, { params: { id: 9 } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error, '草稿未批准，不能发送');
  });
});

test('POST /drafts/:id/send sends approved draft and writes back campaign_kols', async () => {
  const mailer = require('../services/mailer');
  const originalSendMail = mailer.sendMail;
  mailer.sendMail = async () => ({ messageId: 'm-1@smtp' });
  const statements = [];
  try {
    await withPatchedDb({
      get: async (sql) => {
        if (/FROM email_drafts/.test(sql)) {
          return { id: 10, status: 'approved', customer_id: 1, campaign_id: 2, subject: 'Hi', body_text: 'body', kol_name: undefined };
        }
        if (/FROM customers/.test(sql)) return { id: 1, name: 'Alice', email: 'alice@x.com' };
        if (/FROM campaign_kols/.test(sql)) return { id: 77 };
        if (/email_settings/.test(sql)) return { id: 1, username: 'u@x.com', default_cc: '' };
        return null;
      },
      run: async (sql, params) => { statements.push({ sql, params }); return { id: 5, changes: 1 }; }
    }, async () => {
      const handler = findHandler(require('./emails'), 'post', '/drafts/:id/send');
      const response = await callHandler(handler, { params: { id: 10 } });
      assert.equal(response.payload.success, true);
    });
  } finally {
    mailer.sendMail = originalSendMail;
  }
  const insertRecord = statements.find((s) => /INSERT INTO email_records/.test(s.sql));
  assert.ok(insertRecord, 'should insert email_records');
  assert.ok(insertRecord.params.includes('alice@x.com'));
  const updateKol = statements.find((s) => /UPDATE campaign_kols/.test(s.sql));
  assert.ok(updateKol, 'should update campaign_kols');
  assert.ok(updateKol.params.includes('contacted'));
  assert.match(updateKol.sql, /sync_status = 'sync_pending'/);
  const updateDraft = statements.find((s) => /UPDATE email_drafts/.test(s.sql));
  assert.match(updateDraft.sql, /status = 'sent'/);
});

test('PUT /drafts/:id only allows editing pending_review and stores human version', async () => {
  const statements = [];
  await withPatchedDb({
    get: async () => ({ id: 11, status: 'approved' }),
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'put', '/drafts/:id');
    const conflict = await callHandler(handler, { params: { id: 11 }, body: { subject: 's', body_text: 'b' } });
    assert.equal(conflict.statusCode, 409);
  });
});

test('GET /drafts returns counts', async () => {
  await withPatchedDb({
    query: async () => [
      { id: 1, status: 'pending_review', risk_level: 'high', kind: 'first_touch' },
      { id: 2, status: 'pending_review', risk_level: 'low', kind: 'first_touch' },
      { id: 3, status: 'approved', risk_level: 'none', kind: 'first_touch' }
    ]
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/drafts');
    const response = await callHandler(handler, { query: {} });
    assert.deepEqual(response.payload.data.counts, { pending_review: 2, high_risk: 1, approved: 1 });
  });
});

test('POST /drafts/generate calls drafter per customer and returns per-item results', async () => {
  const drafter = require('../services/emailDrafter');
  const original = drafter.draftBatch;
  const seen = [];
  drafter.draftBatch = async (items) => {
    seen.push(...items);
    return items.map((item) => ({ ok: item.customerId !== 2, customer_id: item.customerId, draftId: 100 + item.customerId, error: item.customerId === 2 ? 'AI 超时' : undefined }));
  };
  try {
    await withPatchedDb({}, async () => {
      const handler = findHandler(require('./emails'), 'post', '/drafts/generate');
      const response = await callHandler(handler, { body: { campaign_id: 1, customer_ids: [1, 2] } });
      assert.equal(response.payload.data.results.length, 2);
      assert.equal(response.payload.data.results[1].ok, false);
      assert.equal(response.payload.data.results[1].error, 'AI 超时');
    });
  } finally {
    drafter.draftBatch = original;
  }
  assert.deepEqual(seen.map((i) => i.customerId), [1, 2]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test routes/emails.test.js`
Expected: FAIL，`Missing POST /drafts/:id/send handler`。

- [ ] **Step 3: 在 routes/emails.js 的 module.exports 前追加**

顶部 require 区加：

```js
const emailDrafter = require('../services/emailDrafter');
const { runYoutubeIntakeSnapshot } = require('../services/youtubeIntakeSnapshot');
```

路由代码：

```js
// ---- 草稿（审批台） ----

const DRAFT_KINDS = new Set(['first_touch', 'follow_up', 'reply']);

function parseDraftJson(draft) {
  if (!draft) return draft;
  const parse = (v, fallback) => {
    if (!v) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
  };
  return { ...draft, risk_reasons: parse(draft.risk_reasons, []), evidence: parse(draft.evidence, null) };
}

async function resolveCustomerEmail(customerId) {
  const customer = await dbOperations.get('SELECT id, name, email FROM customers WHERE id = ?', [customerId]);
  return customer;
}

router.post('/drafts/generate', async (req, res) => {
  try {
    const { campaign_id, customer_ids, kind = 'first_touch' } = req.body || {};
    if (!campaign_id || !Array.isArray(customer_ids) || !customer_ids.length) {
      return res.status(400).json({ success: false, error: '请提供 campaign_id 和 customer_ids' });
    }
    if (!DRAFT_KINDS.has(kind)) return res.status(400).json({ success: false, error: '无效的草稿类型' });
    const results = await emailDrafter.draftBatch(
      customer_ids.map((customerId) => ({ campaignId: campaign_id, customerId, kind }))
    );
    res.json({ success: true, data: { results } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/drafts', async (req, res) => {
  try {
    const { status, kind, risk_level, campaign_id } = req.query || {};
    const conditions = [];
    const params = [];
    if (status) { conditions.push('d.status = ?'); params.push(status); }
    if (kind) { conditions.push('d.kind = ?'); params.push(kind); }
    if (risk_level) { conditions.push('d.risk_level = ?'); params.push(risk_level); }
    if (campaign_id) { conditions.push('d.campaign_id = ?'); params.push(campaign_id); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const drafts = (await dbOperations.query(
      `SELECT d.*, k.name AS kol_name, c.name AS campaign_name
       FROM email_drafts d
       LEFT JOIN customers k ON k.id = d.customer_id
       LEFT JOIN campaigns c ON c.id = d.campaign_id
       ${where}
       ORDER BY d.generated_at DESC
       LIMIT 200`,
      params
    )).map(parseDraftJson);
    const all = drafts; // 计数基于当前过滤结果（计数口径与列表一致）
    res.json({
      success: true,
      data: {
        drafts: all,
        counts: {
          pending_review: all.filter((d) => d.status === 'pending_review').length,
          high_risk: all.filter((d) => d.status === 'pending_review' && d.risk_level === 'high').length,
          approved: all.filter((d) => d.status === 'approved').length
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/drafts/:id', async (req, res) => {
  try {
    const draft = await dbOperations.get(
      `SELECT d.*, k.name AS kol_name, c.name AS campaign_name
       FROM email_drafts d
       LEFT JOIN customers k ON k.id = d.customer_id
       LEFT JOIN campaigns c ON c.id = d.campaign_id
       WHERE d.id = ?`,
      [req.params.id]
    );
    if (!draft) return res.status(404).json({ success: false, error: '草稿不存在' });
    res.json({ success: true, data: parseDraftJson(draft) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/drafts/:id', async (req, res) => {
  try {
    const draft = await dbOperations.get('SELECT * FROM email_drafts WHERE id = ?', [req.params.id]);
    if (!draft) return res.status(404).json({ success: false, error: '草稿不存在' });
    if (draft.status !== 'pending_review') {
      return res.status(409).json({ success: false, error: '仅待审阅状态可编辑' });
    }
    const { subject, body_text } = req.body || {};
    if (!subject || !body_text) return res.status(400).json({ success: false, error: '主题和正文为必填' });
    await dbOperations.run(
      `INSERT INTO email_draft_versions (draft_id, subject, body_text, source, created_at) VALUES (?, ?, ?, 'human', NOW())`,
      [draft.id, subject, body_text]
    );
    await dbOperations.run(
      'UPDATE email_drafts SET subject = ?, body_text = ?, updated_at = NOW() WHERE id = ?',
      [subject, body_text, draft.id]
    );
    res.json({ success: true, message: '已保存' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/drafts/:id/regenerate', async (req, res) => {
  try {
    const draft = await dbOperations.get('SELECT * FROM email_drafts WHERE id = ?', [req.params.id]);
    if (!draft) return res.status(404).json({ success: false, error: '草稿不存在' });
    if (draft.status !== 'pending_review') {
      return res.status(409).json({ success: false, error: '仅待审阅状态可重新生成' });
    }
    const feedback = (req.body?.feedback || '').trim() || null;
    await dbOperations.run(
      `INSERT INTO email_draft_versions (draft_id, subject, body_text, source, feedback, created_at)
       VALUES (?, ?, ?, 'regenerate', ?, NOW())`,
      [draft.id, draft.subject, draft.body_text, feedback]
    );
    const result = await emailDrafter.draftForCustomer({
      campaignId: draft.campaign_id, customerId: draft.customer_id,
      kind: draft.kind, sourceReplyId: draft.source_reply_id, feedback, draftId: draft.id
    });
    if (!result.ok) return res.status(500).json({ success: false, error: result.error });
    const updated = await dbOperations.get('SELECT * FROM email_drafts WHERE id = ?', [draft.id]);
    res.json({ success: true, data: parseDraftJson(updated) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/drafts/:id/approve', async (req, res) => {
  try {
    const draft = await dbOperations.get('SELECT * FROM email_drafts WHERE id = ?', [req.params.id]);
    if (!draft) return res.status(404).json({ success: false, error: '草稿不存在' });
    if (draft.status !== 'pending_review') {
      return res.status(409).json({ success: false, error: '仅待审阅状态可批准' });
    }
    await dbOperations.run(
      `UPDATE email_drafts SET status = 'approved', reviewed_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [draft.id]
    );
    res.json({ success: true, message: '已批准' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/drafts/:id/reject', async (req, res) => {
  try {
    const draft = await dbOperations.get('SELECT * FROM email_drafts WHERE id = ?', [req.params.id]);
    if (!draft) return res.status(404).json({ success: false, error: '草稿不存在' });
    if (draft.status !== 'pending_review') {
      return res.status(409).json({ success: false, error: '仅待审阅状态可驳回' });
    }
    await dbOperations.run(
      `UPDATE email_drafts SET status = 'rejected', reviewer_note = ?, reviewed_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [req.body?.reason || null, draft.id]
    );
    res.json({ success: true, message: '已驳回' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/drafts/:id/send', async (req, res) => {
  try {
    const draft = await dbOperations.get('SELECT * FROM email_drafts WHERE id = ?', [req.params.id]);
    if (!draft) return res.status(404).json({ success: false, error: '草稿不存在' });
    if (draft.status !== 'approved') {
      return res.status(409).json({ success: false, error: '草稿未批准，不能发送' });
    }

    const settings = await getEmailSettings();
    if (!settings) return res.status(400).json({ success: false, error: '请先配置邮箱设置' });

    const customer = await resolveCustomerEmail(draft.customer_id);
    if (!customer?.email) {
      await dbOperations.run(`UPDATE email_drafts SET status = 'send_failed', updated_at = NOW() WHERE id = ?`, [draft.id]);
      return res.status(400).json({ success: false, error: '达人无邮箱地址' });
    }

    try {
      const { messageId } = await mailer.sendMail({
        settings,
        to: customer.email,
        cc: mailer.parseCc(settings.default_cc),
        subject: draft.subject,
        text: draft.body_text
      });
      await dbOperations.run(
        `INSERT INTO email_records
         (draft_id, campaign_id, customer_id, kol_name, to_address, cc, subject, body_text, status, smtp_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', ?, NOW())`,
        [draft.id, draft.campaign_id, draft.customer_id, customer.name, customer.email,
         mailer.parseCc(settings.default_cc).join(',') || null, draft.subject, draft.body_text, messageId]
      );
      await dbOperations.run(`UPDATE email_drafts SET status = 'sent', updated_at = NOW() WHERE id = ?`, [draft.id]);
      // 回写 campaign_kols：按 campaign_id + customer_id 定位
      await dbOperations.run(
        `UPDATE campaign_kols SET outreach_status = 'contacted', last_outreach_at = NOW(),
         sync_status = 'sync_pending', updated_at = NOW()
         WHERE campaign_id = ? AND customer_id = ?`,
        [draft.campaign_id, draft.customer_id]
      );
      res.json({ success: true, message: '发送成功' });
    } catch (sendError) {
      await dbOperations.run(
        `INSERT INTO email_records
         (draft_id, campaign_id, customer_id, kol_name, to_address, subject, body_text, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, NOW())`,
        [draft.id, draft.campaign_id, draft.customer_id, customer.name, customer.email,
         draft.subject, draft.body_text, sendError.message]
      );
      await dbOperations.run(`UPDATE email_drafts SET status = 'send_failed', updated_at = NOW() WHERE id = ?`, [draft.id]);
      res.status(500).json({ success: false, error: `发送失败：${sendError.message}` });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

注意：测试 `POST /drafts/:id/send sends approved draft...` 中 `get` 的匹配顺序——`FROM email_drafts` 先匹配草稿查询，`FROM customers` 匹配 `resolveCustomerEmail`，`email_settings` 匹配 `getEmailSettings`，`FROM campaign_kols` 的分支可以删除（send 里不回查 campaign_kols，直接 UPDATE），实现时保持测试与代码一致即可。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd server && node --test routes/emails.test.js && npm test`
Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add server/routes/emails.js server/routes/emails.test.js
git commit -m "feat: add draft review/approve/send APIs with campaign_kols writeback"
```

---

### Task 7: 前端接真实 API（去 mock）

**Files:**
- Modify: `client/src/pages/emailApi.js`（删 mock 分支，`USE_MOCK = false` 或直接删除常量与全部 mock 代码）
- Modify: `client/src/pages/Emails.js`（删 USE_MOCK 提示条与 import）
- Modify: `client/src/pages/CampaignKols.js`（`generateDrafts` 传 customer_id 列表而非 campaign_kol id）

**Interfaces:**
- Consumes: Task 4/6 全部 API。
- Produces: 前端全部走真实接口；无行为新增。

- [ ] **Step 1: CampaignKols 传参修正**

`handleAiDraft` 中 `customer_ids` 目前传的是 `selectedRowKeys`（campaign_kols.id）。改为映射出 customer_id：

```js
      const selectedRows = rows.filter((r) => selectedRowKeys.includes(r.id));
      const customerIds = [...new Set(selectedRows.map((r) => r.customer_id).filter(Boolean))];
      if (!customerIds.length) {
        message.warning('选中的 KOL 缺少 customer_id，无法起草');
        return;
      }
      const result = await generateDrafts({
        campaign_id: selectedRows[0]?.campaign_id,
        customer_ids: customerIds,
        kind: 'first_touch'
      });
```

（列表查询返回的行应含 `customer_id`——实现时核对 `GET /api/campaign-kols` 返回字段，若没有则在该路由的 SELECT 中补上 `ck.customer_id`。）

- [ ] **Step 2: emailApi.js 去 mock**

删除 `USE_MOCK` 常量、全部 mock 数据与 mock 分支，每个函数只保留 axios 真实调用。`getDrafts` 返回 `res.data.data`（含 drafts 与 counts）。`Emails.js` 删除 `USE_MOCK` import 与顶部黄色提示条，`CampaignKols.js` 删除 `USE_MOCK` 引用（`if (!USE_MOCK) fetchRows()` 恢复为 `fetchRows()`）。

- [ ] **Step 3: 构建 + 现有前端测试**

Run: `cd client && npm run build`
Expected: `Compiled successfully.`

Run: `cd client && CI=true npx react-scripts test --watchAll=false`
Expected: 现有测试全部通过。

- [ ] **Step 4: 手动联调（真实配置）**

配置真实邮箱 → 测试 SMTP 通过 → KOL 合作页勾选达人 → AI 起草邮件 → 审批台审阅 → 批准 → 发送 → 发送记录出现 success。

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/emailApi.js client/src/pages/Emails.js client/src/pages/CampaignKols.js
git commit -m "feat: switch email center to real APIs"
```

---

### Task 8: 回复轮询 + AI 摘要 + replies API + 回复草稿

**Files:**
- Create: `server/services/emailReplyPoller.js`
- Modify: `server/routes/emails.js`（追加 replies 路由）
- Modify: `server/index.js`（启动轮询）
- Modify: `server/package.json`（新增 `imapflow`）
- Test: `server/routes/emails.test.js`（追加 confirm 用例）

**Interfaces:**
- Consumes: Task 2 `callActiveAi`、Task 1 表。
- Produces:
  - `startReplyPoller()`：index.js 启动后按 `poll_interval_minutes` 轮询；imapflow 拉 UNSEEN，按 message-id 幂等（`email_replies.message_id` 已存在则跳过并标已读）；按发件人匹配 `email_records.to_address`（取最近一条）→ 写 `email_replies` → 异步 AI 摘要。未匹配的邮件不标已读。
  - `GET /replies?confirm_status=`、`POST /replies/:id/confirm` `{ summary? }`（interested→`replied`，question/other→`negotiating`，rejected→`replied` 之外：rejected 也置 `replied` 并把 `campaign_kols.last_reply_summary` 写入、置 sync_pending；注：确认映射为 interested→replied、question→negotiating、rejected→replied、other→negotiating）、`POST /replies/:id/ignore`、`POST /replies/:id/retry-summary`、`POST /replies/:id/draft-reply`（调 `draftForCustomer` kind='reply' 入审批队列）。

- [ ] **Step 1: 安装依赖**

Run: `cd server && npm install imapflow`
Expected: package.json 新增 `imapflow`，无报错。

- [ ] **Step 2: 追加失败测试（confirm 回写）**

```js
test('POST /replies/:id/confirm maps intent and writes back campaign_kols', async () => {
  const statements = [];
  await withPatchedDb({
    get: async (sql) => {
      if (/FROM email_replies/.test(sql)) {
        return { id: 5, customer_id: 1, campaign_id: 2, ai_intent: 'question', ai_summary: '询问寄送', confirm_status: 'pending' };
      }
      if (/FROM campaign_kols/.test(sql)) return { id: 77, internal_notes: '旧备注' };
      return null;
    },
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/replies/:id/confirm');
    const response = await callHandler(handler, { params: { id: 5 }, body: {} });
    assert.equal(response.payload.success, true);
  });
  const updateKol = statements.find((s) => /UPDATE campaign_kols/.test(s.sql));
  assert.ok(updateKol.params.includes('negotiating'));
  assert.ok(updateKol.params.includes('询问寄送'));
  assert.match(updateKol.sql, /sync_status = 'sync_pending'/);
  const updateReply = statements.find((s) => /UPDATE email_replies/.test(s.sql));
  assert.match(updateReply.sql, /confirm_status = 'confirmed'/);
});
```

- [ ] **Step 3: 实现 replies 路由（追加到 routes/emails.js）**

```js
// ---- 回复 ----

const INTENT_TO_OUTREACH = {
  interested: 'replied',
  question: 'negotiating',
  rejected: 'replied',
  other: 'negotiating'
};

router.get('/replies', async (req, res) => {
  try {
    const { confirm_status } = req.query || {};
    const conditions = [];
    const params = [];
    if (confirm_status) { conditions.push('er.confirm_status = ?'); params.push(confirm_status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const replies = await dbOperations.query(
      `SELECT er.*, k.name AS kol_name, c.name AS campaign_name
       FROM email_replies er
       LEFT JOIN customers k ON k.id = er.customer_id
       LEFT JOIN campaigns c ON c.id = er.campaign_id
       ${where}
       ORDER BY er.received_at DESC
       LIMIT 200`,
      params
    );
    res.json({ success: true, data: replies });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/replies/:id/confirm', async (req, res) => {
  try {
    const reply = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [req.params.id]);
    if (!reply) return res.status(404).json({ success: false, error: '回复不存在' });
    const summary = (req.body?.summary || reply.ai_summary || '').trim();
    const outreachStatus = INTENT_TO_OUTREACH[reply.ai_intent] || 'negotiating';

    const kol = await dbOperations.get(
      'SELECT id, internal_notes FROM campaign_kols WHERE campaign_id = ? AND customer_id = ?',
      [reply.campaign_id, reply.customer_id]
    );
    if (kol) {
      const noteLine = `[邮件回复 ${new Date().toISOString().slice(0, 10)}] ${summary}`;
      const internalNotes = kol.internal_notes ? `${kol.internal_notes}\n${noteLine}` : noteLine;
      await dbOperations.run(
        `UPDATE campaign_kols SET outreach_status = ?, last_reply_summary = ?, internal_notes = ?,
         sync_status = 'sync_pending', updated_at = NOW() WHERE id = ?`,
        [outreachStatus, summary, internalNotes, kol.id]
      );
    }
    await dbOperations.run(
      `UPDATE email_replies SET confirm_status = 'confirmed', confirmed_summary = ?, updated_at = NOW() WHERE id = ?`,
      [summary, reply.id]
    );
    res.json({ success: true, message: '已确认', data: { outreach_status: outreachStatus } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/replies/:id/ignore', async (req, res) => {
  try {
    const reply = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [req.params.id]);
    if (!reply) return res.status(404).json({ success: false, error: '回复不存在' });
    await dbOperations.run(
      `UPDATE email_replies SET confirm_status = 'ignored', updated_at = NOW() WHERE id = ?`,
      [reply.id]
    );
    res.json({ success: true, message: '已忽略' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/replies/:id/retry-summary', async (req, res) => {
  try {
    const reply = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [req.params.id]);
    if (!reply) return res.status(404).json({ success: false, error: '回复不存在' });
    const { summarizeReply } = require('../services/emailReplyPoller');
    await summarizeReply(reply.id);
    const updated = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/replies/:id/draft-reply', async (req, res) => {
  try {
    const reply = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [req.params.id]);
    if (!reply) return res.status(404).json({ success: false, error: '回复不存在' });
    const result = await emailDrafter.draftForCustomer({
      campaignId: reply.campaign_id, customerId: reply.customer_id,
      kind: 'reply', sourceReplyId: reply.id,
      feedback: `对方回复内容：${(reply.body_text || '').slice(0, 2000)}`
    });
    if (!result.ok) return res.status(500).json({ success: false, error: result.error });
    res.json({ success: true, message: '回复草稿已生成，请到审批台审阅', data: { draftId: result.draftId } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

- [ ] **Step 4: 实现 server/services/emailReplyPoller.js**

```js
// IMAP 回复轮询（imapflow）：UNSEEN 邮件按发件人匹配发送记录，幂等去重，写 email_replies 后异步 AI 摘要。
const { ImapFlow } = require('imapflow');
const { dbOperations } = require('../database');
const { callActiveAi } = require('./aiClient');

const BODY_TEXT_LIMIT = 8000;
const VALID_INTENTS = new Set(['interested', 'question', 'rejected', 'other']);

const SUMMARY_SYSTEM = 'You are an assistant that summarizes creator business email replies for a marketing team. Return valid JSON only. No Markdown, no explanations.';
const SUMMARY_USER = `Summarize this email reply. Return JSON: {"summary": "2-3句中文摘要，含对方诉求、报价或问题", "intent": "interested|question|rejected|other"}
- interested: 明确表达合作意愿
- question: 有兴趣但在询问细节
- rejected: 明确拒绝
- other: 无法归类（如自动回复）

Subject: {{subject}}

Body:
{{body}}`;

async function summarizeReply(replyId) {
  try {
    const reply = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [replyId]);
    if (!reply) return;
    const userPrompt = SUMMARY_USER
      .replace('{{subject}}', reply.subject || '')
      .replace('{{body}}', reply.body_text || '');
    const { parsed } = await callActiveAi(SUMMARY_SYSTEM, userPrompt);
    const summary = String(parsed?.summary || '').trim();
    const intent = VALID_INTENTS.has(parsed?.intent) ? parsed.intent : 'other';
    if (!summary) throw new Error('AI 未返回有效摘要');
    await dbOperations.run(
      `UPDATE email_replies SET ai_summary = ?, ai_intent = ?, ai_status = 'success', updated_at = NOW() WHERE id = ?`,
      [summary, intent, replyId]
    );
  } catch (error) {
    console.error(`回复总结失败 (reply ${replyId}):`, error.message);
    await dbOperations.run(
      `UPDATE email_replies SET ai_status = 'failed', updated_at = NOW() WHERE id = ?`,
      [replyId]
    ).catch(() => {});
  }
}

function normalizeAddress(input) {
  const text = String(input || '').trim();
  const match = text.match(/<([^>]+)>/);
  return (match ? match[1] : text).trim().toLowerCase();
}

async function findOwnerByAddress(fromAddress) {
  const record = await dbOperations.get(
    'SELECT id, campaign_id, customer_id FROM email_records WHERE LOWER(to_address) = ? ORDER BY created_at DESC LIMIT 1',
    [fromAddress]
  );
  if (record) return record;
  const customer = await dbOperations.get('SELECT id FROM customers WHERE LOWER(email) = ? LIMIT 1', [fromAddress]);
  if (customer) {
    const kol = await dbOperations.get(
      'SELECT campaign_id, customer_id FROM campaign_kols WHERE customer_id = ? ORDER BY updated_at DESC LIMIT 1',
      [customer.id]
    );
    if (kol) return { id: null, campaign_id: kol.campaign_id, customer_id: kol.customer_id };
  }
  return null;
}

async function pollOnce() {
  const settings = await dbOperations.get('SELECT * FROM email_settings ORDER BY id LIMIT 1');
  if (!settings || !settings.imap_host || !settings.username || !settings.password) return;

  const client = new ImapFlow({
    host: settings.imap_host,
    port: Number(settings.imap_port) || 993,
    secure: settings.imap_secure === undefined ? true : Boolean(settings.imap_secure),
    auth: { user: settings.username, pass: settings.password },
    logger: false,
    socketTimeout: 30000
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ seen: false });
      for (const uid of uids || []) {
        const message = await client.fetchOne(uid, { envelope: true, bodyParts: ['text'], uid: true }, { uid: true });
        if (!message?.envelope) continue;
        const messageId = message.envelope.messageId || `uid-${uid}`;
        // 幂等：message_id 已存在则跳过（标已读）
        const existing = await dbOperations.get('SELECT id FROM email_replies WHERE message_id = ? LIMIT 1', [messageId]);
        if (existing) {
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }).catch(() => {});
          continue;
        }
        const fromAddress = normalizeAddress(message.envelope.from?.[0]?.address || '');
        const owner = await findOwnerByAddress(fromAddress);
        if (!owner) continue; // 未匹配：不标已读，不处理

        const bodyPart = message.bodyParts?.get('text');
        const bodyText = String(bodyPart?.toString() || '').slice(0, BODY_TEXT_LIMIT);
        const result = await dbOperations.run(
          `INSERT INTO email_replies
           (email_record_id, campaign_id, customer_id, from_address, message_id, subject, body_text, received_at,
            ai_status, confirm_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', NOW(), NOW())`,
          [owner.id, owner.campaign_id, owner.customer_id, fromAddress, messageId,
           message.envelope.subject || '', bodyText, message.envelope.date || new Date()]
        );
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }).catch(() => {});
        if (result.id) summarizeReply(result.id).catch(() => {});
      }
      await dbOperations.run('UPDATE email_settings SET last_poll_at = NOW() WHERE id = ?', [settings.id]);
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (error) {
    console.error('IMAP 轮询失败:', error.message);
    try { await client.logout(); } catch { /* ignore */ }
  }
}

let timer = null;

async function startReplyPoller() {
  if (timer) return;
  const settings = await dbOperations.get('SELECT * FROM email_settings ORDER BY id LIMIT 1');
  const minutes = Number(settings?.poll_interval_minutes ?? 5);
  if (!settings || !settings.imap_host || !minutes) {
    console.log('[email] 未配置 IMAP 或轮询间隔为 0，回复追踪未启动。');
    return;
  }
  console.log(`[email] 回复追踪已启动，每 ${minutes} 分钟轮询一次。`);
  timer = setInterval(() => pollOnce().catch((e) => console.error('IMAP 轮询异常:', e.message)), minutes * 60 * 1000);
  timer.unref();
}

module.exports = { startReplyPoller, pollOnce, summarizeReply, normalizeAddress };
```

- [ ] **Step 5: index.js 启动轮询**

`startServer()` 中 `await initDatabase();` 后加：

```js
const { startReplyPoller } = require('./services/emailReplyPoller');
// ...
    await startReplyPoller();
```

- [ ] **Step 6: 测试 + 回归 + Commit**

Run: `cd server && node --test routes/emails.test.js && npm test`
Expected: 全部通过。

Run: `cd server && node -e "require('./services/emailReplyPoller');console.log('poller loaded')"`
Expected: 输出 `poller loaded`。

```bash
git add server/services/emailReplyPoller.js server/routes/emails.js server/routes/emails.test.js server/index.js server/package.json server/package-lock.json
git commit -m "feat: add IMAP reply poller with AI summary and reply APIs"
```

---

### Task 9: 飞书回写——候选池"跟进记录"字段 + 外联状态

**Files:**
- Modify: `server/routes/sync.js`（`CANDIDATE_POOL_FIELD_SCHEMA` 加"跟进记录"，`candidatePoolKolFields` 写入，`campaignKolFields` 加外联状态映射）
- Test: `server/routes/sync.test.js`（追加用例）

**Interfaces:**
- Produces: 候选池新增"跟进记录"文本字段（自动补建）；`candidatePoolKolFields(row)` 输出 `'跟进记录': row.last_reply_summary`；`campaignKolFields(row)` 输出 `'外联状态'`（英文编码→中文标签映射：`not_contacted 待联系 / contacted 已联系 / replied 已回复 / negotiating 沟通中 / interested 有意向 / rejected 已拒绝`），候选池"状态"走现有 `CANDIDATE_POOL_STATUS_LABELS`（contacted→已联络、replied→已回复、negotiating→沟通中，已存在无需改）。

- [ ] **Step 1: 追加失败测试**

```js
test('candidatePoolKolFields includes follow-up note; campaignKolFields maps outreach status', () => {
  const { candidatePoolKolFields, campaignKolFields } = require('./sync');
  const pool = candidatePoolKolFields({ kol_name_snapshot: 'Alice', last_reply_summary: '询问寄送', cooperation_platforms: '[]' });
  assert.equal(pool['跟进记录'], '询问寄送');
  const tracking = campaignKolFields({ kol_name_snapshot: 'Alice', outreach_status: 'contacted', cooperation_platforms: '[]' });
  assert.equal(tracking['外联状态'], '已联系');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test routes/sync.test.js`
Expected: FAIL（`跟进记录` 为 undefined）。

- [ ] **Step 3: 修改 sync.js**

3a. `CANDIDATE_POOL_FIELD_SCHEMA` 末尾（`{ field_name: '跟进人', type: 1 }` 后）加：

```js
  { field_name: '跟进记录', type: 1 }
```

3b. `campaignKolFields` 中 `setTextField(fields, '预算审批状态', row.budget_approval_status);` 后加：

```js
  setTextField(fields, '外联状态', OUTREACH_STATUS_LABELS[row.outreach_status] || row.outreach_status);
```

3c. `candidatePoolKolFields` 返回前（删除 omit 字段逻辑之后）加：

```js
  setTextField(fields, '跟进记录', row.last_reply_summary);
```

3d. 文件顶部常量区加：

```js
const OUTREACH_STATUS_LABELS = {
  not_contacted: '待联系',
  contacted: '已联系',
  replied: '已回复',
  negotiating: '沟通中',
  interested: '有意向',
  rejected: '已拒绝'
};
```

3e. 若 `PROJECT_TRACKING_FIELD_SCHEMA` 需要"外联状态"字段则同步加一条（type 3，选项：待联系/已联系/已回复/沟通中/有意向/已拒绝）。

- [ ] **Step 4: 测试 + 回归 + Commit**

Run: `cd server && npm test`
Expected: 全部通过。

```bash
git add server/routes/sync.js server/routes/sync.test.js
git commit -m "feat: sync outreach status and follow-up note to feishu"
```

---

### Task 10: 跟进定时器 emailFollowUp.js

**Files:**
- Create: `server/services/emailFollowUp.js`
- Modify: `server/index.js`（启动定时器）

**Interfaces:**
- Consumes: Task 5 `draftForCustomer`、Task 1 表。
- Produces: `startFollowUpTimer()`：每 30 分钟扫描——`email_records` 发送成功、`campaign_kols.last_outreach_at` ≥48h、无 `confirm_status='confirmed'` 回复、`follow_up_count < 2` → 生成 follow_up 草稿（`follow_up_count+1`）；≥5 天不再起草（仅日志/后续 UI 标记，P1 不做候选池降级回写）。

- [ ] **Step 1: 实现 server/services/emailFollowUp.js**

```js
// 跟进自动化：48h 未回复生成跟进草稿进审批队列；5 天未回复不再自动起草。
const { dbOperations } = require('../database');
const { draftForCustomer } = require('./emailDrafter');

const FOLLOW_UP_AFTER_HOURS = 48;
const GIVE_UP_AFTER_DAYS = 5;
const MAX_FOLLOW_UPS = 2;
const SCAN_INTERVAL_MINUTES = 30;

async function scanOnce() {
  const candidates = await dbOperations.query(
    `SELECT er.campaign_id, er.customer_id, ck.follow_up_count, ck.last_outreach_at
     FROM email_records er
     JOIN campaign_kols ck ON ck.campaign_id = er.campaign_id AND ck.customer_id = er.customer_id
     WHERE er.status = 'success'
       AND ck.last_outreach_at IS NOT NULL
       AND ck.last_outreach_at <= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND ck.last_outreach_at > DATE_SUB(NOW(), INTERVAL ? DAY)
       AND COALESCE(ck.follow_up_count, 0) < ?
       AND NOT EXISTS (
         SELECT 1 FROM email_replies r
         WHERE r.campaign_id = er.campaign_id AND r.customer_id = er.customer_id
           AND r.confirm_status = 'confirmed'
       )
       AND NOT EXISTS (
         SELECT 1 FROM email_drafts d
         WHERE d.campaign_id = er.campaign_id AND d.customer_id = er.customer_id
           AND d.kind = 'follow_up' AND d.status IN ('pending_review', 'approved')
       )
     GROUP BY er.campaign_id, er.customer_id`,
    [FOLLOW_UP_AFTER_HOURS, GIVE_UP_AFTER_DAYS, MAX_FOLLOW_UPS]
  );

  for (const item of candidates) {
    const result = await draftForCustomer({
      campaignId: item.campaign_id,
      customerId: item.customer_id,
      kind: 'follow_up'
    });
    if (result.ok) {
      await dbOperations.run(
        'UPDATE campaign_kols SET follow_up_count = COALESCE(follow_up_count, 0) + 1, updated_at = NOW() WHERE campaign_id = ? AND customer_id = ?',
        [item.campaign_id, item.customer_id]
      );
      console.log(`[email] 已生成跟进草稿：customer ${item.customer_id}`);
    } else {
      console.error(`[email] 跟进草稿生成失败 (customer ${item.customer_id}):`, result.error);
    }
  }
  return candidates.length;
}

let timer = null;

function startFollowUpTimer() {
  if (timer) return;
  console.log(`[email] 跟进自动化已启动，每 ${SCAN_INTERVAL_MINUTES} 分钟扫描一次。`);
  timer = setInterval(() => scanOnce().catch((e) => console.error('[email] 跟进扫描异常:', e.message)), SCAN_INTERVAL_MINUTES * 60 * 1000);
  timer.unref();
}

module.exports = { startFollowUpTimer, scanOnce };
```

`index.js` 的 `startServer()` 在 `startReplyPoller()` 后加 `startFollowUpTimer()`（require 顶部加）。

- [ ] **Step 2: 验证 + 回归 + Commit**

Run: `cd server && node -e "require('./services/emailFollowUp');console.log('followup loaded')" && npm test`
Expected: 输出 `followup loaded`，测试全绿。

```bash
git add server/services/emailFollowUp.js server/index.js
git commit -m "feat: add follow-up automation timer"
```

---

## 端到端验收（全部完成后，对应 spec 验收标准）

- [ ] 真实 SMTP 配置测试通过；勾选 3 个达人 AI 起草，审批台出现 3 条 pending_review 草稿且各引用 ≥1 条真实视频，证据面板可核对。
- [ ] 高风险草稿原因可读；未批准调 send 返回 409；批准后发送成功，email_records 有记录，`outreach_status='contacted'`，飞书候选池"状态"同步为"已联络"。
- [ ] 编辑草稿存 human 版本；重新生成留 regenerate 版本。
- [ ] 测试邮箱回复后 `/replies` 出现回复且摘要/意向正确；确认后状态与飞书"跟进记录"同步。
- [ ] 48h 无回复自动生成 follow_up 草稿。
- [ ] `cd server && npm test` 全绿。
