const assert = require('node:assert/strict');
const test = require('node:test');
const { dbOperations } = require('../database');

function findImportHandler(router) {
  const layer = router.stack.find((item) => (
    item.route?.path === '/:id/import' && item.route?.methods?.post
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

test('cycle-level subtask import rejects candidates that use cycle_multi_route as the real route', async () => {
  const original = {
    get: dbOperations.get,
    query: dbOperations.query,
    run: dbOperations.run
  };

  dbOperations.get = async (sql) => {
    if (String(sql).includes('FROM finder_subtasks fs')) {
      return {
        id: 12,
        finder_task_id: 7,
        strategy_id: 3,
        campaign_id: 2,
        discovery_route: 'cycle_multi_route',
        source_platform: 'multi',
        target_platform: 'instagram',
        search_cycle: 'C1',
        source_query: 'holiday decor',
        agent_result_summary: '{}'
      };
    }
    return null;
  };
  dbOperations.query = async () => [];
  dbOperations.run = async () => ({ id: 1 });

  try {
    const handler = findImportHandler(require('./finderSubtasks'));
    const response = await callHandler(handler, {
      params: { id: '12' },
      body: {
        finder_subtask_id: 12,
        strategy_id: 3,
        accepted_candidates: [
          {
            platform: 'instagram',
            target_platform: 'instagram',
            source_platform: 'multi',
            discovery_route: 'cycle_multi_route',
            kol_name: 'Bad Route Candidate',
            profile_url: 'https://www.instagram.com/badroute/',
            evidence_url: 'https://www.instagram.com/badroute/',
            evidence_type: 'profile',
            source_query: 'holiday decor',
            search_cycle: 'C1',
            ai_match_reason: 'Invalid route placeholder',
            status: 'new'
          }
        ],
        rejected_candidates: []
      }
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.payload.error, /real discovery_route/i);
  } finally {
    dbOperations.get = original.get;
    dbOperations.query = original.query;
    dbOperations.run = original.run;
  }
});

test('cycle-level subtask import preserves blocked cycle status', async () => {
  const original = {
    get: dbOperations.get,
    query: dbOperations.query,
    run: dbOperations.run
  };
  const updates = [];

  dbOperations.get = async (sql) => {
    if (String(sql).includes('FROM finder_subtasks fs')) {
      return {
        id: 13,
        finder_task_id: 8,
        strategy_id: 3,
        campaign_id: 2,
        discovery_route: 'cycle_multi_route',
        source_platform: 'multi',
        target_platform: 'tiktok',
        search_cycle: 'C2',
        source_query: 'lifepo4 battery',
        agent_result_summary: '{}'
      };
    }
    return null;
  };
  dbOperations.query = async () => [];
  dbOperations.run = async (sql, params = []) => {
    if (String(sql).includes('UPDATE finder_subtasks SET')) updates.push({ sql: String(sql), params });
    return { id: 1 };
  };

  try {
    const handler = findImportHandler(require('./finderSubtasks'));
    const response = await callHandler(handler, {
      params: { id: '13' },
      body: {
        finder_subtask_id: 13,
        strategy_id: 3,
        cycle_status: 'blocked',
        cycle_status_reason: 'WebSearch tool unavailable',
        route_coverage: [
          { route: 'google_web_to_tiktok', status: 'blocked', reason: 'WebSearch tool unavailable' }
        ],
        accepted_candidates: [],
        rejected_candidates: []
      }
    });

    assert.equal(response.statusCode, 200);
    const subtaskUpdate = updates[0];
    assert.equal(subtaskUpdate.params[0], 'failed');
    const summary = JSON.parse(subtaskUpdate.params[4]);
    assert.equal(summary.cycle_status, 'blocked');
    assert.equal(summary.cycle_status_reason, 'WebSearch tool unavailable');
  } finally {
    dbOperations.get = original.get;
    dbOperations.query = original.query;
    dbOperations.run = original.run;
  }
});
