# YouTube 关联推荐扩展发现路线（V1）设计

- 日期：2026-08-06（评审修订版）
- 状态：已实现（2026-08-07 测试全绿）
- 范围：为 KOL Finder 新增独立发现路线 `youtube_watch_next_expansion`（ScrapeCreators watchNextVideos 关联扩展），作为关键词搜索之外的第二条候选来源，复用现有 preflight / 排除集 / 台账 / 候选管道。
- 依据：2026-08-04 六轮 TMB-1404/1407 试跑（665 频道），关联推荐位贡献了第 4 轮全部有效候选。V1 裁剪决策：不做图谱持久化、动态预算、A/B 实验、独立评分公式。

## 1. 目标与定位

关键词搜索从"达人生产器"变为"种子生产器"；关联推荐扩展负责沿内容关系找到垂直创作者。新路线是**独立的 search_source**，单独记账、单独评估命中率，不藏在任何 fallback 里。

产出统一进入现有管道：候选 → 视频证据导入 → AI 分析 → Raw Candidates → 人工评审。不另开流程，不新增排序系统（图谱强度只作为信号写入候选的 `raw_data` 与 `reason`）。

**命名统一**：search_source、返回 provider、台账 provider、自动化元数据、统计口径全部使用 `youtube_watch_next_expansion`。缓存层（记录实际数据供应商）用 `provider='scrapecreators', variant='watchnext'`。

## 2. 触发与输入

- search_source 值：`youtube_watch_next_expansion`，target_platform=youtube 专用；其他平台明确报错。
- 策略驱动，换品类零配置：
  - `finder_handoff.required_keywords` → 产品/场景种子查询词
  - `finder_handoff.competitor_keywords` → 相邻产品种子查询词
- 阈值沿用 `youtubePreflightConfig`（minimum_median_views / 时长 / 近 N 条 / target_market）。
- **时长阈值统一口径**：`effectiveMinSeconds = 策略 minimum_video_duration_seconds（或从 required_evidence 解析值）若 > 0，否则 181`。种子筛选（§4.1）与推荐视频预过滤（§4.3）必须使用同一个 `effectiveMinSeconds`，禁止两处各自解释。

## 3. 固定上限常量

```js
MAX_SEED_QUERIES = 12;        // 种子查询词上限（rankedKeywordQueries 排序后截取）
MAX_SEED_VIDEOS = 12;         // 种子视频上限
MAX_WATCH_NEXT_PER_SEED = 20; // 每条种子最多取的关联视频数
MAX_DEPTH_2_SEEDS = 10;       // 二跳种子数
MAX_ENRICHED_CHANNELS = 120;  // 单任务频道富化上限
```

成本估算（与之一致）：种子搜索 ≤12 + 一跳 ≤12 + 二跳 ≤10 + 频道富化与 preflight 约 30–60 ≈ **64–94 credits/任务**。

## 4. 流程

### 4.1 种子生成（按查询词配额保证多样性）

```
required_keywords 优先、competitor_keywords 补足，经 rankedKeywordQueries 排序，
总查询数 ≤ MAX_SEED_QUERIES；每词调 SC search 第 1 页。

每个 query 最多贡献 1 条种子：
  过滤：lengthSeconds < effectiveMinSeconds（统一口径见 §2）、标题命中 exclusion_keywords、
        频道在排除集 → 跳过；
  从该 query 剩余结果中取 viewCountInt 最高的长视频作为种子；
  全局按频道去重；频道重复时从该 query 结果回补下一条；
  最终 ≤ MAX_SEED_VIDEOS 条。

注：种子阶段不做品牌/经销商硬淘汰——种子只需话题对口，品牌/经销商的淘汰
由候选阶段的排除集与语义排除承担（品牌视频的受众恰是目标人群）。
```

### 4.2 一跳扩展

每条种子调 `/v1/youtube/video` 取 `watchNextVideos`（≤ MAX_WATCH_NEXT_PER_SEED 条），逐条记录 `(seed_video_id, position, depth=1)`。

### 4.3 廉价预过滤（零额外 credit）

仅看 watchNextVideos 自带字段，剔除：

- `lengthInSeconds` < `effectiveMinSeconds`（统一口径见 §2）；
- 标题命中策略 exclusion_keywords；
- 频道在排除集（loadYoutubeExclusionSet）；
- **播放量门槛**：`viewCountInt` 存在且 < `max(1000, floor(minimum_median_views × 0.25))` → 剔除；`viewCountInt` 缺失 → 不在本层淘汰，交给频道 preflight。

**执行顺序硬性约束：先聚合推荐关系，再判重。** 每条推荐视频先把 `(seed_video_id, position, depth)` 计入视频层与频道层聚合（§4.4），之后才判断"频道是否已富化过"。已富化频道不再重复调 channel 详情，但其新的推荐关系必须照常计入 graph_signal——否则多种子共推信号会丢失。

### 4.4 推荐信号聚合（两层，纯计数）

**视频层**（用于二跳选择）：

```json
{ "video_id": "...", "seed_ids": ["A","B"], "positions": [3,8], "position_score": 32, "depth": 1 }
```

`position_score` = 各来源位置权重之和（位次 1-5 → 20，6-10 → 12，11-20 → 5）。**不再乘种子数加成**（求和本身已体现多源推荐）。

**频道层**（写入候选 `raw_data.graph_signal`）：

```json
{ "channel_seed_count": 3, "recommended_video_count": 4, "best_position": 2, "position_score": 57, "depths": [1] }
```

`reason` 附人话说明，如："该频道共有 4 条视频进入关联推荐结果，来自 3 条不同种子，最高推荐位第 2 位。"

### 4.5 频道富化 + preflight（完全复用）

对通过预过滤的新频道（≤ MAX_ENRICHED_CHANNELS）：SC channel 详情 → `youtubeItemsToCandidates` 同构候选 → `preflightScYoutubeCandidates`（阈值全来自策略）。

### 4.6 二跳（选择性，按频道去重）

一跳视频按 `position_score 降序 → seed_ids 数降序 → viewCountInt 降序` 排序；**每个频道最多取 1 条最高分视频**，不足 MAX_DEPTH_2_SEEDS 条时向后回补。重复 4.2–4.5 一次（depth=2）。不做三跳。

### 4.7 自动停止（三级范围，写死）

| 条件 | 停止范围 |
|---|---|
| 某条种子的推荐批次：`已见过频道数 ÷ 有效 channel_id 推荐视频数 > 70%`（该批次有效推荐 ≥10 条才生效） | 停**当前种子**的剩余处理，继续下一条种子 |
| 连续完成富化+preflight 的 20 个**唯一频道**均无合格候选（计数跨种子累计，不随种子切换清零） | 停**当前 depth** 的剩余扩展（一跳停了仍可进二跳选择；二跳停即结束） |
| 预算耗尽（`SC_FINDER_REQUEST_BUDGET = 200`） | 停**整个任务**，保留已得候选 |

### 4.7b 重跑幂等（状态持久化）

- 请求级去重：`finder_search_cache`（7 天 TTL）跨运行兜底，覆盖种子搜索与 watchNext 详情。
- 处理状态：写入 finder task 的 checkpoint（复用现有 `readTaskCheckpoint/saveTaskCheckpoint`，键名 `watch_next`）：
  - `expanded_seed_ids`：已完成 watchNext 展开的种子视频 id 列表；
  - `enriched_channel_ids`：已完成富化+preflight 的频道 id 列表。
- 任务重跑时读回 checkpoint：已展开种子跳过（缓存命中也不重复聚合）、已富化频道只聚合推荐关系不再请求。任务正常完成后可保留 checkpoint 供审计。

### 4.8 输出

与 `youtubeScrapeCreatorsAdapter` 相同的返回契约：`provider: 'youtube_watch_next_expansion'`、candidates、preflight_rejected、scanned_channel_count、external_request_count、cache_hit_count。

## 5. 与现有代码的挂接点

- `server/routes/finderTasks.js`
  - `runProvider`：`source === 'youtube_watch_next_expansion'` 且 target_platform=youtube → `youtubeWatchNextAdapter(request)`；其他平台报错。
  - 新函数 `youtubeWatchNextAdapter`、`collectSeedVideos`、`expandWatchNext`（本文件内，对照现有适配器风格）。
  - 台账：复用 `finder_query_ledger`；`query_text` 记 `seed:<videoId>`，`provider='youtube_watch_next_expansion'`；`recordScYoutubeQueryLedger` 泛化为可传 provider。
  - 缓存：`getCachedPlatformSearch/savePlatformSearchCache`，provider='scrapecreators'、platform='youtube'、page_token=seed video id、variant='watchnext'。
- `server/services/scrapecreatorsYoutube.js`：零改动（`video()` 已存在）。
- `server/utils/scrapecreatorsYoutubeSearch.js`：新增纯函数 `extractWatchNext(data)`（统一形状 `{id,title,views,lengthSeconds,publishedTime,channel:{id,title,handle},position}`）与 `graphScore(positions)`（位置权重求和）。
- 前端 Finder 任务创建处：search_source 选项加"关联推荐扩展（YouTube）"；若选项由服务端常量驱动则只改服务端。

## 6. 错误处理与成本控制

- 全部 SC 调用走 `fetchScJson`（30s 超时 / 402 即停 / 429·5xx 重试 2 次）。
- 单条种子 video 详情失败：跳过该种子并记台账，不阻断整批。
- 缓存命中不计外部调用数；同一任务重跑时缓存命中、已富化频道不重复请求。

## 7. 测试

1. `extractWatchNext` / `graphScore` 纯函数单测（空值、缺 channel、位次权重、同视频多源合并）。
2. `youtubeWatchNextAdapter`（mock fetch + 测试库，对照 `finderScrapeCreatorsYoutube.test.js` 模式）：
   - 种子按 query 配额、频道去重回补、Top 12 截断；
   - 预过滤五类剔除（短时长 / 排除词 / 排除集 / 重复 / 低播放量，含 viewCountInt 缺失放行）；
   - 视频层 position_score 与二跳 Top 10 排序（score → seed 数 → 播放量）；
   - **先聚合后判重**：已富化频道的新推荐关系仍计入 graph_signal，且不重复请求 channel 详情；
   - **二跳按频道去重**：同频道多条高分视频只占 1 个名额，不足回补；
   - **频道层聚合**：同一频道的不同视频被不同种子推荐 → 正确聚合为频道级 graph_signal；
   - 停止条件三级范围：种子批次重复率停当前种子、连续 20 唯一频道无新增停当前 depth（计数跨种子不清零）、预算停全任务；
   - 预算截断；输出契约与关键词路线一致；
   - **重跑幂等**：从 checkpoint 读回 expanded_seed_ids/enriched_channel_ids，已展开种子跳过、已富化频道不重复请求（证据去重属下游导入职责，不在此测）。
3. runProvider 路由：新 search_source 正确分发；非 youtube 平台报错。

## 8. 明确不做（V2 候选）

- 推荐边持久化成图谱表（"自己的 NoxInfluencer"）。
- 发现预算的动态分配（60/20/15/5 之类）。
- 关键词 vs 关联路线的同预算 A/B 对照实验。
- 独立综合评分公式（内容相关度×30% 等）。
- 三跳及以上、跨平台（IG/TikTok）关联扩展。
