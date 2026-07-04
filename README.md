# KOL Campaign OS

通用 KOL Campaign OS Web MVP。当前版本包含视频分析闭环、KOL Strategy、KOL Finder Raw Candidates 审批池，以及 Subagent Hybrid Finder 任务流。

```text
视频链接导入 -> 抓取表现数据/评论 -> AI 分析 -> 导出 XLSX
Strategy -> Finder/Subagent 任务 -> Raw Candidates -> 人工 Approve -> KOL Master / Campaign KOL
```

## 当前功能

- KOL 管理雏形
- AI Prompt 模板管理
- 视频链接粘贴导入
- Excel / CSV 视频链接导入
- YouTube / Instagram / TikTok 平台识别
- 视频抓取任务和分析状态
- 视频分析结果 XLSX 导出
- KOL Strategy 草稿、发布和 Finder Handoff
- KOL Finder 7 轮搜索任务
- Subagent Hybrid Finder：生成 YouTube / Google Web / Reddit / Seed / Instagram small batch 子任务和 Prompt
- Raw Candidates 审批池，Approve 后进入 KOL Master 和 Campaign KOL
- API Key 设置

## 技术栈

- 前端：React + Ant Design
- 后端：Node.js + Express
- 数据库：SQLite
- 表格：xlsx

## 启动

```powershell
npm run install-all
npm run dev
```

默认地址：

```text
前端：http://localhost:3000
后端：http://localhost:5001
```

## 安装 Agent Skills

如果要让 Codex、Hermes、WorkBuddy、Kimi、Trae 等外部智能体使用 KOL Campaign OS 工作流，运行：

```bash
npm run install-skills
```

安装清单由 `skills/manifest.json` 管理。当前入口 skill 是 `kol-campaign-os-agent`，它会按流程协同 `kol-strategy` 和 `kol-finder`。以后新增系统 skill 时，只需要更新 manifest。

如果智能体使用自定义 skills 目录，可以指定目标：

```bash
npm run install-skills -- --target ~/.agents/skills
```

使用 skill 前请先启动后端 API：`http://localhost:5001`。后端未运行时，skill 调用 API 会失败。

推荐对外部智能体这样说：

```text
使用 KOL Campaign OS Agent，帮我为这个产品找 KOL。
产品 brief：...
```

## API 设置

在页面 `API 设置` 中配置：

- YouTube Data API Key
- ScrapeCreators API Key
- Bright Data API Key（备用预留）
- Apify Token（备用预留）
- AI API Key / Base URL / Model

AI 默认兼容 OpenAI-style `/chat/completions` 接口，例如 DeepSeek。

## 当前范围

- 已实现 KOL Finder 任务和 Raw Candidates 审批流
- 已实现 Subagent Hybrid 混合模式：App 生成子任务和 Prompt，外部 agent/Codex 执行搜索后导入 JSON
- System Provider 模式保留，用于已配置的 YouTube / ScrapeCreators 等 provider
- 不做 Outreach
- 不做 HTML 报告
- 不做多用户权限
- 不做桌面 exe 打包

注意：Subagent Hybrid v1 不会在后端自动登录 Instagram、YouTube 或 Reddit；它负责拆任务、生成 Prompt、接收结果和入库审批。
