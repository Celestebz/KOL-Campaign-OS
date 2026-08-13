# 找相似达人（Find Similar Creators）V2 设计

- 日期：2026-08-07
- 状态：待评审
- 范围：新增"输入种子达人 → 实时分析 → 按平台路线找相似达人"能力，作为 Finder 的新 search_source `similar_to_creator`；只做 **Similar for SKU**（绑定策略，复用全部 gate）；单平台单任务。
- 前置：`youtube_watch_next_expansion`（V1）已实现；IG/TK 无 watch-next 等价物，走 AI Brief 关键词搜索。

## 1. 定位与原则

把"找相似"做成搜索/扩展问题而非数据库检索问题：不建达人画像库、不做向量召回（未来候选，见 §8）。核心判断："谁像种子达人**且适合当前 SKU** 且过得了合作门槛"——比 Nox 的纯相似更贴近招募目标。

产出统一进现有管道：候选 → 证据导入 → AI 分析 → Raw Candidates → 人工评审。候选标注来源 `similar_to:<种子达人名>`。

## 2. 输入与入口

- **输入**：种子达人（二选一）+ target_platform + strategy_id + limit
  - 库内：`customer_id`（取该平台的 platform account / 平台 URL）
  - 库外：`creator_url`（任意 YouTube 频道 / IG / TikTok 主页链接）
- **入口**：
  - 客户（KOL Master）详情/列表行加「找相似」按钮 → 打开任务创建弹窗并预填种子
  - RawCandidates 任务创建弹窗：平台选择后出现"发现方式"新增项"找相似达人"，选中后显示种子输入（支持从库内选择或粘贴链接）
- **校验**：种子达人在目标平台必须有可用主页；库外链接先实时拉一次资料（SC channel/profile 端点）确认存在。

## 3. 流程

```
1. 种子解析
   库内：customers/kol_platform_accounts 取目标平台 URL 与已知指标
   库外：SC 拉频道/主页详情（1-2 credits），归一化为 { platform, channelId/handle, name, profileUrl }

2. Similarity Brief 生成（AI，minimax）
   抓取种子近期内容：
     youtube → SC channel-videos 第 1 页（标题，≤30 条）
     instagram → SC profile（bio + 最近 posts 标题）
     tiktok → SC profile + profile/videos 第 1 页
   AI 产出（JSON，落库到 task raw_request 供审计）：
   {
     "content_keywords": [...],   // 内容类目
     "scene_keywords": [...],     // 场景/行为
     "style_keywords": [...],     // 风格/调性
     "competitor_keywords": [...],// 相邻产品/品牌
     "negative_keywords": [...],  // 反向排除
     "target_country": "US"       // 从种子资料/内容推断
   }
   要求多维拆分（类目/场景/行为/季节/身份/相邻内容/产品），禁止只产同义词。
   AI 失败 → 任务失败并给出明确错误（不用兜底词糊弄）。

3. 平台分发
   youtube：种子达人近期视频中按 viewCountInt 取 Top 5 长视频作为种子
            → 复用 V1 扩展（extractWatchNext → 预过滤 → 聚合 → 富化 → preflight → 二跳）
   instagram/tiktok：Brief 的 content+scene+style+competitor 关键词
            → 复用 scrapeCreatorsFinderAdapterV2 关键词搜索（negative_keywords 并入排除）

4. 下游：与现有关键词路线完全一致（gates、preflight、AI 分析、Raw Candidates）。
```

## 4. 与现有代码的挂接点

- `server/routes/finderTasks.js`
  - `youtubeWatchNextAdapter(request)`：种子来源参数化。`request.similar_seed` 存在时改走 `collectCreatorSeeds(request, setting)`（SC channel-videos 取 Top 5 长视频），跳过关键词种子生成；其余扩展/聚合/preflight/停止/checkpoint 逻辑不变。
  - `runProvider`：`source === 'similar_to_creator'` → 按 target_platform 分发：youtube → `youtubeWatchNextAdapter`（creator 模式）；instagram/tiktok → `scrapeCreatorsFinderAdapterV2`（注入 Brief 关键词，见下）。
  - `validateSearchSource`：三个平台白名单均加 `similar_to_creator`。
  - `createFinderTask`：新增 `similarCreator` 参数（`{ customer_id }` 或 `{ url }`），写入 raw_request；任务创建时先做种子解析与校验。
  - `processVideoEvidenceTask`：读取 raw_request 的 similar_creator，注入 request.similar_seed；instagram/tiktok 时调用 Brief 生成并把关键词写入 `request.discovery.keywords` 与 `request.similarity_brief`。
- `server/services/similarityBrief.js`（新建）：`buildSimilarityBrief(seedInfo, recentItems)` → 调 `callAi`（aiClient），返回解析后的 brief JSON；负责 prompt、JSON 校验与错误。
- 前端：
  - `client/src/pages/Customers.js`：行操作加「找相似」（跳 RawCandidates 建任务弹窗并预填）。
  - `client/src/pages/RawCandidates.js`：任务弹窗"发现方式"加"找相似达人"（三平台均可选），选中后显示种子输入（库内搜索选择 / 粘贴链接）；`buildFinderTaskRequest` 增加 `similarCreator` 字段。

## 5. 命名与记账

- search_source / 返回 provider / 台账 provider：`similar_to_creator`（台账 query_text 记 `similar-seed:<channelId|handle>`）。
- 候选 `raw_data.similarity`：`{ seed_creator, seed_url, brief }`；`reason` 写明"与 <种子达人> 相似：<主要匹配维度>"。
- 缓存：Brief 生成结果按种子 channelId 存 `finder_search_cache`（variant='similarity-brief'，7 天 TTL）；视频/profile 拉取沿用 V1 缓存。

## 6. 成本控制与限制

- 成本预估/任务：种子解析 1-2 + Brief 内容拉取 1-2 + YouTube 扩展（≈ V1 的 64-94）或 IG/TK 关键词（~10-20）。YouTube 路线复用 `SC_FINDER_REQUEST_BUDGET=200` 上限。
- 单平台单任务（Finder 硬边界）；种子与目标平台不一致直接报错（如种子是 YouTube 频道但任务选 instagram）。
- 种子达人本人及其已入库频道由现有排除集/库内比对自动排除。

## 7. 测试

1. `similarityBrief`：mock callAi，验证 brief 结构、多维关键词非空、坏 JSON 报错、negative_keywords 传递。
2. creator 模式适配器（mock fetch + 测试库）：
   - 种子解析（库内 customer_id / 库外 url / 平台不匹配报错）；
   - youtube：种子为达人近期 Top 5 长视频，扩展与 preflight 沿用 V1 契约；候选 `raw_data.similarity` 存在；
   - instagram：Brief 关键词注入 discovery.keywords 并走 V2 适配器（mock 验证 query 集合）。
3. 路由：`validateSearchSource` 三平台接受 `similar_to_creator`；runProvider 按平台分发。
4. 前端契约：`buildFinderTaskRequest` 携带 similarCreator（customer_id 或 url 二选一校验）。

## 8. 分期与不做项

**分期（2026-08-07 确认）**：
- **第一期（本次实现）**：instagram / tiktok 的 `similar_to_creator`——种子解析、Similarity Brief 生成、关键词注入 V2 适配器、路由与 UI。
- **第二期**：YouTube creator 模式（种子达人近期 Top 5 长视频 → V1 watch-next 扩展管道），适配器种子来源参数化。

**明确不做（后续候选）**：

- 达人画像库 + 向量召回（embedding 存储选型：pgvector / SQLite-VSS / 外部服务，到时候再决）。
- Similar to Creator（无策略）模式。
- 同 BGM 扩展（TikTok song/videos、IG song/reels）——先小样本验证纯度再说。
- 跨平台"同人识别"（YouTube 频道 ↔ IG 账号匹配）。
