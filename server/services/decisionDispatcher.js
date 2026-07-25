// 决定副作用分发器（阶段 C）。
// 本阶段职责：把人工决定落到既有业务路径，全部复用现有代码：
//   outreach approve/reject → emailReviewActions.approveDraft/rejectDraft（与 /api/emails/drafts/:id/approve|reject 同一实现）
//   reply    approve/reject → emailReviewActions.confirmReply/ignoreReply（与 /api/emails/replies/:id/confirm|ignore 同一实现）
//   candidate approve/reject → campaignKols.setCampaignKolStatus（campaign_kols.status → approved/rejected）
//   strategy approve        → kolStrategies.markStrategyReady（与 /api/kol-strategies/:id/mark-ready 同一事务逻辑）
//   budget   approve/reject → campaignKols.setBudgetApprovalStatus（budget_approval_status → approved/rejected）
//   exception retry/skip/stop → 即时副作用仅透传记录；retry 的自动重跑由下方钩子异步编排
//                        （auto_followup 失败卡在 workflowOrchestrator 内按父项与失败 action 真重跑）。
//
// 下一阶段（spec 第十节“审批后的自动工作流”）：AI 自动流转编排由 workflowOrchestrator 承担，
// 本文件保留为唯一调用入口（钩子）：副作用成功后 fire-and-forget 触发，不阻塞决定响应，
// 编排失败只在 workflowOrchestrator 内部记录（actions_json 的 auto_followup 条目 + 日志）。
const emailReviewActions = require('./emailReviewActions');
const kolStrategies = require('../routes/kolStrategies');
const campaignKols = require('../routes/campaignKols');

async function dispatchDecisionSideEffects(item, { decision, note } = {}) {
  switch (item.type) {
    case 'outreach':
      if (decision === 'approve') await emailReviewActions.approveDraft(item.subject_id);
      else if (decision === 'reject') await emailReviewActions.rejectDraft(item.subject_id, note);
      break;
    case 'reply':
      if (decision === 'approve') await emailReviewActions.confirmReply(item.subject_id);
      else if (decision === 'reject') await emailReviewActions.ignoreReply(item.subject_id);
      break;
    case 'candidate':
      if (decision === 'approve') await campaignKols.setCampaignKolStatus(item.subject_id, 'approved');
      else if (decision === 'reject') await campaignKols.setCampaignKolStatus(item.subject_id, 'rejected');
      break;
    case 'strategy':
      if (decision === 'approve') await kolStrategies.markStrategyReady(item.subject_id);
      break;
    case 'budget':
      if (decision === 'approve') await campaignKols.setBudgetApprovalStatus(item.subject_id, 'approved');
      else if (decision === 'reject') await campaignKols.setBudgetApprovalStatus(item.subject_id, 'rejected');
      break;
    case 'exception':
      // retry/skip/stop：即时副作用仅透传记录；retry 的自动重跑由下方 workflowOrchestrator 钩子承担。
      break;
    default:
      break;
  }
  // 钩子（阶段 C3）：决定副作用成功后异步触发 AI 自动流转。懒加载避免模块加载顺序问题；
  // continueAfterDecision 自身不抛错，.catch 仅作兜底，绝不影响决定写入。
  setImmediate(() => {
    require('./workflowOrchestrator').continueAfterDecision(item, { decision, note }).catch(() => {});
  });
}

module.exports = { dispatchDecisionSideEffects };
