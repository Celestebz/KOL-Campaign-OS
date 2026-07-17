# TikTok Keyword Video Finder 设计

## 背景

当前 Video Evidence Finder 的 YouTube 和 Instagram 链路已经采用统一模式：搜索目标平台的视频内容，将视频保存为证据，完成 AI 分析，再按作者聚合生成 Raw Candidate。

TikTok 发现适配器仍尝试调用 `/v1/tiktok/search`、`/v1/tiktok/users/search` 和 `/v1/tiktok/user/search`。这些入口混合了旧搜索路径和用户搜索，不能稳定保证返回可导入的视频证据。

ScrapeCreators 提供 TikTok Keyword Search：

```http
GET /v1/tiktok/search/keyword?query={query}
```

该接口按关键词返回 TikTok 视频。第一版只接入这个入口，不增加用户搜索、Hashtag Search 或 Profile 补证。

## 目标

让 TikTok Finder 跑通现有视频证据链路：

```text
Strategy 关键词
→ TikTok Keyword Search
→ 构造规范化 TikTok 视频 URL
→ 保存 Video Evidence
→ 抓取或复用视频快照
→ AI Evidence Analysis
→ 按 TikTok 作者聚合
→ 生成 Raw Candidate
→ 人工审核
```

成功标准：

1. TikTok 自动发现只调用 `/v1/tiktok/search/keyword`。
2. 从 `aweme_id` 和 `author.unique_id` 构造可追溯的 TikTok 内容页面 URL。
3. 视频证据包含明确的作者 Profile URL，且 Profile URL 不会进入 `video_url`。
4. TikTok 证据复用现有 `video_sources`、`video_snapshots`、`video_ai_analysis_results` 和 Raw Candidate 链路。
5. 重复视频按视频 ID 去重，同一作者的多条视频聚合为一条 Raw Candidate。
6. YouTube、Instagram、AI 评分、入池和人工审核行为不变。

## 范围

包含：

- ScrapeCreators TikTok Keyword Search。
- `search_item_list[].aweme_info` 响应提取。
- TikTok 视频和作者的纯映射模块。
- 规范化 TikTok 视频 URL 和 Profile URL 构造。
- 上游错误、零结果、全部无效结果的明确错误分类。
- 自动发现、证据分析、作者聚合和 Raw Candidate 的测试。
- 将 TikTok 映射器测试纳入标准服务端测试命令。

不包含：

- TikTok User Search。
- TikTok Hashtag Search 或 Top Search。
- Profile-to-content 补证。
- CDN 播放地址作为证据 URL。
- 短分享链接展开。
- 搜索 cursor 分页。
- TikTok Photo Mode。
- YouTube 或 Instagram 适配器调整。
- Finder UI、评分模型、候选门槛或审批流程调整。

## 方案选择

采用独立 TikTok 视频映射器，参考现有 Instagram Reel 映射器的边界。

不把嵌套的 TikTok 第三方响应映射继续堆入 `finderTasks.js`，也不在本次抽象通用多平台框架。Finder 路由负责调用数据源和衔接既有流程；映射器负责 URL、响应字段和作者身份的验证与转换。

## Finder 请求和关键词

Finder Task 创建参数保持不变：

```json
{
  "strategy_id": 1,
  "target_platform": "tiktok",
  "limit": 10
}
```

继续使用现有 `discoveryKeywords()` 和 `keywordQueries()` 生成 Strategy 查询。第一版每个查询只处理接口首批响应，不使用 cursor 分页，并沿用当前 Finder 的 `limit` 和停止逻辑。

## 数据源调用

每个查询调用：

```http
GET {base_url}/v1/tiktok/search/keyword?query={query}
X-API-Key: {api_key}
```

不再为 TikTok Finder 调用：

```text
/v1/tiktok/search
/v1/tiktok/users/search
/v1/tiktok/user/search
```

API Key 只放在请求头，不得进入日志、错误信息、候选原始摘要或测试输出。

## 响应提取

Keyword Search 的视频记录来自：

```text
search_item_list[].aweme_info
```

映射器只处理有 `aweme_info` 的视频记录。缺少视频对象的搜索项忽略。

## 规范化身份和 URL

### 视频 URL

自动发现不依赖第三方响应直接返回完整 TikTok 页面 URL，而是使用：

```text
aweme_info.aweme_id
aweme_info.author.unique_id
```

构造：

```text
https://www.tiktok.com/@{unique_id}/video/{aweme_id}
```

要求：

- `aweme_id` 为非空纯数字。
- `author.unique_id` 通过 TikTok handle 校验。
- handle 构造 URL 时安全编码。
- 保存前去除查询参数和片段。
- 最终 URL 必须是 HTTPS、主机为 `www.tiktok.com`、路径精确符合 `/@handle/video/{id}`。

不接受：

- TikTok Profile URL。
- `vm.tiktok.com` 等短分享链接。
- TikTok CDN 播放地址。
- Photo Mode URL。
- 缺少作者 handle 或视频 ID 的记录。

### Profile URL

使用同一个 `author.unique_id` 构造：

```text
https://www.tiktok.com/@{unique_id}
```

Profile URL 只用于作者身份、去重和候选主页，不得作为 `video_url`。

作者账号后续改名、注销、私密或地区受限属于抓取阶段风险；自动发现阶段保留原始 `author.unique_id` 和 `aweme_id`，不得编造替代身份。

## Candidate 映射

每个有效 `aweme_info` 映射为现有 Finder Candidate：

```js
{
  platform: 'tiktok',
  kol_name: author.nickname || author.unique_id,
  profile_url: `https://www.tiktok.com/@${encodedHandle}`,
  followers: firstDefined(author.follower_count, author.followers),
  avg_views: firstDefined(statistics.play_count, aweme_info.play_count),
  email: '',
  country_region: aweme_info.region || '',
  matched_keywords: query,
  matched_persona: strategy.persona_config.primary_persona || '',
  representative_video_url: canonicalVideoUrl,
  representative_video_title: aweme_info.desc || '',
  evidence_url: canonicalVideoUrl,
  evidence_title: aweme_info.desc || '',
  evidence_type: 'video',
  source_query: query,
  reason: `Matched TikTok Keyword Search: ${query}`,
  raw_data: aweme_info
}
```

字段缺失时留空，不猜测或编造粉丝数、播放量、地区、邮箱和联系方式。合法数值 `0` 必须保留。

## 下游数据流

有效映射继续进入现有 `processVideoEvidenceTask()`：

1. `normalizeCandidate()` 将 TikTok 页面 URL 识别为视频证据。
2. `saveVideoEvidence()` 校验 TikTok 目标平台和视频 URL。
3. `upsertVideoSourceForEvidence()` 按 TikTok 视频 ID 和规范化 URL 复用或创建 `video_sources`。
4. `ensureVideoSnapshot()` 抓取或复用视频快照。
5. `finder_video_evidence` 关联 Finder Task、Strategy、Campaign 和视频源。
6. `evidence-analysis` 使用现有 AI 证据评分。
7. `generate-candidates-from-evidence` 按 Profile URL 或平台作者身份聚合。
8. 同一作者的多条视频生成至多一个 Raw Candidate，并保留最佳视频和全部证据引用。

## 错误处理

任务必须区分：

1. `ScrapeCreators API Key is not configured`
   - 数据源配置缺失。

2. `TikTok Keyword Search returned 0 videos`
   - 上游成功，但 `search_item_list` 中没有视频。

3. `TikTok Keyword Search returned videos, but none were valid`
   - 上游返回视频对象，但全部缺少有效作者、视频 ID 或规范化 URL。

4. 上游 HTTP 错误
   - 保留安全的上游错误摘要和状态，不覆盖成统一“没有证据”。

单条无效记录跳过，继续处理其他记录。只有所有查询均无法产生有效视频证据时任务才失败。失败原因写入 Finder Task 的 `error_message`，同时保留 provider attempts 和响应摘要。

任何错误都不得暴露 API Key。

## 测试设计

### 映射器单测

- URL 只指向 `/v1/tiktok/search/keyword`。
- 查询参数来自 Strategy 当前关键词。
- 正确提取 `search_item_list[].aweme_info`。
- 从 `aweme_id + author.unique_id` 构造 canonical 视频 URL 和 Profile URL。
- 正确映射 description、region、播放量和作者名称。
- 合法的播放量和粉丝数 `0` 被保留。
- 缺少视频 ID、缺少 handle、非法 handle、Photo Mode 和非视频记录被拒绝。
- CDN URL、Profile URL 和短分享 URL 不会成为 `video_url`。
- 不构造 User Search、Hashtag Search 或 Top Search 端点。

### 自动发现测试

使用 mock ScrapeCreators：

- 验证请求只访问 Keyword Search。
- 验证 `x-api-key` 请求头存在，但不在输出中泄露。
- 使用接近官方响应结构的 `search_item_list[].aweme_info` fixture。
- 验证视频写入 `video_sources` 和 `finder_video_evidence`。
- 验证重复视频 ID 去重。
- 验证同一作者多条视频保留多条证据，并聚合为一条 Raw Candidate。
- 验证缺少配置、上游非成功响应、零视频和全部无效四类错误。

### 回归测试

完整验证：

```text
TikTok Keyword Search
→ Video Evidence
→ AI Evidence Analysis
→ Author Aggregation
→ Raw Candidate(profile_url + video_url)
```

标准 `server/npm test` 必须包含 TikTok 映射器测试，并继续运行现有 YouTube、Instagram 和 Finder 路由测试。

## 实施边界

本次预计新增 TikTok 纯映射器及其测试，并只修改 Finder 中 TikTok 的 ScrapeCreators 分支、必要的自动发现测试和标准测试脚本。不得扩展为 Profile-first、跨平台证据、Hashtag 搜索、分页或 Finder 架构重写。
