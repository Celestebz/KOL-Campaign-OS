# Instagram Reel Finder Final Fix Report

日期：2026-07-17

## 结果

最终审查中的 5 条 Important findings 已全部修复并覆盖；Minor 中确认无调用的旧 `scrapeCreatorsFinderAdapter()` 已删除。未删除任何用户数据文件，未覆盖或暂存 `server/routes/finderTasks.js` 与 `server/routes/finderTasks.test.js` 中开始前已存在的用户 hunks。

## Finding 对应

### Important 1：URL 与 username 校验

- Reel URL 仅接受 `http:` / `https:`。
- host 仅接受 `instagram.com` 与 `www.instagram.com`，拒绝 deceptive hostname。
- pathname 严格限制为 `/reel/<shortcode>`（可有结尾 `/`），拒绝额外路径。
- username 限制为 1–30 位字母、数字、`.`、`_`；`/`、`?`、`#`、`-` 与超长值均拒绝。
- utility tests 覆盖非 HTTP、欺骗 host、非法 pathname 和非法 username。

### Important 2：官方 view-count 字段与零值

- 按 `video_play_count`、`play_count`、`video_view_count`、`view_count`、`views` 顺序读取首个已定义指标。
- 不再用 `||` 选择播放量，因此合法数字 `0` 保留为 `'0'`。
- 官方响应风格的 `reels` fixture 覆盖优先级与零值。

### Important 3：错误分类与任务可见错误

- Instagram adapter 分别统计上游 Reel 数和可映射 candidate 数。
- API 成功但 0 Reels 与“返回 Reels 但全部无效/不可映射”使用不同错误。
- 缺失 API Key 与非成功 HTTP 响应保留原始摘要。
- `processVideoEvidenceTask()` 把 discovery 原始错误写入失败任务的 `error_message`，同时继续保存 `provider_attempts` 与 `raw_response_summary`。
- YouTube/TikTok 的 provider 选择、评分、候选门槛与审批语义未改；通用变化仅是失败任务保留原始 discovery error。

### Important 4：自动发现集成覆盖

- Router 暴露 `runVideoEvidenceDiscovery(taskId)` 这一小型测试 seam；生产后台执行和测试调用共用真实 `processVideoEvidenceTask()` 实现。
- 集成测试使用本地 mock ScrapeCreators 与 mock AI，未手工导入 Instagram evidence。
- 断言所有 ScrapeCreators 请求均为 `GET /v2/instagram/reels/search`，带 `X-API-Key`，不带多余 Authorization，且任务输出不包含 key。
- 官方响应 fixture 经真实 adapter 映射后持久化，`video_play_count: 0` 保留。
- 两个 canonical-equivalent Reel URL 复用一个 `video_source`；同作者两条不同 Reel 保留两条 evidence，分析后只生成一个 author-level Raw Candidate。
- 断言 Raw Candidate 的 `profile_url` 为作者主页、`video_url` 为 Reel URL，且聚合数据引用两条 evidence。

### Important 5：标准 server suite

- `server/package.json` 的 `npm test` 更新为：

```text
node --test routes/*.test.js utils/instagramReelSearch.test.js
```

- 标准套件现在固定包含 Instagram utility tests，同时保留全部 route tests。

### Minor：旧 Profile Search adapter

- `rg -n "scrapeCreatorsFinderAdapter\\(" server --glob '*.js'` 在删除前仅命中函数定义，无任何调用。
- 已删除该未使用旧函数；生产 `finderTasks.js` 中不再存在 Instagram Profile Search endpoint。

## TDD 证据摘要

- URL/username RED：`# tests 8`、`# pass 6`、`# fail 2`；失败分别显示 FTP Reel 被接受、`bad/name` username 被接受。实现后 utility suite 通过。
- view-count RED：focused test `# tests 1`、`# pass 0`、`# fail 1`，实际 `'12000'`、预期 `'0'`。实现后通过。
- 缺失配置 RED：首次缺少执行 seam；补 seam 后任务 `error_message` 实际为通用 `No target-platform video evidence was inserted.`，预期配置错误。传播原始错误后通过。
- 零结果 RED：实际 `ScrapeCreators returned 0 usable Instagram Reels...`，预期独立零 Reel 文案。分类后通过。
- 全无效 RED：实际仍为零 usable 文案，预期 all-invalid 文案。分类后通过。
- 自动集成 RED：mock 收到多余 `Authorization: Bearer ...`；Instagram 分支改为只发送 `X-API-Key` 后通过。
- `npm test` 纳入检查 RED：抛出 `standard npm test omits Instagram Reel utility tests`；更新 package script 后通过。

## 最终测试命令与原始摘要

```bash
cd server && node --test utils/instagramReelSearch.test.js
```

原始末尾摘要：`# tests 9`、`# pass 9`、`# fail 0`、`# duration_ms 55.4035`，退出码 0。

```bash
cd server && node --test --test-name-pattern="Instagram automatic" routes/finderTasks.test.js
```

原始末尾摘要：`# tests 5`、`# pass 5`、`# fail 0`、`# duration_ms 27596.2975`，退出码 0。

```bash
cd server && npm test
```

实际运行脚本：`node --test routes/*.test.js utils/instagramReelSearch.test.js`。

原始末尾摘要：`# tests 43`、`# pass 43`、`# fail 0`、`# duration_ms 54328.554583`，退出码 0。

附加静态检查：

- `node --check server/routes/finderTasks.js`：退出码 0。
- `git diff --check`：退出码 0，无输出。
- `git diff --cached --check`：退出码 0，无输出。

## Commit

- `0db573a fix: harden Instagram Reel discovery`

该提交仅包含：

- `server/package.json`
- `server/routes/finderTasks.js`（仅本轮目标 hunks）
- `server/routes/finderTasks.test.js`（仅本轮目标 hunks）
- `server/utils/instagramReelSearch.js`
- `server/utils/instagramReelSearch.test.js`

## 剩余 concerns

- 本轮 findings 无已知未解决项。
- 工作区仍有本轮开始前的用户未提交改动与其他未跟踪文件；它们未被覆盖、未被暂存、未进入 `0db573a`。
