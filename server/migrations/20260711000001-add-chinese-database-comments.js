const TABLE_COMMENTS = {
  analysis_job_items: '视频分析批次中的单条处理任务及执行结果',
  analysis_jobs: '视频批量分析任务的整体进度与统计',
  api_settings: '第三方 AI 或数据服务的接口配置',
  campaign_kols: '营销活动内已选 KOL 的合作推进、报价及数据快照',
  campaign_videos: '营销活动与视频素材之间的关联记录',
  campaigns: 'KOL 营销活动的基础信息与检索关键词',
  customer_groups: 'KOL 客户分组及分组说明',
  customers: '已入库 KOL 的主档案、联系方式及合作状态',
  finder_tasks: 'KOL Finder 搜索任务、执行进度与结果摘要',
  finder_video_evidence: 'Finder 任务发现的候选视频证据及来源信息',
  kol_platform_accounts: 'KOL 在各内容平台上的账号档案',
  kol_strategies: '营销活动的 KOL 策略、画像、搜索及评分配置',
  prompt_templates: 'AI 视频分析提示词模板',
  raw_candidates: 'Finder 搜索得到、尚待审核入库的 KOL 候选记录',
  sequelize_meta: '系统数据库迁移执行记录，请勿手动修改',
  video_ai_analysis_results: '视频 AI 分析结果、评分、洞察及原始返回',
  video_comments: '视频下采集的用户评论及互动数据',
  video_snapshots: '视频在不同时间点的播放与互动指标快照',
  video_sources: '视频素材主档案、抓取状态及最新数据引用'
};

const COLUMN_COMMENTS = {
  id: '记录唯一编号',
  name: '名称',
  description: '说明',
  status: '当前状态',
  notes: '备注',
  created_at: '记录创建时间',
  updated_at: '记录最后更新时间',
  campaign_id: '所属营销活动编号',
  strategy_id: '关联 KOL 策略编号',
  finder_task_id: '关联 Finder 搜索任务编号',
  customer_id: '关联 KOL 主档案编号',
  video_source_id: '关联视频素材编号',
  platform: '内容平台',
  target_platform: '目标搜索或合作平台',
  source: '数据来源',
  source_url: '原始来源链接',
  raw_data: '来源返回的原始数据（JSON）',
  error_message: '失败或异常说明',
  started_at: '任务开始时间',
  finished_at: '任务结束时间',
  brand: '品牌名称',
  product: '产品名称',
  brand_keywords: '品牌相关关键词（JSON 或文本）',
  purchase_keywords: '购买意向关键词（JSON 或文本）',
  negative_keywords: '排除或负面关键词（JSON 或文本）',
  job_id: '所属批量分析任务编号',
  total_count: '待处理记录总数',
  success_count: '成功处理数量',
  failed_count: '失败处理数量',
  error_detail: '任务错误详情',
  provider: '服务提供商标识',
  api_key: '服务接口密钥（敏感信息）',
  base_url: '服务接口基础地址',
  model: '调用的模型名称',
  extra_config: '服务额外配置（JSON）',
  raw_candidate_id: '来源候选 KOL 记录编号',
  platform_account_id: '关联平台账号编号',
  project_status: '该 KOL 在活动中的项目阶段',
  priority_level: '跟进优先级',
  candidate_priority_score: '候选优先级评分',
  quoted_fee: 'KOL 初始报价',
  final_fee: '最终商定费用',
  currency: '报价币种',
  deliverables: '约定交付内容（JSON 或文本）',
  contact_email_override: '本活动单独指定的联系邮箱',
  contact_name_override: '本活动单独指定的联系人',
  outreach_status: '邀约联系状态',
  negotiation_status: '商务谈判状态',
  contract_status: '合同状态',
  payment_status: '付款状态',
  content_status: '合作内容制作或发布状态',
  cooperation_type: '合作方式，例如付费加寄样或仅寄样',
  project_notes: '活动执行备注',
  internal_notes: '团队内部备注',
  best_evidence_video_id: '最佳证据视频编号',
  best_evidence_url: '最佳证据视频链接',
  evidence_summary: '候选依据摘要',
  master_snapshot: 'KOL 主档案快照（JSON）',
  project_override: '活动内覆盖主档案的字段（JSON）',
  kol_name_snapshot: '入选时的 KOL 名称快照',
  contact_name_snapshot: '入选时的联系人快照',
  youtube_url_snapshot: '入选时的 YouTube 主页快照',
  youtube_followers_snapshot: '入选时的 YouTube 粉丝数快照',
  instagram_url_snapshot: '入选时的 Instagram 主页快照',
  instagram_followers_snapshot: '入选时的 Instagram 粉丝数快照',
  tiktok_url_snapshot: '入选时的 TikTok 主页快照',
  tiktok_followers_snapshot: '入选时的 TikTok 粉丝数快照',
  email_snapshot: '入选时的邮箱快照',
  country_region_snapshot: '入选时的国家或地区快照',
  quoted_price: '原币种报价',
  exchange_rate: '换算人民币所用汇率',
  price_rmb: '折算后的人民币价格',
  owner: '项目负责人',
  youtube_video_link: 'YouTube 合作视频链接',
  instagram_video_link: 'Instagram 合作内容链接',
  tiktok_video_link: 'TikTok 合作视频链接',
  feishu_record_id: '对应飞书多维表格记录编号',
  sync_status: '外部系统同步状态',
  last_synced_at: '最近一次同步时间',
  added_reason: '视频加入活动的原因',
  added_by_finder_task_id: '发现该视频的 Finder 任务编号',
  campaign_kol_id: '该视频对应的活动 KOL 记录编号',
  email: '联系邮箱',
  company: '所属公司或机构',
  phone: '联系电话',
  group_id: '所属客户分组编号',
  first_name: '名字',
  last_name: '姓氏',
  contact_name: '联系人姓名',
  creator_id: '外部系统中的创作者编号',
  profile_url: '主要平台主页链接',
  youtube_url: 'YouTube 主页链接',
  youtube_followers: 'YouTube 粉丝数原始文本',
  instagram_url: 'Instagram 主页链接',
  instagram_followers: 'Instagram 粉丝数原始文本',
  tiktok_url: 'TikTok 主页链接',
  tiktok_followers: 'TikTok 粉丝数原始文本',
  country_language: '主要国家及语言',
  country_region: '国家或地区',
  creator_type: '创作者类型',
  audience_fit: '受众匹配情况',
  contact_route: '建议联系渠道',
  video_price: '单条视频参考报价',
  rating: 'KOL 综合评级',
  source_raw_candidate_id: '首次入库所依据的候选记录编号',
  last_verified_at: '档案最近核验时间',
  cooperation_status: '当前是否适合继续合作',
  cooperation_risk_category: '合作风险分类',
  cooperation_risk_reason: '合作风险原因',
  cooperation_status_updated_at: '合作状态更新时间',
  cooperation_status_source_raw_candidate_id: '合作状态依据的候选记录编号',
  keywords: '本次搜索使用的关键词（JSON）',
  result_count: '任务发现的结果数量',
  search_sources: '启用的搜索服务来源（JSON）',
  discovery_routes: '候选发现路径（JSON）',
  target_platforms: '旧版目标平台列表（JSON，兼容字段）',
  search_cycles: '旧版搜索轮次配置（JSON，兼容字段）',
  current_cycle: '旧版当前搜索轮次（兼容字段）',
  total_cycles: '旧版搜索轮次总数（兼容字段）',
  completed_cycles: '旧版已完成轮次数（兼容字段）',
  provider_attempts: '各搜索服务的调用尝试记录（JSON）',
  raw_request: '任务创建时的原始请求（JSON）',
  raw_response_summary: '搜索服务原始响应摘要（JSON）',
  source_agent: '创建或执行任务的智能体标识',
  evidence_platform: '证据视频所在平台',
  discovery_scope: '本次发现允许的平台范围',
  discovery_route: '发现该证据的检索路径',
  source_signal: '触发发现的信号类型',
  source_query: '发现该结果时使用的检索词',
  evidence_reason: '该视频可作为候选依据的原因',
  platform_user_id: '平台侧用户唯一编号',
  username: '平台账号名',
  profile_url_hash: '主页标准化链接的 SHA-256 哈希',
  followers_count: '可计算的粉丝数量',
  followers_text: '平台展示的粉丝数原始文本',
  avatar_url: '头像链接',
  bio: '平台账号简介',
  category: '产品或内容品类',
  target_market: '目标市场或地区',
  language: '目标内容语言',
  primary_platform: '首要目标平台',
  secondary_platforms: '次要目标平台（JSON）',
  campaign_goal: '营销活动目标',
  product_context: '品牌和产品背景（JSON）',
  persona_config: '目标 KOL 画像配置（JSON）',
  search_strategy: '搜索策略配置（JSON）',
  scoring_weights: '候选评分权重（JSON）',
  finder_handoff: '交给 Finder 的执行配置（JSON）',
  source_material_summary: '策略输入材料摘要',
  source_material_meta: '策略输入材料元数据（JSON）',
  source_material_type: '策略输入材料类型',
  research_status: '外部研究进度状态',
  research_sources: '研究引用来源（JSON）',
  system_prompt: '发送给 AI 的系统提示词',
  user_prompt: '发送给 AI 的用户提示词模板',
  is_default: '是否为默认模板：1 是，0 否',
  kol_name: 'KOL 或频道名称',
  video_url: '作为候选依据的视频链接',
  video_title: '证据视频标题',
  followers: '候选粉丝数原始文本',
  avg_views: '候选平均播放量原始文本',
  matched_keywords: '命中的搜索关键词（JSON 或文本）',
  ai_score: 'AI 给出的匹配评分',
  ai_match_reason: 'AI 给出的匹配理由',
  source_platform: '发现候选时的来源平台',
  approved_customer_id: '审核通过后生成的 KOL 主档案编号',
  approved_campaign_kol_id: '审核通过后生成的活动 KOL 编号',
  search_cycle: '旧版发现候选的搜索轮次（兼容字段）',
  matched_persona: '该候选匹配的 KOL 画像',
  scoring_breakdown: '各评分维度明细（JSON）',
  evidence_url: '用于判断候选的视频证据链接',
  evidence_title: '视频证据标题',
  evidence_type: '证据内容类型',
  rejection_scope: '拒绝结果的影响范围',
  rejection_category: '拒绝原因分类',
  rejection_reason: '拒绝候选的具体原因',
  analysis_type: '分析类型',
  analysis_scope_id: '分析范围或业务对象编号',
  score: 'AI 分析综合评分',
  summary: 'AI 分析摘要',
  sentiment_positive: '正向评论数量',
  sentiment_neutral: '中性评论数量',
  sentiment_negative: '负向评论数量',
  purchase_intent_count: '购买意向信号数量',
  purchase_intent_keywords: '购买意向关键词（JSON）',
  brand_mentions: '品牌提及分析（JSON）',
  risks: '识别到的风险（JSON）',
  product_feedback: '产品反馈分析（JSON）',
  cooperation_advice: 'KOL 合作建议（JSON）',
  content_suggestions: '内容优化建议（JSON）',
  evidence_signals: '支持分析结论的视频证据信号（JSON）',
  full_report: '完整 AI 分析报告（JSON）',
  final_prompt: '实际发送给模型的最终提示词',
  raw_result: '模型原始返回内容',
  extra_data: '额外分析数据（JSON）',
  model_name: '生成结果的 AI 模型名称',
  platform_comment_id: '平台侧评论唯一编号',
  parent_comment_id: '父评论的平台侧编号',
  user_name: '评论用户名称',
  content: '评论正文',
  like_count: '点赞数量',
  commented_at: '平台展示的评论时间',
  play_count: '播放次数',
  comment_count: '评论数量',
  collect_count: '收藏数量',
  share_count: '分享数量',
  primary_exposure_count: '主要曝光指标数值',
  exposure_metric_type: '主要曝光指标类型',
  data_quality_note: '数据质量说明',
  snapshot_at: '该份指标快照的采集时间',
  platform_video_id: '平台侧视频唯一编号',
  canonical_url: '标准化后的视频链接',
  canonical_url_hash: '标准化视频链接的 SHA-256 哈希',
  title: '视频标题',
  author_name: '视频作者名称',
  author_profile_url: '视频作者主页链接',
  author_profile_url_hash: '作者主页标准化链接的 SHA-256 哈希',
  content_type: '视频或内容类型',
  published_at: '平台展示的发布时间',
  cooperation_price: '视频合作报价',
  crawl_status: '视频数据抓取状态',
  analysis_status: '视频 AI 分析状态',
  last_crawled_at: '最近一次抓取时间',
  latest_snapshot_id: '最新视频指标快照编号'
};

function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function columnDefinition(sequelize, column, comment) {
  const parts = [column.Type];
  if (column.Collation) parts.push(`COLLATE ${column.Collation}`);
  parts.push(column.Null === 'NO' ? 'NOT NULL' : 'NULL');

  if (column.Default !== null) {
    const isExpression = /^(CURRENT_TIMESTAMP(?:\(\d+\))?)$/i.test(String(column.Default));
    parts.push(`DEFAULT ${isExpression ? column.Default : sequelize.escape(column.Default)}`);
  } else if (column.Null === 'YES') {
    parts.push('DEFAULT NULL');
  }

  // DEFAULT_GENERATED is metadata reported by SHOW FULL COLUMNS, not valid DDL.
  const writableExtra = String(column.Extra || '')
    .replace(/\bDEFAULT_GENERATED\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (writableExtra) parts.push(writableExtra);
  parts.push(`COMMENT ${sequelize.escape(comment)}`);
  return parts.join(' ');
}

module.exports = {
  async up(queryInterface) {
    const { sequelize } = queryInterface;

    for (const [tableName, tableComment] of Object.entries(TABLE_COMMENTS)) {
      const [columns] = await sequelize.query(`SHOW FULL COLUMNS FROM ${quoteIdentifier(tableName)}`);
      await sequelize.query(
        `ALTER TABLE ${quoteIdentifier(tableName)} COMMENT = ${sequelize.escape(tableComment)}`
      );

      for (const column of columns) {
        const comment = COLUMN_COMMENTS[column.Field];
        if (!comment) {
          throw new Error(`缺少字段注释：${tableName}.${column.Field}`);
        }
        await sequelize.query(
          `ALTER TABLE ${quoteIdentifier(tableName)} MODIFY COLUMN ${quoteIdentifier(column.Field)} ` +
          columnDefinition(sequelize, column, comment)
        );
      }
    }
  },

  async down(queryInterface) {
    const { sequelize } = queryInterface;

    for (const tableName of Object.keys(TABLE_COMMENTS)) {
      const [columns] = await sequelize.query(`SHOW FULL COLUMNS FROM ${quoteIdentifier(tableName)}`);
      await sequelize.query(`ALTER TABLE ${quoteIdentifier(tableName)} COMMENT = ''`);
      for (const column of columns) {
        await sequelize.query(
          `ALTER TABLE ${quoteIdentifier(tableName)} MODIFY COLUMN ${quoteIdentifier(column.Field)} ` +
          columnDefinition(sequelize, column, '')
        );
      }
    }
  }
};
