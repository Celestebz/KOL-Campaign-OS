# KOL Campaign OS - 启动说明

## 快速启动

在项目目录双击：

```bat
启动.bat
```

首次运行时脚本会自动安装依赖，可能需要几分钟。

也可以在项目目录运行：

```bash
npm run dev
```

## 访问地址

- 前端界面：http://localhost:3000
- 后端 API：http://localhost:5001
- 健康检查：http://localhost:5001/api/health

## 安装 Agent Skills

如果要让 Codex、Hermes、WorkBuddy、Kimi、Trae 等外部智能体使用 KOL Campaign OS，运行：

```bash
npm run install-skills
```

安装清单由 `skills/manifest.json` 管理。入口 skill 是 `kol-campaign-os-agent`，它会协同 `kol-strategy` 和 `kol-finder` 完成 Strategy -> Finder -> Raw Candidates 流程。

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

当前版本包含视频分析闭环和 KOL Finder 审批流：

```text
视频链接导入 -> 抓取表现数据/评论 -> AI 分析 -> 导出视频分析 XLSX
Strategy -> Finder/Subagent 任务 -> Raw Candidates -> 人工 Approve
```

KOL Finder 已支持 System Provider 和 Subagent Hybrid 两种模式。Subagent Hybrid 会生成 YouTube / Google Web / Reddit / Seed / Instagram small batch 子任务和可复制 Prompt，由 Codex / WorkBuddy / 外部 agent 搜索后把 JSON 导入 Raw Candidates。

Outreach、HTML 报告、完整自动网页登录搜索暂不在本版实现。
