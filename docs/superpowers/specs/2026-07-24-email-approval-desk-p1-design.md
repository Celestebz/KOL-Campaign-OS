# 邮件审批台 P1 开发方案（正式 spec）

> 版本：v1.1（2026-07-24，基于用户提供的 v1.0 方案，由 Kimi Code 核实代码库后修正）
> 目标读者：开发执行
> 前置共识：**P1 阶段 AI 起草的任何邮件都不能直接发送，全部经人工批准，不分风险高低。**
> 本文取代《KOL 邮件外联与回复追踪设计》（2026-07-24，模板变量方案，已废弃）。

---

## 一、背景与目标

邮件中心（`client/src/pages/Emails.js`）当前只有前端壳：`emailApi.js` 中 `USE_MOCK = true`，各 Tab 全是内置假数据，服务端不存在 `/api/emails/*` 任何路由。

已验证有效的外联方式：AI 先调查达人（近 30 天真实视频、播放数据、匹配理由），再据此撰写个性化首触邮件，而不是通用模板填变量。本方案把这个流程做进系统，建成"邮件审批台"：

```
勾选达人 → AI 起草（引用真实证据）→ 风险标记 → 审批台人工审阅 → 批准后发送 → 状态回写飞书
```

P1 交付后，TMB-1401 这轮外联应能完整在系统内跑通。

## 二、P1 范围

### 包含

1. 邮件后端真实化：邮箱配置（SMTP/IMAP）、发送（nodemailer 已在依赖中）、发送记录。
2. AI 起草：首触邮件（first_touch），支持单人起草和批量起草。
3. 风险标记引擎：结构化风险标签（code + 原因说明）。
4. 审批台 UI：队列 + 证据面板 + 编辑/重新生成/批准/驳回。
5. 回复接入：IMAP 轮询收件、AI 摘要与意向分类、回复草稿进入同一审批队列。
6. 跟进自动化：发送后 48 小时未回复生成跟进草稿进审批队列；5 天未回复标记降级建议。
7. 状态回写：发送/回复确认后更新 `campaign_kols.outreach_status`，标记 `sync_status='sync_pending'` 走现有飞书同步；同时更新飞书候选池对应行的"状态"，并把跟进摘要写入新增的"跟进记录"字段。

### 不包含（P2/P3）

- 低风险事务性邮件自动发送（P1 一律人工批准）。
- 回复"有意向"后自动起草条款确认信、合同与折扣码分发（P3）。
- 打开率/回复率统计看板。
- 多邮箱账号轮发与发送节流策略（P1 只做每日手动发送，不做配额控制）。

## 三、现有可复用资产（已逐一核实）

| 资产 | 位置 | 用法 |
|---|---|---|
| AI 调用逻辑 | `server/routes/finderTasks.js` 约 420–470 行（minimax + openai 兼容两种报文）；`server/routes/videos.js` 有一套近重复实现 | **抽到 `server/services/aiClient.js`**，finderTasks、videos、邮件模块三方共用，一次理顺 |
| AI 配置 | `api_settings` 表（如 `ai.minimax`），活跃模型选择存 `system.provider_selection` 的 `aiModels.active` | 起草直接复用，不新增配置页 |
| YouTube 快照 | `server/services/youtubeIntakeSnapshot.js` 的 `runYoutubeIntakeSnapshot(customerId)`；结果在 `customers.youtube_*` 字段和 `kol_youtube_snapshot_videos` 表（migration 20260722000003，含 `title/play_count/included_in_aggregate`） | 起草前的证据来源；快照超过 7 天先回抓再起草 |
| 达人-项目状态 | `campaign_kols.outreach_status`、`sync_status` | 发送/回复后更新并置 `sync_pending` |
| 飞书同步 | `server/routes/sync.js`、`server/utils/feishuSubtableMapping.js`、`api_settings` 的 `cloud.feishu_bitable`；候选池 schema 为 `CANDIDATE_POOL_FIELD_SCHEMA`（sync.js:142），"状态"单选字段选项齐全 | 复用；`CANDIDATE_POOL_STATUS_LABELS` 已有英文→中文映射 |
| 策略/brief | `kol_strategies`（`product_context`、`persona_config`、`finder_handoff`、`target_market`） | 起草时注入产品卖点与合作口径；**target_market 在 strategy 上，不在 campaign 上** |
| Prompt 模板 | `prompt_templates` 表 + 对应管理页 | 新增一条"外联邮件写作规范"模板（见 email_templates.kind='style_guide'） |
| 鉴权 | `server/middleware/auth.js` authGuard 已覆盖 `/api/*` | 新路由自动受保护 |
| 密钥脱敏 | `redactKnownSecrets`（finderTasks.js） | 日志/响应不输出 SMTP 密码、AI key、飞书 app_secret |

### 状态值约定（v1.1 修正）

- `campaign_kols.outreach_status` **存英文编码**，UI 与飞书侧显示中文。发送成功 → `contacted`；回复确认：interested → `replied`，question → `negotiating`。
- 飞书候选池"状态"字段的中文标签沿用现有 `CANDIDATE_POOL_STATUS_LABELS` 映射（`contacted→已联络`、`replied→已回复`、`negotiating→沟通中`），不绕开。
- 飞书候选池新增"跟进记录"文本字段：加入 `CANDIDATE_POOL_FIELD_SCHEMA`（type 1，自动补建机制现成），确认回复时写入确认摘要。

## 四、数据模型（新建一个 migration）

放 `server/migrations/20260724000001-create-email-center-tables.js`，全部加中文 COMMENT。

### email_settings（单行配置）

`id, smtp_host, smtp_port, smtp_secure, imap_host, imap_port, imap_secure, username, password, sender_name, default_cc, poll_interval_minutes, last_poll_at, created_at, updated_at`

### email_templates

`id, name, kind ENUM('style_guide','fixed'), subject, body_html, created_at, updated_at`

- `kind='style_guide'`：AI 写作规范（合作口径、语气、必含项、禁用项），不是正文模板。
- `kind='fixed'`：旧的变量填充模板，仅用于无需个性化的场景。

### email_drafts（核心表）

`id, campaign_id, customer_id, kind ENUM('first_touch','follow_up','reply'), subject, body_text, status ENUM('pending_review','approved','rejected','sent','send_failed'), risk_level ENUM('none','low','high'), risk_reasons JSON, evidence JSON, source_reply_id NULL, template_id NULL, prompt_version, ai_model, reviewer_note, generated_at, reviewed_at, created_at, updated_at`

- `evidence` 结构：`{ snapshot_date, videos: [{youtube_video_id, title, views, published_at}], match_reason, metrics: {followers, avg_views_30d, median_views_30d, posts_30d} }`。
- `risk_reasons` 结构：`[{ code, message }]`，code 见第六节风险规则。

### email_records（发送记录）

`id, draft_id, campaign_id, customer_id, kol_name, to_address, cc, subject, body_text, status ENUM('success','failed'), error, smtp_message_id, created_at`

### email_replies（回复）

`id, email_record_id NULL, campaign_id, customer_id, from_address, subject, body_text, received_at, ai_status ENUM('pending','success','failed'), ai_summary, ai_intent ENUM('interested','question','rejected','other'), confirm_status ENUM('pending','confirmed','ignored'), confirmed_summary, created_at, updated_at`

### email_draft_versions（草稿版本回溯）

`id, draft_id, subject, body_text, source ENUM('ai','human','regenerate'), feedback, created_at`。每次 AI 生成和人工保存都留版本。

### campaign_kols 加列

`last_outreach_at DATETIME NULL, follow_up_count INT DEFAULT 0`

## 五、API 设计（新建 `server/routes/emails.js`，在 `server/index.js` 挂载 `/api/emails`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/settings` | 邮箱配置读写（密码字段读取时脱敏） |
| POST | `/settings/test` | 测试 SMTP 连接 |
| GET/POST/PUT/DELETE | `/templates` | 模板 CRUD；GET `/templates/variables` 返回变量说明 |
| POST | `/drafts/generate` | 入参 `{ campaign_id, customer_ids[], kind }`；对每个达人执行第六节流程；返回每个达人的成败；批量并发 ≤3 |
| GET | `/drafts` | 过滤：`status, campaign_id, kind, risk_level`；返回计数 `{ pending_review, high_risk, approved }` |
| GET | `/drafts/:id` | 含 evidence 和风险详情 |
| PUT | `/drafts/:id` | 编辑 subject/body_text；仅 `pending_review` 状态可编辑；存 `email_draft_versions`（source='human'） |
| POST | `/drafts/:id/regenerate` | 入参可选 `{ feedback }`；重新生成，旧版本存入 `email_draft_versions`（source='regenerate'） |
| POST | `/drafts/:id/approve` | 状态 → `approved` |
| POST | `/drafts/:id/reject` | 入参 `{ reason }` → `rejected` |
| POST | `/drafts/:id/send` | **仅 `approved` 状态可调用，否则 409**；nodemailer 发送，写 email_records，成功则 draft → `sent`，更新 `campaign_kols.outreach_status='contacted'`、`last_outreach_at`、`sync_status='sync_pending'` |
| GET | `/records` | 发送记录，支持 status 过滤 |
| GET | `/replies` | 回复列表（confirm_status 过滤） |
| POST | `/replies/:id/confirm` / `/ignore` / `/retry-summary` | 确认后更新 `campaign_kols.outreach_status`（interested→`replied`，question→`negotiating`）并置 sync_pending；确认摘要写入候选池"跟进记录" |
| POST | `/replies/:id/draft-reply` | 基于回复内容生成 reply 草稿进审批队列 |

## 六、AI 起草流程（新建 `server/services/emailDrafter.js`）

每个达人一次执行：

1. **快照新鲜度检查**：`customers.youtube_snapshot_updated_at` 距今 > 7 天或为空 → 先调 `runYoutubeIntakeSnapshot(customerId)` 回抓；回抓失败则该达人起草失败，原因入结果。
2. **组装上下文**：
   - 达人：名称、邮箱、国家、`youtube_followers/avg/median/posts/engagement`；
   - 证据视频：`kol_youtube_snapshot_videos` 中 `included_in_aggregate=1` 的近 30 天长视频（标题、播放、发布日期，最多 10 条）；
   - 项目：campaign 名称、关联 `kol_strategies.product_context`（卖点）与 `target_market`（市场，**经 strategy 取，campaign 表无此列**）、合作口径（从 `kind='style_guide'` 的 email_template 读取，含样品+佣金+无固定费+截止日期+授权条款）；
   - 风格约束：同一条 style_guide 模板里的写作要求。
3. **调用 AI**（复用抽出的 `aiClient.js`，temperature 0.2），要求输出 JSON：`{ subject, body_text, cited_video_ids[], personalization_note }`。
4. **硬性校验**（不过则 risk_level=high 或起草失败）：
   - `cited_video_ids` 必须全部存在于该达人快照视频中，否则 high risk `FABRICATED_EVIDENCE`；
   - 正文中的数字（播放量、粉丝数、佣金比例、日期）与系统数据核对，不一致 → high risk `METRIC_MISMATCH`；
   - 正文必须包含产品型号和佣金说明，缺失 → low risk `MISSING_REQUIRED_TERM`。
5. **风险规则引擎**（`server/services/emailRiskRules.js`，规则可配置，先硬编码常量数组）：

| code | 触发 | 级别 |
|---|---|---|
| NO_EMAIL | 达人无邮箱 | high |
| FABRICATED_EVIDENCE | 引用了不存在的视频/数据 | high |
| METRIC_MISMATCH | 正文数字与快照不符 | high |
| MARKET_MISMATCH | 达人国家与 strategy.target_market 不符（如 GB vs US） | high |
| PRICE_COMMITMENT | 正文出现 $金额、fee、rate、guarantee、contract 等承诺性表述 | high |
| STALE_SNAPSHOT | 起草所用快照超过 7 天 | low |
| MISSING_REQUIRED_TERM | 缺产品型号/佣金说明 | low |
| MISSING_VIDEO_REFERENCE | 未引用任何真实视频 | low |
| LANGUAGE_MISMATCH | 达人内容语言非目标语言 | low |

6. 写入 `email_drafts`（status=`pending_review`）+ `email_draft_versions`（source='ai'）。

### 写作规范（style_guide 初始内容，存入 email_templates）

- 三段式：第一句自我介绍加来意并引用达人 1–2 条真实视频；中段说清能提供什么（免费寄样归达人、5% 佣金、明确说明无固定费、一条完播视频及截止日期）；最后一句 call to action（回复即发规格，或确认设备兼容性）。
- 自然语言连贯段落，不用列表符号、不用破折号，简单口语化表达，正文不超过 120 个英文单词。
- 只允许引用上下文里给出的真实视频标题和数据，禁止编造。
- 草坪养护类达人必须在 CTA 中确认是否有 15–45HP PTO 拖拉机。

## 七、跟进自动化（`server/services/emailFollowUp.js`）

随服务启动的定时器（间隔 30 分钟，可配）：

- 扫描 `email_records` 中发送成功、`campaign_kols` 无对应已确认回复、且 `last_outreach_at` 距今 ≥ 48 小时的记录 → 生成 `kind='follow_up'` 草稿进审批队列（`follow_up_count+1`）。
- 距今 ≥ 5 天仍未回复 → 不再自动起草，在审批台该达人卡片上标记"建议转下一批"，并把候选池状态回写建议。

## 八、回复接入（`server/services/emailReplyPoller.js`）

- 新依赖：`imapflow`（需 `npm install`，server 包）。按 `poll_interval_minutes` 轮询 IMAP Unseen 邮件，**按 message-id 幂等去重**。
- 按发件人地址匹配 `email_records.to_address`（或 customers.email）归属到达人与项目。
- 写 `email_replies` 后异步调 AI 生成摘要和意向分类（复用 aiClient），失败置 `ai_status='failed'` 可重试。
- 确认/忽略/回写逻辑沿用现有 mock 交互。

## 九、前端改造

### `client/src/pages/Emails.js` 重构为五个 Tab

1. **审批台**（默认）：顶部计数卡（高风险 / 待审阅 / 已批准待发送），可按项目、类型、风险过滤。左侧草稿队列列表（达人、类型 Tag、风险 Tag、生成时间）；右侧上半为可编辑的主题+正文，下半为**证据面板**：引用的视频标题+播放+发布日期、快照日期、均播/中位/粉丝、匹配理由、风险原因列表。操作按钮：保存修改、重新生成（可填反馈）、批准、驳回、批准后发送。所有 AI 草稿有明显"AI 生成，未经人工批准"标识。
2. **发送记录**：落实现有 mock 列。
3. **回复待确认**：落实现有 mock 交互（确认/忽略/重试），新增"生成回复草稿"按钮。
4. **模板与口径**：模板列表增加 `kind` 列（写作规范/固定模板）。
5. **邮箱配置**：现有 UI 接真实接口。

### `client/src/pages/CampaignKols.js`

"发邮件"按钮旁加"AI 起草邮件"：勾选达人 → 调 `/drafts/generate` → 提示去审批台审阅。原"发邮件"入口改为只能选择 `kind='fixed'` 模板。

### `emailApi.js`

删除全部 mock 代码和 `USE_MOCK`，改接真实 API。（UI 评审阶段先保留 mock。）

## 十、验收标准

1. 配置真实 SMTP 后，从 CampaignKols 勾选 3 个达人点"AI 起草邮件"，审批台出现 3 条 `pending_review` 草稿，每条至少引用 1 条该达人真实视频，证据面板可核对。
2. 正文数字与快照不一致的草稿被标记 high risk 且原因可读。
3. 未批准的草稿调 `/send` 返回 409；批准后发送成功，email_records 有记录，`campaign_kols.outreach_status='contacted'`，飞书候选池对应行"状态"在下次同步后更新为"已联络"。
4. 编辑并保存草稿后，`email_draft_versions` 有人工版本；重新生成后旧 AI 版本可回溯。
5. 用测试邮箱回复一封，`/replies` 出现该回复且 AI 摘要/意向正确；确认后状态与飞书同步。
6. 发送 48 小时后无回复，审批台自动生成 follow_up 草稿。
7. `npm test`（server 现有 node:test 套件）全绿，新增 `routes/emails.test.js` 覆盖 generate/approve/send 权限与风险规则。

## 十一、开发顺序建议

1. migration + models + aiClient 抽取（finderTasks、videos 改引用，回归测试）。
2. settings/templates/records 后端 + 前端对应 Tab 接真实接口。
3. emailDrafter + 风险规则 + drafts API + 审批台 UI。
4. 发送 + 状态回写 + 飞书同步联调（含候选池"跟进记录"新字段）。
5. 回复轮询 + AI 摘要 + 回复草稿。
6. 跟进定时器。

## 十二、注意事项

- 不要在任何日志或 API 响应中输出 SMTP 密码、AI key、飞书 app_secret（参考现有 `redactKnownSecrets`）。
- IMAP 轮询要幂等（按 message-id 去重）。
- 批量起草要控制并发（≤3），AI 调用失败单达人隔离失败不影响其他。
- 所有 AI 生成的草稿在 UI 必须有明显"AI 生成，未经人工批准"标识。
- 阿里邮箱接入：按站点选择服务器（新加坡 `imap/smtp.sg.aliyun.com`、香港 `.hk.`、德国/美国 `.de./.us.alibabacloud.com`，SSL 端口 IMAP 993 / SMTP 465；老企业版为 `*.qiye.aliyun.com`）；以网页版登录域名判断站点；需管理员开启"允许三方客户端"和账号级 POP/IMAP/SMTP 协议；密码栏填"三方客户端安全密码"。
