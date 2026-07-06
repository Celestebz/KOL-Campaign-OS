const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
dotenv.config();

const DEFAULT_ANALYSIS_SYSTEM_PROMPT = 'You are a senior KOL marketing analyst. Return valid JSON only. Do not include Markdown, explanations, or chain-of-thought. The system is brand-agnostic: never assume the target brand is MOOER or any fixed brand unless it is provided in the campaign context.';
const DEFAULT_ANALYSIS_USER_PROMPT = 'Analyze the video performance metrics and comments for KOL marketing value. Consider creator/category fit, audience feedback, purchase intent, brand or category mentions, collaboration risks, product feedback, cooperation advice, and content optimization suggestions. If a target brand or product is configured, evaluate fit against it; otherwise evaluate the video generically for its apparent category. Return all required fields.';

let pool;

function getDbConfig() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'kol_user',
    password: process.env.DB_PASSWORD || 'kol_password',
    database: process.env.DB_NAME || 'kol_campaign_os',
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    namedPlaceholders: false,
    multipleStatements: false,
    charset: 'utf8mb4'
  };
}

async function getPool() {
  if (!pool) {
    const mysql = require('mysql2/promise');
    pool = mysql.createPool(getDbConfig());
  }
  return pool;
}

const dbOperations = {
  query: async (sql, params = []) => {
    const connectionPool = await getPool();
    const [rows] = await connectionPool.execute(sql, params);
    return rows;
  },
  get: async (sql, params = []) => {
    const rows = await dbOperations.query(sql, params);
    return rows[0] || null;
  },
  run: async (sql, params = []) => {
    const connectionPool = await getPool();
    const [result] = await connectionPool.execute(sql, params);
    return {
      id: result.insertId || 0,
      changes: result.affectedRows || 0
    };
  }
};

function assertIdentifier(value) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`Unsafe database identifier: ${value}`);
  }
  return value;
}

function normalizeColumnDefinition(definition) {
  return String(definition)
    .replace(/\bINTEGER\b/gi, 'INT')
    .replace(/\bTEXT\b/gi, 'LONGTEXT');
}

async function addColumnIfMissing(table, column, definition) {
  const tableName = assertIdentifier(table);
  const columnName = assertIdentifier(column);
  const existing = await dbOperations.get(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName]
  );

  if (!existing) {
    await dbOperations.run(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${normalizeColumnDefinition(definition)}`);
  }
}

async function initDatabase() {
  await dbOperations.run(`CREATE TABLE IF NOT EXISTS customer_groups (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description LONGTEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE,
    company VARCHAR(255),
    phone VARCHAR(100),
    group_id INT NULL,
    notes LONGTEXT,
    status VARCHAR(50) DEFAULT 'active',
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    contact_name VARCHAR(255),
    creator_id VARCHAR(255),
    platform VARCHAR(100),
    profile_url VARCHAR(1024),
    youtube_url VARCHAR(1024),
    youtube_followers VARCHAR(100),
    instagram_url VARCHAR(1024),
    instagram_followers VARCHAR(100),
    tiktok_url VARCHAR(1024),
    tiktok_followers VARCHAR(100),
    country_language VARCHAR(255),
    country_region VARCHAR(255),
    creator_type VARCHAR(255),
    audience_fit VARCHAR(255),
    contact_route VARCHAR(255),
    video_price VARCHAR(255),
    exchange_rate VARCHAR(100),
    price_rmb VARCHAR(100),
    rating VARCHAR(100),
    feishu_record_id VARCHAR(255),
    sync_status VARCHAR(50) DEFAULT 'sync_pending',
    last_synced_at DATETIME,
    source_raw_candidate_id INT,
    last_verified_at DATETIME,
    cooperation_status VARCHAR(50) DEFAULT 'available',
    cooperation_risk_category VARCHAR(100),
    cooperation_risk_reason LONGTEXT,
    cooperation_status_updated_at DATETIME,
    cooperation_status_source_raw_candidate_id INT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_customers_group FOREIGN KEY (group_id) REFERENCES customer_groups (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS campaigns (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    brand VARCHAR(255),
    product VARCHAR(255),
    brand_keywords LONGTEXT,
    purchase_keywords LONGTEXT,
    negative_keywords LONGTEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS video_sources (
    id INT AUTO_INCREMENT PRIMARY KEY,
    campaign_id INT,
    platform VARCHAR(100),
    source_url VARCHAR(768) NOT NULL UNIQUE,
    platform_video_id VARCHAR(255),
    kol_name VARCHAR(255),
    title LONGTEXT,
    author_name VARCHAR(255),
    content_type VARCHAR(100),
    published_at VARCHAR(100),
    cooperation_price VARCHAR(255),
    notes LONGTEXT,
    crawl_status VARCHAR(50) DEFAULT 'pending',
    analysis_status VARCHAR(50) DEFAULT 'not_analyzed',
    status VARCHAR(50) DEFAULT 'pending',
    error_message LONGTEXT,
    last_crawled_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_video_sources_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS video_snapshots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    video_source_id INT NOT NULL,
    play_count INT,
    like_count INT,
    comment_count INT,
    collect_count INT,
    share_count INT,
    primary_exposure_count INT,
    exposure_metric_type VARCHAR(100),
    data_quality_note LONGTEXT,
    raw_data LONGTEXT,
    snapshot_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_video_snapshots_source FOREIGN KEY (video_source_id) REFERENCES video_sources (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS video_comments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    video_source_id INT NOT NULL,
    platform_comment_id VARCHAR(255),
    parent_comment_id VARCHAR(255),
    user_name VARCHAR(255),
    content LONGTEXT,
    like_count INT,
    commented_at VARCHAR(100),
    raw_data LONGTEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_video_comments_source FOREIGN KEY (video_source_id) REFERENCES video_sources (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS ai_analysis_results (
    id INT AUTO_INCREMENT PRIMARY KEY,
    video_source_id INT NOT NULL,
    score INT,
    summary LONGTEXT,
    sentiment_positive INT,
    sentiment_neutral INT,
    sentiment_negative INT,
    purchase_intent_count INT,
    purchase_intent_keywords LONGTEXT,
    brand_mentions LONGTEXT,
    risks LONGTEXT,
    product_feedback LONGTEXT,
    cooperation_advice LONGTEXT,
    content_suggestions LONGTEXT,
    full_report LONGTEXT,
    final_prompt LONGTEXT,
    raw_result LONGTEXT,
    model_name VARCHAR(255),
    status VARCHAR(50) DEFAULT 'success',
    error_message LONGTEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_ai_results_source FOREIGN KEY (video_source_id) REFERENCES video_sources (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS analysis_jobs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    status VARCHAR(50) DEFAULT 'pending',
    total_count INT DEFAULT 0,
    success_count INT DEFAULT 0,
    failed_count INT DEFAULT 0,
    error_detail LONGTEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    finished_at DATETIME
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS analysis_job_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    job_id INT NOT NULL,
    video_source_id INT,
    source_url VARCHAR(1024),
    status VARCHAR(50) DEFAULT 'pending',
    error_message LONGTEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_analysis_items_job FOREIGN KEY (job_id) REFERENCES analysis_jobs (id) ON DELETE CASCADE,
    CONSTRAINT fk_analysis_items_source FOREIGN KEY (video_source_id) REFERENCES video_sources (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS api_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider VARCHAR(255) NOT NULL UNIQUE,
    api_key LONGTEXT,
    base_url VARCHAR(1024),
    model VARCHAR(255),
    extra_config LONGTEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS prompt_templates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    platform VARCHAR(100) DEFAULT 'all',
    system_prompt LONGTEXT,
    user_prompt LONGTEXT NOT NULL,
    brand_keywords LONGTEXT,
    purchase_keywords LONGTEXT,
    negative_keywords LONGTEXT,
    is_default TINYINT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS kol_strategies (
    id INT AUTO_INCREMENT PRIMARY KEY,
    campaign_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    brand VARCHAR(255),
    product VARCHAR(255),
    category VARCHAR(255),
    target_market VARCHAR(255),
    language VARCHAR(255),
    primary_platform VARCHAR(100),
    secondary_platforms LONGTEXT,
    campaign_goal LONGTEXT,
    status VARCHAR(50) DEFAULT 'draft',
    product_context LONGTEXT,
    persona_config LONGTEXT,
    search_strategy LONGTEXT,
    scoring_weights LONGTEXT,
    finder_handoff LONGTEXT,
    source_material_summary LONGTEXT,
    source_material_meta LONGTEXT,
    source_material_type VARCHAR(100),
    research_status VARCHAR(50) DEFAULT 'not_started',
    research_sources LONGTEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_kol_strategies_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS finder_tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    campaign_id INT,
    strategy_id INT,
    name VARCHAR(255),
    platform VARCHAR(100),
    keywords LONGTEXT,
    status VARCHAR(50) DEFAULT 'draft',
    result_count INT DEFAULT 0,
    notes LONGTEXT,
    search_sources LONGTEXT,
    discovery_routes LONGTEXT,
    target_platforms LONGTEXT,
    search_cycles LONGTEXT,
    current_cycle VARCHAR(100),
    total_cycles INT DEFAULT 0,
    completed_cycles INT DEFAULT 0,
    success_count INT DEFAULT 0,
    failed_count INT DEFAULT 0,
    provider_attempts LONGTEXT,
    error_message LONGTEXT,
    raw_request LONGTEXT,
    raw_response_summary LONGTEXT,
    source_agent VARCHAR(255),
    started_at DATETIME,
    finished_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_finder_tasks_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE SET NULL,
    CONSTRAINT fk_finder_tasks_strategy FOREIGN KEY (strategy_id) REFERENCES kol_strategies (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS finder_video_evidence (
    id INT AUTO_INCREMENT PRIMARY KEY,
    finder_task_id INT NOT NULL,
    strategy_id INT,
    campaign_id INT,
    video_source_id INT,
    target_platform VARCHAR(100) NOT NULL,
    evidence_platform VARCHAR(100) NOT NULL,
    discovery_scope VARCHAR(100) DEFAULT 'target_platform_only',
    discovery_route VARCHAR(255) DEFAULT 'target_platform_first',
    video_url VARCHAR(1024) NOT NULL,
    platform_video_id VARCHAR(255),
    title LONGTEXT,
    author_name VARCHAR(255),
    author_profile_url VARCHAR(1024),
    source_signal VARCHAR(100),
    source_query LONGTEXT,
    evidence_reason LONGTEXT,
    status VARCHAR(50) DEFAULT 'discovered',
    raw_data LONGTEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_finder_video_evidence_task FOREIGN KEY (finder_task_id) REFERENCES finder_tasks (id) ON DELETE CASCADE,
    CONSTRAINT fk_finder_video_evidence_strategy FOREIGN KEY (strategy_id) REFERENCES kol_strategies (id) ON DELETE SET NULL,
    CONSTRAINT fk_finder_video_evidence_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE SET NULL,
    CONSTRAINT fk_finder_video_evidence_source FOREIGN KEY (video_source_id) REFERENCES video_sources (id) ON DELETE SET NULL,
    INDEX idx_finder_video_task (finder_task_id),
    INDEX idx_finder_video_source (video_source_id),
    INDEX idx_finder_video_platforms (target_platform, evidence_platform),
    INDEX idx_finder_video_url (video_url(255))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS finder_video_evidence_analysis (
    id INT AUTO_INCREMENT PRIMARY KEY,
    finder_task_id INT NOT NULL,
    finder_video_evidence_id INT NOT NULL,
    video_source_id INT,
    analysis_status VARCHAR(50) DEFAULT 'pending',
    model_name VARCHAR(255),
    content_relevance_score INT,
    creator_fit_score INT,
    evidence_strength_score INT,
    freshness_score INT,
    brand_safety_risk VARCHAR(50),
    kol_candidate_potential_score INT,
    audience_signal_score INT,
    engagement_quality_score INT,
    comment_signal_available TINYINT DEFAULT 0,
    purchase_intent_signal LONGTEXT,
    comment_risk_signal LONGTEXT,
    summary LONGTEXT,
    matched_topics LONGTEXT,
    matched_personas LONGTEXT,
    risk_notes LONGTEXT,
    recommendation VARCHAR(100),
    raw_result LONGTEXT,
    final_prompt LONGTEXT,
    error_message LONGTEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_finder_video_evidence_analysis (finder_video_evidence_id),
    CONSTRAINT fk_finder_video_analysis_task FOREIGN KEY (finder_task_id) REFERENCES finder_tasks (id) ON DELETE CASCADE,
    CONSTRAINT fk_finder_video_analysis_evidence FOREIGN KEY (finder_video_evidence_id) REFERENCES finder_video_evidence (id) ON DELETE CASCADE,
    CONSTRAINT fk_finder_video_analysis_source FOREIGN KEY (video_source_id) REFERENCES video_sources (id) ON DELETE SET NULL,
    INDEX idx_finder_video_analysis_task (finder_task_id),
    INDEX idx_finder_video_analysis_source (video_source_id),
    INDEX idx_finder_video_analysis_status (analysis_status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS raw_candidates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    finder_task_id INT,
    campaign_id INT,
    strategy_id INT,
    platform VARCHAR(100),
    kol_name VARCHAR(255) NOT NULL,
    contact_name VARCHAR(255),
    profile_url VARCHAR(1024),
    video_url VARCHAR(1024),
    video_title LONGTEXT,
    followers VARCHAR(100),
    avg_views VARCHAR(100),
    email VARCHAR(255),
    phone VARCHAR(100),
    country_region VARCHAR(255),
    matched_keywords LONGTEXT,
    ai_score INT,
    ai_match_reason LONGTEXT,
    status VARCHAR(50) DEFAULT 'new',
    source VARCHAR(255),
    discovery_route VARCHAR(255),
    source_platform VARCHAR(100),
    target_platform VARCHAR(100),
    source_agent VARCHAR(255),
    raw_data LONGTEXT,
    approved_customer_id INT,
    approved_campaign_kol_id INT,
    error_message LONGTEXT,
    search_cycle VARCHAR(100),
    matched_persona LONGTEXT,
    scoring_breakdown LONGTEXT,
    evidence_url VARCHAR(1024),
    evidence_title LONGTEXT,
    evidence_type VARCHAR(100),
    source_query LONGTEXT,
    rejection_scope VARCHAR(50),
    rejection_category VARCHAR(100),
    rejection_reason LONGTEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_raw_candidates_task FOREIGN KEY (finder_task_id) REFERENCES finder_tasks (id) ON DELETE SET NULL,
    CONSTRAINT fk_raw_candidates_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE SET NULL,
    CONSTRAINT fk_raw_candidates_strategy FOREIGN KEY (strategy_id) REFERENCES kol_strategies (id) ON DELETE SET NULL,
    CONSTRAINT fk_raw_candidates_customer FOREIGN KEY (approved_customer_id) REFERENCES customers (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS finder_subtasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    finder_task_id INT NOT NULL,
    strategy_id INT,
    campaign_id INT,
    name VARCHAR(255),
    status VARCHAR(50) DEFAULT 'pending',
    discovery_route VARCHAR(255),
    source_platform VARCHAR(100),
    target_platform VARCHAR(100),
    search_cycle VARCHAR(100),
    source_query LONGTEXT,
    agent_prompt LONGTEXT,
    agent_result_summary LONGTEXT,
    accepted_count INT DEFAULT 0,
    rejected_count INT DEFAULT 0,
    failed_count INT DEFAULT 0,
    started_at DATETIME,
    finished_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_finder_subtasks_task FOREIGN KEY (finder_task_id) REFERENCES finder_tasks (id) ON DELETE CASCADE,
    CONSTRAINT fk_finder_subtasks_strategy FOREIGN KEY (strategy_id) REFERENCES kol_strategies (id) ON DELETE SET NULL,
    CONSTRAINT fk_finder_subtasks_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`CREATE TABLE IF NOT EXISTS campaign_kols (
    id INT AUTO_INCREMENT PRIMARY KEY,
    campaign_id INT NOT NULL,
    customer_id INT NOT NULL,
    raw_candidate_id INT,
    kol_name_snapshot VARCHAR(255),
    contact_name_snapshot VARCHAR(255),
    youtube_url_snapshot VARCHAR(1024),
    youtube_followers_snapshot VARCHAR(100),
    instagram_url_snapshot VARCHAR(1024),
    instagram_followers_snapshot VARCHAR(100),
    tiktok_url_snapshot VARCHAR(1024),
    tiktok_followers_snapshot VARCHAR(100),
    email_snapshot VARCHAR(255),
    country_region_snapshot VARCHAR(255),
    quoted_price VARCHAR(255),
    exchange_rate VARCHAR(100),
    price_rmb VARCHAR(100),
    status VARCHAR(50) DEFAULT 'candidate',
    owner VARCHAR(255),
    youtube_video_link VARCHAR(1024),
    instagram_video_link VARCHAR(1024),
    tiktok_video_link VARCHAR(1024),
    notes LONGTEXT,
    feishu_record_id VARCHAR(255),
    sync_status VARCHAR(50) DEFAULT 'sync_pending',
    last_synced_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_campaign_kols_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE,
    CONSTRAINT fk_campaign_kols_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
    CONSTRAINT fk_campaign_kols_raw FOREIGN KEY (raw_candidate_id) REFERENCES raw_candidates (id) ON DELETE SET NULL,
    UNIQUE KEY uniq_campaign_customer (campaign_id, customer_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await dbOperations.run(`INSERT IGNORE INTO customer_groups (id, name, description) VALUES
    (1, 'Prospects', 'New KOL candidates'),
    (2, 'Contacted', 'Creators already contacted'),
    (3, 'Collaborated', 'Creators with past collaboration')`);

  await dbOperations.run(`INSERT IGNORE INTO campaigns
    (id, name, brand, product, brand_keywords, purchase_keywords, negative_keywords)
    VALUES
    (1, 'Default Campaign', '', '', '', 'price,how much,where to buy,link,buy,discount,coupon', 'fake,bad,poor quality,expensive,difficult,scam,ad')`);

  await dbOperations.run(`INSERT IGNORE INTO prompt_templates
    (id, name, platform, system_prompt, user_prompt, brand_keywords, purchase_keywords, negative_keywords, is_default)
    VALUES
    (1, 'Default Video Analysis', 'all',
     'You are a KOL marketing analyst. Return valid JSON only.',
     'Analyze the video performance metrics and comments. Evaluate campaign value, audience feedback, purchase intent, risks, product feedback, cooperation advice, and content suggestions.',
     '', 'price,how much,where to buy,link,buy,discount,coupon',
     'fake,bad,poor quality,expensive,difficult,scam,ad', 1)`);

  await dbOperations.run(
    'UPDATE prompt_templates SET system_prompt = ?, user_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
    [DEFAULT_ANALYSIS_SYSTEM_PROMPT, DEFAULT_ANALYSIS_USER_PROMPT]
  );

  await addColumnIfMissing('customers', 'creator_id', 'VARCHAR(255)');
  await addColumnIfMissing('customers', 'platform', 'VARCHAR(100)');
  await addColumnIfMissing('customers', 'profile_url', 'VARCHAR(1024)');
  await addColumnIfMissing('customers', 'contact_name', 'VARCHAR(255)');
  await addColumnIfMissing('customers', 'youtube_url', 'VARCHAR(1024)');
  await addColumnIfMissing('customers', 'youtube_followers', 'VARCHAR(100)');
  await addColumnIfMissing('customers', 'instagram_url', 'VARCHAR(1024)');
  await addColumnIfMissing('customers', 'instagram_followers', 'VARCHAR(100)');
  await addColumnIfMissing('customers', 'tiktok_url', 'VARCHAR(1024)');
  await addColumnIfMissing('customers', 'tiktok_followers', 'VARCHAR(100)');
  await addColumnIfMissing('customers', 'country_language', 'VARCHAR(255)');
  await addColumnIfMissing('customers', 'country_region', 'VARCHAR(255)');
  await addColumnIfMissing('customers', 'creator_type', 'VARCHAR(255)');
  await addColumnIfMissing('customers', 'audience_fit', 'VARCHAR(255)');
  await addColumnIfMissing('customers', 'contact_route', 'VARCHAR(255)');
  await addColumnIfMissing('customers', 'video_price', 'VARCHAR(255)');
  await addColumnIfMissing('customers', 'exchange_rate', 'VARCHAR(100)');
  await addColumnIfMissing('customers', 'price_rmb', 'VARCHAR(100)');
  await addColumnIfMissing('customers', 'rating', 'VARCHAR(100)');
  await addColumnIfMissing('customers', 'feishu_record_id', 'VARCHAR(255)');
  await addColumnIfMissing('customers', 'sync_status', "VARCHAR(50) DEFAULT 'sync_pending'");
  await addColumnIfMissing('customers', 'last_synced_at', 'DATETIME');
  await addColumnIfMissing('customers', 'source_raw_candidate_id', 'INT');
  await addColumnIfMissing('customers', 'last_verified_at', 'DATETIME');
  await addColumnIfMissing('customers', 'cooperation_status', "VARCHAR(50) DEFAULT 'available'");
  await addColumnIfMissing('customers', 'cooperation_risk_category', 'VARCHAR(100)');
  await addColumnIfMissing('customers', 'cooperation_risk_reason', 'LONGTEXT');
  await addColumnIfMissing('customers', 'cooperation_status_updated_at', 'DATETIME');
  await addColumnIfMissing('customers', 'cooperation_status_source_raw_candidate_id', 'INT');
  await addColumnIfMissing('finder_tasks', 'strategy_id', 'INT');
  await addColumnIfMissing('finder_tasks', 'search_sources', 'LONGTEXT');
  await addColumnIfMissing('finder_tasks', 'discovery_routes', 'LONGTEXT');
  await addColumnIfMissing('finder_tasks', 'target_platforms', 'LONGTEXT');
  await addColumnIfMissing('finder_tasks', 'search_cycles', 'LONGTEXT');
  await addColumnIfMissing('finder_tasks', 'current_cycle', 'VARCHAR(100)');
  await addColumnIfMissing('finder_tasks', 'total_cycles', 'INT DEFAULT 0');
  await addColumnIfMissing('finder_tasks', 'completed_cycles', 'INT DEFAULT 0');
  await addColumnIfMissing('finder_tasks', 'success_count', 'INT DEFAULT 0');
  await addColumnIfMissing('finder_tasks', 'failed_count', 'INT DEFAULT 0');
  await addColumnIfMissing('finder_tasks', 'provider_attempts', 'LONGTEXT');
  await addColumnIfMissing('finder_tasks', 'error_message', 'LONGTEXT');
  await addColumnIfMissing('finder_tasks', 'raw_request', 'LONGTEXT');
  await addColumnIfMissing('finder_tasks', 'raw_response_summary', 'LONGTEXT');
  await addColumnIfMissing('finder_tasks', 'source_agent', 'VARCHAR(255)');
  await addColumnIfMissing('finder_tasks', 'started_at', 'DATETIME');
  await addColumnIfMissing('finder_tasks', 'finished_at', 'DATETIME');
  await addColumnIfMissing('kol_strategies', 'source_material_summary', 'LONGTEXT');
  await addColumnIfMissing('kol_strategies', 'source_material_meta', 'LONGTEXT');
  await addColumnIfMissing('kol_strategies', 'source_material_type', 'VARCHAR(100)');
  await addColumnIfMissing('kol_strategies', 'research_status', "VARCHAR(50) DEFAULT 'not_started'");
  await addColumnIfMissing('kol_strategies', 'research_sources', 'LONGTEXT');
  await addColumnIfMissing('raw_candidates', 'strategy_id', 'INT');
  await addColumnIfMissing('raw_candidates', 'search_cycle', 'VARCHAR(100)');
  await addColumnIfMissing('raw_candidates', 'matched_persona', 'LONGTEXT');
  await addColumnIfMissing('raw_candidates', 'scoring_breakdown', 'LONGTEXT');
  await addColumnIfMissing('raw_candidates', 'discovery_route', 'VARCHAR(255)');
  await addColumnIfMissing('raw_candidates', 'source_platform', 'VARCHAR(100)');
  await addColumnIfMissing('raw_candidates', 'target_platform', 'VARCHAR(100)');
  await addColumnIfMissing('raw_candidates', 'source_agent', 'VARCHAR(255)');
  await addColumnIfMissing('raw_candidates', 'evidence_url', 'VARCHAR(1024)');
  await addColumnIfMissing('raw_candidates', 'evidence_title', 'LONGTEXT');
  await addColumnIfMissing('raw_candidates', 'evidence_type', 'VARCHAR(100)');
  await addColumnIfMissing('raw_candidates', 'source_query', 'LONGTEXT');
  await addColumnIfMissing('raw_candidates', 'rejection_scope', 'VARCHAR(50)');
  await addColumnIfMissing('raw_candidates', 'rejection_category', 'VARCHAR(100)');
  await addColumnIfMissing('raw_candidates', 'rejection_reason', 'LONGTEXT');
  await addColumnIfMissing('finder_subtasks', 'strategy_id', 'INT');
  await addColumnIfMissing('finder_subtasks', 'campaign_id', 'INT');
  await addColumnIfMissing('finder_subtasks', 'source_query', 'LONGTEXT');
  await addColumnIfMissing('finder_subtasks', 'agent_prompt', 'LONGTEXT');
  await addColumnIfMissing('finder_subtasks', 'agent_result_summary', 'LONGTEXT');
  await addColumnIfMissing('finder_subtasks', 'accepted_count', 'INT DEFAULT 0');
  await addColumnIfMissing('finder_subtasks', 'rejected_count', 'INT DEFAULT 0');
  await addColumnIfMissing('finder_subtasks', 'failed_count', 'INT DEFAULT 0');
  await addColumnIfMissing('finder_subtasks', 'started_at', 'DATETIME');
  await addColumnIfMissing('finder_subtasks', 'finished_at', 'DATETIME');
  await addColumnIfMissing('video_sources', 'notes', 'LONGTEXT');
  await addColumnIfMissing('video_sources', 'content_type', 'VARCHAR(100)');
  await addColumnIfMissing('video_sources', 'crawl_status', "VARCHAR(50) DEFAULT 'pending'");
  await addColumnIfMissing('video_sources', 'analysis_status', "VARCHAR(50) DEFAULT 'not_analyzed'");
  await addColumnIfMissing('video_snapshots', 'primary_exposure_count', 'INT');
  await addColumnIfMissing('video_snapshots', 'exposure_metric_type', 'VARCHAR(100)');
  await addColumnIfMissing('video_snapshots', 'data_quality_note', 'LONGTEXT');

  await dbOperations.run(`
    UPDATE raw_candidates
    SET rejection_scope = 'project'
    WHERE status = 'ignored' AND (rejection_scope IS NULL OR rejection_scope = '')
  `);

  await dbOperations.run(`
    UPDATE video_snapshots
    SET primary_exposure_count = play_count
    WHERE primary_exposure_count IS NULL AND play_count IS NOT NULL
  `);

  await dbOperations.run(`
    UPDATE video_snapshots
    SET exposure_metric_type = 'play_count',
        data_quality_note = 'Historical data. Re-crawl is recommended for exact exposure metrics.'
    WHERE (exposure_metric_type IS NULL OR exposure_metric_type = '')
      AND play_count IS NOT NULL
  `);

  await dbOperations.run(`
    UPDATE video_sources
    SET content_type = CASE
      WHEN platform = 'youtube' THEN 'video'
      WHEN platform = 'tiktok' THEN 'video'
      ELSE 'unknown'
    END
    WHERE content_type IS NULL OR content_type = ''
  `);

  await dbOperations.run(`
    UPDATE video_sources
    SET crawl_status = 'success'
    WHERE (crawl_status IS NULL OR crawl_status = 'pending')
      AND (
        last_crawled_at IS NOT NULL
        OR status IN ('crawled', 'success', 'analysis_failed')
        OR EXISTS (
          SELECT 1 FROM video_snapshots
          WHERE video_snapshots.video_source_id = video_sources.id
        )
      )
  `);

  await dbOperations.run(`
    UPDATE video_sources
    SET analysis_status = 'success'
    WHERE (analysis_status IS NULL OR analysis_status = 'not_analyzed')
      AND (
        status = 'success'
        OR EXISTS (
          SELECT 1 FROM ai_analysis_results
          WHERE ai_analysis_results.video_source_id = video_sources.id
            AND ai_analysis_results.status = 'success'
        )
      )
  `);

  await dbOperations.run(`
    UPDATE video_sources
    SET analysis_status = 'analysis_failed'
    WHERE (analysis_status IS NULL OR analysis_status = 'not_analyzed')
      AND (
        status = 'analysis_failed'
        OR EXISTS (
          SELECT 1 FROM ai_analysis_results
          WHERE ai_analysis_results.video_source_id = video_sources.id
            AND ai_analysis_results.status = 'analysis_failed'
        )
      )
  `);

  console.log('MySQL database tables initialized');
}

async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { dbOperations, initDatabase, closeDatabase, getPool };
