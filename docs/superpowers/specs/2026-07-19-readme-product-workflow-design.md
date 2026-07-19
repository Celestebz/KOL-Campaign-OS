# README 产品工作流更新设计

## 目标

将仓库首页 README 从旧的功能罗列更新为面向产品使用者的最新说明，让首次访问者能够快速理解 KOL Campaign OS 的业务价值、当前端到端工作流、平台能力和启动方式。

## 受众

主要面向希望使用 KOL Campaign OS 完成 KOL 策略、寻找、筛选和管理的产品使用者。开发者信息保留在后半部分，但不作为首页叙事主线。

## README 信息架构

1. 产品定位与端到端主流程。
2. 当前业务工作流：策略确认、内容搜索、视频证据、AI 分析、作者聚合、Raw Candidate、人工审批、KOL 管理。
3. 平台能力表：YouTube、Instagram Reels、TikTok Keyword Search。
4. 当前功能模块。
5. API 配置要求。
6. Docker、本地安装和启动方式。
7. Agent Skills 使用方式。
8. 当前产品边界。

## 必须反映的最新行为

- Finder 坚持 video-first：先找到相关视频，再分析视频证据并识别作者。
- Instagram 第一版只搜索 Reels，不使用 Profile Search 作为 Finder 入口。
- TikTok 第一版只做 Keyword Search，证据 URL 必须是规范的 `https://www.tiktok.com/@handle/video/{id}`。
- 视频经过 AI 分析后按作者聚合，生成 Raw Candidate。
- Raw Candidate 需人工审批，通过后进入 KOL 管理和项目 KOL。
- YouTube、Instagram 和 TikTok 的 Finder 都围绕视频证据链工作。
- 统一 Agent 流程以策略输入与确认作为 Finder 的前置步骤。

## 删除或修正的旧描述

- 删除“7 轮搜索任务”。
- 删除仍在运行 “Subagent Hybrid / Finder Subtasks” 的描述；相关旧接口已经退役。
- 不再将 Instagram、TikTok 仅描述为平台 URL 识别能力。
- 不宣传尚未实现的 Outreach、多用户权限、桌面打包或自动登录平台。

## 准确性与验证

- 启动命令以根目录 `package.json` 为准。
- API 配置名称以当前设置路由和页面为准。
- 平台入口与证据规则以 Finder 工具及测试为准。
- 修改完成后检查 README 中不存在旧流程关键词，并核对 Markdown 结构和命令。

## 非目标

- 不修改产品代码、API、数据库或 UI。
- 不新增截图、徽章、路线图或部署承诺。
- 不重写独立开发者文档。
