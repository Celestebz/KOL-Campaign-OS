// 决定副作用分发器（阶段 C）。
// 本阶段职责：把人工决定落到既有业务路径，全部复用现有代码：
//   outreach approve/reject → emailReviewActions.approveDraft/rejectDraft（与 /api/emails/drafts/:id/approve|reject 同一实现）
//   reply    approve/reject → emailReviewActions.confirmReply/ignoreReply（与 /api/emails/replies/:id/confirm|ignore 同一实现）
//   candidate approve/reject → campaignKols.setCampaignKolStatus（campaign_kols.status → approved/rejected）
//   strategy approve        → kolStrategies.markStrategyReady（与 /api/kol-strategies/:id/mark-ready 同一事务逻辑）
//   budget   approve/reject → campaignKols.setBudgetApprovalStatus（budget_approval_status → approved/rejected）
//   exception retry/skip/stop → 本阶段只记录决定，不执行重跑。
//
// 下一阶段（spec 第十节“审批后的自动工作流”）：在此扩展 AI 自动流转编排
// （策略批准后启动 Finder、达人批准后生成首轮邮件、回复确认后生成下一封草稿等），
// 由 workflowOrchestrator 承担，本文件保留为唯一调用入口（钩子）。
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
      // retry/skip/stop：实际重跑/跳过/停止属下一阶段（automation_runs），此处仅透传记录。
      break;
    default:
      break;
  }
  // 钩子：下一阶段在这里调用 workflowOrchestrator.continueAfterDecision(item, decision)。
}

module.exports = { dispatchDecisionSideEffects };
