# KOL Campaign OS

通用 KOL Campaign OS Web MVP。当前第一版聚焦视频分析 XLSX：

```text
视频链接导入 -> 抓取表现数据/评论 -> AI 分析 -> 导出 XLSX
```

## 当前功能

- KOL 管理雏形
- AI Prompt 模板管理
- 视频链接粘贴导入
- Excel / CSV 视频链接导入
- YouTube / Instagram / TikTok 平台识别
- 视频抓取任务和分析状态
- 视频分析结果 XLSX 导出
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

## API 设置

在页面 `API 设置` 中配置：

- YouTube Data API Key
- ScrapeCreators API Key
- Bright Data API Key（备用预留）
- Apify Token（备用预留）
- AI API Key / Base URL / Model

AI 默认兼容 OpenAI-style `/chat/completions` 接口，例如 DeepSeek。

## 第一版范围

- 不做完整 KOL Finder
- 不做 7 轮自动搜索
- 不做 Outreach
- 不做 HTML 报告
- 不做多用户权限
- 不做桌面 exe 打包

后续模块会基于当前视频分析和 KOL 管理底座继续扩展。
