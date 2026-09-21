# 外部 Agent 找达人控制台

入口 `/discovery`；原始候选审核仍在 `/finder`。

## 用户流程

1. 选择项目、该项目中的产品、一个平台、1–50 人目标，填写具体要求。
2. 保存生成任务指令。此时是“等待 Agent 接手”，不启动搜索、不调用数据源。
3. 把指令交给安装了新版 `kol-campaign-os-agent` Skill 的外部 Agent。
4. Agent 自动领取、核验、导入证据、调用 OS 分析和生成 Raw 候选，逐阶段回报。
5. 在控制台打开本次 Raw 候选，人工决定是否加入项目。

无需创建、选择或发布策略。历史策略仅供旧流程查看。网页不会启动
Agent 进程。来源查询与附加条件核验由 Agent 完成，OS 保留原有证据
分析、入库和审批规则。依赖所选公开数据工具和 OS AI 服务可用。

## 接入

在 OS API 设置的 External Agent API 中配置当前用户的凭据，在外部
Agent 的安全配置中设置相同凭据。OS 地址由复制的任务指令提供；
凭据不随指令传输。Skill 在 `skills/kol-campaign-os-agent/`，详细协议见
`references/discovery-console.md`。现有本机 Skill 如有自定义内容，更新前保留。

用户会话 API：`/api/discovery-requests`（创建、列表、详情、cancel、retry）。
Agent API：`/api/agent/discovery-requests`（列表、详情、claim、progress、
evidence、evidence/import、analyze、generate）。Agent 没有审批、取消或重新排队接口。

需求按当前用户隔离。提交使用稳定 request_key 防重；领取使用
execution_id，并在 MySQL 事务中锁定需求、创建空 Finder 任务，重试不
新建重复任务。恢复保留该 Finder 任务。完成只表示一轮搜索结束，
不代表满足目标人数；候选数从 OS 数据读取。

停止会拒绝该需求后续的执行请求；已在处理的 HTTP 操作可能完成。
较久没有回报会提示用户检查 Agent，不会假定外部进程仍在线。

## 发布

新增迁移：`20260918000001-create-discovery-requests.js` 和
`20260918000002-discovery-without-strategy.js`，新增
`discovery_requests` 表及索引，并允许策略为空、保存产品上下文快照；不搬迁历史达人数据。生产需先备份数据库，
审阅并显式执行此迁移，再部署新 release、切换 current、重启主系统、
验证 health 和完整交接流程。按 AGENTS.md 另行取得生产修改确认。
旧 release 回退时可保留新表，不必执行会删除需求记录的 down 迁移。
不改动独立 webhook 服务。

## 验证

- `node --test services/discoveryRequests.test.js routes/discoveryRequests.test.js`
- `DISCOVERY_MYSQL_TEST=1 node --test services/discoveryRequests.mysql.test.js`
  （本机 127.0.0.1:3306、独立临时库；不使用现有 DB_NAME）
- 前端 DiscoveryConsole / RawCandidates 测试及生产构建。
- Skill quick_validate。

真实数据源及真实 Agent 的线上联调在发布后执行；本地验证不调用付费搜索。
