'use strict';

const crypto = require('node:crypto');

const PRESERVATION_ERROR = 'Refusing to roll back the multi-product campaign migration because doing so would delete preserved product relationships.';

function normalizeCatalogValue(value) {
  return String(value ?? '').trim().toLowerCase();
}

function catalogKeyHash(brand, name) {
  return crypto
    .createHash('sha256')
    .update(`${normalizeCatalogValue(brand)}\0${normalizeCatalogValue(name)}`, 'utf8')
    .digest('hex');
}

function tableNameOf(table) {
  return typeof table === 'string' ? table : table.tableName;
}

async function tableExists(queryInterface, tableName) {
  const tables = await queryInterface.showAllTables();
  return tables.some(table => tableNameOf(table) === tableName);
}

async function ensureTable(queryInterface, tableName, columns) {
  if (!(await tableExists(queryInterface, tableName))) {
    await queryInterface.createTable(tableName, columns);
    return;
  }

  const existing = await queryInterface.describeTable(tableName);
  for (const [columnName, definition] of Object.entries(columns)) {
    if (!existing[columnName]) {
      await queryInterface.addColumn(tableName, columnName, definition);
    }
  }
}

async function ensureIndex(queryInterface, tableName, fields, options) {
  const indexes = await queryInterface.showIndex(tableName);
  const existing = indexes.find(index => index.name === options.name);
  if (existing) {
    const existingFields = existing.fields.map(field => field.attribute);
    const matches = existingFields.length === fields.length
      && existingFields.every((field, index) => field === fields[index])
      && Boolean(existing.unique) === Boolean(options.unique);
    if (!matches) {
      throw new Error(`Existing index ${options.name} does not match the required multi-product schema.`);
    }
    return;
  }
  await queryInterface.addIndex(tableName, fields, options);
}

async function removeIndexIfPresent(queryInterface, tableName, indexName) {
  const indexes = await queryInterface.showIndex(tableName);
  if (indexes.some(index => index.name === indexName)) {
    await queryInterface.removeIndex(tableName, indexName);
  }
}

async function ensureForeignKey(queryInterface, tableName, columnName, options) {
  const foreignKeys = await queryInterface.getForeignKeyReferencesForTable(tableName);
  const existing = foreignKeys.find(key => key.columnName === columnName);
  if (existing) {
    const [rules] = await queryInterface.sequelize.query(
      `SELECT UPDATE_RULE AS update_rule, DELETE_RULE AS delete_rule
       FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND CONSTRAINT_NAME = ?`,
      { replacements: [tableName, existing.constraintName] }
    );
    const rule = rules[0] || {};
    const expectedUpdate = String(options.onUpdate || 'NO ACTION').toUpperCase();
    const expectedDelete = String(options.onDelete || 'NO ACTION').toUpperCase();
    const matches = existing.referencedTableName === options.references.table
      && existing.referencedColumnName === options.references.field
      && String(rule.update_rule || '').toUpperCase() === expectedUpdate
      && String(rule.delete_rule || '').toUpperCase() === expectedDelete;
    if (matches) {
      return;
    }
    await queryInterface.removeConstraint(tableName, existing.constraintName);
  }
  await queryInterface.addConstraint(tableName, {
    fields: [columnName],
    type: 'foreign key',
    ...options
  });
}

async function migrateLegacyRawCandidateColumn(queryInterface) {
  if (!(await tableExists(queryInterface, 'raw_candidate_product_fits'))) return;
  const columns = await queryInterface.describeTable('raw_candidate_product_fits');
  if (columns.raw_candidate_id && !columns.latest_raw_candidate_id) {
    await queryInterface.renameColumn(
      'raw_candidate_product_fits',
      'raw_candidate_id',
      'latest_raw_candidate_id'
    );
  }
}

async function normalizeCampaignProductRole(queryInterface, DataTypes) {
  await queryInterface.sequelize.query(
    `UPDATE campaign_products
     SET role = 'hero'
     WHERE role IS NULL OR TRIM(role) = '' OR role = 'primary'`
  );
  const columns = await queryInterface.describeTable('campaign_products');
  if (columns.role.allowNull || columns.role.defaultValue !== 'hero') {
    await queryInterface.changeColumn('campaign_products', 'role', {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: 'hero'
    });
  }
}

async function normalizeRawCandidateProductFitColumns(queryInterface, DataTypes) {
  const columns = await queryInterface.describeTable('raw_candidate_product_fits');
  if (!columns.latest_raw_candidate_id.allowNull) {
    await queryInterface.changeColumn('raw_candidate_product_fits', 'latest_raw_candidate_id', {
      type: DataTypes.INTEGER,
      allowNull: true
    });
  }

  await queryInterface.sequelize.query(
    `UPDATE raw_candidate_product_fits
     SET analysis_version = 1
     WHERE analysis_version IS NULL
        OR TRIM(CAST(analysis_version AS CHAR)) NOT REGEXP '^[0-9]+$'
        OR CAST(analysis_version AS UNSIGNED) < 1`
  );
  const refreshed = await queryInterface.describeTable('raw_candidate_product_fits');
  const isInteger = /INT/i.test(refreshed.analysis_version.type);
  const hasDefaultOne = Number(refreshed.analysis_version.defaultValue) === 1;
  if (!isInteger || refreshed.analysis_version.allowNull || !hasDefaultOne) {
    await queryInterface.changeColumn('raw_candidate_product_fits', 'analysis_version', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1
    });
  }
}

async function backfillCatalogHashes(queryInterface) {
  const [products] = await queryInterface.sequelize.query(
    'SELECT id, brand, name, catalog_key_hash FROM products ORDER BY id'
  );
  for (const product of products) {
    const hash = catalogKeyHash(product.brand, product.name);
    if (product.catalog_key_hash !== hash) {
      await queryInterface.sequelize.query(
        'UPDATE products SET catalog_key_hash = ? WHERE id = ?',
        { replacements: [hash, product.id] }
      );
    }
  }
}

async function backfillCampaignProducts(queryInterface) {
  const [campaigns] = await queryInterface.sequelize.query(
    'SELECT id, brand, product FROM campaigns ORDER BY id'
  );

  for (const campaign of campaigns) {
    const name = String(campaign.product ?? '').trim();
    if (!name) continue;

    const brand = String(campaign.brand ?? '').trim();
    const hash = catalogKeyHash(brand, name);
    await queryInterface.sequelize.query(
      `INSERT INTO products (brand, name, catalog_key_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE products.updated_at = products.updated_at`,
      { replacements: [brand, name, hash] }
    );

    const [products] = await queryInterface.sequelize.query(
      'SELECT id FROM products WHERE catalog_key_hash = ? LIMIT 1',
      { replacements: [hash] }
    );
    const product = products[0];
    if (!product) {
      throw new Error(`Unable to resolve normalized product for Campaign ${campaign.id}.`);
    }

    await queryInterface.sequelize.query(
      `INSERT INTO campaign_products
         (campaign_id, product_id, role, priority, status, created_at, updated_at)
       VALUES (?, ?, 'hero', 0, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE campaign_products.updated_at = campaign_products.updated_at`,
      { replacements: [campaign.id, product.id] }
    );
  }
}

async function backfillStrategies(queryInterface) {
  const [strategies] = await queryInterface.sequelize.query(
    `SELECT id, campaign_id, brand, product
     FROM kol_strategies
     WHERE campaign_product_id IS NULL
     ORDER BY id`
  );

  for (const strategy of strategies) {
    const productName = String(strategy.product ?? '').trim();
    if (!productName) continue;
    const hash = catalogKeyHash(strategy.brand, productName);
    const [matches] = await queryInterface.sequelize.query(
      `SELECT cp.id
       FROM campaign_products cp
       JOIN products p ON p.id = cp.product_id
       WHERE cp.campaign_id = ? AND p.catalog_key_hash = ?`,
      { replacements: [strategy.campaign_id, hash] }
    );
    if (matches.length === 1) {
      await queryInterface.sequelize.query(
        `UPDATE kol_strategies
         SET campaign_product_id = ?
         WHERE id = ? AND campaign_product_id IS NULL`,
        { replacements: [matches[0].id, strategy.id] }
      );
    }
  }
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const createdAt = {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
    };
    const updatedAt = {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
    };

    await ensureTable(queryInterface, 'products', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      brand: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
      name: { type: DataTypes.STRING(255), allowNull: false },
      sku: DataTypes.STRING(255),
      category: DataTypes.STRING(255),
      product_url: DataTypes.STRING(1024),
      price: DataTypes.DECIMAL(15, 2),
      currency: DataTypes.STRING(50),
      description: DataTypes.TEXT,
      selling_points: DataTypes.TEXT,
      status: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'active' },
      catalog_key_hash: { type: DataTypes.CHAR(64), allowNull: true },
      created_at: createdAt,
      updated_at: updatedAt
    });

    await ensureTable(queryInterface, 'campaign_products', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      campaign_id: { type: DataTypes.INTEGER, allowNull: false },
      product_id: { type: DataTypes.INTEGER, allowNull: false },
      role: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'hero' },
      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      campaign_brief: DataTypes.TEXT,
      status: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'active' },
      created_at: createdAt,
      updated_at: updatedAt
    });

    await migrateLegacyRawCandidateColumn(queryInterface);
    await ensureTable(queryInterface, 'raw_candidate_product_fits', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      latest_raw_candidate_id: DataTypes.INTEGER,
      existing_customer_id: DataTypes.INTEGER,
      campaign_product_id: { type: DataTypes.INTEGER, allowNull: false },
      platform: DataTypes.STRING(100),
      identity_key_hash: { type: DataTypes.CHAR(64), allowNull: false },
      strategy_id: DataTypes.INTEGER,
      finder_task_id: DataTypes.INTEGER,
      identity_status: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'unresolved' },
      fit_score: DataTypes.INTEGER,
      matched_persona: DataTypes.STRING(255),
      evidence_summary: DataTypes.TEXT,
      decision_status: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'pending' },
      analysis_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: createdAt,
      updated_at: updatedAt
    });

    await ensureTable(queryInterface, 'campaign_kol_products', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      campaign_kol_id: { type: DataTypes.INTEGER, allowNull: false },
      campaign_product_id: { type: DataTypes.INTEGER, allowNull: false },
      source_raw_candidate_product_fit_id: DataTypes.INTEGER,
      fit_score: DataTypes.INTEGER,
      fit_status: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'pending' },
      evidence_summary: DataTypes.TEXT,
      assignment_status: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'active' },
      quoted_fee: DataTypes.STRING(255),
      sample_status: DataTypes.STRING(50),
      deliverables: DataTypes.TEXT,
      content_status: DataTypes.STRING(50),
      result_summary: DataTypes.TEXT,
      created_at: createdAt,
      updated_at: updatedAt
    });

    await ensureTable(queryInterface, 'kol_strategies', {
      campaign_product_id: DataTypes.INTEGER
    });
    await ensureTable(queryInterface, 'finder_tasks', {
      campaign_product_id: DataTypes.INTEGER
    });

    await normalizeCampaignProductRole(queryInterface, DataTypes);
    await normalizeRawCandidateProductFitColumns(queryInterface, DataTypes);

    await removeIndexIfPresent(queryInterface, 'products', 'uq_products_brand_name');
    await backfillCatalogHashes(queryInterface);
    await ensureIndex(queryInterface, 'products', ['catalog_key_hash'], {
      name: 'uq_products_catalog_key_hash',
      unique: true
    });

    await ensureIndex(queryInterface, 'campaign_products', ['campaign_id', 'product_id'], {
      name: 'uq_campaign_products_campaign_product',
      unique: true
    });
    await ensureIndex(queryInterface, 'campaign_products', ['campaign_id'], {
      name: 'idx_campaign_products_campaign'
    });
    await ensureIndex(queryInterface, 'campaign_products', ['product_id'], {
      name: 'idx_campaign_products_product'
    });

    await ensureIndex(queryInterface, 'raw_candidate_product_fits', ['campaign_product_id', 'identity_key_hash'], {
      name: 'uq_raw_candidate_product_fits_identity',
      unique: true
    });
    await ensureIndex(queryInterface, 'raw_candidate_product_fits', ['latest_raw_candidate_id'], {
      name: 'idx_raw_candidate_product_fits_latest_candidate'
    });
    await ensureIndex(queryInterface, 'raw_candidate_product_fits', ['existing_customer_id'], {
      name: 'idx_raw_candidate_product_fits_existing_customer'
    });
    await ensureIndex(queryInterface, 'raw_candidate_product_fits', ['campaign_product_id'], {
      name: 'idx_raw_candidate_product_fits_campaign_product'
    });
    await ensureIndex(queryInterface, 'raw_candidate_product_fits', ['strategy_id'], {
      name: 'idx_raw_candidate_product_fits_strategy'
    });
    await ensureIndex(queryInterface, 'raw_candidate_product_fits', ['finder_task_id'], {
      name: 'idx_raw_candidate_product_fits_finder_task'
    });

    await ensureIndex(queryInterface, 'campaign_kol_products', ['campaign_kol_id', 'campaign_product_id'], {
      name: 'uq_campaign_kol_products_campaign_kol_product',
      unique: true
    });
    await ensureIndex(queryInterface, 'campaign_kol_products', ['campaign_kol_id'], {
      name: 'idx_campaign_kol_products_campaign_kol'
    });
    await ensureIndex(queryInterface, 'campaign_kol_products', ['campaign_product_id'], {
      name: 'idx_campaign_kol_products_campaign_product'
    });
    await ensureIndex(queryInterface, 'campaign_kol_products', ['source_raw_candidate_product_fit_id'], {
      name: 'idx_campaign_kol_products_source_fit'
    });
    await ensureIndex(queryInterface, 'kol_strategies', ['campaign_product_id'], {
      name: 'idx_kol_strategies_campaign_product'
    });
    await ensureIndex(queryInterface, 'finder_tasks', ['campaign_product_id'], {
      name: 'idx_finder_tasks_campaign_product'
    });

    await ensureForeignKey(queryInterface, 'campaign_products', 'campaign_id', {
      name: 'fk_campaign_products_campaign',
      references: { table: 'campaigns', field: 'id' },
      onDelete: 'CASCADE'
    });
    await ensureForeignKey(queryInterface, 'campaign_products', 'product_id', {
      name: 'fk_campaign_products_product',
      references: { table: 'products', field: 'id' },
      onDelete: 'RESTRICT'
    });
    await ensureForeignKey(queryInterface, 'raw_candidate_product_fits', 'latest_raw_candidate_id', {
      name: 'fk_raw_candidate_product_fits_latest_candidate',
      references: { table: 'raw_candidates', field: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    });
    await ensureForeignKey(queryInterface, 'raw_candidate_product_fits', 'existing_customer_id', {
      name: 'fk_raw_candidate_product_fits_existing_customer',
      references: { table: 'customers', field: 'id' },
      onDelete: 'SET NULL'
    });
    await ensureForeignKey(queryInterface, 'raw_candidate_product_fits', 'campaign_product_id', {
      name: 'fk_raw_candidate_product_fits_campaign_product',
      references: { table: 'campaign_products', field: 'id' },
      onDelete: 'CASCADE'
    });
    await ensureForeignKey(queryInterface, 'raw_candidate_product_fits', 'strategy_id', {
      name: 'fk_raw_candidate_product_fits_strategy',
      references: { table: 'kol_strategies', field: 'id' },
      onDelete: 'SET NULL'
    });
    await ensureForeignKey(queryInterface, 'raw_candidate_product_fits', 'finder_task_id', {
      name: 'fk_raw_candidate_product_fits_finder_task',
      references: { table: 'finder_tasks', field: 'id' },
      onDelete: 'SET NULL'
    });
    await ensureForeignKey(queryInterface, 'campaign_kol_products', 'campaign_kol_id', {
      name: 'fk_campaign_kol_products_campaign_kol',
      references: { table: 'campaign_kols', field: 'id' },
      onDelete: 'CASCADE'
    });
    await ensureForeignKey(queryInterface, 'campaign_kol_products', 'campaign_product_id', {
      name: 'fk_campaign_kol_products_campaign_product',
      references: { table: 'campaign_products', field: 'id' },
      onDelete: 'CASCADE'
    });
    await ensureForeignKey(queryInterface, 'campaign_kol_products', 'source_raw_candidate_product_fit_id', {
      name: 'fk_campaign_kol_products_source_fit',
      references: { table: 'raw_candidate_product_fits', field: 'id' },
      onDelete: 'SET NULL'
    });
    await ensureForeignKey(queryInterface, 'kol_strategies', 'campaign_product_id', {
      name: 'fk_kol_strategies_campaign_product',
      references: { table: 'campaign_products', field: 'id' },
      onDelete: 'SET NULL'
    });
    await ensureForeignKey(queryInterface, 'finder_tasks', 'campaign_product_id', {
      name: 'fk_finder_tasks_campaign_product',
      references: { table: 'campaign_products', field: 'id' },
      onDelete: 'SET NULL'
    });

    await backfillCampaignProducts(queryInterface);
    await backfillStrategies(queryInterface);

    const productColumns = await queryInterface.describeTable('products');
    if (productColumns.catalog_key_hash.allowNull) {
      await queryInterface.changeColumn('products', 'catalog_key_hash', {
        type: DataTypes.CHAR(64),
        allowNull: false
      });
    }
  },

  async down() {
    throw new Error(PRESERVATION_ERROR);
  }
};

module.exports.catalogKeyHash = catalogKeyHash;
