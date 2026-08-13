# 多邮箱接入设计（方案 A：email_settings 多行化）

日期：2026-08-07
状态：待评审

## 背景与目标

当前邮箱系统只支持单个邮箱：`email_settings` 表按单行使用，所有消费方以 `ORDER BY id LIMIT 1` 取配置；发件人固定为 `sender_name <username>`；收信只有一个 IMAP 连接和一个 `last_uid` 游标。

目标：支持接入多个邮箱（预计 2-3 个、同一服务商），按 Campaign 绑定发件邮箱，各邮箱独立收信，回复正确归属。

非目标（本期不做）：

- 多邮箱轮发与发送节流（原 P2/P3 规划，见 docs/邮件审批台-P1开发方案.md）
- 多用户/多成员各自的权限隔离
- 审批台逐封切换发件邮箱（发件邮箱由 Campaign 绑定决定，不提供逐封修改）

## 总体方案

将 `email_settings` 从"单行配置"升级为"每行一个邮箱"，现有数据自动迁移为默认邮箱。所有消费方从"取唯一一行"改为"按 mailbox_id 取行 / 取默认行 / 遍历所有启用行"。

## 数据层改动

### email_settings（新增字段）

| 字段 | 类型 | 说明 |
|---|---|---|
| `label` | VARCHAR | 邮箱别名，如"龙虾公司-企业邮"，列表展示用 |
| `is_default` | BOOLEAN DEFAULT false | 默认邮箱，全表至多一行（应用层保证） |
| `enabled` | BOOLEAN DEFAULT true | 停用后不新发、不同步收信，历史数据保留 |

已有字段沿用：`smtp_*`、`imap_*`、`username`、`password`、`sender_name`、`default_cc`、`sync_mode`、`poll_interval_minutes`、`last_uid`、`last_poll_at` —— 每行（每个邮箱）独立维护。

### 关联表（新增 mailbox_id）

- `campaigns.mailbox_id` INTEGER NULL → email_settings.id；NULL 表示使用默认邮箱
- `email_drafts.mailbox_id` INTEGER NULL —— 草稿创建时按 Campaign 绑定解析写入（回复类草稿继承原邮件的 mailbox_id）
- `email_records.mailbox_id` INTEGER NULL —— 发送时写入实际使用的邮箱
- `email_replies.mailbox_id` INTEGER NULL —— 收信入库时写入收到该邮件的邮箱
- `email_threads.mailbox_id` INTEGER NULL —— 按首封邮件的邮箱写入

### 迁移

新增一个迁移文件（命名沿用现有时间戳风格，如 `20260807000001-multi-mailbox.js`）：

1. `email_settings` 加 `label`、`is_default`、`enabled`；现有唯一行设为 `is_default=true, enabled=true, label='默认邮箱'`。
2. 上述五张表加 `mailbox_id` 列 + 索引。
3. 历史数据回填：`email_records` / `email_replies` / `email_threads` / `email_drafts` 的 `mailbox_id` 回填为默认邮箱 id（此前只有一个邮箱，归属明确）；`campaigns.mailbox_id` 保持 NULL（= 默认邮箱）。

## 服务端改动

### 设置 API（server/routes/emails.js）

- `GET /api/emails/settings`：返回邮箱列表（含 `id`、`label`、`is_default`、`enabled`，password 掩码）。前端同期改造，直接消费列表结构。
- `POST /api/emails/settings`：新增邮箱。
- `PUT /api/emails/settings/:id`：更新指定邮箱；保存后重启该邮箱的收信 worker。
- `DELETE /api/emails/settings/:id`：删除邮箱（仅当无关联 drafts/records 时允许；否则提示改用停用）。
- `POST /api/emails/settings/:id/default`：设为默认（同事务内清掉其他行的 `is_default`）。
- `POST /api/emails/settings/test`、`/test-imap`：改为接收完整配置或 `id`，测试指定邮箱。
- `GET /api/emails/settings/sync-status`：返回每个邮箱的同步状态数组。
- `POST /api/emails/settings/sync-now`：带 `id` 同步指定邮箱，不带则同步全部启用邮箱。
- **兼容**：不带 `id` 的 `PUT /settings` 保留旧行为（操作默认邮箱），避免破坏可能存在的脚本调用；`GET /settings` 直接返回列表（前端随本期一起升级，无旧消费者）。

### 发件链路

- `emailDraftSender.js`：发送时按草稿的 `mailbox_id` 取 settings 行（无则默认行），传给 `mailer.createTransporter`；`email_records.mailbox_id` 落库。
- `emailDrafter.js` / 草稿创建处：按 Campaign 的 `mailbox_id`（空→默认邮箱）解析并写入 `email_drafts.mailbox_id`；`sender_name` 改从该行读取。回复类草稿继承 `source_reply` 对应回复的 `mailbox_id`。
- `mailer.js` 无需结构改动（已按传入 settings 构建 transporter 和 from）。

### 收信链路

- `emailLiveSync.js`：改为按 `enabled=true` 的每个邮箱各维护一个 IDLE 连接和独立 `last_uid` 游标；`restartEmailSync()` 支持按 id 重启单个；`getEmailSyncStatus()` 返回数组。
- `emailReplyPoller.js`：轮询循环遍历启用且 `sync_mode='poll'` 的邮箱，各自更新 `last_poll_at`。
- 回复入库时写入 `mailbox_id`；按发件人匹配 `email_records`/`customers` 的逻辑不变（不同邮箱的客户群按业务线区分，天然不冲突）。

## 前端改动（client/src/pages/Emails.js）

- **邮箱配置 Tab**：单表单改为「邮箱列表 + 编辑表单」：列表展示各邮箱（label、地址、默认标记、启用开关、同步状态），支持新增/编辑/删除/设默认/测试 SMTP/IMAP/立即同步。屏蔽规则、收信状态卡片保持在列表下方，收信状态按邮箱分行展示。
- **Campaign 设置**：新增发件邮箱下拉（选项为启用中的邮箱，默认"使用默认邮箱"）。
- **审批台 / 邮件待办 / 审批记录**：列表项显示邮箱标识（label 或地址），并提供按邮箱筛选的下拉（服务端查询加 `mailbox_id` 参数）。
- `emailApi.js` 同步扩展；`Emails.test.js` 更新。

## 错误处理

- 删除默认邮箱：禁止，需先另设默认。
- 停用某邮箱：其草稿发送时回退到默认邮箱，接口返回 `warning` 字段，审批台弹出提示（如"绑定邮箱已停用，已改用默认邮箱发送"），发送人知情后仍可完成发送；其收信 worker 停止。
- 某邮箱 IMAP/SMTP 连接失败：只影响该邮箱的状态展示与同步，不阻塞其他邮箱。
- 邮箱被删但有历史记录：删除接口直接拒绝，引导停用，避免悬空 `mailbox_id`。

## 测试

- 服务端：设置 API 的增删改/设默认/兼容性（不带 id 操作默认邮箱）；发件按 Campaign 绑定取邮箱；多邮箱收信各自维护游标。
- 前端：更新 `Emails.test.js` 覆盖邮箱列表渲染与新增/编辑流程。
- 迁移：在测试库验证旧单行数据正确升级为默认邮箱、历史记录回填正确。

## 影响面清单（需改动的 `LIMIT 1` 消费方）

- `server/routes/emails.js`（getEmailSettings 及全部 settings 端点）
- `server/services/emailLiveSync.js`（约 7 处 getSettings 调用）
- `server/services/emailReplyPoller.js`（2 处）
- `server/services/emailDraftSender.js`
- `server/services/emailDrafter.js`（sender_name 读取）
