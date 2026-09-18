const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { createRouter } = require('./discoveryRequests');

test('Agent evidence operations use the claimed task and never expose approval controls', async () => {
  const app = express();
  app.use(express.json(), (req, res, next) => { req.user = { id: 7 }; next(); });
  const finder = express.Router();
  finder.post('/:id/video-evidence/import', (req, res) => res.json({ taskId: req.params.id, evidence: req.body.evidence }));
  const service = { active: async (owner, id, execution) => {
    assert.equal(owner, 7);
    assert.equal(id, '9');
    if (execution !== 'runner-0001') throw Object.assign(new Error('not owner'), { statusCode: 409 });
    return { finder_task_id: 42 };
  } };
  app.use('/api/agent/discovery-requests', createRouter({ agent: true, service: () => service, finderRouter: finder }));
  await request(app).post('/api/agent/discovery-requests/9/evidence/import').send({}).expect(409);
  const result = await request(app).post('/api/agent/discovery-requests/9/evidence/import')
    .set('X-Discovery-Execution-Id', 'runner-0001').send({ evidence: [{ video_url: 'example' }] }).expect(200);
  assert.equal(result.body.taskId, '42');
  assert.equal(result.body.evidence.length, 1);
  for (const action of ['cancel', 'retry', 'approve']) await request(app).post(`/api/agent/discovery-requests/9/${action}`).expect(404);
});
test('web requests cannot claim or report Agent progress', async () => {
  const app = express();
  app.use('/api/discovery-requests', createRouter({ service: () => ({}) }));
  await request(app).post('/api/discovery-requests/1/claim').expect(404);
  await request(app).post('/api/discovery-requests/1/progress').expect(404);
});
