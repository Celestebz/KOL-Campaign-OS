# KOL 邮件外联与回复追踪设计

日期：2026-07-24

## 背景

kol-campaign-os 已管理 Campaign 与 KOL 的完整合作流程（`campaign_kols` 表含 `outreach_status`、`contact_email_override`、`email_snapshot` 等字段），但外联邮件仍需人工在系统外发送，回复也无法追踪，外联状态靠手动维护并同步飞书。

参考项目 [sendemail](https://github.com/Celestebz/sendemail)（同作者、同项目骨架）提供了成熟的 SMTP 发送与模板变量替换实现（`server/routes/email.js` 371 行、`server/routes/templates.js` 272 行，裸 SQL + SQLite + nodemailer）。本项目 nodemailer 6.9.7 已在依赖中但尚未使用。

本次将 sendemail 的发送/模板逻辑移植进现有系统，新增 IMAP 回复追踪与 AI 回复总结，形成完整外联闭环。

## 目标

- 在 CampaignKols 页面勾选 KOL，用模板批量发送个性化邮件，变量自动替换，可逐封预览编辑。
- 记录每封邮件的发送结果（成功/失败/错误原因），单封失败不中断批次。
- 通过 IMAP 定时轮询收件箱，自动把 KOL 回复匹配到对应 `campaign_kol_id`。
- 收到回复后由 server 直接调用 LLM 生成摘要与意向分类，人工确认后更新 `campaign_kols`。
- 确认后的外联状态与回复摘要经现有飞书 sync 管道自动回写飞书子表。

## 非目标

- 不做邮件打开率/点击率追踪（像素追踪、链接跳转统计）。
- 不做自动多轮跟进（跟进邮件由人工再次发起发送流程）。
- 不做独立邮件服务的部署与跨系统集成。
- 不修改现有视频 AI 分析、Finder、飞书同步的业务逻辑。
- 不支持多邮箱账户，本期只支持单个企业邮箱。

## 总体方案

在 server 内新增邮件子系统，分四个模块：

1. **发送**：`services/mailer.js` 封装 nodemailer transporter（移植 sendemail 的 465 端口 SSL 判定、抄送解析、CID 图片内嵌逻辑），`routes/emails.js` 提供模板 CRUD、预览、批量发送、发送记录接口。裸 SQL 全部改写为现有 `dbOperations` 风格。
2. **回复追踪**：`services/replyTracker.js` 用 node-imap 定时轮询收件箱未读邮件，匹配到发送记录后写入 `email_replies` 并触发 AI 总结。
3. **AI 总结**：把 `routes/videos.js` 中的 `callOpenAiCompatible` / `callMiniMax` / `parseAiContentRobust` 等 LLM 调用辅助函数抽取到 `server/utils/llm.js`，videos.js 与邮件模块共用。复用 `system.provider_selection` 的激活 provider 与 `api_settings` 中的密钥，用户无需新增配置。
4. **确认与回写**：前端确认回复后更新 `campaign_kols.outreach_status` / `internal_notes` 并置 `sync_status = 'sync_pending'`，由现有 `/api/sync` 流程回写飞书，不改 sync 机制本身。

## 数据模型

新增四张表（迁移文件按 `server/migrations/` 现有命名规则）：

**email_settings**（单行配置）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK | |
| smtp_host / smtp_port / smtp_secure | STRING / INTEGER / BOOLEAN | SMTP 配置 |
| imap_host / imap_port / imap_secure | STRING / INTEGER / BOOLEAN | IMAP 配置 |
| username / password | STRING / TEXT | 邮箱账号与授权码 |
| sender_name | STRING | 发件人显示名 |
| default_cc | TEXT | 默认抄送，逗号/分号/换行分隔 |
| poll_interval_minutes | INTEGER | IMAP 轮询间隔，默认 5 |

**email_templates**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK | |
| name | STRING | 模板名 |
| subject | STRING | 主题，支持变量 |
| body_html | TEXT | 正文 HTML，支持变量 |

变量语法 `{{variable}}`，发送时替换。支持的变量：`kol_name`、`contact_name`、`campaign_name`、`product_names`、`cooperation_type`、`sender_name`。

**email_send_records**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK | |
| campaign_kol_id | INTEGER FK | 关联 campaign_kols |
| template_id | INTEGER FK NULL | 使用的模板（自定义内容可为空） |
| to_address / cc | STRING / TEXT | 收件人与实际抄送 |
| subject / body_html | STRING / TEXT | 实际发送内容快照 |
| status | STRING | `success` / `failed` |
| error | TEXT NULL | 失败原因 |
| message_id | STRING NULL | SMTP 返回的 Message-ID，用于回复匹配 |

**email_replies**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK | |
| send_record_id | INTEGER FK NULL | 匹配到的发送记录 |
| campaign_kol_id | INTEGER FK | 冗余关联，便于查询 |
| from_address | STRING | 发件人 |
| subject | STRING | 回复主题 |
| body_text | TEXT | 纯文本正文（HTML 转文本，截断至 8000 字符） |
| received_at | DATE | 收信时间 |
| ai_summary | TEXT NULL | AI 摘要 |
| ai_intent | STRING NULL | `interested` / `question` / `rejected` / `other` |
| ai_status | STRING | `pending` / `success` / `failed` |
| confirm_status | STRING | `pending` / `confirmed` / `ignored`，默认 `pending` |

**campaign_kols 复用现有字段**：`outreach_status` 取值扩展为 `not_contacted`（待联系）/ `contacted`（已联系）/ `replied`（已回复）/ `interested`（有意向）/ `rejected`（已拒绝），不加新列。

## 发送流程

1. 前端在 CampaignKols 页勾选 KOL，打开"发邮件"弹窗：选模板（或自定义主题/正文）、逐封预览（变量已替换，可单独编辑）、确认发送。
2. 后端 `POST /api/emails/send` 接收 `campaignKolIds`、`templateId`、可选的逐封覆盖内容。
3. 收件人地址优先级：`contact_email_override` > `email_snapshot` > 关联 customer 的 email；三者皆空的记录标记失败（`error = '无收件人地址'`），不影响其他记录。
4. 逐封发送，成功则写入 `email_send_records`（含 Message-ID），并把对应 `campaign_kols.outreach_status` 置为 `contacted`、`sync_status` 置为 `sync_pending`；失败仅记录错误。批次结束后返回每封结果。
5. 抄送：请求可覆盖，否则用 `email_settings.default_cc`（解析逻辑移植自 sendemail）。
6. 正文中的本地图片（`/uploads/...`）按 sendemail 的 CID 内嵌方式处理。

## 回复追踪

1. `replyTracker.js` 在 server 启动后按 `poll_interval_minutes`（默认 5 分钟）轮询 IMAP 收件箱，只取未读邮件。未配置 IMAP 或轮询间隔为 0 则不启动。
2. 匹配规则（按优先级）：
   - 邮件头 `In-Reply-To` / `References` 含某条 `email_send_records.message_id` → 精确匹配；
   - 否则发件人地址等于某条发送记录的 `to_address` → 取该地址最近一条发送记录。
3. 匹配成功：写入 `email_replies`（`ai_status = pending`），标记该邮件已读，随后异步触发 AI 总结。
4. 匹配失败：跳过，不标记已读（避免吞掉人工邮件）。
5. 单轮轮询失败（网络、认证）记日志并等待下一轮，不影响 server 运行。

## AI 总结

1. 抽取 `server/utils/llm.js`：`getActiveAiSetting()`（读 `system.provider_selection` + `api_settings`）、`callOpenAiCompatible`、`callMiniMax`、`parseAiContentRobust`。videos.js 改为引用该模块，行为不变。
2. `prompt_templates` 表通过迁移新增 `scene` 列（STRING(50)，默认 `'video_analysis'`，现有行行为不变，视频分析查询显式按此值过滤），并 seed 一条 `scene = 'email_reply_summary'` 的默认模板，输出 JSON：`{ "summary": "...", "intent": "interested|question|rejected|other" }`。现有 Templates 页会列出该模板，可直接编辑。
3. 总结触发后更新 `email_replies.ai_summary` / `ai_intent` / `ai_status`。LLM 调用失败时 `ai_status = failed`，回复仍可人工查看原文并确认。

## 人工确认与飞书回写

1. 前端"邮件中心"页"回复待确认"列表展示：KOL 名、回复时间、AI 摘要、意向标签、原文（可展开）。
2. 操作：
   - **确认**：将 `outreach_status` 按意向映射更新（interested→`interested`，rejected→`rejected`，其余→`replied`），AI 摘要追加到 `internal_notes`，`confirm_status = confirmed`，`sync_status = sync_pending`；确认前可修改摘要文本。
   - **忽略**：仅置 `confirm_status = ignored`，不改合作状态。
3. 飞书回写走现有 sync 管道。同步映射中检查子表是否已有"外联状态"与"最近回复摘要"字段，缺失时按 sync.js 现有的自动建字段先例补建。

## API 一览

- `GET/POST /api/emails/settings`：邮箱配置读写（密码只写不读，返回时掩码）。
- `POST /api/emails/settings/test`：用当前配置做一次 SMTP 连接验证。
- `GET/POST/PUT/DELETE /api/emails/templates`：模板 CRUD。
- `POST /api/emails/preview`：按 campaign_kol_id + 模板渲染预览。
- `POST /api/emails/send`：批量发送。
- `GET /api/emails/records`：发送记录列表（按 campaign / 状态过滤）。
- `GET /api/emails/replies?confirm_status=pending`：回复列表。
- `POST /api/emails/replies/:id/confirm`：确认（可带修改后的摘要）。
- `POST /api/emails/replies/:id/ignore`：忽略。
- `POST /api/emails/replies/:id/retry-summary`：AI 总结失败后重试。

## 前端

- **CampaignKols 页**：工具栏加"发邮件"按钮与发送弹窗（模板选择、逐封预览编辑、发送结果展示）；列表 `outreach_status` 列展示新状态值。
- **邮件中心页**（新页面，路由 `/emails`）：三个标签页——发送记录 / 回复待确认 / 模板管理。
- **Settings 页**：新增"邮箱配置"区块（SMTP/IMAP/账号/授权码/默认抄送/轮询间隔/测试连接按钮）。

## 错误处理

- 未配置邮箱时调用发送接口返回 400「请先配置邮箱设置」。
- 批次内单封失败不中断，结果逐封返回。
- IMAP 认证失败连续发生时记错误日志，不 crash；设置页"测试连接"可提前暴露配置问题。
- LLM 总结失败不阻塞人工确认流程。

## 测试

- `server/routes/emails.test.js`（supertest，按现有测试惯例）：模板 CRUD、预览变量替换、发送（mock nodemailer）、无地址失败、确认/忽略回复的状态流转。
- `server/services/replyTracker.test.js`：mock IMAP 源，验证 In-Reply-To 精确匹配、发件人兜底匹配、未匹配不标已读。
- `server/utils/llm.test.js`：验证抽取后接口与 videos.js 原行为一致（以现有 videos 测试通过为准）。

## 依赖与迁移

- 新增依赖：`node-imap`（IMAP 轮询）。nodemailer 已在依赖中。
- 一个迁移文件：建四张新表、给 `prompt_templates` 加 `scene` 列并补默认值、seed 默认回复总结 prompt 模板，中文注释遵循 `20260711000001-add-chinese-database-comments` 先例。
