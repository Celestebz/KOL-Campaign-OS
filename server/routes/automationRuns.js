// 后台任务运行状态查询（阶段 D）：前端按 run_id 轮询批量任务进度。
const express = require('express');
const automationRuns = require('../services/automationRuns');
const { iso } = require('../services/approvalBuilders/shared');

const router = express.Router();

router.get('/:id', async (req, res) => {
  try {
    const run = await automationRuns.getRun(req.params.id);
    if (!run) return res.status(404).json({ success: false, error: '任务运行记录不存在' });
    res.json({
      success: true,
      data: {
        id: run.id,
        run_type: run.run_type,
        status: run.status,
        progress: run.progress,
        items: run.checkpoint?.items || [],
        last_error: run.last_error || null,
        started_at: iso(run.started_at),
        finished_at: iso(run.finished_at)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
