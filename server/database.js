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
