# 飞书 KOL 总表导入设计

## 背景

系统已支持把本地 KOL 主库、项目和项目 KOL 推送到飞书多维表格（`POST /api/sync/feishu/push`），但方向是单向的。用户把飞书多维表格配置为云端存储后，飞书 KOL 总表里已有的数据无法进入系统，只能在本地重新录入或走 XLSX 批量导入。

## 目标

- 提供「从飞书导入」能力：读取已配置的飞书 KOL 总表，把记录导入本地 `customers` 表。
- 已在本地存在的记录（相同 `feishu_record_id`、相同 `creator_id`、或相同 KOL 名称 + 平台）以飞书为准更新本地字段。
- 不存在的记录新建为本地 KOL。
- 入口放在 KOL 管理页工具栏，与「批量导入」并列。
- 导入成功的记录回写 `feishu_record_id` 并标记 `sync_status = 'synced'`，后续推送走更新而不是新建。

## 非目标

- 不导入飞书项目表和项目 KOL 子表。
- 不做定时或自动双向同步，导入只由用户手动触发。
- 不删除本地多出、飞书没有的 KOL。
- 不修改现有推送逻辑、字段和飞书配置结构。
- 不新增数据库表或迁移；`customers` 现有字段足够。

## 方案选择

采用「后端拉取 + 服务端去重合并」方案，与现有推送共用同一份飞书配置和凭证：

- 新增 `POST /api/sync/feishu/pull`，复用 `getFeishuConfig` / `getTenantAccessToken` / `fetchJson`。
- 通过飞书分页接口拉取 KOL 总表全部记录：

```text
GET /open-apis/bitable/v1/apps/{app_token}/tables/{kol_table_id}/records?page_size=100[&page_token=...]
```

- 在服务端把飞书字段映射为 `customers` 列，一次性读出本地全部 KOL 做内存匹配，再逐条 INSERT 或 UPDATE。

该方案不引入新依赖、不改数据库结构，匹配逻辑放在服务端纯函数里，便于用 `node --test` 做 TDD。

## 字段映射

飞书字段值需要容错提取：文本字段可能是字符串或 `[{ text }]` 片段数组，超链接字段是 `{ link, text }` 对象，数字字段可能是数字。统一由纯函数 `feishuFieldToText` 提取为字符串。

| 飞书字段 | customers 列 |
| --- | --- |
| KOL名称 | name |
| 平台 | platform |
| creator_id | creator_id |
| 联系人 | contact_name |
| YouTube主页 | youtube_url |
| YouTube粉丝量 | youtube_followers |
| Instagram主页 | instagram_url |
| Instagram粉丝量 | instagram_followers |
| TikTok主页 | tiktok_url |
| TikTok粉丝量 | tiktok_followers |
| Email | email |
| 国家地区 | country_region |
| 内容类型 | creator_type |
| 备注 | notes |

飞书没有对应字段的本地列（分组、合作状态、风险、价格等）保持不动；新建记录走数据库默认值。

## 匹配与合并

对每条飞书记录按以下顺序匹配本地 KOL，命中即更新：

1. `feishu_record_id` 等于飞书 `record_id`；
2. 两边 `creator_id` 均非空且相等；
3. 两边 `email` 均非空且相等（`customers.email` 有唯一约束，是可靠身份键；比较忽略大小写）；
4. 任一组非空主页链接相同（`youtube_url` / `instagram_url` / `tiktok_url`，比较忽略大小写和末尾斜杠）；
5. `name` 和 `platform` 同时相等（`platform` 为空时只按名称匹配视为不可靠，不参与匹配）。

本地记录身份字段全空时，第 4 条是最后的兜底；主页链接几乎不会撞车，误合并风险极低。若全部规则都未命中才新建记录——宁可产生可见的重复，也不冒错误覆盖的风险。

- **命中**：只 UPDATE 映射覆盖的列，同时回写 `feishu_record_id`、`sync_status = 'synced'`、`last_synced_at`。未被映射的列保持原值。
- **未命中**：INSERT 新记录，映射列 + `feishu_record_id` + `sync_status = 'synced'` + `last_synced_at`。
- **飞书记录缺少 KOL名称**：跳过并计入 `skipped`（`name` 是必填列）。
- **单条失败**（如 Email 唯一约束冲突）：捕获错误计入 `errors`，不中断整批导入。

## API

```text
POST /api/sync/feishu/pull
```

无请求体。响应：

```json
{
  "success": true,
  "data": {
    "fetched": 12,
    "created": 5,
    "updated": 6,
    "skipped": 1,
    "failed": 0,
    "errors": [{ "record_id": "rec...", "error": "..." }]
  }
}
```

飞书未配置（缺 App ID / App Secret / Base Token / KOL 总表 ID）时返回 400 与缺失项说明，与推送路由一致。

## 用户界面

KOL 管理页（`client/src/pages/Customers.js`）工具栏在「批量导入」旁新增「从飞书导入」按钮：

- 点击后进入 loading，调用 `POST /api/sync/feishu/pull`；
- 成功：`message.success` 展示「从飞书导入完成：新增 X，更新 Y，跳过 Z，失败 N」，随后刷新列表；
- 有失败但部分成功：用 `message.warning` 展示相同统计；
- 请求失败：`message.warning` 展示后端错误（如「飞书未配置」），本地数据不变。

按钮文案使用中文，图标用 `CloudDownloadOutlined`。

## 错误处理

- 飞书配置缺失：400，提示缺失配置项，本地不变。
- 拉取分页中途失败：整次请求失败并返回飞书错误信息，已写入的本批数据保留（与推送的逐条容错一致，单条写入失败才计入 `errors`）。
- 飞书字段为空：对应本地列写入 `null` 或保持默认，不报错。
- 前端请求失败：保留当前列表，仅提示。

## 测试

后端（`node --test`）覆盖：

- 字段提取：字符串、片段数组、超链接对象、数字、空值；
- 匹配优先级：`feishu_record_id` > `creator_id` > 名称 + 平台；
- 命中更新只写映射列并回写 `feishu_record_id` 与 `synced`；
- 未命中新建；
- 缺 KOL名称跳过；
- 单条写入失败计入 `errors` 且不影响其他记录；
- 分页 `has_more` + `page_token` 拉取多页；
- 未配置返回 400。

前端（Jest + Testing Library，新建 `Customers.test.js`）覆盖：

- 点击「从飞书导入」调用 `/api/sync/feishu/pull` 并刷新列表；
- 成功统计通过 message 展示；
- 接口报错时展示后端错误信息。

最后运行服务端全量测试、相关前端测试和生产构建。

## 验收标准

- 配置好飞书 KOL 总表后，点击「从飞书导入」即可把总表记录导入 KOL 管理页。
- 重复导入不产生重复记录；飞书侧修改过的字段再次导入会更新本地。
- 导入过的 KOL 再推送回飞书时是更新原记录，不会新建。
- 本地已有的合作状态、分组等飞书没有的字段不受导入影响。
- 未配置飞书时按钮给出明确错误提示，本地数据不变。
