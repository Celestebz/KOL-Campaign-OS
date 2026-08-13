# 多用户体系需求记录（搁置中，备案通过后启动）

- 记录日期：2026-08-06
- 状态：需求冻结待启动（等域名 ICP 备案通过）

## 已确认的决策（2026-08-06 brainstorm）

1. 邀请码注册（管理员生成邀请码，不做开放注册、不做注册后审批）
2. 废弃团队口令，改为账号密码登录；管理员/成员两级
3. 每用户独立设置：API key、飞书等各自一套；读设置"先查当前用户、回落管理员（系统默认）"；后台任务固定用管理员设置
4. 一次做完，不分期

## 数据共享模型（2026-08-06 补充，用户明确诉求）

核心原则：**共享资源池 + 私有工作区**。

### 共享（所有用户只读同一份）

- KOL Master 基础资料：主页、粉丝数、播放表现等客观数据
- 视频内容与 AI 分析结果（视频证据、分析结论）
- 共享字段不允许普通编辑，避免互相覆盖

### 私有（每用户独立，互不可见）

- 邮件：邮箱账户（IMAP/SMTP）走每用户独立设置；邮件记录、回复、待办归属各自项目
- 项目/活动及其全部过程数据：候选池、项目状态、触达记录、合作进展、审批草稿
- KOL 的"主观层"：备注、评级、合作状态、个人标签——**每用户一层私有注解**，同一 KOL 页面上各自看到并编辑自己的那层，互不覆盖（不采用 last-write-wins）

### 设计要点（开工时展开为正式 spec）

- users / invite_codes 表；api_settings 加 owner_user_id（NULL=管理员默认）
- 业务表（campaigns / campaign_kols / email_records / approval_items 等）加 owner_user_id 维度；共享表（customers 客观字段、videos、video_ai_analysis_results）不加
- customers 的私有注解层：新表（如 kol_annotations: customer_id + owner_user_id + notes/rating/status）
- 列表/详情查询统一过"共享 + 我的私有层"的组装

## 启动信号

域名备案通过 → 用户说"做多用户"→ 从本记录出正式 spec → writing-plans。
