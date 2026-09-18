const express = require('express');
const { getService } = require('../services/discoveryRequests');

function createRouter({ agent = false, service = getService, finderRouter } = {}) {
  const router = express.Router();
  const handle = (fn) => async (req, res) => {
    try { res.json({ success: true, data: await fn(service(), req) }); }
    catch (e) { res.status(e.statusCode || e.status || 400).json({ success: false, error: e.message }); }
  };
  router.get('/', handle((s, req) => s.list(req.user.id)));
  router.get('/:id', handle((s, req) => s.get(req.user.id, req.params.id)));
  if (!agent) {
    router.post('/', handle((s, req) => s.create(req.user.id, req.body)));
    router.post('/:id/cancel', handle((s, req) => s.control(req.user.id, req.params.id, 'cancel')));
    router.post('/:id/retry', handle((s, req) => s.control(req.user.id, req.params.id, 'retry')));
  } else {
    router.get('/:id/evidence', async (req, res, next) => {
      try {
        const request = await service().get(req.user.id, req.params.id);
        if (!request.finder_task_id) return res.json({ success: true, data: [] });
        req.url = `/${request.finder_task_id}/video-evidence`;
        return (finderRouter || require('./finderTasks')).handle(req, res, next);
      } catch (e) { res.status(e.statusCode || 400).json({ success: false, error: e.message }); }
    });
    router.post('/:id/claim', handle((s, req) => s.claim(req.user.id, req.params.id, req.body)));
    router.post('/:id/progress', handle((s, req) => s.progress(req.user.id, req.params.id, req.body)));
    // Use the existing evidence pipeline, scoped to the claimed request. No approval endpoints.
    for (const [path, target] of Object.entries({ 'evidence/import': 'video-evidence/import', analyze: 'evidence-analysis', generate: 'generate-candidates-from-evidence' })) {
      router.post(`/:id/${path}`, async (req, res, next) => {
        try {
          const request = await service().active(req.user.id, req.params.id, req.get('X-Discovery-Execution-Id'));
          req.url = `/${request.finder_task_id}/${target}`;
          return (finderRouter || require('./finderTasks')).handle(req, res, next);
        } catch (e) { res.status(e.statusCode || 400).json({ success: false, error: e.message }); }
      });
    }
  }
  return router;
}
module.exports = { createRouter };
