# KOL Campaign OS - 启动说明

## 开机自启（推荐）

一次配置后，每次开机/登录 Windows 都会自动在后台启动工作台，无需再双击任何脚本。浏览器收藏 `http://localhost:5001`，开机后直接打开书签即可。

1. 确保已安装 Docker Desktop，并在其设置中勾选 **Start Docker Desktop when you sign in**。
2. 在项目根目录 `.env` 中设置团队访问口令（局域网开放后必须）：

   ```
   APP_ACCESS_PASSWORD=你的团队口令
   ```

3. 右键 `注册开机自启.bat` → **以管理员身份运行**。它会：
   - 注册登录时自动启动的计划任务（隐藏窗口、后台运行）；
   - 注册每天 12:30 的数据库备份任务（备份在 `backups/daily/`，保留 14 天）；
   - 放行 Windows 防火墙 5001 端口（供团队局域网访问）；
   - 并立即在后台启动一次服务。
4. 建议把电源选项中的自动睡眠关闭，否则电脑睡眠时链接会打不开。

取消自启：右键 `取消开机自启.bat` → 以管理员身份运行。

- 你的书签：`http://localhost:5001`
- 团队成员书签：`http://<本机内网 IP>:5001`（建议在路由器为本机做 DHCP 固定 IP 绑定；团队成员需在同一局域网）
- 运行日志：`logs/service-<日期>.log`

> 注意：自启运行的是生产模式（后端直接托管 `client/build`，单端口 5001）。前端代码更新后需要执行一次 `npm run build` 才会生效。

## 快速启动（手动 / 调试用）

1. 确保已安装 Docker Desktop。
2. 在项目目录双击：

```bat
启动.bat
```

脚本会自动启动 MySQL 容器、安装依赖并运行前后端。首次运行可能需要几分钟。

也可以在项目目录按顺序运行：

```bash
npm run db:up
npm run install-all
npm run dev
```

## 访问地址

- 前端界面：http://localhost:3000（手动 dev 模式）
- 后端 API：http://localhost:5001
- 健康检查：http://localhost:5001/api/health

## 登录保护

- 在 `.env` 中设置 `APP_ACCESS_PASSWORD` 后，打开工作台会先出现登录页，输入团队口令即可进入（登录态保留 7 天）。
- 不设置该变量则不启用登录（仅限本机单人开发使用；团队/局域网场景请务必设置）。
- `/api/agent` 外部智能体接口仍使用原有的 Bearer Token，不受登录影响。

## 安装 Agent Skills

如果要让 Codex、Hermes、WorkBuddy、Kimi、Trae 等外部智能体使用 KOL Campaign OS，运行：

```bash
npm run install-skills
```

安装清单由 `skills/manifest.json` 管理。入口 skill 是 `kol-campaign-os-agent`，它会协同 `kol-strategy` 和 `kol-finder` 完成 KOL 策略 -> KOL 寻找 -> 候选池流程。

如果智能体使用自定义 skills 目录，可以指定目标：

```bash
npm run install-skills -- --target ~/.agents/skills
```

使用 skill 前请确认后端 API 已运行：`http://localhost:5001`。

推荐对外部智能体这样说：

```text
使用 KOL Campaign OS Agent，帮我为这个产品找 KOL。
产品 brief：...
```

## 停止应用

双击：

```bat
停止.bat
```

或在正在运行的终端窗口按 `Ctrl + C`。

## 当前 MVP

当前版本包含视频分析闭环和 KOL 寻找审批流：

```text
视频链接导入 -> 抓取表现数据/评论 -> AI 分析 -> 导出视频分析 XLSX
KOL 策略 -> KOL 寻找/Subagent 任务 -> 候选池 -> 人工通过
```

KOL 寻找已支持 System Provider 和 Subagent Hybrid 两种模式。Subagent Hybrid 会生成 YouTube / Google Web / Reddit / Seed / Instagram small batch 子任务和可复制 Prompt，由 Codex / WorkBuddy / 外部 agent 搜索后把 JSON 导入候选池。

Outreach、HTML 报告、完整自动网页登录搜索暂不在本版实现。
