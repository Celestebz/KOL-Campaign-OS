'use strict';

const PRESERVATION_ERROR = 'Refusing to roll back the multi-product campaign migration because doing so would delete preserved product relationships.';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const timestamp = {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
    };
    const updatedTimestamp = {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
    };

    await queryInterface.createTable('products', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      brand: { type: DataTypes.STRING(255), allowNull: false, defaultValue: '' },
      name: { type: DataTypes.STRING(255), allowNull: false },
      created_at: timestamp,
      updated_at: updatedTimestamp
    });
    await queryInterface.addIndex('products', ['brand', 'name'], {
      name: 'uq_products_brand_name',
      unique: true
    });

    await queryInterface.createTable('campaign_products', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      campaign_id: { type: DataTypes.INTEGER, allowNull: false },
      product_id: { type: DataTypes.INTEGER, allowNull: false },
      status: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'active' },
      created_at: timestamp,
      updated_at: updatedTimestamp
    });
    await queryInterface.addConstraint('campaign_products', {
      fields: ['campaign_id'],
      type: 'foreign key',
      name: 'fk_campaign_products_campaign',
      references: { table: 'campaigns', field: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addConstraint('campaign_products', {
      fields: ['product_id'],
      type: 'foreign key',
      name: 'fk_campaign_products_product',
      references: { table: 'products', field: 'id' },
      onDelete: 'RESTRICT'
    });
    await queryInterface.addIndex('campaign_products', ['campaign_id', 'product_id'], {
      name: 'uq_campaign_products_campaign_product',
      unique: true
    });

    await queryInterface.createTable('raw_candidate_product_fits', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      raw_candidate_id: { type: DataTypes.INTEGER, allowNull: false },
      campaign_product_id: { type: DataTypes.INTEGER, allowNull: false },
      identity_key_hash: { type: DataTypes.CHAR(64), allowNull: false },
      created_at: timestamp,
      updated_at: updatedTimestamp
    });
    await queryInterface.addConstraint('raw_candidate_product_fits', {
      fields: ['raw_candidate_id'],
      type: 'foreign key',
      name: 'fk_raw_candidate_product_fits_candidate',
      references: { table: 'raw_candidates', field: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addConstraint('raw_candidate_product_fits', {
      fields: ['campaign_product_id'],
      type: 'foreign key',
      name: 'fk_raw_candidate_product_fits_campaign_product',
      references: { table: 'campaign_products', field: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addIndex('raw_candidate_product_fits', ['campaign_product_id', 'identity_key_hash'], {
      name: 'uq_raw_candidate_product_fits_identity',
      unique: true
    });

    await queryInterface.createTable('campaign_kol_products', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      campaign_kol_id: { type: DataTypes.INTEGER, allowNull: false },
      campaign_product_id: { type: DataTypes.INTEGER, allowNull: false },
      created_at: timestamp,
      updated_at: updatedTimestamp
    });
    await queryInterface.addConstraint('campaign_kol_products', {
      fields: ['campaign_kol_id'],
      type: 'foreign key',
      name: 'fk_campaign_kol_products_campaign_kol',
      references: { table: 'campaign_kols', field: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addConstraint('campaign_kol_products', {
      fields: ['campaign_product_id'],
      type: 'foreign key',
      name: 'fk_campaign_kol_products_campaign_product',
      references: { table: 'campaign_products', field: 'id' },
      onDelete: 'CASCADE'
    });
    await queryInterface.addIndex('campaign_kol_products', ['campaign_kol_id', 'campaign_product_id'], {
      name: 'uq_campaign_kol_products_campaign_kol_product',
      unique: true
    });

    await queryInterface.addColumn('kol_strategies', 'campaign_product_id', {
      type: DataTypes.INTEGER,
      allowNull: true
    });
    await queryInterface.addConstraint('kol_strategies', {
      fields: ['campaign_product_id'],
      type: 'foreign key',
      name: 'fk_kol_strategies_campaign_product',
      references: { table: 'campaign_products', field: 'id' },
      onDelete: 'SET NULL'
    });
    await queryInterface.addIndex('kol_strategies', ['campaign_product_id'], {
      name: 'idx_kol_strategies_campaign_product'
    });

    await queryInterface.addColumn('finder_tasks', 'campaign_product_id', {
      type: DataTypes.INTEGER,
      allowNull: true
    });
    await queryInterface.addConstraint('finder_tasks', {
      fields: ['campaign_product_id'],
      type: 'foreign key',
      name: 'fk_finder_tasks_campaign_product',
      references: { table: 'campaign_products', field: 'id' },
      onDelete: 'SET NULL'
    });
    await queryInterface.addIndex('finder_tasks', ['campaign_product_id'], {
      name: 'idx_finder_tasks_campaign_product'
    });

    await queryInterface.sequelize.query(
      `INSERT INTO products (brand, name, created_at, updated_at)
       SELECT DISTINCT TRIM(COALESCE(brand, '')), TRIM(product), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       FROM campaigns
       WHERE TRIM(COALESCE(product, '')) <> ''
       ON DUPLICATE KEY UPDATE products.updated_at = products.updated_at`
    );

    await queryInterface.sequelize.query(
      `INSERT INTO campaign_products (campaign_id, product_id, status, created_at, updated_at)
       SELECT c.id, p.id, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       FROM campaigns c
       JOIN products p
         ON p.brand = TRIM(COALESCE(c.brand, ''))
        AND p.name = TRIM(c.product)
       WHERE TRIM(COALESCE(c.product, '')) <> ''
       ON DUPLICATE KEY UPDATE campaign_products.updated_at = campaign_products.updated_at`
    );

    await queryInterface.sequelize.query(
      `UPDATE kol_strategies ks
       JOIN (
         SELECT candidate.strategy_id, MIN(candidate.campaign_product_id) AS campaign_product_id
         FROM (
           SELECT ks_match.id AS strategy_id, cp.id AS campaign_product_id
           FROM kol_strategies ks_match
           JOIN campaign_products cp ON cp.campaign_id = ks_match.campaign_id
           JOIN products p
             ON p.id = cp.product_id
            AND p.brand = TRIM(COALESCE(ks_match.brand, ''))
            AND p.name = TRIM(ks_match.product)
           WHERE TRIM(COALESCE(ks_match.product, '')) <> ''
         ) candidate
         GROUP BY candidate.strategy_id
         HAVING COUNT(*) = 1
       ) matched ON matched.strategy_id = ks.id
       SET ks.campaign_product_id = matched.campaign_product_id
       WHERE ks.campaign_product_id IS NULL`
    );
  },

  async down() {
    throw new Error(PRESERVATION_ERROR);
  }
};
