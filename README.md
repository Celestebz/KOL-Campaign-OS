# KOL Campaign OS

KOL Campaign OS 是一套以**内容证据**为核心的 KOL 策略、寻找、筛选与管理系统。它不会只按 Profile 名单猜测 KOL 是否合适，而是先找到与产品相关的视频，再通过 AI 分析内容证据、识别作者并生成候选人。

```text
产品 Brief / 素材 → KOL 策略生成与人工确认
策略关键词 → 平台内容搜索 → 视频证据 → AI 分析
按作者聚合 → Raw Candidate → 人工审批 → KOL 管理 / 项目 KOL
```

## 产品工作流

### 1. 创建并确认 KOL 策略

录入品牌、产品、市场、语言、目标受众和 Campaign 目标，也可以上传产品资料供 AI 分析。系统生成策略草稿后，由用户确认目标平台、搜索方向、内容信号和评分权重；只有已确认的策略才会进入 Finder。

### 2. 从相关内容寻找创作者

Finder 根据策略关键词在目标平台搜索相关视频。视频链接是内容证据，作者主页只用于确认身份，不作为独立证据。

| 平台 | 第一版搜索入口 | 有效证据 |
| --- | --- | --- |
| YouTube | 关键词视频搜索 | YouTube 视频 / Shorts URL |
| Instagram | Reels Keyword Search | `https://www.instagram.com/reel/{shortcode}/` |
| TikTok | Keyword Search | `https://www.tiktok.com/@handle/video/{id}` |

Instagram Finder 只搜索 Reels；TikTok Finder 只做 Keyword Search。无效链接、缺失作者、Photo Mode 等不能形成规范视频证据的结果不会进入候选链路。

### 3. 分析视频证据并按作者聚合

系统抓取视频及公开表现数据，通过 AI 判断竞品、品类、使用场景、功能和社群等证据信号。同一作者的多条有效视频会聚合在一起，再生成 Raw Candidate，避免把同一位创作者重复列为多个候选。

### 4. 人工审批候选人

Raw Candidate 保留来源视频、证据分析和推荐理由。候选人必须经过人工审批；通过后才会写入 KOL 管理，并可关联到对应项目的 KOL 列表。

## 当前能力

- 产品 Brief、素材分析与 KOL 策略草稿生成
- 目标平台、搜索方向、内容信号和评分权重确认
- YouTube 关键词视频搜索
- Instagram Reels Keyword Search
- TikTok Keyword Search
- 视频链接粘贴导入及 Excel / CSV 批量导入
- YouTube、Instagram、TikTok 视频链接识别与规范化
- 视频公开数据、评论抓取和 AI 内容分析
- 视频证据去重、证据信号记录和按作者聚合
- Raw Candidate 生成、筛选和人工审批
- KOL 主库与项目 KOL 管理
- 视频分析结果 XLSX 导出
- API Provider、AI 模型、External Agent 和飞书存储设置

## API 设置

在应用的 `API 设置` 页面配置运行所需服务：

- **平台数据源**：YouTube、Instagram、TikTok 分别设置主 Provider 和可选备用 Provider
- **AI 模型**：OpenAI、DeepSeek、MiniMax 或兼容 OpenAI / HTTP API 的自定义模型
- **External Agent API**：为 Codex 等外部 Agent 配置访问 Token
- **云端存储**：配置飞书多维表格作为已通过 KOL 的云端主库
- **运行与备用策略**：控制 Provider Fallback、失败原因和原始响应记录

默认组合为 YouTube Data API、ScrapeCreators（Instagram / TikTok）以及 DeepSeek。实际运行前，请在页面中填写所选 Provider 的 API Key、Base URL 或模型信息。

## 本地启动

### 环境要求

- Node.js 与 npm
- Docker Desktop
- 可用的平台数据源及 AI API 凭证

### 安装并运行

1. 启动 MySQL 8：

```bash
npm run db:up
```

2. 安装根目录、后端和前端依赖：

```bash
npm run install-all
```

3. 同时启动前端和后端：

```bash
npm run dev
```

默认地址：

```text
前端：http://localhost:3000
后端：http://localhost:5001
```

停止数据库服务：

```bash
npm run db:down
```

## 使用 Agent Skills

如需让 Codex、Hermes、WorkBuddy、Kimi、Trae 等外部智能体使用 KOL Campaign OS 工作流，可安装仓库自带 Skills：

```bash
npm run install-skills
```

安装清单由 `skills/manifest.json` 管理，入口为 `kol-campaign-os-agent`，并协同 `kol-strategy` 和 `kol-finder`。如需指定自定义 Skills 目录：

```bash
npm run install-skills -- --target ~/.agents/skills
```

使用前需启动后端并在 `API 设置 → External Agent API` 中配置 Token。外部 Agent 读取已确认的策略后，也必须遵守同一条视频证据链：为单一目标平台创建 Finder Task、导入目标平台视频、执行证据分析，再从已分析的视频证据生成候选；不能直接写入或审批 Raw Candidate。

推荐指令：

```text
使用 KOL Campaign OS Agent，帮我为这个产品找 KOL。
产品 brief：...
```

## 技术栈

- 前端：React + Ant Design
- 后端：Node.js + Express
- 数据库：MySQL 8 + Docker Compose
- 表格导入导出：xlsx

## 当前产品边界

- Finder 目前支持 YouTube 关键词视频、Instagram Reels 和 TikTok Keyword Search
- Profile URL 只用于作者身份识别，不作为视频证据
- 候选审批始终由人工完成，Agent 不得自动通过候选
- 候选池默认保存在本地；已通过 KOL 可配置同步至飞书多维表格，KOL 管理页也支持从飞书 KOL 总表导入回本地
- 暂不提供 Outreach、多用户权限和桌面安装包
- 系统不会代替用户自动登录 Instagram、YouTube 或 TikTok
