'use strict';

const DEFAULT_ANALYSIS_SYSTEM_PROMPT = 'You are a senior KOL marketing analyst. Return valid JSON only. Do not include Markdown, explanations, or chain-of-thought. The system is brand-agnostic: never assume the target brand is MOOER or any fixed brand unless it is provided in the campaign context.';
const DEFAULT_ANALYSIS_USER_PROMPT = 'Analyze the video performance metrics and comments for KOL marketing value. Consider creator/category fit, audience feedback, purchase intent, brand or category mentions, collaboration risks, product feedback, cooperation advice, and content optimization suggestions. If a target brand or product is configured, evaluate fit against it; otherwise evaluate the video generically for its apparent category. Return all required fields.';

function isProduction() {
  return String(process.env.NODE_ENV).toLowerCase() === 'production';
}

function assertDevelopment(operation) {
  if (isProduction()) {
    throw new Error(`Database destructive operation "${operation}" is not allowed in production (NODE_ENV=production).`);
  }
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;

    assertDevelopment('DROP TABLE in migration up');

    // Drop legacy tables that are being replaced or removed in V2.
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    const legacyTables = [
      'finder_video_evidence_analysis',
      'finder_subtasks',
      'ai_analysis_results',
      'finder_video_evidence',
      'finder_tasks',
      'raw_candidates',
      'campaign_kols',
      'campaign_videos',
      'kol_platform_accounts',
      'video_comments',
      'video_snapshots',
      'video_ai_analysis_results',
      'video_sources',
      'kol_strategies',
      'prompt_templates',
      'api_settings',
      'campaigns',
      'customers',
      'customer_groups'
    ];
    for (const table of legacyTables) {
      await queryInterface.sequelize.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 1');

    await queryInterface.createTable('customer_groups', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(255), allowNull: false, unique: true },
      description: DataTypes.TEXT,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });

    await queryInterface.createTable('customers', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(255), allowNull: false },
      email: { type: DataTypes.STRING(255), unique: true },
      company: DataTypes.STRING(255),
      phone: DataTypes.STRING(100),
      group_id: DataTypes.INTEGER,
      notes: DataTypes.TEXT,
      status: { type: DataTypes.STRING(50), defaultValue: 'active' },
      first_name: DataTypes.STRING(255),
      last_name: DataTypes.STRING(255),
      contact_name: DataTypes.STRING(255),
      creator_id: DataTypes.STRING(255),
      platform: DataTypes.STRING(100),
      profile_url: DataTypes.STRING(1024),
      youtube_url: DataTypes.STRING(1024),
      youtube_followers: DataTypes.STRING(100),
      instagram_url: DataTypes.STRING(1024),
      instagram_followers: DataTypes.STRING(100),
      tiktok_url: DataTypes.STRING(1024),
      tiktok_followers: DataTypes.STRING(100),
      country_language: DataTypes.STRING(255),
      country_region: DataTypes.STRING(255),
      creator_type: DataTypes.STRING(255),
      audience_fit: DataTypes.STRING(255),
      contact_route: DataTypes.STRING(255),
      video_price: DataTypes.STRING(255),
      exchange_rate: DataTypes.STRING(100),
      price_rmb: DataTypes.STRING(100),
      rating: DataTypes.STRING(100),
      feishu_record_id: DataTypes.STRING(255),
      sync_status: { type: DataTypes.STRING(50), defaultValue: 'sync_pending' },
      last_synced_at: DataTypes.DATE,
      source_raw_candidate_id: DataTypes.INTEGER,
      last_verified_at: DataTypes.DATE,
      cooperation_status: { type: DataTypes.STRING(50), defaultValue: 'available' },
      cooperation_risk_category: DataTypes.STRING(100),
      cooperation_risk_reason: DataTypes.TEXT,
      cooperation_status_updated_at: DataTypes.DATE,
      cooperation_status_source_raw_candidate_id: DataTypes.INTEGER,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addConstraint('customers', {
      fields: ['group_id'],
      type: 'foreign key',
      name: 'fk_customers_group',
      references: { table: 'customer_groups', field: 'id' },
      onDelete: 'SET NULL'
    });

    await queryInterface.createTable('campaigns', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(255), allowNull: false },
      brand: DataTypes.STRING(255),
      product: DataTypes.STRING(255),
      brand_keywords: DataTypes.TEXT,
      purchase_keywords: DataTypes.TEXT,
      negative_keywords: DataTypes.TEXT,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });

    await queryInterface.createTable('kol_strategies', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      campaign_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      brand: DataTypes.STRING(255),
      product: DataTypes.STRING(255),
      category: DataTypes.STRING(255),
      target_market: DataTypes.STRING(255),
      language: DataTypes.STRING(255),
      primary_platform: DataTypes.STRING(100),
      secondary_platforms: DataTypes.TEXT,
      campaign_goal: DataTypes.TEXT,
      status: { type: DataTypes.STRING(50), defaultValue: 'draft' },
      product_context: DataTypes.TEXT,
      persona_config: DataTypes.TEXT,
      scoring_weights: DataTypes.TEXT,
      finder_handoff: DataTypes.TEXT,
      source_material_summary: DataTypes.TEXT,
      source_material_meta: DataTypes.TEXT,
      source_material_type: DataTypes.STRING(100),
      research_status: { type: DataTypes.STRING(50), defaultValue: 'not_started' },
      research_sources: DataTypes.TEXT,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addConstraint('kol_strategies', {
      fields: ['campaign_id'],
      type: 'foreign key',
      name: 'fk_kol_strategies_campaign',
      references: { table: 'campaigns', field: 'id' },
      onDelete: 'CASCADE'
    });

    await queryInterface.createTable('api_settings', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      provider: { type: DataTypes.STRING(255), allowNull: false, unique: true },
      api_key: DataTypes.TEXT,
      base_url: DataTypes.STRING(1024),
      model: DataTypes.STRING(255),
      extra_config: DataTypes.TEXT,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });

    await queryInterface.createTable('prompt_templates', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(255), allowNull: false },
      platform: { type: DataTypes.STRING(100), defaultValue: 'all' },
      system_prompt: DataTypes.TEXT,
      user_prompt: { type: DataTypes.TEXT, allowNull: false },
      brand_keywords: DataTypes.TEXT,
      purchase_keywords: DataTypes.TEXT,
      negative_keywords: DataTypes.TEXT,
      is_default: { type: DataTypes.TINYINT, defaultValue: 0 },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });

    await queryInterface.createTable('finder_tasks', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      campaign_id: DataTypes.INTEGER,
      strategy_id: DataTypes.INTEGER,
      name: DataTypes.STRING(255),
      platform: DataTypes.STRING(100),
      keywords: DataTypes.TEXT,
      status: { type: DataTypes.STRING(50), defaultValue: 'draft' },
      result_count: { type: DataTypes.INTEGER, defaultValue: 0 },
      notes: DataTypes.TEXT,
      search_sources: DataTypes.TEXT,
      discovery_routes: DataTypes.TEXT,
      success_count: { type: DataTypes.INTEGER, defaultValue: 0 },
      failed_count: { type: DataTypes.INTEGER, defaultValue: 0 },
      provider_attempts: DataTypes.TEXT,
      error_message: DataTypes.TEXT,
      raw_request: DataTypes.TEXT,
      raw_response_summary: DataTypes.TEXT,
      source_agent: DataTypes.STRING(255),
      started_at: DataTypes.DATE,
      finished_at: DataTypes.DATE,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addConstraint('finder_tasks', {
      fields: ['campaign_id'],
      type: 'foreign key',
      name: 'fk_finder_tasks_campaign',
      references: { table: 'campaigns', field: 'id' },
      onDelete: 'SET NULL'
    });
    await queryInterface.addConstraint('finder_tasks', {
      fields: ['strategy_id'],
      type: 'foreign key',
      name: 'fk_finder_tasks_strategy',
      references: { table: 'kol_strategies', field: 'id' },
      onDelete: 'SET NULL'
    });

    await queryInterface.createTable('video_sources', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      platform: DataTypes.STRING(100),
      platform_video_id: DataTypes.STRING(255),
      source_url: { type: DataTypes.STRING(2048), allowNull: false },
      canonical_url: { type: DataTypes.STRING(2048), allowNull: false },
      canonical_url_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
      title: DataTypes.TEXT,
      kol_name: DataTypes.STRING(255),
      author_name: DataTypes.STRING(255),
      author_profile_url: DataTypes.STRING(1024),
      author_profile_url_hash: DataTypes.CHAR(64),
      content_type: DataTypes.STRING(100),
      published_at: DataTypes.STRING(100),
      cooperation_price: DataTypes.STRING(255),
      notes: DataTypes.TEXT,
      crawl_status: { type: DataTypes.STRING(50), defaultValue: 'pending' },
      analysis_status: { type: DataTypes.STRING(50), defaultValue: 'not_analyzed' },
      status: { type: DataTypes.STRING(50), defaultValue: 'pending' },
      error_message: DataTypes.TEXT,
      last_crawled_at: DataTypes.DATE,
      latest_snapshot_id: DataTypes.INTEGER,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addIndex('video_sources', ['author_profile_url_hash'], { name: 'idx_video_source_author' });
    await queryInterface.addIndex('video_sources', ['platform', 'platform_video_id'], { name: 'idx_video_source_platform_video' });

    await queryInterface.createTable('video_snapshots', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      video_source_id: { type: DataTypes.INTEGER, allowNull: false },
      play_count: DataTypes.INTEGER,
      like_count: DataTypes.INTEGER,
      comment_count: DataTypes.INTEGER,
      collect_count: DataTypes.INTEGER,
      share_count: DataTypes.INTEGER,
      primary_exposure_count: DataTypes.INTEGER,
      exposure_metric_type: DataTypes.STRING(100),
      data_quality_note: DataTypes.TEXT,
      raw_data: DataTypes.TEXT,
      snapshot_at: { type: DataTypes.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addConstraint('video_snapshots', {
      fields: ['video_source_id'],
      type: 'foreign key',
      name: 'fk_video_snapshots_source',
      references: { table: 'video_sources', field: 'id' },
      onDelete: 'CASCADE'
    });

    await queryInterface.createTable('video_comments', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      video_source_id: { type: DataTypes.INTEGER, allowNull: false },
      platform_comment_id: DataTypes.STRING(255),
      parent_comment_id: DataTypes.STRING(255),
      user_name: DataTypes.STRING(255),
      content: DataTypes.TEXT,
      like_count: DataTypes.INTEGER,
      commented_at: DataTypes.STRING(100),
      raw_data: DataTypes.TEXT,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addConstraint('video_comments', {
      fields: ['video_source_id'],
      type: 'foreign key',
      name: 'fk_video_comments_source',
      references: { table: 'video_sources', field: 'id' },
      onDelete: 'CASCADE'
    });

    await queryInterface.createTable('analysis_jobs', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      status: { type: DataTypes.STRING(50), defaultValue: 'pending' },
      total_count: { type: DataTypes.INTEGER, defaultValue: 0 },
      success_count: { type: DataTypes.INTEGER, defaultValue: 0 },
      failed_count: { type: DataTypes.INTEGER, defaultValue: 0 },
      error_detail: DataTypes.TEXT,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      started_at: DataTypes.DATE,
      finished_at: DataTypes.DATE
    });

    await queryInterface.createTable('analysis_job_items', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      job_id: { type: DataTypes.INTEGER, allowNull: false },
      video_source_id: DataTypes.INTEGER,
      source_url: DataTypes.STRING(1024),
      status: { type: DataTypes.STRING(50), defaultValue: 'pending' },
      error_message: DataTypes.TEXT,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addConstraint('analysis_job_items', {
      fields: ['job_id'],
      type: 'foreign key',
      name: 'fk_analysis_items_job',
      references: { table: 'analysis_jobs', field: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addConstraint('analysis_job_items', {
      fields: ['video_source_id'],
      type: 'foreign key',
      name: 'fk_analysis_items_source',
      references: { table: 'video_sources', field: 'id' },
      onDelete: 'SET NULL'
    });

    await queryInterface.createTable('video_ai_analysis_results', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      video_source_id: { type: DataTypes.INTEGER, allowNull: false },
      analysis_type: { type: DataTypes.STRING(100), allowNull: false },
      analysis_scope_id: DataTypes.INTEGER,
      score: DataTypes.INTEGER,
      summary: DataTypes.TEXT,
      sentiment_positive: DataTypes.INTEGER,
      sentiment_neutral: DataTypes.INTEGER,
      sentiment_negative: DataTypes.INTEGER,
      purchase_intent_count: DataTypes.INTEGER,
      purchase_intent_keywords: DataTypes.TEXT,
      brand_mentions: DataTypes.TEXT,
      risks: DataTypes.TEXT,
      product_feedback: DataTypes.TEXT,
      cooperation_advice: DataTypes.TEXT,
      content_suggestions: DataTypes.TEXT,
      full_report: DataTypes.TEXT,
      final_prompt: DataTypes.TEXT,
      raw_result: DataTypes.TEXT,
      extra_data: DataTypes.TEXT,
      evidence_signals: DataTypes.TEXT('long'),
      model_name: DataTypes.STRING(255),
      status: { type: DataTypes.STRING(50), defaultValue: 'success' },
      error_message: DataTypes.TEXT,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addConstraint('video_ai_analysis_results', {
      fields: ['video_source_id'],
      type: 'foreign key',
      name: 'fk_video_ai_results_source',
      references: { table: 'video_sources', field: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addConstraint('video_ai_analysis_results', {
      fields: ['video_source_id', 'analysis_type', 'analysis_scope_id'],
      type: 'unique',
      name: 'uniq_video_ai_analysis'
    });

    await queryInterface.createTable('finder_video_evidence', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      finder_task_id: { type: DataTypes.INTEGER, allowNull: false },
      strategy_id: DataTypes.INTEGER,
      campaign_id: DataTypes.INTEGER,
      video_source_id: { type: DataTypes.INTEGER, allowNull: false },
      target_platform: { type: DataTypes.STRING(100), allowNull: false },
      evidence_platform: { type: DataTypes.STRING(100), allowNull: false },
      discovery_scope: { type: DataTypes.STRING(100), defaultValue: 'target_platform_only' },
      discovery_route: { type: DataTypes.STRING(255), defaultValue: 'target_platform_first' },
      source_signal: DataTypes.STRING(100),
      source_query: DataTypes.TEXT,
      evidence_reason: DataTypes.TEXT,
      status: { type: DataTypes.STRING(50), defaultValue: 'discovered' },
      raw_data: DataTypes.TEXT,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addConstraint('finder_video_evidence', {
      fields: ['finder_task_id'],
      type: 'foreign key',
      name: 'fk_finder_video_evidence_task',
      references: { table: 'finder_tasks', field: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addConstraint('finder_video_evidence', {
      fields: ['strategy_id'],
      type: 'foreign key',
      name: 'fk_finder_video_evidence_strategy',
      references: { table: 'kol_strategies', field: 'id' },
      onDelete: 'SET NULL'
    });
    await queryInterface.addConstraint('finder_video_evidence', {
      fields: ['campaign_id'],
      type: 'foreign key',
      name: 'fk_finder_video_evidence_campaign',
      references: { table: 'campaigns', field: 'id' },
      onDelete: 'SET NULL'
    });
    await queryInterface.addConstraint('finder_video_evidence', {
      fields: ['video_source_id'],
      type: 'foreign key',
      name: 'fk_finder_video_evidence_source',
      references: { table: 'video_sources', field: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addIndex('finder_video_evidence', ['finder_task_id'], { name: 'idx_finder_video_task' });
    await queryInterface.addIndex('finder_video_evidence', ['video_source_id'], { name: 'idx_finder_video_source' });
    await queryInterface.addIndex('finder_video_evidence', ['target_platform', 'evidence_platform'], { name: 'idx_finder_video_platforms' });

    await queryInterface.createTable('raw_candidates', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      finder_task_id: DataTypes.INTEGER,
      campaign_id: DataTypes.INTEGER,
      strategy_id: DataTypes.INTEGER,
      platform: DataTypes.STRING(100),
      kol_name: { type: DataTypes.STRING(255), allowNull: false },
      contact_name: DataTypes.STRING(255),
      profile_url: DataTypes.STRING(1024),
      video_url: DataTypes.STRING(1024),
      video_title: DataTypes.TEXT,
      followers: DataTypes.STRING(100),
      avg_views: DataTypes.STRING(100),
      email: DataTypes.STRING(255),
      phone: DataTypes.STRING(100),
      country_region: DataTypes.STRING(255),
      matched_keywords: DataTypes.TEXT,
      ai_score: DataTypes.INTEGER,
      ai_match_reason: DataTypes.TEXT,
      status: { type: DataTypes.STRING(50), defaultValue: 'new' },
      source: DataTypes.STRING(255),
      discovery_route: DataTypes.STRING(255),
      source_platform: DataTypes.STRING(100),
      target_platform: DataTypes.STRING(100),
      source_agent: DataTypes.STRING(255),
      raw_data: DataTypes.TEXT,
      approved_customer_id: DataTypes.INTEGER,
      approved_campaign_kol_id: DataTypes.INTEGER,
      error_message: DataTypes.TEXT,
      matched_persona: DataTypes.TEXT,
      scoring_breakdown: DataTypes.TEXT,
      evidence_url: DataTypes.STRING(1024),
      evidence_title: DataTypes.TEXT,
      evidence_type: DataTypes.STRING(100),
      source_query: DataTypes.TEXT,
      rejection_scope: DataTypes.STRING(50),
      rejection_category: DataTypes.STRING(100),
      rejection_reason: DataTypes.TEXT,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addConstraint('raw_candidates', {
      fields: ['finder_task_id'],
      type: 'foreign key',
      name: 'fk_raw_candidates_task',
      references: { table: 'finder_tasks', field: 'id' },
      onDelete: 'SET NULL'
    });
    await queryInterface.addConstraint('raw_candidates', {
      fields: ['campaign_id'],
      type: 'foreign key',
      name: 'fk_raw_candidates_campaign',
      references: { table: 'campaigns', field: 'id' },
      onDelete: 'SET NULL'
    });
    await queryInterface.addConstraint('raw_candidates', {
      fields: ['strategy_id'],
      type: 'foreign key',
      name: 'fk_raw_candidates_strategy',
      references: { table: 'kol_strategies', field: 'id' },
      onDelete: 'SET NULL'
    });
    await queryInterface.addConstraint('raw_candidates', {
      fields: ['approved_customer_id'],
      type: 'foreign key',
      name: 'fk_raw_candidates_customer',
      references: { table: 'customers', field: 'id' },
      onDelete: 'SET NULL'
    });

    await queryInterface.createTable('campaign_kols', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      campaign_id: { type: DataTypes.INTEGER, allowNull: false },
      strategy_id: DataTypes.INTEGER,
      finder_task_id: DataTypes.INTEGER,
      raw_candidate_id: DataTypes.INTEGER,
      customer_id: { type: DataTypes.INTEGER, allowNull: false },
      platform_account_id: DataTypes.INTEGER,
      target_platform: DataTypes.STRING(100),
      source: DataTypes.STRING(255),

      project_status: { type: DataTypes.STRING(50), defaultValue: 'candidate' },
      priority_level: { type: DataTypes.STRING(50), defaultValue: 'normal' },
      candidate_priority_score: DataTypes.INTEGER,

      quoted_fee: DataTypes.STRING(255),
      final_fee: DataTypes.STRING(255),
      currency: DataTypes.STRING(50),
      deliverables: DataTypes.TEXT,

      contact_email_override: DataTypes.STRING(255),
      contact_name_override: DataTypes.STRING(255),

      outreach_status: DataTypes.STRING(50),
      negotiation_status: DataTypes.STRING(50),
      contract_status: DataTypes.STRING(50),
      payment_status: DataTypes.STRING(50),
      content_status: DataTypes.STRING(50),

      project_notes: DataTypes.TEXT,
      internal_notes: DataTypes.TEXT,

      best_evidence_video_id: DataTypes.INTEGER,
      best_evidence_url: DataTypes.STRING(1024),
      evidence_summary: DataTypes.TEXT,

      master_snapshot: DataTypes.TEXT,
      project_override: DataTypes.TEXT,

      // Compatibility fields
      kol_name_snapshot: DataTypes.STRING(255),
      contact_name_snapshot: DataTypes.STRING(255),
      youtube_url_snapshot: DataTypes.STRING(1024),
      youtube_followers_snapshot: DataTypes.STRING(100),
      instagram_url_snapshot: DataTypes.STRING(1024),
      instagram_followers_snapshot: DataTypes.STRING(100),
      tiktok_url_snapshot: DataTypes.STRING(1024),
      tiktok_followers_snapshot: DataTypes.STRING(100),
      email_snapshot: DataTypes.STRING(255),
      country_region_snapshot: DataTypes.STRING(255),
      quoted_price: DataTypes.STRING(255),
      exchange_rate: DataTypes.STRING(100),
      price_rmb: DataTypes.STRING(100),
      status: { type: DataTypes.STRING(50), defaultValue: 'candidate' },
      owner: DataTypes.STRING(255),
      youtube_video_link: DataTypes.STRING(1024),
      instagram_video_link: DataTypes.STRING(1024),
      tiktok_video_link: DataTypes.STRING(1024),
      notes: DataTypes.TEXT,
      feishu_record_id: DataTypes.STRING(255),
      sync_status: { type: DataTypes.STRING(50), defaultValue: 'sync_pending' },
      last_synced_at: DataTypes.DATE,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addConstraint('campaign_kols', {
      fields: ['campaign_id'],
      type: 'foreign key',
      name: 'fk_campaign_kols_campaign',
      references: { table: 'campaigns', field: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addConstraint('campaign_kols', {
      fields: ['strategy_id'],
      type: 'foreign key',
      name: 'fk_campaign_kols_strategy',
      references: { table: 'kol_strategies', field: 'id' },
      onDelete: 'SET NULL'
    });
    await queryInterface.addConstraint('campaign_kols', {
      fields: ['finder_task_id'],
      type: 'foreign key',
      name: 'fk_campaign_kols_finder_task',
      references: { table: 'finder_tasks', field: 'id' },
      onDelete: 'SET NULL'
    });
    await queryInterface.addConstraint('campaign_kols', {
      fields: ['customer_id'],
      type: 'foreign key',
      name: 'fk_campaign_kols_customer',
      references: { table: 'customers', field: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addConstraint('campaign_kols', {
      fields: ['raw_candidate_id'],
      type: 'foreign key',
      name: 'fk_campaign_kols_raw',
      references: { table: 'raw_candidates', field: 'id' },
      onDelete: 'SET NULL'
    });

    await queryInterface.createTable('kol_platform_accounts', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      customer_id: { type: DataTypes.INTEGER, allowNull: false },
      platform: { type: DataTypes.STRING(100), allowNull: false },
      platform_user_id: DataTypes.STRING(255),
      username: DataTypes.STRING(255),
      profile_url: DataTypes.STRING(1024),
      profile_url_hash: DataTypes.CHAR(64),
      followers_count: DataTypes.INTEGER,
      followers_text: DataTypes.STRING(100),
      avatar_url: DataTypes.STRING(1024),
      bio: DataTypes.TEXT,
      raw_data: DataTypes.TEXT,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addConstraint('kol_platform_accounts', {
      fields: ['customer_id'],
      type: 'foreign key',
      name: 'fk_kol_platform_accounts_customer',
      references: { table: 'customers', field: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addConstraint('kol_platform_accounts', {
      fields: ['customer_id', 'platform', 'platform_user_id'],
      type: 'unique',
      name: 'uniq_kol_platform_account'
    });

    await queryInterface.addConstraint('campaign_kols', {
      fields: ['platform_account_id'],
      type: 'foreign key',
      name: 'fk_campaign_kols_platform_account',
      references: { table: 'kol_platform_accounts', field: 'id' },
      onDelete: 'SET NULL'
    });
    await queryInterface.addConstraint('campaign_kols', {
      fields: ['best_evidence_video_id'],
      type: 'foreign key',
      name: 'fk_campaign_kols_best_evidence',
      references: { table: 'video_sources', field: 'id' },
      onDelete: 'SET NULL'
    });
    await queryInterface.addConstraint('campaign_kols', {
      fields: ['campaign_id', 'platform_account_id'],
      type: 'unique',
      name: 'uniq_campaign_platform_account'
    });

    await queryInterface.createTable('campaign_videos', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      campaign_id: { type: DataTypes.INTEGER, allowNull: false },
      video_source_id: { type: DataTypes.INTEGER, allowNull: false },
      added_reason: { type: DataTypes.STRING(100), defaultValue: 'manual' },
      added_by_finder_task_id: DataTypes.INTEGER,
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') }
    });
    await queryInterface.addConstraint('campaign_videos', {
      fields: ['campaign_id'],
      type: 'foreign key',
      name: 'fk_campaign_videos_campaign',
      references: { table: 'campaigns', field: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addConstraint('campaign_videos', {
      fields: ['video_source_id'],
      type: 'foreign key',
      name: 'fk_campaign_videos_source',
      references: { table: 'video_sources', field: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addConstraint('campaign_videos', {
      fields: ['added_by_finder_task_id'],
      type: 'foreign key',
      name: 'fk_campaign_videos_finder_task',
      references: { table: 'finder_tasks', field: 'id' },
      onDelete: 'SET NULL'
    });
    await queryInterface.addConstraint('campaign_videos', {
      fields: ['campaign_id', 'video_source_id'],
      type: 'unique',
      name: 'uniq_campaign_video'
    });

    // Seed default data
    await queryInterface.bulkInsert('customer_groups', [
      { id: 1, name: 'Prospects', description: 'New KOL candidates' },
      { id: 2, name: 'Contacted', description: 'Creators already contacted' },
      { id: 3, name: 'Collaborated', description: 'Creators with past collaboration' }
    ]);

    await queryInterface.bulkInsert('campaigns', [
      {
        id: 1,
        name: 'Default Campaign',
        brand: '',
        product: '',
        brand_keywords: '',
        purchase_keywords: 'price,how much,where to buy,link,buy,discount,coupon',
        negative_keywords: 'fake,bad,poor quality,expensive,difficult,scam,ad'
      }
    ]);

    await queryInterface.bulkInsert('prompt_templates', [
      {
        id: 1,
        name: 'Default Video Analysis',
        platform: 'all',
        system_prompt: DEFAULT_ANALYSIS_SYSTEM_PROMPT,
        user_prompt: DEFAULT_ANALYSIS_USER_PROMPT,
        brand_keywords: '',
        purchase_keywords: 'price,how much,where to buy,link,buy,discount,coupon',
        negative_keywords: 'fake,bad,poor quality,expensive,difficult,scam,ad',
        is_default: 1
      }
    ]);
  },

  async down(queryInterface) {
    assertDevelopment('DROP TABLE in migration down');
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    const tables = [
      'campaign_videos',
      'kol_platform_accounts',
      'campaign_kols',
      'raw_candidates',
      'finder_video_evidence',
      'video_ai_analysis_results',
      'analysis_job_items',
      'analysis_jobs',
      'video_comments',
      'video_snapshots',
      'video_sources',
      'finder_tasks',
      'prompt_templates',
      'api_settings',
      'kol_strategies',
      'campaigns',
      'customers',
      'customer_groups'
    ];
    for (const table of tables) {
      await queryInterface.sequelize.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  }
};
