const assert = require('node:assert/strict');
const test = require('node:test');
const supertest = require('supertest');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
require('dotenv').config();

process.env.NODE_ENV = 'test';
process.env.DB_NAME = 'kol_campaign_os_videos_test';
process.env.DB_NAME_TEST = 'kol_campaign_os_videos_test';

const express = require('express');
const { Sequelize } = require('sequelize');
const { initDatabase, sequelize, dbOperations } = require('../database');
const videoRoutes = require('./videos');

async function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/videos', videoRoutes);
  return app;
}

async function resetTestDatabase() {
  const admin = new Sequelize('mysql', 'root', process.env.DB_ROOT_PASSWORD || 'root_password', {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    dialect: 'mysql',
    logging: false
  });
  await admin.query(`DROP DATABASE IF EXISTS ${process.env.DB_NAME}`);
  await admin.query(`CREATE DATABASE ${process.env.DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.query(`GRANT ALL PRIVILEGES ON ${process.env.DB_NAME}.* TO '${process.env.DB_USER || 'kol_user'}'@'%'`);
  await admin.query('FLUSH PRIVILEGES');
  await admin.close();
}

test('GET /api/videos returns finder evidence analysis as discovery scene fallback', async () => {
  await resetTestDatabase();
  await initDatabase();
  const app = await buildApp();

  const campaign = await dbOperations.run(
    'INSERT INTO campaigns (name, brand, product) VALUES (?, ?, ?)',
    ['Video Test Campaign', 'PETKIT', 'Breezy 2']
  );
  const strategy = await dbOperations.run(
    `INSERT INTO kol_strategies (campaign_id, name, status, campaign_goal, product_context, persona_config, search_strategy, scoring_weights, finder_handoff)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [campaign.id, 'Video Test Strategy', 'ready', 'goal', '{}', '{}', '{}', '{}', '{}']
  );
  const task = await dbOperations.run(
    `INSERT INTO finder_tasks (campaign_id, strategy_id, name, status, platform)
     VALUES (?, ?, ?, ?, ?)`,
    [campaign.id, strategy.id, 'Video Test Finder Task', 'success', 'youtube']
  );

  const video = await dbOperations.run(
    `INSERT INTO video_sources
     (source_url, canonical_url, canonical_url_hash, platform, platform_video_id, title, kol_name, author_name, status, crawl_status, analysis_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'hash-test-video',
      'youtube',
      'dQw4w9WgXcQ',
      'Cat backpack review',
      'Cat Gear Creator',
      'Cat Gear Creator',
      'crawled',
      'success',
      'not_analyzed'
    ]
  );

  await dbOperations.run(
    `INSERT INTO finder_video_evidence
     (finder_task_id, video_source_id, target_platform, evidence_platform, source_signal, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [task.id, video.id, 'youtube', 'youtube', 'category_fit', 'analyzed']
  );

  await dbOperations.run(
    `INSERT INTO video_ai_analysis_results
     (video_source_id, analysis_type, analysis_scope_id, status, score, summary, extra_data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      video.id,
      'finder_evidence',
      1,
      'success',
      82,
      '适合进入候选池',
      JSON.stringify({
        candidate_decision: {
          candidate_priority_score: 82,
          recommended_status: 'manual_review',
          reason: '适合进入候选池'
        }
      })
    ]
  );

  const res = await supertest(app).get('/api/videos').expect(200);
  const row = res.body.data[0];

  assert.equal(row.ai_scene, 'finder_evidence');
  assert.equal(row.ai_scene_label, '前期发现');
  assert.equal(row.ai_score, 82);
  assert.equal(row.ai_summary, '适合进入候选池');
  assert.equal(row.analysis_status, 'not_analyzed');
});

test('cleanup videos database connection', async () => {
  await sequelize.close();
});
