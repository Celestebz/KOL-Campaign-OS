# Instagram Reel Finder 设计

## 背景

当前 Video Evidence Finder 的 YouTube 链路已经按照“搜索视频证据 → 识别作者 → 分析证据 → 按作者聚合 → 生成 Raw Candidate”的方式跑通。

Instagram 虽然复用了相同的下游流程，但发现适配器调用的是 Instagram Profile Search。该接口主要返回主页，通常没有合规的 Reel URL。Finder 随后要求输入必须是目标平台的视频证据，因此这些主页结果会被跳过，任务最终可能以 `No target-platform video evidence was inserted.` 失败。

本次不重新设计 Finder，只为 Instagram 补上与 YouTube 等价的 Reel 搜索入口。

## 目标

让 Instagram Finder 完整跑通以下现有链路：

```text
Strategy 关键词
→ 搜索公开 Instagram Reels
→ 将 Reel 保存为视频证据
→ 抓取或复用视频快照
→ AI 证据分析
→ 按 Instagram 作者聚合
→ 生成 Raw Candidate
→ 人工审核
```

成功标准：

1. Instagram 自动发现结果包含合规的 `instagram.com/reel/...` URL。
2. 每条证据保留明确的作者名称和 Profile URL。
3. 发现结果能够进入现有 `video_sources`、`video_snapshots`、`video_ai_analysis_results` 和 Raw Candidate 链路。
4. 同一 Reel 和同一作者继续使用现有去重与聚合逻辑。
5. YouTube、TikTok、评分规则、入池规则和人工审核流程不受影响。

## 范围

第一版只支持公开 Instagram Reels。

包含：

- 使用 ScrapeCreators Instagram Reels Search 搜索公开 Reel。
- 将第三方响应映射为 Finder 现有的统一 Candidate 结构。
- 复用现有视频证据保存、快照抓取、AI 分析和候选生成流程。
- 补充 Instagram 适配器和端到端契约测试。
- 对配置错误、接口失败、零结果和无效结果返回可理解的错误信息。

不包含：

- Instagram Profile Search。
- 普通图文 Post 搜索。
- 从 Profile 反向抓取近期内容。
- Profile Lead 数据表或补证状态机。
- TikTok Finder 调整。
- 新的评分模型、候选门槛或 UI 工作流。
- 自动批准候选人。

## 现有逻辑保持不变

Finder Task 的创建参数继续为：

```json
{
  "strategy_id": 1,
  "target_platform": "instagram",
  "limit": 10
}
```

Strategy 搜索词继续由现有 `discoveryKeywords()` 和 `keywordQueries()` 生成。`limit` 的行为保持现状，不在本次重新定义。

每条 Reel 进入现有证据链路后，继续使用以下业务规则：

- 硬条件通过。
- 至少一个相关信号达到 20 分，或证据强度达到 20 分。
- 风险等级不是 `high`。
- AI 总分只用于排序，不作为硬淘汰线。
- 最终候选由人工审核，不自动进入 KOL Master 或 Campaign KOL。

## Instagram 发现适配器

### 数据源

Instagram 的 `scrapecreators` 适配器不再调用 Profile Search，改为调用：

```http
GET {base_url}/v2/instagram/reels/search?query={query}
X-API-Key: {api_key}
```

适配器针对 `keywordQueries(request)` 逐个搜索，并遵守现有任务 `limit` 和停止条件。

### 响应映射

每条 Reel 映射为现有统一 Candidate：

```js
{
  platform: 'instagram',
  kol_name: author.full_name || author.username,
  profile_url: `https://www.instagram.com/${author.username}/`,
  followers: author.follower_count || '',
  avg_views: reel.play_count || '',
  email: '',
  country_region: inferredCountry || '',
  matched_keywords: query,
  matched_persona: strategy.persona_config.primary_persona || '',
  representative_video_url: reel.url,
  representative_video_title: reel.caption || '',
  reason: `Matched Instagram Reel search: ${query}`,
  raw_data: reel
}
```

实现必须兼容第三方响应中常见的作者字段嵌套差异，但不能猜测或编造作者、粉丝数、地区和互动数据。

### 证据校验

发现结果必须满足：

- URL 使用 HTTP(S)。
- URL 是 `instagram.com/reel/...`。
- 目标平台和证据平台均为 `instagram`。
- 能确定作者名称。
- 能构造或读取作者 Profile URL。

Profile URL 只能写入 `author_profile_url` / `profile_url`，不能作为 `video_url`。

缺少合规 Reel URL 或作者身份的结果直接跳过，不进入 `finder_video_evidence`。

## 下游数据流

适配器输出继续交给现有 `processVideoEvidenceTask()`：

1. `normalizeCandidate()` 将代表内容识别为视频证据。
2. `saveVideoEvidence()` 校验平台和 Reel URL。
3. `upsertVideoSourceForEvidence()` 根据规范化 URL 或 Reel shortcode 复用或创建 `video_sources`。
4. `ensureVideoSnapshot()` 抓取或复用近期快照。
5. `finder_video_evidence` 关联 Finder Task、Strategy、Campaign 和视频源。
6. `evidence-analysis` 运行现有证据评分。
7. `generate-candidates-from-evidence` 按 Profile URL 或平台作者身份聚合。
8. 每位作者生成至多一个 Raw Candidate，并保留最佳 Reel 和全部证据引用。

## 错误处理

- 未配置 ScrapeCreators API Key：任务失败并明确提示配置缺失。
- API 返回非成功状态：保留上游错误摘要，不伪装成零结果。
- API 成功但没有 Reels：报告零结果，并提示尝试更短或更宽的 Strategy 关键词。
- 返回记录全部缺少合规 Reel URL 或作者：任务失败，错误说明没有可导入的 Instagram Reel 证据。
- 单条无效结果：跳过该条，继续处理其他结果。
- 抓取或分析失败：沿用现有证据级失败状态，不生成虚构数据。
- 不删除任何用户数据或历史 Finder 记录。

## 测试设计

### 适配器测试

1. Instagram 搜索使用 `/v2/instagram/reels/search`，不调用 Profile Search。
2. 查询参数来自现有 Strategy 关键词。
3. Reel URL、caption、作者名称、username、Profile URL、粉丝数和原始数据映射正确。
4. 第三方响应字段缺失时安全留空，不抛出无关异常。
5. Profile URL 不会被映射为 `video_url`。

### 校验与去重测试

1. 合规 `instagram.com/reel/...` 可以导入。
2. Profile URL、普通网页和跨平台 URL 被跳过。
3. 同一 Reel 的等价 URL只生成一个 `video_source`。
4. 同一作者的多条 Reel 在候选生成阶段聚合为一条 Raw Candidate。

### 回归与端到端测试

使用 mock ScrapeCreators 和 mock AI，验证：

```text
创建 Instagram Finder Task
→ 自动发现 Reel
→ 写入 video_sources 和 finder_video_evidence
→ 创建或复用 snapshot
→ 完成 evidence analysis
→ 生成包含 Profile URL 和 Reel URL 的 Raw Candidate
```

同时运行现有 YouTube Finder 测试，确认其行为不变。

## 实施边界

本次预计只修改 Instagram Finder 适配器及相关测试。若实现过程中发现 ScrapeCreators 实际响应结构与文档不一致，应通过兼容映射和测试夹具解决；不得扩展为 Profile-first、跨平台补证或 Finder 架构重写。
