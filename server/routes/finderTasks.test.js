const assert = require('node:assert/strict');
const test = require('node:test');
const { dbOperations } = require('../database');

const tiktokCycles = [
  { cycle: 'C1', name: 'Competitor Reviews', keywords: 'Battle Born battery review', target_platforms: ['tiktok'] },
  { cycle: 'C2', name: 'Category Search', keywords: 'lifepo4 battery', target_platforms: ['tiktok'] },
  { cycle: 'C3', name: 'Use-case Search', keywords: 'rv lithium upgrade', target_platforms: ['tiktok'] },
  { cycle: 'C4', name: 'Feature / Technical Search', keywords: 'bms bluetooth battery', target_platforms: ['tiktok'] },
  { cycle: 'C5', name: 'Community / Audience Search', keywords: 'rv battery reddit', target_platforms: ['tiktok'] },
  { cycle: 'C6', name: 'Platform Native Search', keywords: '#lifepo4', target_platforms: ['tiktok'] },
  { cycle: 'C7', name: 'Spider-web Expansion', keywords: 'tagged accounts', target_platforms: ['tiktok'] }
];

function findGenerateHandler(router) {
  const layer = router.stack.find((item) => (
    item.route?.path === '/:id/subtasks/generate' && item.route?.methods?.post
  ));
  return layer.route.stack[0].handle;
}

function callHandler(handler, { params, body }) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        resolve(this);
        return this;
      }
    };
    Promise.resolve(handler({ params, body }, response, reject)).catch(reject);
  });
}

async function withMockedFinderTask(rawRequest, assertions) {
  const original = {
    get: dbOperations.get,
    query: dbOperations.query,
    run: dbOperations.run
  };
  const insertedSubtasks = new Map();
  let nextSubtaskId = 100;

  dbOperations.get = async (sql, params = []) => {
    const text = String(sql);
    if (text.includes('SELECT * FROM finder_tasks WHERE id = ?')) {
      return {
        id: 9,
        strategy_id: 4,
        campaign_id: 6,
        target_platforms: JSON.stringify(['tiktok']),
        discovery_routes: JSON.stringify(rawRequest.discovery_routes),
        search_cycles: JSON.stringify(tiktokCycles),
        raw_request: JSON.stringify({
          strategy_id: 4,
          execution_mode: 'subagent_hybrid',
          subtask_mode: 'cycle',
          target_platforms: ['tiktok'],
          ...rawRequest
        })
      };
    }
    if (text.includes('FROM kol_strategies')) {
      return {
        id: 4,
        campaign_id: 6,
        status: 'ready',
        name: 'TikTok Battery Strategy',
        brand: 'WEIZE',
        product: 'Mini LiFePO4 Battery',
        category: 'LiFePO4 Battery',
        primary_platform: 'tiktok',
        secondary_platforms: JSON.stringify([]),
        search_strategy: JSON.stringify(tiktokCycles),
        product_context: '{}',
        persona_config: '{}',
        scoring_weights: '{}',
        finder_handoff: JSON.stringify({
          required_platforms: ['tiktok'],
          required_keywords: ['lifepo4', 'rv battery']
        })
      };
    }
    if (text.includes('SELECT * FROM finder_subtasks WHERE id = ?')) {
      return insertedSubtasks.get(params[0]);
    }
    return null;
  };
  dbOperations.query = async () => [];
  dbOperations.run = async (sql, params = []) => {
    const text = String(sql);
    if (text.includes('INSERT INTO finder_subtasks')) {
      const id = nextSubtaskId++;
      insertedSubtasks.set(id, {
        id,
        finder_task_id: params[0],
        strategy_id: params[1],
        campaign_id: params[2],
        name: params[3],
        status: params[4],
        discovery_route: params[5],
        source_platform: params[6],
        target_platform: params[7],
        search_cycle: params[8],
        source_query: params[9],
        agent_prompt: params[10],
        agent_result_summary: params[11]
      });
      return { id };
    }
    if (text.includes('UPDATE finder_subtasks SET agent_prompt')) {
      const row = insertedSubtasks.get(params[1]);
      insertedSubtasks.set(params[1], { ...row, agent_prompt: params[0] });
    }
    return { id: 1 };
  };

  try {
    const handler = findGenerateHandler(require('./finderTasks'));
    const response = await callHandler(handler, {
      params: { id: '9' },
      body: {}
    });

    await assertions(response);
  } finally {
    dbOperations.get = original.get;
    dbOperations.query = original.query;
    dbOperations.run = original.run;
  }
}

test('TikTok first-run no-seed subtasks make C1-C6 executable and skip C7 seed expansion', async () => {
  await withMockedFinderTask({
    discovery_routes: ['google_web_to_tiktok', 'youtube_to_tiktok', 'instagram_to_tiktok', 'reddit_to_tiktok', 'seed_posts_to_profile'],
    seed_urls: []
  }, async (response) => {
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.data.length, 7);

    for (const subtask of response.payload.data.filter((row) => row.search_cycle !== 'C7')) {
      const summary = typeof subtask.agent_result_summary === 'string'
        ? JSON.parse(subtask.agent_result_summary)
        : subtask.agent_result_summary;
      const plan = summary.route_plan;
      const requiredRoutes = plan.required_routes.map((item) => item.route);
      const optionalRoutes = plan.optional_routes.map((item) => item.route);
      const skippedRoutes = plan.skipped_routes.map((item) => item.route);

      assert.equal(summary.cycle_status, 'pending');
      assert.ok(requiredRoutes.includes('google_web_to_tiktok'), `${subtask.search_cycle} should require google_web_to_tiktok`);
      assert.ok(optionalRoutes.includes('youtube_to_tiktok'), `${subtask.search_cycle} should offer youtube_to_tiktok`);
      assert.ok(optionalRoutes.includes('instagram_to_tiktok'), `${subtask.search_cycle} should offer instagram_to_tiktok`);
      assert.ok(optionalRoutes.includes('reddit_to_tiktok'), `${subtask.search_cycle} should offer reddit_to_tiktok`);
      assert.ok(skippedRoutes.includes('seed_posts_to_profile'), `${subtask.search_cycle} should mark seed route skipped without seed URLs`);
      assert.ok(!requiredRoutes.includes('seed_posts_to_profile'), `${subtask.search_cycle} should not require seed without seed URLs`);
    }

    const c7 = response.payload.data.find((row) => row.search_cycle === 'C7');
    const c7Summary = typeof c7.agent_result_summary === 'string'
      ? JSON.parse(c7.agent_result_summary)
      : c7.agent_result_summary;
    assert.equal(c7.status, 'completed');
    assert.equal(c7Summary.cycle_status, 'skipped');
    assert.equal(c7Summary.cycle_status_reason, 'no_seed');
    assert.equal(c7Summary.route_plan.target_count, 0);
    assert.equal(c7Summary.route_plan.required_routes.length, 0);
    assert.ok(c7Summary.route_plan.skipped_routes.some((item) => item.route === 'seed_posts_to_profile'));
  });
});

test('TikTok C7 requires seed expansion when seed URLs are supplied', async () => {
  await withMockedFinderTask({
    discovery_routes: ['google_web_to_tiktok', 'youtube_to_tiktok', 'instagram_to_tiktok', 'reddit_to_tiktok', 'seed_posts_to_profile'],
    seed_urls: ['https://www.tiktok.com/@example']
  }, async (response) => {
    assert.equal(response.statusCode, 200);
    const c7 = response.payload.data.find((row) => row.search_cycle === 'C7');
    const c7Summary = typeof c7.agent_result_summary === 'string'
      ? JSON.parse(c7.agent_result_summary)
      : c7.agent_result_summary;
    const requiredRoutes = c7Summary.route_plan.required_routes.map((item) => item.route);
    assert.equal(c7.status, 'pending');
    assert.equal(c7Summary.cycle_status, 'pending');
    assert.ok(requiredRoutes.includes('seed_posts_to_profile'));
    assert.ok(!c7Summary.route_plan.skipped_routes.some((item) => item.route === 'seed_posts_to_profile'));
  });
});
