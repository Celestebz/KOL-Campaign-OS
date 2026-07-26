// 六类 approval builder 汇总入口。
// 每个 builder 产出统一结构：
// { id, type, subject_type, subject_id, campaign_id, campaign_name, title,
//   dedupe_key, risk_level, facts, opinion, risks, actions, updated_at }
// dedupe_key 规则（保证同一待办重复扫描不重复建行）：
//   strategy:kol_strategy:{id}    candidate:campaign_kol:{id}   budget:campaign_kol:{id}
//   outreach:email_draft:{id}     reply:email_reply:{id}
//   exception:finder:{id}         exception:email:{id}          exception:run:{id}
const { buildStrategyItems } = require('./strategyApprovalBuilder');
const { buildCandidateItems } = require('./candidateApprovalBuilder');
const { buildBudgetItems } = require('./budgetApprovalBuilder');
const { buildOutreachItems } = require('./outreachApprovalBuilder');
const { buildReplyItems } = require('./replyApprovalBuilder');
const { buildExceptionItems } = require('./exceptionApprovalBuilder');

async function buildAllApprovalItems() {
  const [strategies, candidates, budgets, outreaches, replies, exceptions] = await Promise.all([
    buildStrategyItems(),
    buildCandidateItems(),
    buildBudgetItems(),
    buildOutreachItems(),
    buildReplyItems(),
    buildExceptionItems()
  ]);
  return [...strategies, ...candidates, ...budgets, ...outreaches, ...replies, ...exceptions];
}

module.exports = { buildAllApprovalItems };
