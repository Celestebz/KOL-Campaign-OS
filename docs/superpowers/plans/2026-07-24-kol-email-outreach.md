# KOL 邮件外联与回复追踪实现计划

> **已废弃（2026-07-24）**：对应的设计已被《邮件审批台 P1 开发方案》取代，本计划不再执行。新计划将按审批台 spec 另行编写。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 kol-campaign-os 内新增邮件子系统：模板批量发信给 KOL、IMAP 追踪回复、AI 总结 + 人工确认、状态回写飞书。

**Architecture:** 移植 sendemail（github.com/Celestebz/sendemail）的 nodemailer 发送/模板逻辑为 `server/services/mailer.js` + `server/routes/emails.js`（裸 SQL 经 `dbOperations`，与仓库现有路由一致）；`server/services/replyTracker.js` 用 node-imap 轮询收件箱；AI 总结复用从 `routes/videos.js` 抽取的 `server/utils/llm.js`（server 直调大模型）；确认回复后更新 `campaign_kols` 并置 `sync_status='sync_pending'`，由现有 sync 管道回写飞书。

**Tech Stack:** Node.js + Express + Sequelize(MySQL) + Umzug 迁移 + nodemailer（已在依赖）+ node-imap + mailparser（新增）；前端 React + Ant Design + axios。

**Spec:** `docs/superpowers/specs/2026-07-24-kol-email-outreach-design.md`

## Global Constraints

- 服务端测试命令：`cd server && npm test`（node:test，`routes/*.test.js utils/*.test.js middleware/*.test.js`）。
- 路由测试惯例：monkey-patch `dbOperations.query/get/run`，用 `findHandler(router, method, path)` + `callHandler` 调 handler（参照 `server/routes/settings.test.js`），不连真实数据库。
- 所有新路由文件用 `dbOperations` 裸 SQL，不新增 Sequelize 模型。
- 表名、列名 snake_case；迁移文件名格式 `YYYYMMDDHHMMSS-<name>.js`。
- 回复确认后 `campaign_kols` 状态映射：`interested→interested`、`rejected→rejected`、`question/other→replied`；发送成功置 `contacted`。
- `outreach_status` 中文标签映射（飞书与前端共用语义）：`not_contacted 待联系 / contacted 已联系 / replied 已回复 / interested 有意向 / rejected 已拒绝`。
- 密钥类字段（邮箱授权码）GET 接口返回 `••••••••`，POST 收到 `••••••••` 时保留原值（参照 `server/routes/settings.js` 惯例）。
- 前端统一 `axios` 直调 `/api/...`， antd v5 组件，中文文案。
- 提交信息格式参照仓库历史（如 `feat: ...`、`docs: ...`）。

---

### Task 1: 数据库迁移——邮件四表 + prompt_templates.scene + campaign_kols.last_reply_summary

**Files:**
- Create: `server/migrations/20260724000001-add-email-outreach.js`

**Interfaces:**
- Produces: 表 `email_settings`（单行配置）、`email_templates`、`email_send_records`、`email_replies`；列 `prompt_templates.scene`（默认 `'video_analysis'`）；列 `campaign_kols.last_reply_summary`；seed 一条 `scene='email_reply_summary'` 的 prompt 模板。后续所有任务依赖这些表结构。

- [ ] **Step 1: 写迁移文件**

创建 `server/migrations/20260724000001-add-email-outreach.js`：

```js
// 邮件外联功能：邮箱配置、邮件模板、发送记录、回复追踪四张表；
// prompt_templates 增加 scene 列区分使用场景；campaign_kols 增加最近回复摘要列。
const DEFAULT_REPLY_SYSTEM_PROMPT = 'You are an assistant that summarizes KOL (influencer) business email replies for a marketing team. Return valid JSON only. Do not include Markdown, explanations, or chain-of-thought.';
const DEFAULT_REPLY_USER_PROMPT = `Summarize the following email reply from KOL {{kol_name}} regarding campaign {{campaign_name}}.
Reply subject: {{subject}}

Reply body:
{{body}}

Return JSON: {"summary": "2-3句中文摘要，包含对方的诉求、报价或问题", "intent": "interested|question|rejected|other"}
- interested: 明确表达合作意愿
- question: 有合作可能但在询问细节/报价
- rejected: 明确拒绝
- other: 无法归类（如自动回复）`;

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const tables = await queryInterface.showAllTables();
    const has = (name) => tables.includes(name);

    // 邮箱账户配置（单行，id 固定为 1）
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
        password: { type: DataTypes.TEXT, comment: '邮箱授权码' },
        sender_name: { type: DataTypes.STRING(255), comment: '发件人显示名' },
        default_cc: { type: DataTypes.TEXT, comment: '默认抄送，逗号/分号/换行分隔' },
        poll_interval_minutes: { type: DataTypes.INTEGER, defaultValue: 5, comment: 'IMAP轮询间隔分钟，0为关闭' },
        created_at: { type: DataTypes.DATE },
        updated_at: { type: DataTypes.DATE }
      });
    }

    // 邮件模板，正文支持 {{变量}} 占位符
    if (!has('email_templates')) {
      await queryInterface.createTable('email_templates', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: DataTypes.STRING(255), allowNull: false, comment: '模板名称' },
        subject: { type: DataTypes.STRING(500), allowNull: false, comment: '邮件主题，支持变量' },
        body_html: { type: DataTypes.TEXT, allowNull: false, comment: '邮件正文HTML，支持变量' },
        created_at: { type: DataTypes.DATE },
        updated_at: { type: DataTypes.DATE }
      });
    }

    // 每封邮件的发送记录，message_id 用于匹配回复
    if (!has('email_send_records')) {
      await queryInterface.createTable('email_send_records', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        campaign_kol_id: { type: DataTypes.INTEGER, allowNull: false, comment: '关联campaign_kols.id' },
        template_id: { type: DataTypes.INTEGER, comment: '使用的模板，自定义内容为空' },
        to_address: { type: DataTypes.STRING(255), allowNull: false, comment: '收件人' },
        cc: { type: DataTypes.TEXT, comment: '实际抄送' },
        subject: { type: DataTypes.STRING(500), comment: '实际发送主题' },
        body_html: { type: DataTypes.TEXT, comment: '实际发送正文' },
        status: { type: DataTypes.STRING(20), allowNull: false, comment: 'success/failed' },
        error: { type: DataTypes.TEXT, comment: '失败原因' },
        message_id: { type: DataTypes.STRING(500), comment: 'SMTP返回的Message-ID' },
        created_at: { type: DataTypes.DATE },
        updated_at: { type: DataTypes.DATE }
      });
      await queryInterface.addIndex('email_send_records', ['campaign_kol_id']);
      await queryInterface.addIndex('email_send_records', ['to_address']);
    }

    // KOL回复邮件及AI总结
    if (!has('email_replies')) {
      await queryInterface.createTable('email_replies', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        send_record_id: { type: DataTypes.INTEGER, comment: '匹配到的发送记录' },
        campaign_kol_id: { type: DataTypes.INTEGER, allowNull: false, comment: '关联campaign_kols.id' },
        from_address: { type: DataTypes.STRING(255), allowNull: false, comment: '发件人' },
        subject: { type: DataTypes.STRING(500), comment: '回复主题' },
        body_text: { type: DataTypes.TEXT, comment: '纯文本正文，截断8000字符' },
        received_at: { type: DataTypes.DATE, comment: '收信时间' },
        ai_summary: { type: DataTypes.TEXT, comment: 'AI摘要' },
        ai_intent: { type: DataTypes.STRING(20), comment: 'interested/question/rejected/other' },
        ai_status: { type: DataTypes.STRING(20), defaultValue: 'pending', comment: 'pending/success/failed' },
        confirm_status: { type: DataTypes.STRING(20), defaultValue: 'pending', comment: 'pending/confirmed/ignored' },
        created_at: { type: DataTypes.DATE },
        updated_at: { type: DataTypes.DATE }
      });
      await queryInterface.addIndex('email_replies', ['campaign_kol_id']);
      await queryInterface.addIndex('email_replies', ['confirm_status']);
    }

    // prompt_templates 增加场景列，现有行为默认视频分析
    const promptTemplates = await queryInterface.describeTable('prompt_templates');
    if (!promptTemplates.scene) {
      await queryInterface.addColumn('prompt_templates', 'scene', {
        type: DataTypes.STRING(50), defaultValue: 'video_analysis', comment: '使用场景：video_analysis/email_reply_summary'
      });
    }
    const [existing] = await queryInterface.sequelize.query(
      "SELECT id FROM prompt_templates WHERE scene = 'email_reply_summary' LIMIT 1"
    );
    if (!existing.length) {
      await queryInterface.sequelize.query(
        `INSERT INTO prompt_templates (name, platform, scene, system_prompt, user_prompt, is_default, created_at, updated_at)
         VALUES ('邮件回复总结', 'all', 'email_reply_summary', ?, ?, 0, NOW(), NOW())`,
        { replacements: [DEFAULT_REPLY_SYSTEM_PROMPT, DEFAULT_REPLY_USER_PROMPT] }
      );
    }

    // 飞书同步 SELECT ck.*，加列即可把最近回复摘要带入同步行
    const campaignKols = await queryInterface.describeTable('campaign_kols');
    if (!campaignKols.last_reply_summary) {
      await queryInterface.addColumn('campaign_kols', 'last_reply_summary', {
        type: DataTypes.TEXT, comment: '最近一封已确认回复的摘要'
      });
    }
  },

  async down(queryInterface) {
    const campaignKols = await queryInterface.describeTable('campaign_kols');
    if (campaignKols.last_reply_summary) await queryInterface.removeColumn('campaign_kols', 'last_reply_summary');
    await queryInterface.sequelize.query("DELETE FROM prompt_templates WHERE scene = 'email_reply_summary'");
    const promptTemplates = await queryInterface.describeTable('prompt_templates');
    if (promptTemplates.scene) await queryInterface.removeColumn('prompt_templates', 'scene');
    for (const table of ['email_replies', 'email_send_records', 'email_templates', 'email_settings']) {
      await queryInterface.dropTable(table, { cascade: true }).catch(() => {});
    }
  }
};
```

- [ ] **Step 2: 跑迁移验证**

Run: `cd server && npm run db:migrate`
Expected: 输出包含 `20260724000001-add-email-outreach.js ... migrated`（开发库自动执行），无报错。

- [ ] **Step 3: 验证表结构**

Run: `cd server && node -e "require('./database').initDatabase().then(async()=>{const {dbOperations}=require('./database');console.log(await dbOperations.query('SHOW TABLES'));console.log((await dbOperations.query(\"SELECT scene FROM prompt_templates WHERE scene='email_reply_summary'\")).length);process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: 表列表含 `email_settings/email_templates/email_send_records/email_replies`，输出 `1`（seed 模板存在）。

- [ ] **Step 4: 回归现有测试**

Run: `cd server && npm test`
Expected: 全部通过（迁移不应影响现有行为）。

- [ ] **Step 5: Commit**

```bash
git add server/migrations/20260724000001-add-email-outreach.js
git commit -m "feat: add email outreach tables migration"
```

---

### Task 2: 抽取 server/utils/llm.js（videos.js 改引用，行为不变）

**Files:**
- Create: `server/utils/llm.js`
- Modify: `server/routes/videos.js`（删除被搬走的定义，改为 import）
- Test: 复用现有 `server/routes/videos.test.js`（不新增）

**Interfaces:**
- Consumes: 无（纯搬迁）。
- Produces: `require('../utils/llm')` 导出 `{ parseJson, providerKey, legacyKeysFor, getSelection, getSetting, hasProviderConfig, fetchJson, parseAiContentRobust, callOpenAiCompatible, callMiniMax, callActiveAi, PROVIDER_LABELS, DEFAULT_SELECTION, SYSTEM_SELECTION_KEY }`。其中 `callActiveAi(systemPrompt, userPrompt)` 为新增便捷函数，返回 `{ parsed, raw, model }`。Task 7 的 `replySummarizer` 依赖 `callActiveAi`。

- [ ] **Step 1: 先跑一遍现有测试确认基线**

Run: `cd server && npm test`
Expected: 全部通过。

- [ ] **Step 2: 创建 server/utils/llm.js**

把 `server/routes/videos.js` 中以下定义**原样搬入** `server/utils/llm.js`（不要改逻辑）：

- 常量：`SYSTEM_SELECTION_KEY`、`DEFAULT_SELECTION`、`PROVIDER_LABELS`（videos.js 第 11-40 行）
- 函数：`parseJson`（89-97）、`providerKey`（291-293）、`mergeSelection`（295-305）、`getSelection`（307-310）、`getSetting`（312-322）、`legacyKeysFor`（324-331）、`hasProviderConfig`（333-335）、`fetchJson`（337-356）、`parseAiContentRobust`（738-761）、`firstDefined`（在 videos.js 中定位 `function firstDefined`，一并搬入）、`callOpenAiCompatible`（791-821）、`callMiniMax`（823-857 左右，整个函数）

文件头部为：

```js
// 从 routes/videos.js 抽取的共享 LLM 调用与配置读取工具。
// 供 videos.js（视频 AI 分析）与邮件回复总结等场景共用。
const { dbOperations } = require('../database');
```

文件尾部在搬入的代码之后新增：

```js
// 按当前激活的 AI provider 直调大模型，返回 { parsed, raw, model }。
async function callActiveAi(systemPrompt, userPrompt) {
  const selection = await getSelection();
  const provider = selection.aiModels.active || 'deepseek';

  if (provider === 'custom_http_api') {
    throw new Error('Custom HTTP API 当前仅预留，暂不可用于分析');
  }

  const setting = await getSetting(providerKey('ai', provider), legacyKeysFor('ai', provider));

  if (provider === 'minimax') {
    return callMiniMax(setting, systemPrompt, userPrompt);
  }

  if (['openai', 'deepseek', 'custom_openai_compatible'].includes(provider)) {
    return callOpenAiCompatible(setting, provider, systemPrompt, userPrompt);
  }

  throw new Error(`${PROVIDER_LABELS[provider] || provider} 当前暂不可用于 AI 分析`);
}

module.exports = {
  SYSTEM_SELECTION_KEY,
  DEFAULT_SELECTION,
  PROVIDER_LABELS,
  parseJson,
  providerKey,
  mergeSelection,
  getSelection,
  getSetting,
  legacyKeysFor,
  hasProviderConfig,
  fetchJson,
  firstDefined,
  parseAiContentRobust,
  callOpenAiCompatible,
  callMiniMax,
  callActiveAi
};
```

- [ ] **Step 3: 修改 videos.js 改为引用**

在 `server/routes/videos.js` 顶部 `const { normalizeVideoUrl } = ...` 之后加：

```js
const {
  SYSTEM_SELECTION_KEY,
  DEFAULT_SELECTION,
  PROVIDER_LABELS,
  parseJson,
  providerKey,
  mergeSelection,
  getSelection,
  getSetting,
  legacyKeysFor,
  hasProviderConfig,
  fetchJson,
  firstDefined,
  parseAiContentRobust,
  callOpenAiCompatible,
  callMiniMax,
  callActiveAi
} = require('../utils/llm');
```

然后**删除** videos.js 中 Step 2 列出的全部本地定义（常量与函数）。注意：

- `fetchFirstJson` 留在 videos.js（它是平台抓取专用），它内部调用的 `fetchJson` 现在来自 import。
- `mergeSelection`/`getSelection` 若 videos.js 内未直接使用但 `DEFAULT_SELECTION` 被平台选择逻辑使用（第 564 行附近），保留 import 即可。
- `runAiAnalysis` 函数体重写为（保持返回结构不变）：

```js
async function runAiAnalysis(video, snapshot, comments) {
  const promptTemplate = await dbOperations.get('SELECT * FROM prompt_templates WHERE is_default = 1 ORDER BY id LIMIT 1');
  const campaignVideo = await dbOperations.get(
    'SELECT campaign_id FROM campaign_videos WHERE video_source_id = ? ORDER BY created_at DESC LIMIT 1',
    [video.id]
  );
  const campaign = campaignVideo
    ? await dbOperations.get('SELECT * FROM campaigns WHERE id = ?', [campaignVideo.campaign_id])
    : await dbOperations.get('SELECT * FROM campaigns WHERE id = 1');
  const finalPrompt = buildAnalysisPromptV2(video, snapshot, comments, promptTemplate, campaign);
  const systemPrompt = promptTemplate?.system_prompt || 'You are a KOL marketing analyst. Return valid JSON only. Do not include Markdown or chain-of-thought.';

  const result = await callActiveAi(systemPrompt, finalPrompt);
  return { ...result, finalPrompt };
}
```

- [ ] **Step 4: 跑测试验证行为不变**

Run: `cd server && npm test`
Expected: 全部通过（重点是 `videos.test.js` 无回归）。

- [ ] **Step 5: 启动 smoke 验证**

Run: `cd server && node -e "const llm=require('./utils/llm');console.log(Object.keys(llm).join(','))"`
Expected: 输出包含 `callActiveAi,parseAiContentRobust` 等全部导出名，无报错。

- [ ] **Step 6: Commit**

```bash
git add server/utils/llm.js server/routes/videos.js
git commit -m "refactor: extract shared LLM helpers into server/utils/llm.js"
```

---

### Task 3: server/utils/emailVariables.js——变量替换与收件人解析

**Files:**
- Create: `server/utils/emailVariables.js`
- Test: `server/utils/emailVariables.test.js`

**Interfaces:**
- Consumes: Task 1 的表结构（变量数据来源行）。
- Produces:
  - `renderTemplate(text, vars)` — 把 `{{key}}` 替换为 `vars[key]`（缺失替换为空串），通用，也供 replySummarizer 渲染 prompt。
  - `resolveRecipient(row)` — 返回 `row.contact_email_override || row.email_snapshot || row.customer_email || null`。
  - `buildVariables(row, senderName)` — 返回变量对象 `{ kol_name, contact_name, campaign_name, product_names, cooperation_type, sender_name }`。
  - `COOPERATION_TYPE_LABELS = { paid_product: '付费＋产品', product_exchange: '产品置换', other: '其他' }`。
  - `VARIABLE_LABELS` — 前端展示用的变量中文说明。

- [ ] **Step 1: 写失败测试**

创建 `server/utils/emailVariables.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderTemplate,
  resolveRecipient,
  buildVariables,
  COOPERATION_TYPE_LABELS
} = require('./emailVariables');

test('renderTemplate replaces all known variables and blanks unknown ones', () => {
  const out = renderTemplate('Hi {{kol_name}}, 合作 {{campaign_name}}! {{unknown}}', {
    kol_name: 'Alice',
    campaign_name: 'Launch'
  });
  assert.equal(out, 'Hi Alice, 合作 Launch! ');
});

test('renderTemplate handles null/empty input', () => {
  assert.equal(renderTemplate(null, { a: '1' }), '');
  assert.equal(renderTemplate('{{a}}{{a}}', { a: 'x' }), 'xx');
});

test('resolveRecipient priority: override > snapshot > customer email', () => {
  assert.equal(resolveRecipient({
    contact_email_override: 'a@x.com', email_snapshot: 'b@x.com', customer_email: 'c@x.com'
  }), 'a@x.com');
  assert.equal(resolveRecipient({ email_snapshot: 'b@x.com', customer_email: 'c@x.com' }), 'b@x.com');
  assert.equal(resolveRecipient({ customer_email: 'c@x.com' }), 'c@x.com');
  assert.equal(resolveRecipient({}), null);
});

test('buildVariables falls back across snapshot and customer fields', () => {
  const vars = buildVariables({
    kol_name_snapshot: '', customer_name: 'Alice',
    contact_name_override: 'Bob', contact_name_snapshot: 'Bobby', customer_contact_name: 'Robert',
    campaign_name: 'Launch', product_names: 'Pedal A、Pedal B',
    cooperation_type: 'product_exchange'
  }, 'MOOER Team');
  assert.deepEqual(vars, {
    kol_name: 'Alice',
    contact_name: 'Bob',
    campaign_name: 'Launch',
    product_names: 'Pedal A、Pedal B',
    cooperation_type: COOPERATION_TYPE_LABELS.product_exchange,
    sender_name: 'MOOER Team'
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test utils/emailVariables.test.js`
Expected: FAIL，`Cannot find module './emailVariables'`。

- [ ] **Step 3: 实现 server/utils/emailVariables.js**

```js
// 邮件模板变量替换与收件人解析。
// 支持变量：{{kol_name}} {{contact_name}} {{campaign_name}} {{product_names}} {{cooperation_type}} {{sender_name}}

const COOPERATION_TYPE_LABELS = {
  paid_product: '付费＋产品',
  product_exchange: '产品置换',
  other: '其他'
};

const VARIABLE_LABELS = {
  kol_name: 'KOL名称',
  contact_name: '联系人姓名',
  campaign_name: '项目名称',
  product_names: '合作产品',
  cooperation_type: '合作方式',
  sender_name: '发件人署名'
};

function renderTemplate(text, vars = {}) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key) => (
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : ''
  ));
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value);
  }
  return null;
}

// row 来自 routes/emails.js 的 KOL 查询（含 customer/campaign 联表字段）
function resolveRecipient(row) {
  return firstNonEmpty(row.contact_email_override, row.email_snapshot, row.customer_email);
}

function buildVariables(row, senderName = '') {
  return {
    kol_name: firstNonEmpty(row.kol_name_snapshot, row.customer_name) || '',
    contact_name: firstNonEmpty(row.contact_name_override, row.contact_name_snapshot, row.customer_contact_name) || '',
    campaign_name: firstNonEmpty(row.campaign_name) || '',
    product_names: firstNonEmpty(row.product_names) || '',
    cooperation_type: COOPERATION_TYPE_LABELS[row.cooperation_type] || row.cooperation_type || '',
    sender_name: senderName || ''
  };
}

module.exports = {
  COOPERATION_TYPE_LABELS,
  VARIABLE_LABELS,
  renderTemplate,
  resolveRecipient,
  buildVariables
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test utils/emailVariables.test.js`
Expected: PASS 4 个用例。

- [ ] **Step 5: Commit**

```bash
git add server/utils/emailVariables.js server/utils/emailVariables.test.js
git commit -m "feat: add email template variable utilities"
```

---

### Task 4: server/services/mailer.js——SMTP 发送封装（移植 sendemail）

**Files:**
- Create: `server/services/mailer.js`
- Test: `server/services/mailer.test.js`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `createTransporter(settings)` — nodemailer transporter，`secure` 由 `smtp_secure` 决定（sendemail 的 465 判定由 settings 显式化）。
  - `parseCc(text)` — 返回去空白后的地址数组。
  - `normalizeParagraphs(html)` — 给无 style 的 `<p>` 注入内联间距。
  - `convertImagesToCid(html, baseDir)` — 返回 `{ html, attachments }`，把 `/uploads/...` 本地图片转 CID 附件。
  - `verifySettings(settings)` — `transporter.verify()`，配置错误时抛出中文文案错误。
  - `sendBatch({ settings, items })` — items 为 `[{ campaignKolId, to, cc, subject, html }]`，逐封发送并写 `email_send_records`，返回 `{ total, success, failed, errors: [{ campaignKolId, to, error }] }`。**单封失败不中断**。Task 5 的发送路由依赖它。

- [ ] **Step 1: 写失败测试**

创建 `server/services/mailer.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { parseCc, normalizeParagraphs, convertImagesToCid } = require('./mailer');

test('parseCc splits by comma/semicolon/newline incl. Chinese separators', () => {
  assert.deepEqual(parseCc('a@x.com, b@x.com;c@x.com\nd@x.com，e@x.com； f@x.com '), [
    'a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com'
  ]);
  assert.deepEqual(parseCc(''), []);
  assert.deepEqual(parseCc(null), []);
});

test('normalizeParagraphs injects inline style only into style-less <p>', () => {
  assert.equal(
    normalizeParagraphs('<p>hi</p><p style="color:red">yo</p>'),
    '<p style="margin:8px 0; line-height:1.6;">hi</p><p style="color:red">yo</p>'
  );
  assert.equal(normalizeParagraphs(null), null);
});

test('convertImagesToCid converts existing /uploads images, leaves others intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailer-'));
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploads', 'pic.png'), 'fake');

  const { html, attachments } = convertImagesToCid(
    '<img src="/uploads/pic.png"><img src="https://x.com/a.png"><img src="/uploads/missing.png">',
    dir
  );
  assert.match(html, /cid:image0@kol-campaign-os/);
  assert.match(html, /https:\/\/x\.com\/a\.png/);
  assert.match(html, /\/uploads\/missing\.png/);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].filename, 'pic.png');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test services/mailer.test.js`
Expected: FAIL，`Cannot find module './mailer'`。

- [ ] **Step 3: 实现 server/services/mailer.js**

```js
// SMTP 邮件发送封装。核心逻辑移植自 sendemail 项目（routes/email.js），
// SQL 改写为 dbOperations，secure 改为读取配置而非硬编码 465 判定。
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { dbOperations } = require('../database');

const getDataDir = () => {
  if (process.pkg) return path.join(path.dirname(process.execPath), 'data');
  return path.join(__dirname, '..', '..', 'data');
};

function createTransporter(settings) {
  return nodemailer.createTransport({
    host: settings.smtp_host,
    port: Number(settings.smtp_port) || 465,
    secure: settings.smtp_secure === undefined ? true : Boolean(settings.smtp_secure),
    auth: {
      user: settings.username,
      pass: settings.password
    }
  });
}

function parseCc(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .split(/[,;\n，；]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 统一段落间距：为无样式的 <p> 注入内联样式，避免不同客户端默认 margin 不一致
function normalizeParagraphs(html) {
  if (!html || typeof html !== 'string') return html;
  return html.replace(/<p(?![^>]*style=)([^>]*)>/g, '<p style="margin:8px 0; line-height:1.6;"$1>');
}

// 将 HTML 中的本地图片（/uploads/...）转换为 CID 附件
function convertImagesToCid(htmlContent, baseDir = getDataDir()) {
  const imgRegex = /<img[^>]+src="([^">]+)"/g;
  let match;
  let result = htmlContent;
  const attachments = [];
  let cidCounter = 0;

  while ((match = imgRegex.exec(htmlContent)) !== null) {
    const imgPath = match[1];
    if (!imgPath.startsWith('/uploads/')) continue;

    try {
      const fullPath = path.join(baseDir, imgPath.replace(/^\//, ''));
      if (fs.existsSync(fullPath)) {
        const cid = `image${cidCounter++}@kol-campaign-os`;
        attachments.push({ filename: path.basename(fullPath), path: fullPath, cid });
        result = result.replace(imgPath, `cid:${cid}`);
      }
    } catch (error) {
      console.error('转换图片失败:', imgPath, error.message);
    }
  }

  return { html: result, attachments };
}

async function verifySettings(settings) {
  if (!settings || !settings.smtp_host || !settings.username) {
    throw new Error('请先配置邮箱设置');
  }
  const transporter = createTransporter(settings);
  try {
    await transporter.verify();
  } catch (error) {
    throw new Error(`SMTP 连接失败：${error.message}`);
  }
}

// items: [{ campaignKolId, templateId, to, cc, subject, html }]
// 逐封发送并写 email_send_records；单封失败不中断批次。
async function sendBatch({ settings, items }) {
  const transporter = createTransporter(settings);
  const from = settings.sender_name
    ? `"${settings.sender_name}" <${settings.username}>`
    : settings.username;

  const results = { total: items.length, success: 0, failed: 0, errors: [] };

  for (const item of items) {
    const normalized = normalizeParagraphs(item.html);
    const { html, attachments } = convertImagesToCid(normalized);
    try {
      const info = await transporter.sendMail({
        from,
        to: item.to,
        cc: item.cc && item.cc.length ? item.cc.join(',') : undefined,
        subject: item.subject,
        html,
        attachments
      });
      await dbOperations.run(
        `INSERT INTO email_send_records
         (campaign_kol_id, template_id, to_address, cc, subject, body_html, status, message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'success', ?, NOW(), NOW())`,
        [item.campaignKolId, item.templateId || null, item.to,
         (item.cc || []).join(',') || null, item.subject, html, info.messageId || null]
      );
      await dbOperations.run(
        `UPDATE campaign_kols SET outreach_status = 'contacted', sync_status = 'sync_pending', updated_at = NOW() WHERE id = ?`,
        [item.campaignKolId]
      );
      results.success++;
    } catch (error) {
      console.error('邮件发送失败', { to: item.to, error: error.message });
      await dbOperations.run(
        `INSERT INTO email_send_records
         (campaign_kol_id, template_id, to_address, cc, subject, body_html, status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, NOW(), NOW())`,
        [item.campaignKolId, item.templateId || null, item.to,
         (item.cc || []).join(',') || null, item.subject || '（无主题）', html || '（无内容）', error.message]
      );
      results.failed++;
      results.errors.push({ campaignKolId: item.campaignKolId, to: item.to, error: error.message });
    }
  }

  return results;
}

module.exports = {
  getDataDir,
  createTransporter,
  parseCc,
  normalizeParagraphs,
  convertImagesToCid,
  verifySettings,
  sendBatch
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test services/mailer.test.js`
Expected: PASS 3 个用例。

- [ ] **Step 5: Commit**

```bash
git add server/services/mailer.js server/services/mailer.test.js
git commit -m "feat: add SMTP mailer service ported from sendemail"
```

---

### Task 5: routes/emails.js——邮箱配置 + 模板 CRUD + 预览

**Files:**
- Create: `server/routes/emails.js`
- Test: `server/routes/emails.test.js`
- Modify: `server/index.js`（注册路由，本任务先挂路由，Task 8 再挂轮询）

**Interfaces:**
- Consumes: Task 1 表结构、Task 3 `renderTemplate/resolveRecipient/buildVariables/VARIABLE_LABELS`、Task 4 `verifySettings/parseCc`。
- Produces: 挂载在 `/api/emails` 的路由（本任务实现 `GET/POST /settings`、`POST /settings/test`、`GET/POST/PUT/DELETE /templates`、`GET /templates/variables`、`POST /preview`；发送与回复相关接口在 Task 6、Task 9 追加到同一文件）。响应统一 `{ success, data?, error? }`。

- [ ] **Step 1: 写失败测试**

创建 `server/routes/emails.test.js`（测试辅助函数 `findHandler`/`callHandler` 复制自 `settings.test.js` 惯例）：

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
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(originals)) dbOperations[key] = originals[key];
    });
}

test('GET /settings masks stored password', async () => {
  await withPatchedDb({
    get: async () => ({ id: 1, smtp_host: 'smtp.ex.com', username: 'u@ex.com', password: 'secret', default_cc: '' })
  }, async () => {
    const handler = findHandler(require('./emails'), 'get', '/settings');
    const response = await callHandler(handler);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.data.password, '••••••••');
  });
});

test('POST /settings keeps stored password when masked value submitted', async () => {
  const statements = [];
  await withPatchedDb({
    get: async () => ({ id: 1, password: 'real-secret' }),
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/settings');
    const response = await callHandler(handler, {
      body: { smtp_host: 'smtp.ex.com', username: 'u@ex.com', password: '••••••••' }
    });
    assert.equal(response.payload.success, true);
    const update = statements.find((s) => /UPDATE email_settings/.test(s.sql));
    assert.ok(update, 'should update existing row');
    assert.ok(update.params.includes('real-secret'), 'must keep original password');
  });
});

test('POST /preview renders template variables for a campaign kol', async () => {
  await withPatchedDb({
    get: async (sql) => {
      if (/email_templates/.test(sql)) return { id: 2, subject: 'Hi {{kol_name}}', body_html: '<p>{{campaign_name}} x {{product_names}}</p>' };
      if (/campaign_kols/.test(sql)) {
        return {
          id: 7, kol_name_snapshot: 'Alice', contact_name_override: null, contact_name_snapshot: null,
          contact_email_override: null, email_snapshot: 'alice@x.com', cooperation_type: 'paid_product',
          customer_name: 'Alice C', customer_contact_name: 'Alice', customer_email: 'alice-c@x.com',
          campaign_name: 'Launch', product_names: 'Pedal A'
        };
      }
      if (/email_settings/.test(sql)) return { id: 1, sender_name: 'Team' };
      return null;
    }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/preview');
    const response = await callHandler(handler, { body: { campaignKolId: 7, templateId: 2 } });
    assert.equal(response.payload.data.subject, 'Hi Alice');
    assert.equal(response.payload.data.body_html, '<p>Launch x Pedal A</p>');
    assert.equal(response.payload.data.to, 'alice@x.com');
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
const {
  renderTemplate,
  resolveRecipient,
  buildVariables,
  VARIABLE_LABELS
} = require('../utils/emailVariables');
const mailer = require('../services/mailer');

const router = express.Router();

const MASKED_SECRET = '••••••••';

async function getEmailSettings() {
  return dbOperations.get('SELECT * FROM email_settings ORDER BY id LIMIT 1');
}

// KOL 发送上下文查询：campaign_kols + customer + campaign + 合作产品名
const KOL_CONTEXT_SELECT = `
  SELECT ck.id, ck.kol_name_snapshot, ck.contact_name_override, ck.contact_name_snapshot,
         ck.contact_email_override, ck.email_snapshot, ck.cooperation_type,
         k.name AS customer_name, k.contact_name AS customer_contact_name, k.email AS customer_email,
         c.name AS campaign_name,
         (SELECT GROUP_CONCAT(p.name SEPARATOR '、')
          FROM campaign_kol_products ckp
          JOIN campaign_products cp ON cp.id = ckp.campaign_product_id
          JOIN products p ON p.id = cp.product_id
          WHERE ckp.campaign_kol_id = ck.id) AS product_names
  FROM campaign_kols ck
  JOIN customers k ON k.id = ck.customer_id
  JOIN campaigns c ON c.id = ck.campaign_id
`;

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

router.post('/settings', async (req, res) => {
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

// ---- 模板 CRUD ----

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
  if (!body.name || !body.subject || !body.body_html) {
    return '模板名称、主题和内容为必填字段';
  }
  return null;
}

router.post('/templates', async (req, res) => {
  try {
    const invalid = validateTemplateBody(req.body || {});
    if (invalid) return res.status(400).json({ success: false, error: invalid });
    const { name, subject, body_html } = req.body;
    const result = await dbOperations.run(
      'INSERT INTO email_templates (name, subject, body_html, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
      [name, subject, body_html]
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
    const { name, subject, body_html } = req.body;
    await dbOperations.run(
      'UPDATE email_templates SET name=?, subject=?, body_html=?, updated_at=NOW() WHERE id=?',
      [name, subject, body_html, req.params.id]
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

// ---- 预览 ----

router.post('/preview', async (req, res) => {
  try {
    const { campaignKolId, templateId, customSubject, customContent } = req.body || {};
    const row = await dbOperations.get(`${KOL_CONTEXT_SELECT} WHERE ck.id = ?`, [campaignKolId]);
    if (!row) return res.status(404).json({ success: false, error: 'KOL 合作记录不存在' });

    let subject = customSubject || '';
    let bodyHtml = customContent || '';
    if (templateId) {
      const template = await dbOperations.get('SELECT * FROM email_templates WHERE id = ?', [templateId]);
      if (!template) return res.status(404).json({ success: false, error: '模板不存在' });
      subject = customSubject || template.subject;
      bodyHtml = customContent || template.body_html;
    }

    const settings = await getEmailSettings();
    const vars = buildVariables(row, settings?.sender_name || '');
    res.json({
      success: true,
      data: {
        to: resolveRecipient(row),
        subject: renderTemplate(subject, vars),
        body_html: renderTemplate(bodyHtml, vars)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
```

- [ ] **Step 4: 注册路由**

修改 `server/index.js`：在 `const finderSubtaskRoutes = ...` 一行后加 `const emailRoutes = require('./routes/emails');`，在 `app.use('/api/agent', agentRoutes);` 后加 `app.use('/api/emails', emailRoutes);`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && node --test routes/emails.test.js`
Expected: PASS 3 个用例。

- [ ] **Step 6: 全量回归 + Commit**

Run: `cd server && npm test`
Expected: 全部通过。

```bash
git add server/routes/emails.js server/routes/emails.test.js server/index.js
git commit -m "feat: add email settings, template CRUD and preview APIs"
```

---

### Task 6: routes/emails.js——批量发送 + 发送记录

**Files:**
- Modify: `server/routes/emails.js`（在 `module.exports` 前追加两个路由）
- Test: `server/routes/emails.test.js`（追加用例）

**Interfaces:**
- Consumes: Task 4 `mailer.sendBatch/parseCc`、Task 5 的 `getEmailSettings/KOL_CONTEXT_SELECT`。
- Produces: `POST /api/emails/send`，请求体 `{ campaignKolIds: number[], templateId?: number, customSubject?: string, customContent?: string, overrideCc?: string, perItem?: { [campaignKolId]: { subject?, body_html? } } }`，返回 `{ success, data: { total, success, failed, errors } }`；`GET /api/emails/records?campaign_kol_id=&status=` 返回 `{ success, data: { records, total } }`。

- [ ] **Step 1: 追加失败测试**

在 `server/routes/emails.test.js` 末尾追加：

```js
test('POST /send renders per-kol content and reports per-item results', async () => {
  const mailer = require('../services/mailer');
  const originalSendBatch = mailer.sendBatch;
  const sentItems = [];
  mailer.sendBatch = async ({ items }) => {
    sentItems.push(...items);
    return { total: items.length, success: items.length, failed: 0, errors: [] };
  };

  const kolRows = {
    7: { id: 7, kol_name_snapshot: 'Alice', contact_email_override: 'alice@x.com', cooperation_type: 'paid_product', campaign_name: 'Launch', product_names: null },
    8: { id: 8, kol_name_snapshot: 'Bob', contact_email_override: null, email_snapshot: null, customer_email: null, cooperation_type: 'paid_product', campaign_name: 'Launch', product_names: null }
  };

  await withPatchedDb({
    get: async (sql, params) => {
      if (/email_settings/.test(sql)) return { id: 1, username: 'u@ex.com', default_cc: 'boss@ex.com' };
      if (/email_templates/.test(sql)) return { id: 2, subject: 'Hi {{kol_name}}', body_html: '<p>hello</p>' };
      return null;
    },
    query: async (sql, params) => params.map((id) => kolRows[id]).filter(Boolean)
  }, async () => {
    try {
      const handler = findHandler(require('./emails'), 'post', '/send');
      const response = await callHandler(handler, { body: { campaignKolIds: [7, 8], templateId: 2 } });
      assert.equal(response.payload.data.success, 1);
      assert.equal(response.payload.data.failed, 1);
    } finally {
      mailer.sendBatch = originalSendBatch;
    }
  });

  assert.equal(sentItems.length, 1, '无地址的 KOL 不应进入发送列表');
  assert.equal(sentItems[0].to, 'alice@x.com');
  assert.equal(sentItems[0].subject, 'Hi Alice');
  assert.deepEqual(sentItems[0].cc, ['boss@ex.com']);
});

test('POST /send rejects when email settings missing', async () => {
  await withPatchedDb({ get: async () => null }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/send');
    const response = await callHandler(handler, { body: { campaignKolIds: [7], templateId: 2 } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.error, '请先配置邮箱设置');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test routes/emails.test.js`
Expected: FAIL，`Missing POST /send handler`。

- [ ] **Step 3: 在 routes/emails.js 的 module.exports 前追加**

```js
// ---- 发送 ----

router.post('/send', async (req, res) => {
  try {
    const { campaignKolIds, templateId, customSubject, customContent, overrideCc, perItem = {} } = req.body || {};
    if (!Array.isArray(campaignKolIds) || campaignKolIds.length === 0) {
      return res.status(400).json({ success: false, error: '请选择要发送的 KOL' });
    }

    const settings = await getEmailSettings();
    if (!settings) return res.status(400).json({ success: false, error: '请先配置邮箱设置' });

    let template = null;
    if (templateId) {
      template = await dbOperations.get('SELECT * FROM email_templates WHERE id = ?', [templateId]);
      if (!template) return res.status(400).json({ success: false, error: '模板不存在' });
    }
    if (!template && !customSubject && !customContent) {
      return res.status(400).json({ success: false, error: '请选择模板或填写自定义内容' });
    }

    const placeholders = campaignKolIds.map(() => '?').join(',');
    const rows = await dbOperations.query(`${KOL_CONTEXT_SELECT} WHERE ck.id IN (${placeholders})`, campaignKolIds);

    const ccList = mailer.parseCc(overrideCc).length ? mailer.parseCc(overrideCc) : mailer.parseCc(settings.default_cc);

    const items = [];
    const skipped = [];
    for (const row of rows) {
      const to = resolveRecipient(row);
      if (!to) {
        skipped.push({ campaignKolId: row.id, to: null, error: '无收件人地址' });
        continue;
      }
      const vars = buildVariables(row, settings.sender_name || '');
      const override = perItem[row.id] || {};
      items.push({
        campaignKolId: row.id,
        templateId: template?.id || null,
        to,
        cc: ccList,
        subject: renderTemplate(override.subject || customSubject || template.subject, vars),
        html: renderTemplate(override.body_html || customContent || template.body_html, vars)
      });
    }

    const results = await mailer.sendBatch({ settings, items });
    results.total = rows.length;
    results.failed += skipped.length;
    results.errors = [...skipped, ...results.errors];

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---- 发送记录 ----

router.get('/records', async (req, res) => {
  try {
    const { campaign_kol_id, status } = req.query || {};
    const conditions = [];
    const params = [];
    if (campaign_kol_id) { conditions.push('sr.campaign_kol_id = ?'); params.push(campaign_kol_id); }
    if (status) { conditions.push('sr.status = ?'); params.push(status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRow = await dbOperations.get(`SELECT COUNT(*) AS total FROM email_send_records sr ${where}`, params);
    const records = await dbOperations.query(
      `SELECT sr.*, ck.kol_name_snapshot AS kol_name, t.name AS template_name
       FROM email_send_records sr
       LEFT JOIN campaign_kols ck ON ck.id = sr.campaign_kol_id
       LEFT JOIN email_templates t ON t.id = sr.template_id
       ${where}
       ORDER BY sr.created_at DESC
       LIMIT 200`,
      params
    );
    res.json({ success: true, data: { records, total: totalRow?.total || 0 } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test routes/emails.test.js`
Expected: PASS 全部 5 个用例。

- [ ] **Step 5: 全量回归 + Commit**

Run: `cd server && npm test`
Expected: 全部通过。

```bash
git add server/routes/emails.js server/routes/emails.test.js
git commit -m "feat: add batch email sending and send records APIs"
```

---

### Task 7: 回复匹配 + AI 总结（replyMatching.js + replySummarizer.js + 依赖安装）

**Files:**
- Create: `server/utils/replyMatching.js`
- Test: `server/utils/replyMatching.test.js`
- Create: `server/services/replySummarizer.js`
- Modify: `server/package.json`（新增依赖 `node-imap`、`mailparser`）

**Interfaces:**
- Consumes: Task 2 `callActiveAi`、Task 3 `renderTemplate`、Task 1 表结构。
- Produces:
  - `normalizeEmailAddress(input)` — 从 `"Name <a@b.com>"` 提取小写地址。
  - `extractMessageIds({ inReplyTo, references })` — 返回规范化 Message-ID 数组（去 `<>`、去空白）。
  - `findMatchingSendRecord({ fromAddress, messageIds }, sendRecords)` — 先按 `message_id` 精确匹配，再按 `to_address` 兜底取最近一条；返回记录或 `null`。Task 8 的 replyTracker 依赖这三个函数。
  - `summarizeReply(replyId)` — 调 LLM 生成摘要并回写 `email_replies.ai_summary/ai_intent/ai_status`；失败置 `ai_status='failed'` 不抛出。Task 8、Task 9 依赖。

- [ ] **Step 1: 安装新依赖**

Run: `cd server && npm install node-imap mailparser`
Expected: `server/package.json` dependencies 新增 `node-imap` 与 `mailparser`，安装无报错。

- [ ] **Step 2: 写失败测试**

创建 `server/utils/replyMatching.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeEmailAddress,
  extractMessageIds,
  findMatchingSendRecord
} = require('./replyMatching');

test('normalizeEmailAddress extracts lowercase address from display format', () => {
  assert.equal(normalizeEmailAddress('Alice <Alice@X.com>'), 'alice@x.com');
  assert.equal(normalizeEmailAddress('Bob@Y.com '), 'bob@y.com');
  assert.equal(normalizeEmailAddress(''), '');
});

test('extractMessageIds normalizes angle brackets from in-reply-to and references', () => {
  assert.deepEqual(
    extractMessageIds({ inReplyTo: '<m1@smtp>', references: '<m0@smtp> <m1@smtp>' }),
    ['m1@smtp', 'm0@smtp']
  );
  assert.deepEqual(extractMessageIds({}), []);
});

test('findMatchingSendRecord prefers In-Reply-To match over address fallback', () => {
  const records = [
    { id: 1, to_address: 'alice@x.com', message_id: 'm1@smtp', created_at: '2026-07-20' },
    { id: 2, to_address: 'alice@x.com', message_id: 'm2@smtp', created_at: '2026-07-22' }
  ];
  const byThread = findMatchingSendRecord({ fromAddress: 'alice@x.com', messageIds: ['m1@smtp'] }, records);
  assert.equal(byThread.id, 1);
  const byAddress = findMatchingSendRecord({ fromAddress: 'Alice <alice@x.com>', messageIds: [] }, records);
  assert.equal(byAddress.id, 2, '兜底取该地址最近一条发送记录');
  assert.equal(findMatchingSendRecord({ fromAddress: 'nobody@x.com', messageIds: [] }, records), null);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd server && node --test utils/replyMatching.test.js`
Expected: FAIL，`Cannot find module './replyMatching'`。

- [ ] **Step 4: 实现 server/utils/replyMatching.js**

```js
// 回复邮件与发送记录的匹配工具（纯函数，便于测试）。

function normalizeEmailAddress(input) {
  const text = String(input || '').trim();
  const match = text.match(/<([^>]+)>/);
  return (match ? match[1] : text).trim().toLowerCase();
}

function normalizeMessageId(id) {
  return String(id || '').trim().replace(/^<|>$/g, '').trim();
}

function extractMessageIds({ inReplyTo, references } = {}) {
  const ids = [];
  const push = (value) => {
    const normalized = normalizeMessageId(value);
    if (normalized && !ids.includes(normalized)) ids.push(normalized);
  };
  push(inReplyTo);
  // References 是空格分隔的 id 列表
  for (const token of String(references || '').split(/\s+/)) push(token);
  return ids;
}

// 匹配规则：1) In-Reply-To/References 命中 message_id；2) 发件人地址兜底取最近一条。
// sendRecords 为该发件人相关的全部发送记录（含 message_id、to_address、created_at）。
function findMatchingSendRecord({ fromAddress, messageIds = [] }, sendRecords = []) {
  for (const id of messageIds) {
    const hit = sendRecords.find((record) => record.message_id && record.message_id === id);
    if (hit) return hit;
  }
  const address = normalizeEmailAddress(fromAddress);
  if (!address) return null;
  const candidates = sendRecords
    .filter((record) => normalizeEmailAddress(record.to_address) === address)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return candidates[0] || null;
}

module.exports = {
  normalizeEmailAddress,
  extractMessageIds,
  findMatchingSendRecord
};
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && node --test utils/replyMatching.test.js`
Expected: PASS 3 个用例。

- [ ] **Step 6: 实现 server/services/replySummarizer.js**

```js
// 回复邮件 AI 总结：复用 utils/llm.js 的激活 provider 直调大模型。
const { dbOperations } = require('../database');
const { callActiveAi } = require('../utils/llm');
const { renderTemplate } = require('../utils/emailVariables');

const VALID_INTENTS = new Set(['interested', 'question', 'rejected', 'other']);

const FALLBACK_SYSTEM_PROMPT = 'You are an assistant that summarizes KOL (influencer) business email replies for a marketing team. Return valid JSON only. Do not include Markdown, explanations, or chain-of-thought.';
const FALLBACK_USER_PROMPT = `Summarize the following email reply from KOL {{kol_name}} regarding campaign {{campaign_name}}.
Reply subject: {{subject}}

Reply body:
{{body}}

Return JSON: {"summary": "2-3句中文摘要，包含对方的诉求、报价或问题", "intent": "interested|question|rejected|other"}`;

// 生成摘要并回写 email_replies。任何失败都记录为 ai_status='failed'，不向外抛出。
async function summarizeReply(replyId) {
  try {
    const reply = await dbOperations.get(
      `SELECT er.*, ck.kol_name_snapshot, c.name AS campaign_name
       FROM email_replies er
       JOIN campaign_kols ck ON ck.id = er.campaign_kol_id
       JOIN campaigns c ON c.id = ck.campaign_id
       WHERE er.id = ?`,
      [replyId]
    );
    if (!reply) return;

    const template = await dbOperations.get(
      "SELECT * FROM prompt_templates WHERE scene = 'email_reply_summary' ORDER BY id LIMIT 1"
    );
    const vars = {
      kol_name: reply.kol_name_snapshot || '',
      campaign_name: reply.campaign_name || '',
      subject: reply.subject || '',
      body: reply.body_text || ''
    };
    const systemPrompt = template?.system_prompt || FALLBACK_SYSTEM_PROMPT;
    const userPrompt = renderTemplate(template?.user_prompt || FALLBACK_USER_PROMPT, vars);

    const { parsed } = await callActiveAi(systemPrompt, userPrompt);
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

module.exports = { summarizeReply, VALID_INTENTS };
```

- [ ] **Step 7: 全量回归 + Commit**

Run: `cd server && npm test`
Expected: 全部通过。

```bash
git add server/utils/replyMatching.js server/utils/replyMatching.test.js server/services/replySummarizer.js server/package.json server/package-lock.json
git commit -m "feat: add reply matching utils and AI reply summarizer"
```

---

### Task 8: services/replyTracker.js——IMAP 轮询 + index.js 挂载

**Files:**
- Create: `server/services/replyTracker.js`
- Modify: `server/index.js`（启动轮询）

**Interfaces:**
- Consumes: Task 7 的 `normalizeEmailAddress/extractMessageIds/findMatchingSendRecord/summarizeReply`、Task 1 表结构。
- Produces: `startReplyTracker()` — 从 `server/index.js` 的 `startServer()` 在 `initDatabase()` 之后调用；按 `email_settings.poll_interval_minutes` 轮询（默认 5 分钟，0 或未配置则不启动）。新回复写入 `email_replies`（`ai_status='pending'`）后异步触发 `summarizeReply`。前端无直接接口。

- [ ] **Step 1: 实现 server/services/replyTracker.js**

IMAP 交互无法按仓库惯例做离线单测，匹配逻辑已在 Task 7 覆盖；本文件保持薄、只做 IMAP 编排。

```js
// IMAP 收件箱轮询：把 KOL 回复匹配到发送记录并写入 email_replies。
// 匹配不上的邮件不标记已读（避免吞掉人工邮件）。
const Imap = require('node-imap');
const { simpleParser } = require('mailparser');
const { dbOperations } = require('../database');
const {
  normalizeEmailAddress,
  extractMessageIds,
  findMatchingSendRecord
} = require('../utils/replyMatching');
const { summarizeReply } = require('./replySummarizer');

const BODY_TEXT_LIMIT = 8000;

function connect(settings) {
  return new Imap({
    user: settings.username,
    password: settings.password,
    host: settings.imap_host,
    port: Number(settings.imap_port) || 993,
    tls: settings.imap_secure === undefined ? true : Boolean(settings.imap_secure),
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 15000,
    authTimeout: 15000
  });
}

function openInbox(imap) {
  return new Promise((resolve, reject) => {
    imap.openBox('INBOX', false, (err, box) => (err ? reject(err) : resolve(box)));
  });
}

function searchUnseen(imap) {
  return new Promise((resolve, reject) => {
    imap.search(['UNSEEN'], (err, uids) => (err ? reject(err) : resolve(uids || [])));
  });
}

function fetchMessages(imap, uids) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const fetcher = imap.fetch(uids, { bodies: '' });
    fetcher.on('message', (msg) => {
      const entry = {};
      msg.on('body', (stream) => {
        simpleParser(stream).then((parsed) => { entry.parsed = parsed; }).catch(() => {});
      });
      msg.once('attributes', (attrs) => { entry.uid = attrs.uid; });
      msg.once('end', () => messages.push(entry));
    });
    fetcher.once('error', reject);
    fetcher.once('end', () => resolve(messages));
  });
}

function markSeen(imap, uid) {
  return new Promise((resolve) => {
    imap.addFlags(uid, ['\\Seen'], () => resolve());
  });
}

async function loadCandidateRecords() {
  return dbOperations.query(
    'SELECT id, campaign_kol_id, to_address, message_id, created_at FROM email_send_records ORDER BY created_at DESC'
  );
}

async function handleMessage(imap, entry, sendRecords) {
  const parsed = entry.parsed;
  if (!parsed || !entry.uid) return;

  const fromAddress = normalizeEmailAddress(parsed.from?.text || '');
  const messageIds = extractMessageIds({
    inReplyTo: parsed.inReplyTo,
    references: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references
  });
  const record = findMatchingSendRecord({ fromAddress, messageIds }, sendRecords);
  if (!record) return; // 未匹配：不标已读，不处理

  const bodyText = String(parsed.text || '').slice(0, BODY_TEXT_LIMIT);
  const result = await dbOperations.run(
    `INSERT INTO email_replies
     (send_record_id, campaign_kol_id, from_address, subject, body_text, received_at, ai_status, confirm_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', NOW(), NOW())`,
    [record.id, record.campaign_kol_id, fromAddress, parsed.subject || '', bodyText, parsed.date || new Date()]
  );
  await markSeen(imap, entry.uid);
  // 异步总结，不阻塞轮询
  if (result.id) summarizeReply(result.id).catch(() => {});
}

async function pollOnce() {
  const settings = await dbOperations.get('SELECT * FROM email_settings ORDER BY id LIMIT 1');
  if (!settings || !settings.imap_host || !settings.username || !settings.password) return;

  const imap = connect(settings);
  await new Promise((resolve) => {
    imap.once('ready', async () => {
      try {
        await openInbox(imap);
        const uids = await searchUnseen(imap);
        if (uids.length) {
          const messages = await fetchMessages(imap, uids);
          const sendRecords = await loadCandidateRecords();
          for (const entry of messages) {
            await handleMessage(imap, entry, sendRecords).catch((error) => {
              console.error('处理回复邮件失败:', error.message);
            });
          }
        }
      } catch (error) {
        console.error('IMAP 轮询失败:', error.message);
      } finally {
        imap.end();
      }
      resolve();
    });
    imap.once('error', (error) => {
      console.error('IMAP 连接失败:', error.message);
      resolve();
    });
    imap.connect();
  });
}

let timer = null;

async function tick() {
  try {
    await pollOnce();
  } catch (error) {
    console.error('IMAP 轮询异常:', error.message);
  }
}

async function startReplyTracker() {
  if (timer) return;
  const settings = await dbOperations.get('SELECT * FROM email_settings ORDER BY id LIMIT 1');
  const minutes = Number(settings?.poll_interval_minutes ?? 5);
  if (!settings || !settings.imap_host || !minutes) {
    console.log('[email] 未配置 IMAP 或轮询间隔为 0，回复追踪未启动。');
    return;
  }
  console.log(`[email] 回复追踪已启动，每 ${minutes} 分钟轮询一次。`);
  timer = setInterval(tick, minutes * 60 * 1000);
  timer.unref();
}

module.exports = { startReplyTracker, pollOnce };
```

- [ ] **Step 2: 在 index.js 启动轮询**

修改 `server/index.js` 的 `startServer()`，在 `await initDatabase();` 之后、`app.listen` 之前加：

```js
const { startReplyTracker } = require('./services/replyTracker');
// ...
    await initDatabase();
    await startReplyTracker();
```

（`require` 放文件顶部其他 require 处，保持风格一致。）

- [ ] **Step 3: 语法与启动验证**

Run: `cd server && node -e "require('./services/replyTracker'); console.log('replyTracker loaded')"`
Expected: 输出 `replyTracker loaded`。

Run: `cd server && npm test`
Expected: 全部通过（新文件不影响现有测试）。

- [ ] **Step 4: Commit**

```bash
git add server/services/replyTracker.js server/index.js
git commit -m "feat: add IMAP reply tracker service"
```

---

### Task 9: 回复查询/确认/忽略/重试接口 + campaign_kols 回写

**Files:**
- Modify: `server/routes/emails.js`（追加四个路由）
- Test: `server/routes/emails.test.js`（追加用例）

**Interfaces:**
- Consumes: Task 7 `summarizeReply/VALID_INTENTS`。
- Produces:
  - `GET /api/emails/replies?confirm_status=pending` → `{ success, data: replies[] }`（联表带 `kol_name`、`campaign_name`）。
  - `POST /api/emails/replies/:id/confirm`，body `{ summary?: string }` → 更新 `campaign_kols.outreach_status`（映射：`interested→interested`、`rejected→rejected`、`question/other→replied`）、`last_reply_summary`、追加 `internal_notes`、`sync_status='sync_pending'`，回复置 `confirm_status='confirmed'`。
  - `POST /api/emails/replies/:id/ignore` → 仅置 `confirm_status='ignored'`。
  - `POST /api/emails/replies/:id/retry-summary` → 重跑 `summarizeReply` 并返回更新后的回复。
  - 导出 `OUTREACH_STATUS_LABELS = { not_contacted: '待联系', contacted: '已联系', replied: '已回复', interested: '有意向', rejected: '已拒绝' }`（Task 10 飞书映射与前端共用此语义）。

- [ ] **Step 1: 追加失败测试**

在 `server/routes/emails.test.js` 末尾追加：

```js
test('POST /replies/:id/confirm maps intent to outreach status and marks sync pending', async () => {
  const statements = [];
  await withPatchedDb({
    get: async (sql) => {
      if (/email_replies/.test(sql)) {
        return { id: 5, campaign_kol_id: 7, ai_intent: 'interested', ai_summary: '愿意合作，报价 $500', confirm_status: 'pending' };
      }
      if (/campaign_kols/.test(sql)) return { id: 7, internal_notes: '旧备注' };
      return null;
    },
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/replies/:id/confirm');
    const response = await callHandler(handler, { params: { id: 5 }, body: {} });
    assert.equal(response.payload.success, true);
  });

  const updateKol = statements.find((s) => /UPDATE campaign_kols/.test(s.sql));
  assert.ok(updateKol, 'should update campaign_kols');
  assert.ok(updateKol.params.includes('interested'));
  assert.match(updateKol.sql, /sync_status = 'sync_pending'/);
  assert.ok(updateKol.params.includes('愿意合作，报价 $500'));
  assert.ok(updateKol.params.some((p) => typeof p === 'string' && p.includes('旧备注') && p.includes('愿意合作')));
  const updateReply = statements.find((s) => /UPDATE email_replies/.test(s.sql));
  assert.match(updateReply.sql, /confirm_status = 'confirmed'/);
});

test('POST /replies/:id/confirm honors edited summary and maps rejected intent', async () => {
  const statements = [];
  await withPatchedDb({
    get: async (sql) => {
      if (/email_replies/.test(sql)) {
        return { id: 6, campaign_kol_id: 8, ai_intent: 'rejected', ai_summary: 'AI 摘要', confirm_status: 'pending' };
      }
      if (/campaign_kols/.test(sql)) return { id: 8, internal_notes: null };
      return null;
    },
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/replies/:id/confirm');
    await callHandler(handler, { params: { id: 6 }, body: { summary: '人工修改：暂不考虑' } });
  });
  const updateKol = statements.find((s) => /UPDATE campaign_kols/.test(s.sql));
  assert.ok(updateKol.params.includes('rejected'));
  assert.ok(updateKol.params.includes('人工修改：暂不考虑'));
});

test('POST /replies/:id/ignore only flips confirm_status', async () => {
  const statements = [];
  await withPatchedDb({
    get: async () => ({ id: 9, campaign_kol_id: 7, confirm_status: 'pending' }),
    run: async (sql, params) => { statements.push({ sql, params }); return { id: 0, changes: 1 }; }
  }, async () => {
    const handler = findHandler(require('./emails'), 'post', '/replies/:id/ignore');
    const response = await callHandler(handler, { params: { id: 9 } });
    assert.equal(response.payload.success, true);
  });
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /UPDATE email_replies/);
  assert.match(statements[0].sql, /confirm_status = 'ignored'/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test routes/emails.test.js`
Expected: FAIL，`Missing POST /replies/:id/confirm handler`。

- [ ] **Step 3: 在 routes/emails.js 的 module.exports 前追加**

文件顶部 require 处加：`const { summarizeReply } = require('../services/replySummarizer');`

```js
// ---- 回复 ----

const OUTREACH_STATUS_LABELS = {
  not_contacted: '待联系',
  contacted: '已联系',
  replied: '已回复',
  interested: '有意向',
  rejected: '已拒绝'
};

const INTENT_TO_OUTREACH = {
  interested: 'interested',
  rejected: 'rejected',
  question: 'replied',
  other: 'replied'
};

router.get('/replies', async (req, res) => {
  try {
    const { confirm_status } = req.query || {};
    const conditions = [];
    const params = [];
    if (confirm_status) { conditions.push('er.confirm_status = ?'); params.push(confirm_status); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const replies = await dbOperations.query(
      `SELECT er.*, ck.kol_name_snapshot AS kol_name, c.name AS campaign_name
       FROM email_replies er
       JOIN campaign_kols ck ON ck.id = er.campaign_kol_id
       JOIN campaigns c ON c.id = ck.campaign_id
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
    const outreachStatus = INTENT_TO_OUTREACH[reply.ai_intent] || 'replied';

    const kol = await dbOperations.get('SELECT id, internal_notes FROM campaign_kols WHERE id = ?', [reply.campaign_kol_id]);
    if (!kol) return res.status(404).json({ success: false, error: 'KOL 合作记录不存在' });

    const noteLine = `[邮件回复 ${new Date().toISOString().slice(0, 10)}] ${summary}`;
    const internalNotes = kol.internal_notes ? `${kol.internal_notes}\n${noteLine}` : noteLine;

    await dbOperations.run(
      `UPDATE campaign_kols SET outreach_status = ?, last_reply_summary = ?, internal_notes = ?,
       sync_status = 'sync_pending', updated_at = NOW() WHERE id = ?`,
      [outreachStatus, summary, internalNotes, reply.campaign_kol_id]
    );
    await dbOperations.run(
      `UPDATE email_replies SET confirm_status = 'confirmed', ai_summary = ?, updated_at = NOW() WHERE id = ?`,
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
    await summarizeReply(reply.id);
    const updated = await dbOperations.get('SELECT * FROM email_replies WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

`module.exports = router;` 之后追加：`module.exports.OUTREACH_STATUS_LABELS = OUTREACH_STATUS_LABELS;`

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && node --test routes/emails.test.js`
Expected: PASS 全部 8 个用例。

- [ ] **Step 5: 全量回归 + Commit**

Run: `cd server && npm test`
Expected: 全部通过。

```bash
git add server/routes/emails.js server/routes/emails.test.js
git commit -m "feat: add reply confirm/ignore APIs with campaign_kols writeback"
```

---

### Task 10: 飞书同步字段——外联状态 + 最近回复摘要

**Files:**
- Modify: `server/routes/sync.js`（`PROJECT_TRACKING_FIELD_SCHEMA`、`campaignKolFields`、`CANDIDATE_POOL_OMITTED_FIELDS`）
- Test: `server/routes/sync.test.js`（追加用例）

**Interfaces:**
- Consumes: Task 9 `OUTREACH_STATUS_LABELS`（从 `routes/emails.js` require，注意 emails.js 加载不触发任何副作用，安全）。
- Produces: 飞书项目跟踪子表新增两个自动补建字段 `外联状态`（单选）与 `最近回复摘要`（文本）；`campaignKolFields(row)` 输出包含这两个键；候选池表不写这两个字段。

- [ ] **Step 1: 追加失败测试**

在 `server/routes/sync.test.js` 末尾追加：

```js
test('campaignKolFields includes outreach status label and last reply summary', () => {
  const { campaignKolFields } = require('./sync');
  const fields = campaignKolFields({
    kol_name_snapshot: 'Alice',
    outreach_status: 'interested',
    last_reply_summary: '愿意合作，报价 $500',
    cooperation_platforms: '[]'
  });
  assert.equal(fields['外联状态'], '有意向');
  assert.equal(fields['最近回复摘要'], '愿意合作，报价 $500');
});

test('candidatePoolKolFields omits outreach fields', () => {
  const { candidatePoolKolFields } = require('./sync');
  const fields = candidatePoolKolFields({
    kol_name_snapshot: 'Alice',
    outreach_status: 'contacted',
    last_reply_summary: 'x',
    cooperation_platforms: '[]'
  });
  assert.equal(fields['外联状态'], undefined);
  assert.equal(fields['最近回复摘要'], undefined);
});
```

（文件顶部若没有 `assert`/`test` 的 require 则按现有写法补齐；`campaignKolFields` 依赖的 `parseJson` 等对 `'[]'` 输入安全。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && node --test routes/sync.test.js`
Expected: FAIL，`fields['外联状态']` 为 `undefined`。

- [ ] **Step 3: 修改 sync.js**

3a. `PROJECT_TRACKING_FIELD_SCHEMA` 中在 `{ field_name: '预算审批状态' ... },` 之前插入：

```js
  {
    field_name: '外联状态', aliases: [], type: 3, accepted_types: [1, 3],
    property: { options: [{ name: '待联系' }, { name: '已联系' }, { name: '已回复' }, { name: '有意向' }, { name: '已拒绝' }] }
  },
  { field_name: '最近回复摘要', aliases: [], type: 1, accepted_types: [1] },
```

3b. 文件顶部 require 区加：

```js
const { OUTREACH_STATUS_LABELS } = require('./emails');
```

3c. `campaignKolFields` 中 `setTextField(fields, '预算审批状态', row.budget_approval_status);` 之后加：

```js
  setTextField(fields, '外联状态', OUTREACH_STATUS_LABELS[row.outreach_status] || row.outreach_status);
  setTextField(fields, '最近回复摘要', row.last_reply_summary);
```

3d. `CANDIDATE_POOL_OMITTED_FIELDS` 数组追加两个元素：`'外联状态', '最近回复摘要'`。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd server && npm test`
Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add server/routes/sync.js server/routes/sync.test.js
git commit -m "feat: sync outreach status and last reply summary to feishu"
```

---

### Task 11: 前端邮件中心页（/emails）+ 菜单路由注册

**Files:**
- Create: `client/src/pages/Emails.js`
- Modify: `client/src/App.js`（菜单项 + Route）

**Interfaces:**
- Consumes: Task 5/6/9 的全部 `/api/emails/*` 接口；Task 9 `OUTREACH_STATUS_LABELS` 语义在前端复制一份（前端无共享常量机制，按现有前端惯例各自维护）。
- Produces: 路由 `/emails` 的邮件中心页，四个标签页：回复待确认 / 发送记录 / 模板管理 / 邮箱配置。Task 12 不依赖本页。

- [ ] **Step 1: 创建 client/src/pages/Emails.js**

```jsx
import React, { useCallback, useEffect, useState } from 'react';
import {
  Button, Card, Form, Input, InputNumber, message, Modal, Popconfirm,
  Select, Space, Switch, Table, Tabs, Tag, Tooltip
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import axios from 'axios';

const { TextArea } = Input;

const INTENT_LABELS = {
  interested: { text: '有意向', color: 'green' },
  question: { text: '询问中', color: 'gold' },
  rejected: { text: '已拒绝', color: 'red' },
  other: { text: '其他', color: 'default' }
};

const AI_STATUS_LABELS = {
  pending: { text: '总结中', color: 'blue' },
  success: { text: '已总结', color: 'green' },
  failed: { text: '总结失败', color: 'red' }
};

// ---- 回复待确认 ----

function RepliesTab() {
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [editedSummary, setEditedSummary] = useState('');

  const fetchReplies = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/emails/replies', { params: { confirm_status: 'pending' } });
      setReplies(res.data.data || []);
    } catch (error) {
      message.error('获取回复列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchReplies(); }, [fetchReplies]);

  const openConfirm = (record) => {
    setConfirming(record);
    setEditedSummary(record.ai_summary || '');
  };

  const handleConfirm = async () => {
    try {
      await axios.post(`/api/emails/replies/${confirming.id}/confirm`, { summary: editedSummary });
      message.success('已确认，状态将同步到飞书');
      setConfirming(null);
      fetchReplies();
    } catch (error) {
      message.error(error.response?.data?.error || '确认失败');
    }
  };

  const handleIgnore = async (record) => {
    try {
      await axios.post(`/api/emails/replies/${record.id}/ignore`);
      message.success('已忽略');
      fetchReplies();
    } catch (error) {
      message.error('操作失败');
    }
  };

  const handleRetry = async (record) => {
    try {
      await axios.post(`/api/emails/replies/${record.id}/retry-summary`);
      message.success('已重新总结');
      fetchReplies();
    } catch (error) {
      message.error('重试失败');
    }
  };

  const columns = [
    { title: 'KOL', dataIndex: 'kol_name', width: 140 },
    { title: '项目', dataIndex: 'campaign_name', width: 140 },
    { title: '回复时间', dataIndex: 'received_at', width: 160,
      render: (v) => (v ? new Date(v).toLocaleString('zh-CN') : '-') },
    { title: '主题', dataIndex: 'subject', width: 180, ellipsis: true },
    {
      title: 'AI 摘要', dataIndex: 'ai_summary', ellipsis: true,
      render: (v, record) => {
        const ai = AI_STATUS_LABELS[record.ai_status] || {};
        if (record.ai_status === 'failed') {
          return <Space><Tag color={ai.color}>{ai.text}</Tag><Button type="link" size="small" onClick={() => handleRetry(record)}>重试</Button></Space>;
        }
        return v || <Tag color={ai.color}>{ai.text}</Tag>;
      }
    },
    {
      title: '意向', dataIndex: 'ai_intent', width: 90,
      render: (v) => {
        const intent = INTENT_LABELS[v];
        return intent ? <Tag color={intent.color}>{intent.text}</Tag> : '-';
      }
    },
    {
      title: '操作', width: 170, render: (_, record) => (
        <Space>
          <Button type="link" size="small" onClick={() => openConfirm(record)}>确认</Button>
          <Popconfirm title="忽略这条回复？" onConfirm={() => handleIgnore(record)}>
            <Button type="link" size="small" danger>忽略</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <>
      <Button icon={<ReloadOutlined />} onClick={fetchReplies} style={{ marginBottom: 12 }}>刷新</Button>
      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={replies}
        expandable={{
          expandedRowRender: (record) => (
            <div style={{ whiteSpace: 'pre-wrap' }}>{record.body_text || '（无正文）'}</div>
          )
        }}
      />
      <Modal
        title={`确认回复 - ${confirming?.kol_name || ''}`}
        open={Boolean(confirming)}
        onOk={handleConfirm}
        onCancel={() => setConfirming(null)}
        okText="确认并更新状态"
        width={640}
      >
        <p>确认后将按意向更新外联状态，并把摘要写入备注、同步飞书。可修改摘要：</p>
        <TextArea rows={4} value={editedSummary} onChange={(e) => setEditedSummary(e.target.value)} />
      </Modal>
    </>
  );
}

// ---- 发送记录 ----

function RecordsTab() {
  const [data, setData] = useState({ records: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState();

  const fetchRecords = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/emails/records', { params: status ? { status } : {} });
      setData(res.data.data || { records: [], total: 0 });
    } catch (error) {
      message.error('获取发送记录失败');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { fetchRecords(); }, [fetchRecords]);

  const columns = [
    { title: 'KOL', dataIndex: 'kol_name', width: 140 },
    { title: '收件人', dataIndex: 'to_address', width: 200 },
    { title: '主题', dataIndex: 'subject', ellipsis: true },
    { title: '模板', dataIndex: 'template_name', width: 140, render: (v) => v || '自定义' },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (v, record) => (
        <Tooltip title={record.error || ''}>
          <Tag color={v === 'success' ? 'green' : 'red'}>{v === 'success' ? '成功' : '失败'}</Tag>
        </Tooltip>
      )
    },
    { title: '发送时间', dataIndex: 'created_at', width: 160,
      render: (v) => (v ? new Date(v).toLocaleString('zh-CN') : '-') }
  ];

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Select
          allowClear placeholder="全部状态" style={{ width: 140 }}
          value={status} onChange={setStatus}
          options={[{ value: 'success', label: '成功' }, { value: 'failed', label: '失败' }]}
        />
        <Button icon={<ReloadOutlined />} onClick={fetchRecords}>刷新</Button>
      </Space>
      <Table rowKey="id" loading={loading} columns={columns} dataSource={data.records} />
    </>
  );
}

// ---- 模板管理 ----

function TemplatesTab() {
  const [templates, setTemplates] = useState([]);
  const [variables, setVariables] = useState({});
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const [tplRes, varRes] = await Promise.all([
        axios.get('/api/emails/templates'),
        axios.get('/api/emails/templates/variables')
      ]);
      setTemplates(tplRes.data.data || []);
      setVariables(varRes.data.data || {});
    } catch (error) {
      message.error('获取模板失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const openEdit = (record) => {
    setEditing(record || null);
    form.setFieldsValue(record || { name: '', subject: '', body_html: '' });
    setModalOpen(true);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    try {
      if (editing) {
        await axios.put(`/api/emails/templates/${editing.id}`, values);
        message.success('模板已更新');
      } else {
        await axios.post('/api/emails/templates', values);
        message.success('模板已创建');
      }
      setModalOpen(false);
      fetchTemplates();
    } catch (error) {
      message.error(error.response?.data?.error || '保存失败');
    }
  };

  const handleDelete = async (record) => {
    try {
      await axios.delete(`/api/emails/templates/${record.id}`);
      message.success('已删除');
      fetchTemplates();
    } catch (error) {
      message.error('删除失败');
    }
  };

  const columns = [
    { title: '名称', dataIndex: 'name', width: 180 },
    { title: '主题', dataIndex: 'subject', ellipsis: true },
    {
      title: '操作', width: 150, render: (_, record) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
          <Popconfirm title="删除该模板？" onConfirm={() => handleDelete(record)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit(null)} style={{ marginBottom: 12 }}>
        新建模板
      </Button>
      <Table rowKey="id" loading={loading} columns={columns} dataSource={templates} />
      <Modal
        title={editing ? '编辑模板' : '新建模板'}
        open={modalOpen} onOk={handleSave} onCancel={() => setModalOpen(false)}
        width={720} okText="保存"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="模板名称" rules={[{ required: true, message: '必填' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="subject" label="邮件主题" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="支持变量，如：合作邀约 - {{campaign_name}}" />
          </Form.Item>
          <Form.Item name="body_html" label="邮件正文 (HTML)" rules={[{ required: true, message: '必填' }]}>
            <TextArea rows={10} placeholder="<p>Hi {{contact_name}},</p><p>...</p>" />
          </Form.Item>
          <div style={{ color: '#888' }}>
            可用变量：
            {Object.entries(variables).map(([key, label]) => (
              <Tag key={key}>{`{{${key}}} ${label}`}</Tag>
            ))}
          </div>
        </Form>
      </Modal>
    </>
  );
}

// ---- 邮箱配置 ----

function SettingsTab() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await axios.get('/api/emails/settings');
      if (res.data.data) form.setFieldsValue(res.data.data);
    } catch (error) {
      message.error('获取邮箱设置失败');
    }
  }, [form]);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const handleSave = async () => {
    const values = await form.validateFields();
    setLoading(true);
    try {
      await axios.post('/api/emails/settings', values);
      message.success('邮箱设置已保存');
    } catch (error) {
      message.error(error.response?.data?.error || '保存失败');
    } finally {
      setLoading(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await axios.post('/api/emails/settings/test');
      message.success(res.data.message || 'SMTP 连接成功');
    } catch (error) {
      message.error(error.response?.data?.error || '连接失败');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card title="企业邮箱配置" style={{ maxWidth: 720 }}>
      <Form form={form} layout="vertical">
        <Form.Item name="smtp_host" label="SMTP 服务器" rules={[{ required: true, message: '必填' }]}>
          <Input placeholder="如 smtp.exmail.qq.com" />
        </Form.Item>
        <Space size="large">
          <Form.Item name="smtp_port" label="SMTP 端口" initialValue={465}>
            <InputNumber min={1} max={65535} />
          </Form.Item>
          <Form.Item name="smtp_secure" label="SMTP SSL" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Space>
        <Form.Item name="imap_host" label="IMAP 服务器（用于回复追踪）">
          <Input placeholder="如 imap.exmail.qq.com" />
        </Form.Item>
        <Space size="large">
          <Form.Item name="imap_port" label="IMAP 端口" initialValue={993}>
            <InputNumber min={1} max={65535} />
          </Form.Item>
          <Form.Item name="imap_secure" label="IMAP TLS" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
          <Form.Item name="poll_interval_minutes" label="轮询间隔（分钟，0 关闭）" initialValue={5}>
            <InputNumber min={0} max={120} />
          </Form.Item>
        </Space>
        <Form.Item name="username" label="邮箱账号" rules={[{ required: true, message: '必填' }]}>
          <Input placeholder="you@company.com" />
        </Form.Item>
        <Form.Item name="password" label="授权码 / 密码">
          <Input.Password placeholder="邮箱授权码（非登录密码）" />
        </Form.Item>
        <Form.Item name="sender_name" label="发件人显示名">
          <Input placeholder="如 MOOER Marketing" />
        </Form.Item>
        <Form.Item name="default_cc" label="默认抄送">
          <TextArea rows={2} placeholder="多个地址用逗号/分号/换行分隔" />
        </Form.Item>
        <Space>
          <Button type="primary" loading={loading} onClick={handleSave}>保存</Button>
          <Button loading={testing} onClick={handleTest}>测试 SMTP 连接</Button>
        </Space>
      </Form>
    </Card>
  );
}

function Emails() {
  return (
    <Card title="邮件中心">
      <Tabs
        defaultActiveKey="replies"
        items={[
          { key: 'replies', label: '回复待确认', children: <RepliesTab /> },
          { key: 'records', label: '发送记录', children: <RecordsTab /> },
          { key: 'templates', label: '模板管理', children: <TemplatesTab /> },
          { key: 'settings', label: '邮箱配置', children: <SettingsTab /> }
        ]}
      />
    </Card>
  );
}

export default Emails;
```

- [ ] **Step 2: 注册菜单与路由**

修改 `client/src/App.js`：

1. import 区加 `import Emails from './pages/Emails';`，图标 import 加 `MailOutlined`。
2. `menuItems` 中 `{ key: '/campaign-kols', ... }` 之后插入 `{ key: '/emails', icon: <MailOutlined />, label: '邮件中心' },`。
3. `<Routes>` 中 `<Route path="/campaign-kols" ... />` 之后插入 `<Route path="/emails" element={<Emails />} />`。

- [ ] **Step 3: 构建验证**

Run: `cd client && npm run build`
Expected: `Compiled successfully.`，无报错。

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/Emails.js client/src/App.js
git commit -m "feat: add email center page"
```

---

### Task 12: 前端 CampaignKols 发邮件入口

**Files:**
- Modify: `client/src/pages/CampaignKols.js`（工具栏按钮 + 发送弹窗）

**Interfaces:**
- Consumes: `POST /api/emails/send`（Task 6）、`GET /api/emails/templates`、`POST /api/emails/preview`（Task 5）；页面已有的 `selectedRowKeys`（第 111 行）与 `fetchRows`。
- Produces: CampaignKols 工具栏"发邮件"按钮；弹窗内选模板 → 预览（可改主题/正文/抄送）→ 发送 → 展示逐封结果。

- [ ] **Step 1: 修改 CampaignKols.js**

1a. import 区：`import { ... } from 'antd'` 中确保已有 `List`、`Divider`（若没有则补上）；图标 import 加 `MailOutlined`。

1b. 组件 state 区（`selectedRowKeys` 声明附近）加：

```jsx
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailTemplates, setEmailTemplates] = useState([]);
  const [emailTemplateId, setEmailTemplateId] = useState();
  const [emailPreview, setEmailPreview] = useState(null);
  const [emailSubject, setEmailSubject] = useState('');
  const [emailContent, setEmailContent] = useState('');
  const [emailCc, setEmailCc] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [emailResult, setEmailResult] = useState(null);
```

1c. 在组件内加以下函数（放在 `syncSelected` 之后即可）：

```jsx
  const openEmailModal = async () => {
    if (!selectedRowKeys.length) {
      message.warning('请先勾选要发送的 KOL');
      return;
    }
    setEmailResult(null);
    setEmailPreview(null);
    setEmailSubject('');
    setEmailContent('');
    setEmailCc('');
    setEmailTemplateId(undefined);
    setEmailModalOpen(true);
    try {
      const res = await axios.get('/api/emails/templates');
      setEmailTemplates(res.data.data || []);
    } catch (error) {
      message.error('获取邮件模板失败');
    }
  };

  const previewEmail = async (templateId) => {
    try {
      const res = await axios.post('/api/emails/preview', {
        campaignKolId: selectedRowKeys[0],
        templateId
      });
      setEmailPreview(res.data.data);
      setEmailSubject(res.data.data.subject);
      setEmailContent(res.data.data.body_html);
    } catch (error) {
      message.error(error.response?.data?.error || '预览失败');
    }
  };

  const sendEmails = async () => {
    setEmailSending(true);
    setEmailResult(null);
    try {
      const res = await axios.post('/api/emails/send', {
        campaignKolIds: selectedRowKeys,
        templateId: emailTemplateId,
        customSubject: emailSubject || undefined,
        customContent: emailContent || undefined,
        overrideCc: emailCc || undefined
      });
      setEmailResult(res.data.data);
      if (res.data.data.failed === 0) message.success(`全部发送成功（${res.data.data.success} 封）`);
      else message.warning(`成功 ${res.data.data.success} 封，失败 ${res.data.data.failed} 封`);
      fetchRows();
    } catch (error) {
      message.error(error.response?.data?.error || '发送失败');
    } finally {
      setEmailSending(false);
    }
  };
```

1d. 工具栏（第 361-375 行的 `<Space wrap>` 内，"同步选中到飞书项目子表"按钮后）加：

```jsx
          <Button icon={<MailOutlined />} onClick={openEmailModal} disabled={!selectedRowKeys.length}>发邮件</Button>
```

1e. 在 columns 数组中 `{ title: '合作方式', ... }` 一列之后插入"外联状态"列：

```jsx
    { title: '外联状态', dataIndex: 'outreach_status', key: 'outreach_status', width: 110, render: (v) => {
      const labels = { not_contacted: '待联系', contacted: '已联系', replied: '已回复', interested: '有意向', rejected: '已拒绝' };
      const colors = { contacted: 'blue', replied: 'gold', interested: 'green', rejected: 'red' };
      return v ? <Tag color={colors[v] || 'default'}>{labels[v] || v}</Tag> : '-';
    } },
```

1f. 在页面 JSX 末尾（最后一个 `</Drawer>` 或最外层闭合标签前）加弹窗：

```jsx
      <Modal
        title={`发邮件给 ${selectedRowKeys.length} 位 KOL`}
        open={emailModalOpen}
        onCancel={() => setEmailModalOpen(false)}
        width={720}
        footer={[
          <Button key="cancel" onClick={() => setEmailModalOpen(false)}>关闭</Button>,
          <Button key="send" type="primary" loading={emailSending} onClick={sendEmails}
            disabled={!emailTemplateId && !emailSubject}>
            发送
          </Button>
        ]}
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Select
            style={{ width: '100%' }}
            placeholder="选择邮件模板"
            value={emailTemplateId}
            onChange={(value) => { setEmailTemplateId(value); previewEmail(value); }}
            options={emailTemplates.map((t) => ({ value: t.id, label: t.name }))}
          />
          {emailPreview && (
            <>
              <div style={{ color: '#888' }}>预览（第一位 KOL：{emailPreview.to || '无收件人地址'}），修改主题/正文将应用于全部收件人：</div>
              <Input
                addonBefore="主题"
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
              />
              <Input.TextArea
                rows={8}
                value={emailContent}
                onChange={(e) => setEmailContent(e.target.value)}
              />
              <Input
                addonBefore="抄送"
                placeholder="留空使用默认抄送"
                value={emailCc}
                onChange={(e) => setEmailCc(e.target.value)}
              />
            </>
          )}
          {emailResult && (
            <>
              <Divider style={{ margin: '8px 0' }} />
              <div>发送完成：成功 {emailResult.success} / 失败 {emailResult.failed}（共 {emailResult.total}）</div>
              {emailResult.errors.length > 0 && (
                <List
                  size="small"
                  header="失败明细"
                  dataSource={emailResult.errors}
                  renderItem={(item) => <List.Item>{item.to || `KOL #${item.campaignKolId}`}：{item.error}</List.Item>}
                />
              )}
            </>
          )}
        </Space>
      </Modal>
```

- [ ] **Step 2: 构建验证 + 现有前端测试**

Run: `cd client && npm run build`
Expected: `Compiled successfully.`

Run: `cd client && CI=true npx react-scripts test --watchAll=false`
Expected: 现有测试（含 `CampaignKols.test.js`）全部通过。

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/CampaignKols.js
git commit -m "feat: add send-email entry on campaign kols page"
```

---

## 端到端验收（全部任务完成后手动执行）

- [ ] 配置真实企业邮箱（邮件中心 → 邮箱配置），点"测试 SMTP 连接"通过。
- [ ] 新建一个含 `{{kol_name}}` 的模板；在 KOL 合作页勾选 1-2 位有邮箱的 KOL 发送，发送记录出现 success 行，`campaign_kols.outreach_status` 变为 `contacted`。
- [ ] 用该 KOL 邮箱回复此信，等待一个轮询周期（或重启服务触发），"回复待确认"出现该回复且带 AI 摘要与意向。
- [ ] 确认回复（可改摘要），检查 `campaign_kols` 的 `outreach_status` / `last_reply_summary` / `internal_notes` 已更新；在 KOL 合作页点"同步选中到飞书项目子表"，飞书子表出现"外联状态"与"最近回复摘要"值。
