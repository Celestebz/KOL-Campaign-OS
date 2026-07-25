const express = require('express');
const approvalItemService = require('../services/approvalItemService');

const router = express.Router();

// 老板工作台聚合接口（阶段 C）：先 syncApprovalItems()（六类 builder + dedupe upsert），
// 再从统一审核表 approval_items 组装响应。
// 响应契约（前端并行开发，字段名严格固定）：
// { summary: { pending, high_risk, exceptions, handled_today }, items: [...], recent_decisions: [...] }
// items 在阶段 B 字段基础上新增 approval_item_id 与 version（用于提交决定时的乐观锁）。

router.get('/', async (req, res) => {
  try {
    await approvalItemService.syncApprovalItems();
    const [items, summary, recentDecisions] = await Promise.all([
      approvalItemService.listPendingWorkbenchItems(),
      approvalItemService.getSummary(),
      approvalItemService.listRecentDecisions()
    ]);
    res.json({
      summary,
      items,
      recent_decisions: recentDecisions
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
