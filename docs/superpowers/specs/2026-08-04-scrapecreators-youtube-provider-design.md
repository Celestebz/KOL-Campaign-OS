# ScrapeCreators YouTube Provider 接入设计

- 日期：2026-08-04
- 状态：已确认（brainstorm 评审通过）
- 范围：KOL Campaign OS 的 YouTube 数据源接入 ScrapeCreators，覆盖 Finder 发现、视频详情+评论、30 天 intake 快照三处；通用品类（换品类 = 换策略，零代码改动）

## 1. 背景与依据

2026-08-04 用 ScrapeCreators（下称 SC）完成了 TMB-1404/TMB-1407 六轮 YouTube KOL 采集试跑（665 频道，~1,959 credits），验证了以下端点与字段（试跑脚本 `scripts/_sc_round*.cjs`，数据 `outputs/sc_round*_candidates.json`）：

| 能力 | SC 端点 | 已验证字段 |
|---|---|---|
| 关键词搜索 | `GET /v1/youtube/search?query=&continuationToken=` | videos/shorts/lives 数组；viewCountInt、publishedTime、lengthSeconds、channel.{id,title,handle}；continuationToken 翻页 |
| 频道详情 | `GET /v1/youtube/channel?channelId=/handle=/url=` | subscriberCount、videoCount、country、links、description；handle 三态入参 |
| 频道视频 | `GET /v1/youtube/channel-videos?handle=/channelId=` | 单页 ~30 条，自带 viewCountInt/likeCountInt/commentCountInt（includeExtras）、lengthSeconds、publishedTime；有 lives 数组区分直播 |
| 视频详情 | `GET /v1/youtube/video?url=` | title、view/like/comment 数、durationMs、publishDate、channel、type、captionTracks、watchNextVideos |
| 视频评论 | `GET /v1/youtube/video/comments?url=` | 评论作者/正文/点赞/发布时间；continuationToken |

实测空值与怪癖（必须在归一化层兜底）：

1. `country` 存在 null（不可硬过滤）；
2. `publishedTime` 偶发 null（排序/过滤需兜底）；
3. handle 缺失时返回 `channel/<channelId>` 形式（需归一化）；
4. `email` 字段实测 665 频道全部为 null（不依赖）；
5. 无 `publishedAfter` 参数（发布时间过滤在客户端做）；
6. 无批量查询（1 credit/次调用）；
7. IG `user/reels` 端点曾挂起——所有请求必须带 30s 超时；
8. 频道详情返回的 subscriberCount 可能为浮点（如 65099.99），取整。

待实施期实测确认的点（**2026-08-04 已实测**）：

- ~~`channel-videos` 的 continuationToken 翻页是否可用~~ → **可用**：单页 30 条，page2 正常返回不同结果（实测 handle=mrbeast）。
- ~~`video/comments` 单页条数与排序~~ → **单页 20 条**，有 continuationToken；取满 100 条顶层评论需翻 5 页（详情适配按页拉取，上限 5 页）。
- `search` 的 `uploadDate` 类过滤参数是否存在（无则客户端过滤）——文档未列出，按客户端过滤实现。

## 2. 总体架构

```
server/services/scrapecreatorsYoutube.js   ← 新建，唯一与 SC API 打交道的模块
├── search(query, continuationToken)        关键词搜索（翻页）
├── channel(identity)                       频道详情（channelId/handle/url 三态入参）
├── channelVideos(identity, opts)           近 ~30 条视频（includeExtras）
├── video(url)                              单视频详情
└── videoComments(url, continuationToken)   评论（翻页）
```

三个消费点：

1. `server/routes/finderTasks.js` — `runProvider` youtube 分支加 `scrapecreators`，新增 `youtubeScrapeCreatorsAdapter(request)`，对照 `youtubeMatonGatewayAdapter`；
2. `server/routes/videos.js` — `fetchWithProvider` youtube+scrapecreators 分支，新增 `fetchYouTubeScrapeCreators` + 归一化，对照 `fetchYouTubeMaton`/`normalizeYouTubeItem`；
3. `server/services/youtubeIntakeSnapshot.js` — `youtubeConfig` 加第三 provider，快照数据面走 SC 端点。

配置面：

- `client/src/pages/settings/settingsContract.js`：youtube 的 `scrapecreators` 从"预留"转正（去标记、允许配置 key 与设为 fallback）；`server/services/aiClient.js` 的 `PROVIDER_LABELS` 同步。
- key 读取顺序：`youtube.scrapecreators` → 共享 fallback（`instagram.scrapecreators` / `tiktok.scrapecreators` 的 api_key，base_url 同理）。
- 主备自动切换：复用现有 `system.provider_selection`（platforms.youtube = {primary, fallbacks}）与 `fallbackStrategy.enableFallback`，不新增 UI 组件。Finder 侧：maton 适配器抛错且 enableFallback 开启时，`runProvider` 依次尝试 fallbacks 中的 scrapecreators（与 `fetchVideoData` 的循环语义一致）。

## 3. Finder 发现流程（youtubeScrapeCreatorsAdapter）

骨架复用 `youtubeMatonGatewayAdapter`（finderTasks.js:1187），保证通用性：

1. **查询词**：`rankedKeywordQueries(request)` 原样复用（策略 `finder_handoff` 关键词 + 按 `finder_query_ledger` 历史产出率排序）。换品类 = 换策略，零代码。
2. **搜索**：每词调 `search`，`continuationToken` 翻页；每页返回 videos+shorts+lives，按 channel.id 去重；`loadYoutubeExclusionSet()` + `isExcludedYoutubeCreator` 排除（复用）。
3. **缓存与台账**：复用 `finder_search_cache` / `finder_query_ledger`，provider 键用 `'scrapecreators'`（与 Maton 的 `'maton_youtube_gateway'` 区分，互不影响命中率统计）。缓存键含 query+continuationToken。
4. **频道富化**：每个新频道 1 次 `channel` 调用，产出与 `youtubeItemsToCandidates` 相同结构（platform、kol_name、profile_url、followers、country_region、matched_keywords、representative_video_url/title、reason、raw_data）。`email` 留空（SC email 字段实测无效）；links 存入 raw_data 供后续人工取联系方式。
5. **中位播放核验（SC 版 preflight）**：对照 `preflightYoutubeCandidates` + `evaluateYoutubePreflight`。阈值全部来自 `youtubePreflightConfig(request)`（策略 finder_handoff 的 minimum_median_views / 时长 / 近 N 条 / 活跃天数 / target_market）。SC 每频道 1 次 `channel-videos` 调用即可取齐近 10 条长视频（lengthSeconds ≥ 策略阈值）的播放中位数；国家过滤沿用"country 为空放行、非目标市场排除"的现有语义。通过/拒绝均写入 raw_data.preflight，拒绝列表进返回值的 `preflight_rejected`。
6. **预算**：新增 `SC_FINDER_REQUEST_BUDGET`（默认 200 credits/任务，常量可调），计数每次真实外部调用；耗尽时优雅截断（返回已得候选）并记录台账。缓存命中不计。
7. **返回契约**：`{provider: 'scrapecreators_youtube', endpoint, candidates, preflight_rejected, scanned_channel_count, target_qualified_count, max_scanned_channels, external_request_count, cache_hit_count}`，与 Maton 版一致，下游 evidence/analysis/raw candidates 零改动。
8. **主备切换**：`runProvider` 在 youtube 平台按 provider_selection 解析主备；主适配器抛错且 `enableFallback` 时依次尝试 fallback。错误消息保留原始原因（如 "Maton 配额耗尽后切换 ScrapeCreators"）。

## 4. 视频详情 + 评论（videos.js）

`fetchYouTubeScrapeCreators(videoUrl)`：

- `video(url)` 取详情 → 归一化为 `normalizeYouTubeItem` 同款结构：`{platform:'youtube', platform_video_id, kol_name, title, author_name, content_type('video'|'short'|'live'，由 type 字段与 lives 语义映射), published_at, metrics:{play_count, like_count, comment_count, collect_count:0, share_count:0}, exposure, comments, raw}`。
- `videoComments(url)` 取顶层评论 ≤100 条（作者/正文/点赞/时间），失败时返回 `[]`（与 `fetchYouTubeComments` 的容错语义一致）。
- `fetchWithProvider` 注册 youtube+scrapecreators 分支；`fetchVideoData` 现有的 primary→fallbacks 循环自动获得降级能力。

## 5. Intake 快照（youtubeIntakeSnapshot.js）

- `youtubeConfig` 增加 scrapecreators：按 provider_selection 决定次序；未配置 selection 时默认排在 google_official、maton_gateway 之后。
- 数据面映射：`video(url)` 解析 video→channelId；`channel(identity)` 查频道；`channelVideos` 拉近期视频并按 publishedTime ≥ 30 天截止线客户端过滤；统计字段直接取自 channel-videos 的 includeExtras（view/like/comment/duration/publishedAt 齐全，30 天 ≤30 条时无需逐条 video 调用）；直播/回放排除用 lives 数组 + type 字段。
- channel-videos 翻页已实测可用（单页 30 条）：30 天窗口超出单页时按 continuationToken 翻页（上限 3 页/90 条，遇到早于截止线的条目即停）。

## 6. 错误处理

- 全部请求 30s AbortController 超时；超时/5xx/429 指数退避重试 2 次（250ms → 1s）。
- 402（credits 耗尽）：立即停止本任务外部调用，抛出带明确文案的错误（"ScrapeCreators 额度耗尽"），不进入重试。
- 401：报"ScrapeCreators API Key 未配置或无效"。
- 单频道/单视频失败不阻断整批，记入台账/日志。
- 空值兜底：country null 放行（由 preflight 语义处理）；publishedTime null 排到最旧；handle 为 `channel/<id>` 形式时归一化为 channelId 入参；subscriberCount 取整。

## 7. 测试

对照现有测试文件（`server/routes/finderTasks.test.js`、`server/routes/settings.test.js`、`server/routes/agentAutomationMigration.test.js` 的模式，mock fetch）：

1. `youtubeScrapeCreatorsAdapter`：mock search/channel/channel-videos 响应，断言候选结构契约（字段与 youtubeItemsToCandidates 一致）、排除集生效、预算截断、缓存命中不重复扣计数。
2. SC preflight：构造不同播放/时长分布，断言阈值过滤与 `preflight_rejected` 内容（中位数、长视频数、国家）。
3. `fetchYouTubeScrapeCreators`：归一化结构断言（含 collect/share=0、评论上限、评论失败降级 []）。
4. `youtubeConfig`：provider 优先级解析（selection 存在/缺失两种）。
5. settings：`/api/settings/status` 对 youtube.scrapecreators 的 configured 上报；`settingsContract` 不再含"预留"文案（client 侧 `Settings.test.js` / `settingsContract.test.js` 同步更新）。
6. runProvider 主备切换：maton 抛错 + enableFallback → SC 被调用；SC 未配置 → 报原始主源错误。

## 8. 非目标（YAGNI）

- 不做 SC 的 TikTok/IG 侧改动（已有 `scrapeCreatorsFinderAdapterV2`）。
- 不做 watchNextVideos 关联挖掘（本次试跑用过，但属于发现策略增强，后续单独立项）。
- 不做 Bright Data / Custom 预留 provider。
- 不改动 emails、approvals、Feishu 等下游模块。
- 不引入新 npm 依赖（fetch + 现有基础设施）。

## 9. 里程碑

1. `scrapecreatorsYoutube.js` 服务模块 + 实测补齐（channel-videos 翻页、comments 条数）。
2. videos.js 详情+评论分支（独立可用，便于先验证 key 与归一化）。
3. finderTasks.js 发现适配器 + SC preflight + 主备切换。
4. youtubeIntakeSnapshot.js 快照分支。
5. settings 转正 + 测试补齐。
