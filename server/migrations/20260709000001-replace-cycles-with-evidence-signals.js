'use strict';

function isProduction() {
  return String(process.env.NODE_ENV).toLowerCase() === 'production';
}

function assertDevelopment(operation) {
  if (isProduction()) {
    throw new Error(`Database destructive operation "${operation}" is not allowed in production (NODE_ENV=production).`);
  }
}

async function removeColumnIfPresent(queryInterface, table, column) {
  const definition = await queryInterface.describeTable(table);
  if (definition[column]) await queryInterface.removeColumn(table, column);
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    assertDevelopment('replace legacy finder schema with evidence signals');

    for (const [table, column] of [
      ['kol_strategies', 'search_strategy'],
      ['finder_tasks', 'target_platforms'],
      ['finder_tasks', 'search_cycles'],
      ['finder_tasks', 'current_cycle'],
      ['finder_tasks', 'total_cycles'],
      ['finder_tasks', 'completed_cycles'],
      ['raw_candidates', 'search_cycle']
    ]) {
      await removeColumnIfPresent(queryInterface, table, column);
    }

    const analysisDefinition = await queryInterface.describeTable('video_ai_analysis_results');
    if (!analysisDefinition.evidence_signals) {
      await queryInterface.addColumn('video_ai_analysis_results', 'evidence_signals', {
        type: DataTypes.TEXT('long'),
        allowNull: true
      });
    }
  },

  async down() {
    assertDevelopment('replace legacy finder schema with evidence signals in migration down');
    throw new Error('Down migration is not supported for this destructive schema replacement.');
  }
};