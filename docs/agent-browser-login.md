# Skill 浏览器登录

首次使用：安装或更新 `kol-campaign-os-agent`，让 Agent 执行安装目录下的
`node scripts/os-client.cjs login`。客户端打开 `/agent/connect?code=…`；
用户在 OS 登录、核对连接码并允许连接。授权随后自动保存，不要求用户
复制 Token、配置环境变量或在聊天里输入密码。后续 `request` 自动认证和续期。
首次登录命令需要保留运行，等待用户在十分钟内确认；超时重新发起即可。

OS「设置 → Skill 连接」可按设备撤销；客户端 `logout` 撤销当前连接。
已存在的手动 Agent Token 保持兼容，新连接不读取或依赖它。
切换账号时先 `logout` 再 `login`，以免继续使用此前的账号。

## 权限和生命周期

- 仅接入原有 Agent API、Finder 明确允许的操作及邮件/达人 GET 白名单。
  不授予普通网页写接口、邮箱配置、审批或发送权限。
- 邮箱、会话、草稿仍归属授权用户；达人主库沿用现有共享模型。
- 设备请求十分钟失效；服务端只保存设备码和用户码的 SHA-256。
  客户端随机校验串对应的 SHA-256 challenge 绑定兑换；原始校验串不进入浏览器。
- 服务端事务锁保证审批后仅能兑换一次。用户需显式确认且浏览器写请求
  必须匹配 Origin；匿名创建/轮询/续期有限流，过期设备请求会分批清理。
- 访问凭据有效十五分钟，客户端在到期前或首次 401 后续期；长期授权
  最长九十天，届时重新登录。撤销、账号停用或账号 token_version 改变立即失效。
  服务端仅存凭据哈希。刷新请求在事务内再次检查账号状态和授权。
- Windows 本机缓存使用当前用户 DPAPI 加密；Unix 使用 0700 目录、0600 文件。
  缓存位于用户目录 `.kol-campaign-os/auth/`，按 OS origin 隔离，不写入仓库。
  网络故障不删除授权，也不把凭据写到命令行参数或日志。
- 验证网址来自当前 OS origin 下的固定相对路径，不接受第三方回调或跳转。
  生产应使用 HTTPS；当前历史 HTTP 地址不会因本次代码改动自动升级为 HTTPS。

## 发布

本分支基于当前生产修复 `c5a9540`，不包含未上线的产品任务功能。
新增迁移 `20261125000001-agent-browser-login.js` 只创建
`agent_login_devices` 和 `agent_login_grants` 两张表及其索引，不改历史业务记录。
部署前备份数据库并审阅迁移，使用项目 Umzug 的 `SequelizeStorage`
（`modelName: sequelize_meta`）显式执行该迁移；不要为了此次迁移运行其他待执行迁移。
切换新 release 并验证主系统和独立 Webhook 后，再更新本机安装的 Skill。

发布失败优先切回旧 release；新表可以保留，不能假定需要执行破坏性 down。
前端必须重新构建，否则登录授权页及撤销入口不可见。部署和生产迁移需另行确认。

## 验证

后端测试包括真实本地 HTTP 链路（浏览器批准 → 客户端换取授权 → 读取受保护
接口 → 自动续期 → 撤销拒绝）、并发单次兑换、过期/拒绝/账号状态、跨站拒绝、
Windows DPAPI 缓存和失败重试。测试不连接业务库，不启动真实邮箱任务。
MySQL 集成测试另见 `server/services/agentLogin.mysql.test.js`，须使用专用测试实例。

本地结果：23 项后端/客户端测试及 1 项真实 MySQL 8 专项通过。MySQL 测试使用
独立临时容器和随机测试数据库，验证后均清理；覆盖迁移、并发单次兑换、续期、
账号隔离和撤销，并修复了原始 Date 绑定参数的时区偏差。前端授权页及其余设置
回归共 9 项通过，生产构建成功，Skill 校验及
独立目录安装验证通过。原有 `edits Feishu project mappings with system campaign choices`
测试存在多个「系统项目」控件导致选择器歧义；用未修改的基线组件和测试重新
运行也复现失败，本次保留其原状。后续可通过显式设置
`KOL_AGENT_LOGIN_MYSQL_TEST=1`、`KOL_AGENT_LOGIN_MYSQL_HOST/PORT` 和测试实例
`DB_ROOT_PASSWORD` 重跑 MySQL 专项；它仅操作随机命名的测试数据库。
