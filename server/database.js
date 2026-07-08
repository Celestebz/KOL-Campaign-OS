const path = require('path');
const dotenv = require('dotenv');
const { Umzug, SequelizeStorage } = require('umzug');
const SequelizeLib = require('sequelize');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
dotenv.config();

const models = require('./models');
const { sequelize } = models;

const DEFAULT_ANALYSIS_SYSTEM_PROMPT = 'You are a senior KOL marketing analyst. Return valid JSON only. Do not include Markdown, explanations, or chain-of-thought. The system is brand-agnostic: never assume the target brand is MOOER or any fixed brand unless it is provided in the campaign context.';
const DEFAULT_ANALYSIS_USER_PROMPT = 'Analyze the video performance metrics and comments for KOL marketing value. Consider creator/category fit, audience feedback, purchase intent, brand or category mentions, collaboration risks, product feedback, cooperation advice, and content optimization suggestions. If a target brand or product is configured, evaluate fit against it; otherwise evaluate the video generically for its apparent category. Return all required fields.';

// Backward-compatible raw-query wrapper so existing routes can migrate gradually.
const dbOperations = {
  query: async (sql, params = []) => {
    const rows = await sequelize.query(sql, {
      replacements: params,
      type: sequelize.QueryTypes.SELECT,
      logging: false
    });
    return rows || [];
  },
  get: async (sql, params = []) => {
    const rows = await dbOperations.query(sql, params);
    return rows[0] || null;
  },
  run: async (sql, params = []) => {
    const [result, metadata] = await sequelize.query(sql, {
      replacements: params,
      type: sequelize.QueryTypes.RAW,
      logging: false
    });
    // MySQL2 raw results: INSERT returns [insertId, affectedRows]; UPDATE/DELETE return [affectedRows].
    const isInsert = /^\s*INSERT\b/i.test(sql);
    return {
      id: isInsert ? (Number(result) || 0) : 0,
      changes: Number(metadata !== undefined ? metadata : result) || 0
    };
  }
};

// Kept for compatibility with routes that still call addColumnIfMissing.
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

async function runMigrations() {
  const umzug = new Umzug({
    migrations: {
      glob: path.join(__dirname, 'migrations', '*.js').replace(/\\/g, '/'),
      resolve: ({ name, path: migrationPath }) => {
        const migration = require(migrationPath);
        return {
          name,
          up: async () => migration.up(sequelize.getQueryInterface(), SequelizeLib),
          down: async () => migration.down(sequelize.getQueryInterface(), SequelizeLib)
        };
      }
    },
    storage: new SequelizeStorage({ sequelize, modelName: 'sequelize_meta' }),
    logger: console
  });

  const pending = await umzug.pending();
  if (pending.length > 0) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        `Refusing to auto-run ${pending.length} pending migration(s) in production. ` +
        `Migrations in this project may contain destructive operations (DROP TABLE). ` +
        `Please review the pending migrations manually and run with an explicit ` +
        `NODE_ENV=development if you accept the risk, or apply changes manually.`
      );
    }
    console.log(`Running ${pending.length} pending migration(s)...`);
    await umzug.up();
  } else {
    console.log('No pending migrations.');
  }
}

async function seedDefaults() {
  // Migration already seeds defaults. This function can be extended for
  // runtime idempotent updates that are not schema changes.
  const [defaultTemplate] = await dbOperations.query(
    'SELECT id FROM prompt_templates WHERE id = 1 LIMIT 1'
  );
  if (defaultTemplate) {
    await dbOperations.run(
      'UPDATE prompt_templates SET system_prompt = ?, user_prompt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
      [DEFAULT_ANALYSIS_SYSTEM_PROMPT, DEFAULT_ANALYSIS_USER_PROMPT]
    );
  }
}

async function backfillRawCandidatePersonas() {
  await dbOperations.run(
    `UPDATE raw_candidates rc
     LEFT JOIN kol_strategies ks ON ks.id = rc.strategy_id
     SET rc.matched_persona = CASE
       WHEN JSON_VALID(ks.persona_config)
         AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(ks.persona_config, '$.primary_persona')), '') != ''
         THEN JSON_UNQUOTE(JSON_EXTRACT(ks.persona_config, '$.primary_persona'))
       WHEN LOWER(CONCAT_WS(' ', rc.source_query, rc.matched_keywords, rc.ai_match_reason)) LIKE '%competitor%'
         THEN '竞品评测型 KOL'
       WHEN LOWER(CONCAT_WS(' ', rc.source_query, rc.matched_keywords, rc.ai_match_reason)) REGEXP 'review|category|backpack|carrier'
         THEN '品类评测型 KOL'
       WHEN LOWER(CONCAT_WS(' ', rc.source_query, rc.matched_keywords, rc.ai_match_reason)) REGEXP 'travel|outdoor|use_case'
         THEN '场景体验型 KOL'
       WHEN LOWER(CONCAT_WS(' ', rc.source_query, rc.matched_keywords, rc.ai_match_reason)) LIKE '%cat%'
         THEN '垂直社群型 KOL'
       ELSE '待确认画像'
     END
     WHERE rc.matched_persona IS NULL OR rc.matched_persona = ''`
  );
}

async function initDatabase() {
  await sequelize.authenticate();
  console.log('MySQL connection established via Sequelize.');

  await runMigrations();
  await seedDefaults();

  // Compatibility: make sure legacy columns expected by older routes exist.
  // These can be removed once all routes are fully migrated to Sequelize models.
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

  await addColumnIfMissing('campaign_kols', 'strategy_id', 'INT');
  await addColumnIfMissing('campaign_kols', 'finder_task_id', 'INT');
  await addColumnIfMissing('campaign_kols', 'platform_account_id', 'INT');
  await addColumnIfMissing('campaign_kols', 'target_platform', 'VARCHAR(100)');
  await addColumnIfMissing('campaign_kols', 'source', 'VARCHAR(255)');
  await addColumnIfMissing('campaign_kols', 'project_status', "VARCHAR(50) DEFAULT 'candidate'");
  await addColumnIfMissing('campaign_kols', 'priority_level', "VARCHAR(50) DEFAULT 'normal'");
  await addColumnIfMissing('campaign_kols', 'candidate_priority_score', 'INT');
  await addColumnIfMissing('campaign_kols', 'quoted_fee', 'VARCHAR(255)');
  await addColumnIfMissing('campaign_kols', 'final_fee', 'VARCHAR(255)');
  await addColumnIfMissing('campaign_kols', 'currency', 'VARCHAR(50)');
  await addColumnIfMissing('campaign_kols', 'deliverables', 'LONGTEXT');
  await addColumnIfMissing('campaign_kols', 'contact_email_override', 'VARCHAR(255)');
  await addColumnIfMissing('campaign_kols', 'contact_name_override', 'VARCHAR(255)');
  await addColumnIfMissing('campaign_kols', 'outreach_status', 'VARCHAR(50)');
  await addColumnIfMissing('campaign_kols', 'negotiation_status', 'VARCHAR(50)');
  await addColumnIfMissing('campaign_kols', 'contract_status', 'VARCHAR(50)');
  await addColumnIfMissing('campaign_kols', 'payment_status', 'VARCHAR(50)');
  await addColumnIfMissing('campaign_kols', 'content_status', 'VARCHAR(50)');
  await addColumnIfMissing('campaign_kols', 'project_notes', 'LONGTEXT');
  await addColumnIfMissing('campaign_kols', 'internal_notes', 'LONGTEXT');
  await addColumnIfMissing('campaign_kols', 'best_evidence_video_id', 'INT');
  await addColumnIfMissing('campaign_kols', 'best_evidence_url', 'VARCHAR(1024)');
  await addColumnIfMissing('campaign_kols', 'evidence_summary', 'LONGTEXT');
  await addColumnIfMissing('campaign_kols', 'master_snapshot', 'LONGTEXT');
  await addColumnIfMissing('campaign_kols', 'project_override', 'LONGTEXT');
  await backfillRawCandidatePersonas();

  console.log('Database initialized.');
}

module.exports = {
  initDatabase,
  sequelize,
  Sequelize: require('sequelize'),
  models,
  dbOperations,
  addColumnIfMissing
};
