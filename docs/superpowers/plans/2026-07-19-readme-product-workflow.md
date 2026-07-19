# README Product Workflow Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the outdated repository landing-page copy with a product-user-oriented explanation of the current KOL Campaign OS workflow and platform capabilities.

**Architecture:** This is a documentation-only change. `README.md` remains the single repository landing page and presents the end-to-end product workflow first, followed by platform behavior, capabilities, configuration, startup, Agent Skills, and product boundaries.

**Tech Stack:** GitHub-flavored Markdown, Node.js/npm commands, Docker Compose, React, Express, MySQL 8.

## Global Constraints

- Do not modify product code, APIs, database migrations, or UI.
- Preserve all unrelated tracked and untracked workspace changes.
- Describe Finder as video-first: content search → video evidence → AI analysis → author aggregation → Raw Candidate.
- Describe Instagram as Reels-only search and TikTok as Keyword Search only.
- Do not describe retired 7-round search, Subagent Hybrid, or Finder Subtasks as active features.
- Do not claim Outreach, multi-user authorization, desktop packaging, or automatic platform login.

---

### Task 1: Rewrite and verify the product-facing README

**Files:**
- Modify: `README.md`
- Reference: `package.json`
- Reference: `server/routes/settings.js`
- Reference: `server/utils/instagramReelSearch.js`
- Reference: `server/utils/tiktokKeywordSearch.js`

**Interfaces:**
- Consumes: Current npm scripts, provider configuration names, Finder evidence rules, and approved design spec.
- Produces: A GitHub landing page whose workflow and commands match the current `main` branch.

- [ ] **Step 1: Replace the opening with the current product workflow**

Use this exact workflow shape near the top of `README.md`:

```text
产品 Brief / 素材 → KOL 策略生成与人工确认
策略关键词 → 平台内容搜索 → 视频证据 → AI 分析
按作者聚合 → Raw Candidate → 人工审批 → KOL 管理 / 项目 KOL
```

Explain that candidates originate from relevant content evidence rather than profile-only search.

- [ ] **Step 2: Add the platform capability table**

Document these exact active paths:

```markdown
| 平台 | 第一版搜索入口 | 有效证据 |
| --- | --- | --- |
| YouTube | 关键词视频搜索 | YouTube 视频 / Shorts URL |
| Instagram | Reels Keyword Search | `https://www.instagram.com/reel/{shortcode}/` |
| TikTok | Keyword Search | `https://www.tiktok.com/@handle/video/{id}` |
```

State that valid evidence is analyzed by AI and grouped by author before Raw Candidate creation.

- [ ] **Step 3: Refresh capabilities, configuration, startup, and boundaries**

Keep these verified commands unchanged:

```bash
npm run db:up
npm run install-all
npm run dev
```

Describe the current settings groups: platform data providers, AI models, External Agent API, Feishu storage, and fallback/runtime policy. Keep the default frontend and backend URLs as `http://localhost:3000` and `http://localhost:5001`.

Keep Agent Skills installation with `npm run install-skills`, and clarify that external agents use the confirmed strategy and video-evidence workflow rather than retired Finder Subtasks.

- [ ] **Step 4: Run documentation accuracy checks**

Run:

```bash
rg -n "7 轮|Subagent Hybrid|Finder Subtasks|Instagram small batch" README.md
```

Expected: no matches.

Run:

```bash
rg -n "Reels Keyword Search|Keyword Search|视频证据|Raw Candidate|npm run db:up|npm run install-skills" README.md
```

Expected: every required concept and command appears.

Run:

```bash
git diff --check -- README.md
```

Expected: no output and exit status 0.

- [ ] **Step 5: Commit only the README**

```bash
git add README.md
git commit -m "docs: refresh README for video-first KOL workflow"
```

- [ ] **Step 6: Push the verified documentation update**

```bash
git push origin main
```

Expected: the remote `main` advances to the README commit without including unrelated workspace changes.
