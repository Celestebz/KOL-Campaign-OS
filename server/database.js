const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const getDataDir = () => {
  if (process.pkg) {
    return path.join(path.dirname(process.execPath), 'data');
  }
  return path.join(__dirname, '..', 'data');
};

const dataDir = getDataDir();
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`Created data directory: ${dataDir}`);
}

const dbPath = path.join(dataDir, 'database.sqlite');

const DEFAULT_ANALYSIS_SYSTEM_PROMPT = 'You are a senior KOL marketing analyst. Return valid JSON only. Do not include Markdown, explanations, or chain-of-thought. The system is brand-agnostic: never assume the target brand is MOOER or any fixed brand unless it is provided in the campaign context.';
const DEFAULT_ANALYSIS_USER_PROMPT = 'Analyze the video performance metrics and comments for KOL marketing value. Consider creator/category fit, audience feedback, purchase intent, brand or category mentions, collaboration risks, product feedback, cooperation advice, and content optimization suggestions. If a target brand or product is configured, evaluate fit against it; otherwise evaluate the video generically for its apparent category. Return all required fields.';

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database connection failed:', err.message);
  } else {
    console.log('Database connected');
    initDatabase();
  }
});

const dbOperations = {
  query: (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  }),
  get: (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  }),
  run: (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  })
};

async function addColumnIfMissing(table, column, definition) {
  const columns = await dbOperations.query(`PRAGMA table_info(${table})`);
  if (!columns.some((col) => col.name === column)) {
    await dbOperations.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function initDatabase() {
  try {
    await dbOperations.run(`CREATE TABLE IF NOT EXISTS customer_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT
    )`);

    await dbOperations.run(`CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      company TEXT,
      phone TEXT,
      group_id INTEGER NULL,
      notes TEXT,
      status TEXT DEFAULT 'active',
      first_name TEXT,
      last_name TEXT,
      contact_name TEXT,
      creator_id TEXT,
      platform TEXT,
      profile_url TEXT,
      youtube_url TEXT,
      youtube_followers TEXT,
      instagram_url TEXT,
      instagram_followers TEXT,
      tiktok_url TEXT,
      tiktok_followers TEXT,
      country_language TEXT,
      country_region TEXT,
      creator_type TEXT,
      audience_fit TEXT,
      contact_route TEXT,
      video_price TEXT,
      exchange_rate TEXT,
      price_rmb TEXT,
      rating TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES customer_groups (id)
    )`);

    await dbOperations.run(`CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      brand TEXT,
      product TEXT,
      brand_keywords TEXT,
      purchase_keywords TEXT,
      negative_keywords TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await dbOperations.run(`CREATE TABLE IF NOT EXISTS video_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER,
      platform TEXT,
      source_url TEXT NOT NULL UNIQUE,
      platform_video_id TEXT,
      kol_name TEXT,
      title TEXT,
      author_name TEXT,
      content_type TEXT,
      published_at TEXT,
      cooperation_price TEXT,
      notes TEXT,
      crawl_status TEXT DEFAULT 'pending',
      analysis_status TEXT DEFAULT 'not_analyzed',
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      last_crawled_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns (id)
    )`);

    await dbOperations.run(`CREATE TABLE IF NOT EXISTS video_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_source_id INTEGER NOT NULL,
      play_count INTEGER,
      like_count INTEGER,
      comment_count INTEGER,
      collect_count INTEGER,
      share_count INTEGER,
      primary_exposure_count INTEGER,
      exposure_metric_type TEXT,
      data_quality_note TEXT,
      raw_data TEXT,
      snapshot_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (video_source_id) REFERENCES video_sources (id)
    )`);

    await dbOperations.run(`CREATE TABLE IF NOT EXISTS video_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_source_id INTEGER NOT NULL,
      platform_comment_id TEXT,
      parent_comment_id TEXT,
      user_name TEXT,
      content TEXT,
      like_count INTEGER,
      commented_at TEXT,
      raw_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (video_source_id) REFERENCES video_sources (id)
    )`);

    await dbOperations.run(`CREATE TABLE IF NOT EXISTS ai_analysis_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_source_id INTEGER NOT NULL,
      score INTEGER,
      summary TEXT,
      sentiment_positive INTEGER,
      sentiment_neutral INTEGER,
      sentiment_negative INTEGER,
      purchase_intent_count INTEGER,
      purchase_intent_keywords TEXT,
      brand_mentions TEXT,
      risks TEXT,
      product_feedback TEXT,
      cooperation_advice TEXT,
      content_suggestions TEXT,
      full_report TEXT,
      final_prompt TEXT,
      raw_result TEXT,
      model_name TEXT,
      status TEXT DEFAULT 'success',
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (video_source_id) REFERENCES video_sources (id)
    )`);

    await dbOperations.run(`CREATE TABLE IF NOT EXISTS analysis_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT DEFAULT 'pending',
      total_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      error_detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      finished_at DATETIME
    )`);

    await dbOperations.run(`CREATE TABLE IF NOT EXISTS analysis_job_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      video_source_id INTEGER,
      source_url TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES analysis_jobs (id),
      FOREIGN KEY (video_source_id) REFERENCES video_sources (id)
    )`);

    await dbOperations.run(`CREATE TABLE IF NOT EXISTS api_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL UNIQUE,
      api_key TEXT,
      base_url TEXT,
      model TEXT,
      extra_config TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await dbOperations.run(`CREATE TABLE IF NOT EXISTS prompt_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      platform TEXT DEFAULT 'all',
      system_prompt TEXT,
      user_prompt TEXT NOT NULL,
      brand_keywords TEXT,
      purchase_keywords TEXT,
      negative_keywords TEXT,
      is_default INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await dbOperations.run(`CREATE TABLE IF NOT EXISTS kol_strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      brand TEXT,
      product TEXT,
      category TEXT,
      target_market TEXT,
      language TEXT,
      primary_platform TEXT,
      secondary_platforms TEXT,
      campaign_goal TEXT,
      status TEXT DEFAULT 'draft',
      product_context TEXT,
      persona_config TEXT,
      search_strategy TEXT,
      scoring_weights TEXT,
      finder_handoff TEXT,
      source_material_summary TEXT,
      source_material_meta TEXT,
      source_material_type TEXT,
      research_status TEXT DEFAULT 'not_started',
      research_sources TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns (id)
    )`);

    await dbOperations.run(`CREATE TABLE IF NOT EXISTS finder_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER,
      strategy_id INTEGER,
      name TEXT,
      platform TEXT,
      keywords TEXT,
      status TEXT DEFAULT 'draft',
      result_count INTEGER DEFAULT 0,
      notes TEXT,
      search_sources TEXT,
      discovery_routes TEXT,
      target_platforms TEXT,
      search_cycles TEXT,
      current_cycle TEXT,
      total_cycles INTEGER DEFAULT 0,
      completed_cycles INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      provider_attempts TEXT,
      error_message TEXT,
      raw_request TEXT,
      raw_response_summary TEXT,
      source_agent TEXT,
      started_at DATETIME,
      finished_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns (id),
      FOREIGN KEY (strategy_id) REFERENCES kol_strategies (id)
    )`);

    await dbOperations.run(`CREATE TABLE IF NOT EXISTS raw_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      finder_task_id INTEGER,
      campaign_id INTEGER,
      strategy_id INTEGER,
      platform TEXT,
      kol_name TEXT NOT NULL,
      contact_name TEXT,
      profile_url TEXT,
      video_url TEXT,
      video_title TEXT,
      followers TEXT,
      avg_views TEXT,
      email TEXT,
      phone TEXT,
      country_region TEXT,
      matched_keywords TEXT,
      ai_score INTEGER,
      ai_match_reason TEXT,
      status TEXT DEFAULT 'new',
      source TEXT,
      discovery_route TEXT,
      source_platform TEXT,
      target_platform TEXT,
      source_agent TEXT,
      raw_data TEXT,
      approved_customer_id INTEGER,
      approved_campaign_kol_id INTEGER,
      error_message TEXT,
      search_cycle TEXT,
      matched_persona TEXT,
      scoring_breakdown TEXT,
      evidence_url TEXT,
      evidence_title TEXT,
      evidence_type TEXT,
      source_query TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (finder_task_id) REFERENCES finder_tasks (id),
      FOREIGN KEY (campaign_id) REFERENCES campaigns (id),
      FOREIGN KEY (strategy_id) REFERENCES kol_strategies (id),
      FOREIGN KEY (approved_customer_id) REFERENCES customers (id)
    )`);

    await dbOperations.run(`CREATE TABLE IF NOT EXISTS campaign_kols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      raw_candidate_id INTEGER,
      kol_name_snapshot TEXT,
      contact_name_snapshot TEXT,
      youtube_url_snapshot TEXT,
      youtube_followers_snapshot TEXT,
      instagram_url_snapshot TEXT,
      instagram_followers_snapshot TEXT,
      tiktok_url_snapshot TEXT,
      tiktok_followers_snapshot TEXT,
      email_snapshot TEXT,
      country_region_snapshot TEXT,
      quoted_price TEXT,
      exchange_rate TEXT,
      price_rmb TEXT,
      status TEXT DEFAULT 'candidate',
      owner TEXT,
      youtube_video_link TEXT,
      instagram_video_link TEXT,
      tiktok_video_link TEXT,
      notes TEXT,
      feishu_record_id TEXT,
      sync_status TEXT DEFAULT 'sync_pending',
      last_synced_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns (id),
      FOREIGN KEY (customer_id) REFERENCES customers (id),
      FOREIGN KEY (raw_candidate_id) REFERENCES raw_candidates (id),
      UNIQUE (campaign_id, customer_id)
    )`);

    await dbOperations.run(`INSERT OR IGNORE INTO customer_groups (id, name, description) VALUES
      (1, 'Prospects', 'New KOL candidates'),
      (2, 'Contacted', 'Creators already contacted'),
      (3, 'Collaborated', 'Creators with past collaboration')`);

    await dbOperations.run(`INSERT OR IGNORE INTO campaigns
      (id, name, brand, product, brand_keywords, purchase_keywords, negative_keywords)
      VALUES
      (1, 'Default Campaign', '', '', '', 'price,how much,where to buy,link,buy,discount,coupon,多少钱,在哪买,链接,价格', 'fake,bad,poor quality,expensive,difficult,scam,ad,质量差,难用,贵,广告')`);

    await dbOperations.run(`INSERT OR IGNORE INTO prompt_templates
      (id, name, platform, system_prompt, user_prompt, brand_keywords, purchase_keywords, negative_keywords, is_default)
      VALUES
      (1, 'Default Video Analysis', 'all',
       'You are a KOL marketing analyst. Return valid JSON only.',
       'Analyze the video performance metrics and comments. Evaluate campaign value, audience feedback, purchase intent, risks, product feedback, cooperation advice, and content suggestions.',
       '', 'price,how much,where to buy,link,buy,discount,coupon,多少钱,在哪买,链接,价格',
       'fake,bad,poor quality,expensive,difficult,scam,ad,质量差,难用,贵,广告', 1)`);

    await dbOperations.run(
      'UPDATE prompt_templates SET system_prompt = ?, user_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
      [DEFAULT_ANALYSIS_SYSTEM_PROMPT, DEFAULT_ANALYSIS_USER_PROMPT]
    );

    await addColumnIfMissing('customers', 'creator_id', 'TEXT');
    await addColumnIfMissing('customers', 'platform', 'TEXT');
    await addColumnIfMissing('customers', 'profile_url', 'TEXT');
    await addColumnIfMissing('customers', 'contact_name', 'TEXT');
    await addColumnIfMissing('customers', 'youtube_url', 'TEXT');
    await addColumnIfMissing('customers', 'youtube_followers', 'TEXT');
    await addColumnIfMissing('customers', 'instagram_url', 'TEXT');
    await addColumnIfMissing('customers', 'instagram_followers', 'TEXT');
    await addColumnIfMissing('customers', 'tiktok_url', 'TEXT');
    await addColumnIfMissing('customers', 'tiktok_followers', 'TEXT');
    await addColumnIfMissing('customers', 'country_language', 'TEXT');
    await addColumnIfMissing('customers', 'country_region', 'TEXT');
    await addColumnIfMissing('customers', 'creator_type', 'TEXT');
    await addColumnIfMissing('customers', 'audience_fit', 'TEXT');
    await addColumnIfMissing('customers', 'contact_route', 'TEXT');
    await addColumnIfMissing('customers', 'video_price', 'TEXT');
    await addColumnIfMissing('customers', 'exchange_rate', 'TEXT');
    await addColumnIfMissing('customers', 'price_rmb', 'TEXT');
    await addColumnIfMissing('customers', 'rating', 'TEXT');
    await addColumnIfMissing('customers', 'feishu_record_id', 'TEXT');
    await addColumnIfMissing('customers', 'sync_status', "TEXT DEFAULT 'sync_pending'");
    await addColumnIfMissing('customers', 'last_synced_at', 'DATETIME');
    await addColumnIfMissing('customers', 'source_raw_candidate_id', 'INTEGER');
    await addColumnIfMissing('customers', 'last_verified_at', 'DATETIME');
    await addColumnIfMissing('finder_tasks', 'strategy_id', 'INTEGER');
    await addColumnIfMissing('finder_tasks', 'search_sources', 'TEXT');
    await addColumnIfMissing('finder_tasks', 'discovery_routes', 'TEXT');
    await addColumnIfMissing('finder_tasks', 'target_platforms', 'TEXT');
    await addColumnIfMissing('finder_tasks', 'search_cycles', 'TEXT');
    await addColumnIfMissing('finder_tasks', 'current_cycle', 'TEXT');
    await addColumnIfMissing('finder_tasks', 'total_cycles', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('finder_tasks', 'completed_cycles', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('finder_tasks', 'success_count', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('finder_tasks', 'failed_count', 'INTEGER DEFAULT 0');
    await addColumnIfMissing('finder_tasks', 'provider_attempts', 'TEXT');
    await addColumnIfMissing('finder_tasks', 'error_message', 'TEXT');
    await addColumnIfMissing('finder_tasks', 'raw_request', 'TEXT');
    await addColumnIfMissing('finder_tasks', 'raw_response_summary', 'TEXT');
    await addColumnIfMissing('finder_tasks', 'source_agent', 'TEXT');
    await addColumnIfMissing('kol_strategies', 'source_material_summary', 'TEXT');
    await addColumnIfMissing('kol_strategies', 'source_material_meta', 'TEXT');
    await addColumnIfMissing('kol_strategies', 'source_material_type', 'TEXT');
    await addColumnIfMissing('kol_strategies', 'research_status', "TEXT DEFAULT 'not_started'");
    await addColumnIfMissing('kol_strategies', 'research_sources', 'TEXT');
    await addColumnIfMissing('finder_tasks', 'started_at', 'DATETIME');
    await addColumnIfMissing('finder_tasks', 'finished_at', 'DATETIME');
    await addColumnIfMissing('raw_candidates', 'strategy_id', 'INTEGER');
    await addColumnIfMissing('raw_candidates', 'search_cycle', 'TEXT');
    await addColumnIfMissing('raw_candidates', 'matched_persona', 'TEXT');
    await addColumnIfMissing('raw_candidates', 'scoring_breakdown', 'TEXT');
    await addColumnIfMissing('raw_candidates', 'discovery_route', 'TEXT');
    await addColumnIfMissing('raw_candidates', 'source_platform', 'TEXT');
    await addColumnIfMissing('raw_candidates', 'target_platform', 'TEXT');
    await addColumnIfMissing('raw_candidates', 'source_agent', 'TEXT');
    await addColumnIfMissing('raw_candidates', 'evidence_url', 'TEXT');
    await addColumnIfMissing('raw_candidates', 'evidence_title', 'TEXT');
    await addColumnIfMissing('raw_candidates', 'evidence_type', 'TEXT');
    await addColumnIfMissing('raw_candidates', 'source_query', 'TEXT');
    await addColumnIfMissing('video_sources', 'notes', 'TEXT');
    await addColumnIfMissing('video_sources', 'content_type', 'TEXT');
    await addColumnIfMissing('video_sources', 'crawl_status', "TEXT DEFAULT 'pending'");
    await addColumnIfMissing('video_sources', 'analysis_status', "TEXT DEFAULT 'not_analyzed'");
    await addColumnIfMissing('video_snapshots', 'primary_exposure_count', 'INTEGER');
    await addColumnIfMissing('video_snapshots', 'exposure_metric_type', 'TEXT');
    await addColumnIfMissing('video_snapshots', 'data_quality_note', 'TEXT');

    await dbOperations.run(`
      UPDATE video_snapshots
      SET primary_exposure_count = play_count
      WHERE primary_exposure_count IS NULL AND play_count IS NOT NULL
    `);

    await dbOperations.run(`
      UPDATE video_snapshots
      SET exposure_metric_type = 'play_count',
          data_quality_note = '历史数据，建议重新抓取以获得精确曝光口径'
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

    console.log('Database tables initialized');
  } catch (error) {
    console.error('Database initialization failed:', error);
  }
}

module.exports = { db, dbOperations };
