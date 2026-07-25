const express = require('express');
const approvalItemService = require('../services/approvalItemService');

const router = express.Router();

function sendError(res, error) {
  const payload = { success: false, error: error.message };
  if (error.currentVersion !== undefined) payload.current_version = error.currentVersion;
  return res.status(error.statusCode || 500).json(payload);
}

// 统一审核列表：?status=pending&type=outreach 过滤，附带 summary 计数
router.get('/', async (req, res) => {
  try {
    const { status, type } = req.query || {};
    const [items, summary] = await Promise.all([
      approvalItemService.listApprovalItems({ status, type }),
      approvalItemService.getSummary()
    ]);
    res.json({ success: true, data: { items, summary } });
  } catch (error) {
    sendError(res, error);
  }
});

// 审核详情（含 facts/opinion/risks/actions 快照与决定信息）
router.get('/:id', async (req, res) => {
  try {
    const item = await approvalItemService.getApprovalItem(req.params.id);
    if (!item) return res.status(404).json({ success: false, error: '审核事项不存在' });
    res.json({ success: true, data: item });
  } catch (error) {
    sendError(res, error);
  }
});

// 提交人工决定：{ decision, note, version, decided_by }
// version 与库中不一致 → 409 { error, current_version }
router.post('/:id/decision', async (req, res) => {
  try {
    const { decision, note, version, decided_by } = req.body || {};
    const item = await approvalItemService.submitDecision(req.params.id, {
      decision, note, version, decided_by
    });
    res.json({ success: true, data: item });
  } catch (error) {
    sendError(res, error);
  }
});

module.exports = router;
