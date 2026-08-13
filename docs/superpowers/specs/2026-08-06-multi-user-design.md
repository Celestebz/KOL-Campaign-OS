# 多用户体系设计：共享资源池 + 私有工作区

- 日期：2026-08-06
- 状态：待评审
- 前置：`docs/superpowers/specs/2026-08-06-multi-user-requirements-notes.md`（需求记录）
- 范围：团队密码外层门禁（保留）+ 邀请码注册 + 账号密码登录、管理员/成员两级、每用户独立设置（含回落）、业务数据按用户隔离、KOL 私有注解层。

## 1. 目标

- 双层门：团队密码外层门禁（保留）+ 个人账号内层身份；管理员邀请码注册制。
- **共享面**：KOL 资源库、内容分析（视频/AI 分析）、产品目录、项目管理、KOL 合作——所有登录用户看到并操作同一份（协作防重复触达）。
- **私有不共享**：工作台、KOL 寻找（Finder 任务与 Raw Candidates）、邮件中心（各配各的邮箱，各看各的信与审批）、系统设置（每用户独立，未配置项回落系统默认）。
- 同一 KOL 的备注/评级/合作状态/报价等主观字段每用户一层，互不覆盖。
- 成员数据对管理员也不可见（最大隐私模型）；管理员对成员的管理仅限账号元数据与邀请码。

## 2. 数据模型

### 2.1 新增表

**users**
| 列 | 类型 | 说明 |
|---|---|---|
| id | INT PK | |
| username | VARCHAR(50) UNIQUE | 登录名（字母数字下划线，不区分大小写存储为小写） |
| display_name | VARCHAR(100) | 展示名 |
| password_hash | VARCHAR(255) | scrypt（Node 内置 crypto，不加依赖）：`scrypt$N$r$p$salt$hash` |
| role | VARCHAR(20) | `admin` / `member`；首个用户为 admin，其后仅 admin 可改角色 |
| status | VARCHAR(20) | `active` / `disabled` |
| token_version | INT default 1 | 改密/停用时 +1，使旧 cookie 失效 |
| created_at / updated_at | DATE | |

**invite_codes**
| 列 | 类型 | 说明 |
|---|---|---|
| id | INT PK | |
| code | VARCHAR(32) UNIQUE | 16 位随机（`crypto.randomBytes(8).toString('hex')`） |
| note | VARCHAR(255) | 备注（给谁用） |
| max_uses | INT default 1 | |
| used_count | INT default 0 | |
| expires_at | DATE NULL | |
| created_by | INT | users.id |
| created_at | DATE | |

**kol_user_annotations**（KOL 私有注解层）
| 列 | 类型 | 说明 |
|---|---|---|
| id | INT PK | |
| customer_id | INT | |
| owner_user_id | INT | |
| rating | VARCHAR(50) NULL | 评级 |
| notes | TEXT NULL | 备注 |
| cooperation_status | VARCHAR(50) NULL | 合作状态（私有口径） |
| cooperation_risk_category / cooperation_risk_reason | VARCHAR/TEXT NULL | 风险标记 |
| video_price | DECIMAL NULL | 报价 |
| price_rmb | DECIMAL NULL | |
| UNIQUE(customer_id, owner_user_id) | | 每用户每 KOL 一行 |

读取规则：`COALESCE(我的注解列, customers 共享列)`；写入规则：登录用户一律写自己的注解行（upsert），共享列仅后台任务/数据同步可写。

### 2.2 加 `owner_user_id` 列的表（私有工作区）

`email_records`、`email_replies`、`email_drafts`、`email_draft_versions`、`email_threads`、`email_bounces`、`email_settings`、`email_templates`、`email_filter_rules`、`approval_items`、`automation_runs`。

- 列定义：`owner_user_id INT NULL`（NULL = 系统/管理员域），加普通索引。
- 现有全部数据迁移为 NULL（系统域），管理员账号直接继承——你当前的一切数据原样可用。
- 对应菜单：**邮件中心（含审批台）、工作台（各自看待办与邮件指标）、系统设置**。

### 2.3 共享表（不加 owner，所有用户读写同一份）

**业务共享**：`campaigns`、`campaign_products`、`campaign_kols`、`campaign_kol_products`、`campaign_videos`、`campaign_kol_events`、`kol_strategies`、`confirmed_campaign_kol_collaboration`、`confirmed_campaign_kol_videos`——即「项目管理」和「KOL 合作」两个菜单的全部数据，两人看到并操作同一批记录（防重复触达）。

**资源库共享（只读为主）**：`customers`（客观字段）、`kol_platform_accounts`、`video_sources`、`video_snapshots`、`video_comments`、`video_ai_analysis_results`、`kol_youtube_snapshot_videos`、`products`、`prompt_templates`、`customer_groups`。

**基础设施共享**：`finder_search_cache`、`finder_query_cursors`、`finder_query_ledger`（发现缓存与产出台账全员共享，避免重复消耗外部 API 额度）。

注意：KOL 合作/项目数据为全员可写共享（协作性质，防重复触达优先）；`customers` 的主观字段（备注/评级/合作状态/报价）仍走每用户私有注解层（2.1 kol_user_annotations），互不可见。

### 2.4 api_settings

加 `owner_user_id INT NOT NULL DEFAULT 0`（**0 = 系统默认**；此处用 0 哨兵而非 NULL，因为 MySQL 唯一索引把 NULL 视为互不相等，无法约束重复系统行）。同时**把现有 `provider` 单列唯一索引替换为 `UNIQUE(provider, owner_user_id)`**——不替换则无法保存多个用户的同名 provider 设置。读取顺序：当前用户的行 → owner=0 行 → legacy key 行。写入：成员写 owner=自己 id 的行；管理员写 owner=0 行（系统默认）。业务表的 owner 列仍用 NULL 表示系统域（无唯一约束问题），仅 api_settings 用 0 哨兵。

## 3. 认证与会话（双层门）

- **外层团队密码（保留）**：沿用现有机制不变——`APP_ACCESS_PASSWORD` 校验通过后签发 v1 门禁 cookie。不知道团队密码的人连登录/注册页的数据接口都摸不到。
- **内层个人账号**：门禁通过后再用账号密码登录，签发用户会话 cookie（`v2.<uid>.<token_version>.<expires>.<sig>`，签名密钥 `SESSION_SECRET`，缺省回退 APP_ACCESS_PASSWORD）。`authGuard` 对 /api/* 要求**两个 cookie 都有效**；用户会话失效（改密/停用/token_version 变更）时仅内层需重登，外层 cookie 不动。
- **注册**：页面在外层门禁之后，仍需**邀请码**（管理员在「用户与邀请」页生成，次数/有效期可控）。即"口令进门 + 邀请码注册 + 此后账号密码登录"。
- **登录限流**：账号密码连续 5 次失败锁 15 分钟（内存计数器，按 IP+用户名）。
- **初始化引导**：`users` 为空时，门禁后的页面显示"初始化管理员"（用户名+密码），首个 admin 创建后入口关闭。
- **改密/停用**：用户可改自己密码（验旧密）；admin 可停用/启用成员、重置成员密码、改角色。bump `token_version` 使该用户全部会话失效。
- **External Agent API**（`/api/agent/*` Bearer token）不受影响，操作归属系统域（owner NULL，即管理员工作区）。

## 4. 设置隔离与回落

- `aiClient.getSetting(key, legacyKeys, userId)`：先查 `(provider=key, owner_user_id=userId)`，再查 `(provider=key, owner_user_id IS NULL)`，再 legacy。
- 写路径（settings 路由）：成员写 owner=自己的行；admin 写 owner NULL 行（系统默认）。
- 消费点全部改为传当前用户：`fetchVideoData`、finder 各适配器、`youtubeIntakeSnapshot`（由谁触发用谁）、邮件发送等。HTTP 请求链路从 `req.user.id` 取。
- **后台任务分两类**：通用后台任务（intake 快照、finder 自动化等无用户上下文的执行体）固定使用系统默认（NULL 行，即管理员维护的配置）；**邮件同步是特例**——邮箱本身是每用户资源，后台轮询按"每个配有 IMAP 的用户"分别轮询各自邮箱，产生的邮件记录写入对应 owner。

## 5. 数据可见性规则

- 中间件把 `req.user` 注入；约定助手 `ownerScope(req)` 返回当前用户 id。
- **私有表**（2.2 节：Finder、邮件、审批、工作台相关）所有读写必须带 owner 条件。**归属规则**：管理员新建写 NULL（系统域即管理员域）；成员新建写自己的 id。**可见范围**：管理员 `owner_user_id IS NULL OR owner_user_id = 自己`；成员仅 `owner_user_id = 自己`。**管理员也看不到成员的私有数据**（2026-08-06 评审确认）。成员被停用后其私有数据保留但无人可见，V1 不做数据转移/删除工具。
- **共享业务表**（2.3 节：项目/合作/资料库）：全员可见可写，不按用户过滤。这是协作面——谁触达过哪个 KOL、进展到哪一步，两人看到同一份，避免重复触达。
- **customers 主观字段**（备注/评级/合作状态/报价）：每用户私有注解层，互不可见（2.1）。
- Agent API（/api/agent/*）归属系统域；其读写的共享表（KOL Master、活动候选池）本就共享，行为不变。

## 6. 前端

- **登录流程（两层）**：先输团队密码（外层门禁，沿用现有页面）；通过后进入账号登录页（用户名+密码），`users` 为空时显示初始化管理员表单；附"注册"链接。
- **注册页**：用户名/昵称/密码/邀请码。
- **用户与邀请**（仅 admin 菜单可见）：用户列表（启用/停用/重置密码/改角色）、邀请码生成（次数/有效期/备注）与作废。
- **设置页**：UI 不变，保存/读取自动带当前用户；页面顶部一行小字提示"未配置的项使用系统默认"。
- **KOL 详情/列表**：备注、评级、合作状态、报价字段读写走注解层（"我的备注"语义）；客观字段只读。
- **我的账号**：修改密码、查看自己的邀请码使用记录（admin）。

## 7. 迁移与兼容

1. 新增三表 + 各私有表加 `owner_user_id` 列（一个迁移文件，全部 additive，无 DROP）。
2. 现有数据 owner 全部置 NULL（系统域）——管理员登录后看到的就是现在的全部数据。
3. 现有 api_settings 行 owner 置 NULL（成为系统默认）。
4. 部署后首次访问：输团队密码过外层门禁 → 初始化管理员（用户名 + 密码）。团队密码继续作为外层门禁保留，不废弃。
5. 本地开发：无用户时 `authGuard` 不再因 APP_ACCESS_PASSWORD 为空而全放行——开发环境也需先初始化管理员（与生产行为一致，避免两套逻辑）。

## 8. 测试

- users/invite 模型与迁移：注册流程（好码/坏码/过期/超次）、首个 admin 引导、停用后旧 cookie 失效、改密后旧 cookie 失效。
- authGuard：无会话 401、v1 老 cookie 401、agent 路由放行、健康检查放行。
- 设置回落：用户行 > NULL 行 > legacy；成员写不污染系统默认；admin 写即默认。
- 隔离：A/B 两用户互不可见对方活动/邮件/候选；注解层 COALESCE 读取与 upsert 写入；共享表双方同读。
- 后台任务：邮件轮询使用系统默认邮箱配置；成员的邮箱配置产生成员域邮件记录。

## 9. 实施顺序与上线门禁

按依赖关系分七步实施（评审确认的顺序）：

1. 数据库迁移与登录（三新表 + owner 列 + api_settings 唯一索引调整 + 认证/会话/引导）
2. 活动与候选隔离（campaigns 及其下游全部私有表的读写带 owner）
3. KOL 私有注解层
4. 设置隔离（含读取回落全消费点改造）
5. 多邮箱同步（按用户分别轮询，风险最高，单独成步）
6. 前端用户管理与注册页
7. 隔离回归测试（双用户交叉验证）

**上线门禁**：第 7 步双用户隔离测试全部通过前，不开放任何成员注册（不生成有效邀请码），防止读到/改到他人数据。此外所有走裸 SQL 的查询点（email 模块、approval、agent 路由等）必须逐一过清单核对，不允许"模型改了、裸 SQL 漏了"。

## 10. 非目标

- 更细粒度权限（只读成员、按活动授权）、操作审计 UI、找回密码（无邮件外发场景，admin 重置即可）、SSO/第三方登录、每用户独立数据库。
- 去掉外层团队密码只做单层账号（本轮明确保留双层门）；开放注册（无需邀请码）。
