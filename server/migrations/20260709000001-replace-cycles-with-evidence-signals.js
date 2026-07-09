'use strict';

function isProduction() {
  return String(process.env.NODE_ENV).toLowerCase() === 'production';
}

function assertDevelopment(operation) {
  if (isProduction()) {
    throw new Error(`Database destructive operation "${operation}" is not allowed in production (NODE_ENV=production).`);
  }
}

const BUSINESS_TABLES = [
  'analysis_job_items', 'analysis_jobs', 'campaign_kols', 'campaign_videos',
  'raw_candidates', 'finder_video_evidence', 'video_ai_analysis_results',
  'video_comments', 'video_snapshots', 'video_sources', 'finder_tasks',
  'kol_platform_accounts', 'customers', 'kol_strategies', 'campaigns'
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    assertDevelopment('replace cycles with evidence signals in migration up');

    await queryInterface.sequelize.transaction(async (transaction) => {
      try {
        await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 0', { transaction });

        // Truncate all business tables in foreign-key-safe order (children before parents).
        for (const table of BUSINESS_TABLES) {
          await queryInterface.sequelize.query(`TRUNCATE TABLE \`${table}\``, { transaction });
        }

        // Drop legacy cycle columns.
        await queryInterface.removeColumn('kol_strategies', 'search_strategy', { transaction });
        await queryInterface.removeColumn('finder_tasks', 'search_cycles', { transaction });
        await queryInterface.removeColumn('finder_tasks', 'current_cycle', { transaction });
        await queryInterface.removeColumn('finder_tasks', 'total_cycles', { transaction });
        await queryInterface.removeColumn('finder_tasks', 'completed_cycles', { transaction });
        await queryInterface.removeColumn('raw_candidates', 'search_cycle', { transaction });

        // Add new evidence_signals column for video evidence signal scoring.
        await queryInterface.addColumn('video_ai_analysis_results', 'evidence_signals', {
          type: DataTypes.TEXT('long'),
          allowNull: true
        }, { transaction });

        // Reset auto-increment counters for cleared business tables.
        for (const table of BUSINESS_TABLES) {
          await queryInterface.sequelize.query(`ALTER TABLE \`${table}\` AUTO_INCREMENT = 1`, { transaction });
        }
      } finally {
        await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 1', { transaction });
      }
    });
  },

  async down(queryInterface) {
    assertDevelopment('replace cycles with evidence signals in migration down');
    throw new Error('Down migration is not supported for this destructive schema replacement.');
  }
};
