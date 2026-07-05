const assert = require('node:assert/strict');
const test = require('node:test');
const { dbOperations } = require('../database');

const baseCycles = [
  { cycle: 'C1', name: 'Competitor Reviews', keywords: 'competitor review', target_platforms: [] },
  { cycle: 'C2', name: 'Category Search', keywords: 'category creator', target_platforms: [] },
  { cycle: 'C3', name: 'Use-case Search', keywords: 'use case creator', target_platforms: [] },
  { cycle: 'C4', name: 'Feature / Technical Search', keywords: 'feature review', target_platforms: [] },
  { cycle: 'C5', name: 'Community / Audience Search', keywords: 'community creator', target_platforms: [] },
  { cycle: 'C6', name: 'Platform Native Search', keywords: 'native search', target_platforms: [] },
  { cycle: 'C7', name: 'Spider-web Expansion', keywords: 'seed expansion', target_platforms: [] }
];

function cyclesFor(platform) {
  return baseCycles.map((cycle) => ({ ...cycle, target_platforms: [platform] }));
}

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

async function withMockedFinderTask(options, assertions) {
  const original = {
    get: dbOperations.get,
    query: dbOperations.query,
    run: dbOperations.run
  };
  const platform = options.platform || 'tiktok';
  const rawRequest = {
    strategy_id: 4,
    execution_mode: 'subagent_hybrid',
    subtask_mode: 'cycle',
    search_intensity: options.search_intensity || 'standard',
    cycles_source: options.cycles_source || 'intensity',
    target_platforms: [platform],
    discovery_routes: options.discovery_routes || [],
    seed_urls: options.seed_urls || [],
    ...(options.raw_request || {})
  };
  const insertedSubtasks = new Map();
  const taskUpdates = [];
  let nextSubtaskId = 100;

  dbOperations.get = async (sql, params = []) => {
    const text = String(sql);
    if (text.includes('SELECT * FROM finder_tasks WHERE id = ?')) {
      return {
        id: 9,
        strategy_id: 4,
        campaign_id: 6,
        target_platforms: JSON.stringify([platform]),
        discovery_routes: JSON.stringify(rawRequest.discovery_routes),
        search_cycles: JSON.stringify(cyclesFor(platform)),
        raw_request: JSON.stringify(rawRequest)
      };
    }
    if (text.includes('FROM kol_strategies')) {
      return {
        id: 4,
        campaign_id: 6,
        status: 'ready',
        name: `${platform} Strategy`,
        brand: 'WEIZE',
        product: 'Mini LiFePO4 Battery',
        category: 'LiFePO4 Battery',
        primary_platform: platform,
        secondary_platforms: JSON.stringify([]),
        search_strategy: JSON.stringify(cyclesFor(platform)),
        product_context: '{}',
        persona_config: '{}',
        scoring_weights: '{}',
        finder_handoff: JSON.stringify({
          required_platforms: [platform],
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
    if (text.includes('UPDATE finder_tasks SET')) {
      taskUpdates.push({ sql: text, params });
    }
    return { id: 1 };
  };

  try {
    const handler = findGenerateHandler(require('./finderTasks'));
    const response = await callHandler(handler, {
      params: { id: '9' },
      body: options.body || {}
    });
    await assertions(response, taskUpdates);
  } finally {
    dbOperations.get = original.get;
    dbOperations.query = original.query;
    dbOperations.run = original.run;
  }
}

function searchCycles(response) {
  return response.payload.data.map((row) => row.search_cycle);
}

function latestTaskSummary(taskUpdates) {
  const update = taskUpdates.findLast((item) => item.sql.includes('raw_response_summary'));
  assert.ok(update, 'expected task update with raw_response_summary');
  return JSON.parse(update.params.at(-2));
}

test('TikTok standard first-run no-seed generates C2/C3/C5/C6 and defers C7', async () => {
  await withMockedFinderTask({
    platform: 'tiktok',
    search_intensity: 'standard',
    discovery_routes: ['google_web_to_tiktok', 'youtube_to_tiktok', 'instagram_to_tiktok', 'reddit_to_tiktok', 'seed_posts_to_profile']
  }, async (response, taskUpdates) => {
    assert.equal(response.statusCode, 200);
    assert.deepEqual(searchCycles(response), ['C2', 'C3', 'C5', 'C6']);
    assert.equal(response.payload.meta.expansion.expansion_status, 'deferred');
    assert.equal(response.payload.meta.expansion.expansion_reason, 'waiting_for_seeds');
    const summary = latestTaskSummary(taskUpdates);
    assert.ok(summary.some((item) => item.expansion_cycle === 'C7' && item.expansion_status === 'deferred'));

    for (const subtask of response.payload.data) {
      const plan = subtask.agent_result_summary.route_plan;
      const requiredRoutes = plan.required_routes.map((item) => item.route);
      const optionalRoutes = plan.optional_routes.map((item) => item.route);
      assert.ok(requiredRoutes.includes('google_web_to_tiktok'));
      assert.ok(optionalRoutes.includes('youtube_to_tiktok'));
      assert.ok(optionalRoutes.includes('instagram_to_tiktok'));
      assert.ok(optionalRoutes.includes('reddit_to_tiktok'));
    }
  });
});

test('Instagram standard first-run generates C1/C2/C3/C5', async () => {
  await withMockedFinderTask({
    platform: 'instagram',
    search_intensity: 'standard',
    discovery_routes: ['youtube_to_instagram', 'google_web_to_instagram', 'reddit_to_instagram', 'seed_posts_to_profile']
  }, async (response) => {
    assert.equal(response.statusCode, 200);
    assert.deepEqual(searchCycles(response), ['C1', 'C2', 'C3', 'C5']);
    assert.equal(response.payload.meta.expansion.expansion_status, 'deferred');
  });
});

test('YouTube quick first-run generates C1/C2/C4', async () => {
  await withMockedFinderTask({
    platform: 'youtube',
    search_intensity: 'quick',
    discovery_routes: ['youtube_native_search', 'google_web_to_youtube']
  }, async (response) => {
    assert.equal(response.statusCode, 200);
    assert.deepEqual(searchCycles(response), ['C1', 'C2', 'C4']);
  });
});

test('Full first-run generates C1-C6 and excludes C7', async () => {
  await withMockedFinderTask({
    platform: 'tiktok',
    search_intensity: 'full',
    discovery_routes: ['google_web_to_tiktok', 'youtube_to_tiktok', 'instagram_to_tiktok', 'reddit_to_tiktok', 'seed_posts_to_profile']
  }, async (response) => {
    assert.equal(response.statusCode, 200);
    assert.deepEqual(searchCycles(response), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
    assert.equal(response.payload.data.some((row) => row.search_cycle === 'C7'), false);
  });
});

test('Expansion phase with seed generates only C7', async () => {
  await withMockedFinderTask({
    platform: 'tiktok',
    search_intensity: 'standard',
    discovery_routes: ['google_web_to_tiktok', 'seed_posts_to_profile'],
    body: {
      phase: 'expansion',
      cycles: ['C7'],
      seed_urls: ['https://www.tiktok.com/@example']
    }
  }, async (response) => {
    assert.equal(response.statusCode, 200);
    assert.deepEqual(searchCycles(response), ['C7']);
    const plan = response.payload.data[0].agent_result_summary.route_plan;
    assert.ok(plan.required_routes.some((item) => item.route === 'seed_posts_to_profile'));
    assert.equal(response.payload.meta.expansion, null);
  });
});

test('Expansion phase without seed defers C7 and creates no subtask', async () => {
  await withMockedFinderTask({
    platform: 'tiktok',
    search_intensity: 'standard',
    discovery_routes: ['google_web_to_tiktok', 'seed_posts_to_profile'],
    body: {
      phase: 'expansion',
      cycles: ['C7']
    }
  }, async (response) => {
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.data.length, 0);
    assert.equal(response.payload.meta.expansion.expansion_status, 'deferred');
    assert.equal(response.payload.meta.expansion.expansion_reason, 'waiting_for_seeds');
  });
});
