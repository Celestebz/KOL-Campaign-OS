const express = require('express');
const { createProductTaskService } = require('../services/productTaskService');
const { createProductTaskMail } = require('../services/productTaskMail');
const multer = require('multer');
const { previewWorkbook } = require('../services/productTaskWorkbook');
const { id } = require('../services/productTaskService');

function createRouter(dependencies = require('../database')) {
  const router = express.Router();
  const service = createProductTaskService(dependencies);
  const mail = createProductTaskMail(dependencies);
  const handle = (action) => async (req, res) => {
    try { res.json({ success: true, data: await action(req) }); }
    catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
  };
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
  router.post('/:campaignId/tasks/import-preview', (req, res, next) => upload.single('file')(req, res, (error) => {
    if (error) return res.status(400).json({ success: false, error: '请选择不超过5MB的表格' });
    next();
  }), handle(async (r) => {
    if (!r.file) { const error = new Error('请上传任务清单'); error.statusCode = 400; throw error; }
    await service.list(r.params.campaignId);
    const products = await dependencies.sequelize.query(`SELECT cp.id campaign_product_id, p.sku
      FROM campaign_products cp JOIN products p ON p.id=cp.product_id WHERE cp.campaign_id=? AND cp.status='active' AND p.status='active'`,
    { replacements: [id(r.params.campaignId)], type: 'SELECT', logging: false });
    try { return previewWorkbook(r.file.buffer, products); }
    catch (error) { error.statusCode = 400; throw error; }
  }));
  router.post('/:campaignId/tasks/import', handle((r) => service.importTasks(r.params.campaignId, r.body)));
  router.get('/:campaignId/tasks', handle((r) => service.list(r.params.campaignId)));
  router.post('/:campaignId/task-outreach/preview', handle((r) => mail.preview(r.params.campaignId, r.body, r.user?.id)));
  router.post('/:campaignId/task-outreach/drafts', handle((r) => mail.createDrafts(r.params.campaignId, r.body, r.user?.id)));
  router.post('/:campaignId/tasks', handle((r) => service.saveTask(r.params.campaignId, null, r.body)));
  router.put('/:campaignId/tasks/:taskId', handle((r) => service.saveTask(r.params.campaignId, r.params.taskId, r.body)));
  router.get('/:campaignId/task-members', handle((r) => service.members(r.params.campaignId)));
  router.post('/:campaignId/task-members', handle((r) => service.addMembers(r.params.campaignId, r.body, r.user?.id)));
  router.put('/:campaignId/tasks/:taskId/members/:memberId', handle((r) => service.updateMember(r.params.campaignId, r.params.taskId, r.params.memberId, r.body, r.user?.id)));
  router.get('/:campaignId/tasks/:taskId/members/:memberId/timeline', handle((r) => service.timeline(r.params.campaignId, r.params.taskId, r.params.memberId, r.user?.id)));
  router.post('/:campaignId/tasks/:taskId/members/:memberId/contact', handle((r) => service.manualContact(r.params.campaignId, r.params.taskId, r.params.memberId, r.body, r.user?.id)));
  return router;
}
module.exports = { createRouter };
