# KOL Campaign OS 智能体规则

## 修改确认

- 开始修改项目代码、配置或数据库之前，必须先取得用户明确确认。
- 只读检查、诊断和整理不需要修改项目时，可以直接执行。

## 服务器优先

- KOL Campaign OS 的正式运行数据以生产服务器为准。
- 当用户询问系统数据、运行状态、日志、任务结果、邮件状态或线上性能时，默认通过 SSH 查询服务器，不使用本地数据库推断线上状态。
- 生产服务器：`codexdiag@59.110.45.218`。
- 主系统当前版本：`/opt/kol-campaign-os/current`。
- 发布目录：`/opt/kol-campaign-os/releases/`。
- systemd 服务：`kol-campaign-os.service`。
- 默认只读检查生产数据库、日志和运行状态；修改生产数据或配置前必须再次取得用户明确确认。
- 不得在输出中显示密码、Cookie、API Key、Token 或其他密钥值。

## 代码与部署

- 代码修改仍在本地 Git 工作区完成，不直接修改生产服务器中的代码。
- 修改后应运行与风险相称的测试，提交并推送 GitHub，再通过新的 release 部署。
- 禁止直接编辑 `/opt/kol-campaign-os/current`；该路径只能作为 release 的符号链接切换。
- 部署前应备份数据库，审阅并执行迁移，然后切换 `current`、重启服务并验证健康状态。
- 发布失败时优先切回旧 release；数据库迁移不能假定可直接回滚。
- sudo 仅使用用户临时授权；部署完成后必须撤销临时 sudo，并验证授权已失效。

## Webhook 隔离

- `/opt/webhook-service` 与 KOL Campaign OS 主系统独立，不属于 GitHub 主项目发布包。
- PM2 进程 `feishu-webhook` 不得因主系统检查、修改或部署而重启。
- 不得修改、覆盖、移动或删除 `/opt/webhook-service`，除非用户明确要求处理 Webhook。
- 主系统部署后应只读验证 `feishu-webhook` 仍在线及其健康接口正常。

## 业务边界

- KOL Campaign OS 系统管理和 NoxInfluencer 没有关系。
- 不得因为主系统维护任务而调用或修改 NoxInfluencer 工作流、数据或配置。
