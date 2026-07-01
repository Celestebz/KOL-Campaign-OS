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

## 停止应用

双击：

```bat
停止.bat
```

或在正在运行的终端窗口按 `Ctrl + C`。

## 当前 MVP

第一版只做视频分析闭环：

```text
视频链接导入 -> 抓取表现数据/评论 -> AI 分析 -> 导出视频分析 XLSX
```

KOL Finder、7轮搜索、Outreach、HTML 报告先预留，不在本版实现。
