export const CAMPAIGN_STAGES = [
  { key: 'preparation', label: '需求准备' },
  { key: 'finding', label: 'KOL 寻找' },
  { key: 'outreach', label: '外联洽谈' },
  { key: 'fulfillment', label: '合作履约' },
  { key: 'content', label: '内容上线' }
];

const count = (value) => Number(value || 0);

function projectStatusCount(summary, key) {
  return count(summary?.by_project_status?.[key]);
}

export function deriveCampaignStage(detail = {}) {
  const campaign = detail.campaign || {};
  const strategy = detail.strategy || null;
  const summary = detail.summary || {};

  if (campaign.status === 'completed' || campaign.status === 'archived') return 'content';
  if (
    projectStatusCount(summary, 'content_preparation')
    + projectStatusCount(summary, 'pending_publish')
    + projectStatusCount(summary, 'published') > 0
  ) return 'content';
  if (
    count(summary.kols_confirmed)
    + projectStatusCount(summary, 'pending_shipping')
    + projectStatusCount(summary, 'shipped')
    + projectStatusCount(summary, 'delivered') > 0
  ) return 'fulfillment';
  if (
    count(summary.contacted)
    + count(summary.replied)
    + count(summary.drafts_pending)
    + count(summary.replies_pending) > 0
  ) return 'outreach';
  if (
    strategy?.status === 'ready'
    || count(summary.kols_total) > 0
    || count(summary.kols_candidate) > 0
    || count(summary.finder_tasks_running) > 0
  ) return 'finding';
  return 'preparation';
}

export function pendingApprovalCount(detail = {}) {
  const summary = detail.summary || {};
  const candidateCount = count(summary.candidates_pending_review);
  return (
    (detail.strategy?.status === 'draft' ? 1 : 0)
    + candidateCount
    + count(summary.drafts_pending)
    + count(summary.replies_pending)
  );
}

export function deriveResponsibility(detail = {}) {
  const summary = detail.summary || {};
  const hasRisk = count(summary.exceptions) > 0 || (detail.risks || []).length > 0;
  if (hasRisk) return { key: 'exception', label: '系统异常', color: 'red' };
  if (pendingApprovalCount(detail) > 0) return { key: 'human', label: '待你审核', color: 'blue' };
  if (count(summary.finder_tasks_running) > 0) return { key: 'ai', label: 'AI 处理中', color: 'processing' };
  if (count(summary.contacted) > count(summary.replied)) return { key: 'external', label: '等待外部', color: 'gold' };
  return { key: 'ai', label: 'AI 处理中', color: 'processing' };
}

export function deriveSubstage(detail = {}, stage = deriveCampaignStage(detail)) {
  const summary = detail.summary || {};
  if (count(summary.exceptions) > 0) return '存在执行异常';
  if (detail.strategy?.status === 'draft') return '达人策略待审核';
  if (stage === 'preparation') return detail.strategy ? '完善项目需求' : '等待生成达人策略';
  if (stage === 'finding') {
    if (count(summary.candidates_pending_review) > 0) return '候选达人待审核';
    if (count(summary.finder_tasks_running) > 0) return '正在寻找达人';
    return '补充候选达人';
  }
  if (stage === 'outreach') {
    if (count(summary.replies_pending) > 0) return '达人回复待确认';
    if (count(summary.drafts_pending) > 0) return '邮件草稿待审核';
    if (count(summary.contacted) > count(summary.replied)) return '等待达人回复';
    return '沟通跟进中';
  }
  if (stage === 'fulfillment') {
    if (projectStatusCount(summary, 'pending_shipping') > 0) return '等待发货';
    if (projectStatusCount(summary, 'shipped') > 0) return '样品运输中';
    if (projectStatusCount(summary, 'delivered') > 0) return '等待内容交付';
    return '合作推进中';
  }
  if (projectStatusCount(summary, 'pending_publish') > 0) return '等待上线';
  if (projectStatusCount(summary, 'published') > 0) return '内容已上线';
  return '内容制作中';
}

export function primaryProduct(detail = {}) {
  const products = Array.isArray(detail.products) ? detail.products : [];
  return products.find((item) => item.role === 'hero') || products[0] || null;
}

export function normalizeCampaignProgress(detail = {}) {
  const stage = deriveCampaignStage(detail);
  const summary = detail.summary || {};
  const campaign = detail.campaign || {};
  const product = primaryProduct(detail);
  const approvals = pendingApprovalCount(detail);
  const riskCount = Math.max(count(summary.exceptions), (detail.risks || []).length);
  const responsibility = deriveResponsibility(detail);
  return {
    ...campaign,
    detail,
    stage,
    substage: deriveSubstage(detail, stage),
    responsibility,
    approvalCount: approvals,
    riskCount,
    totalKols: count(summary.kols_total),
    candidateKols: count(summary.kols_candidate),
    candidatesPendingReview: count(summary.candidates_pending_review),
    confirmedKols: count(summary.kols_confirmed),
    contacted: count(summary.contacted),
    replied: count(summary.replied),
    finderRunning: count(summary.finder_tasks_running),
    primaryProductName: product?.product?.name || campaign.product || '',
    primaryProductSku: product?.product?.sku || '',
    nextStep: detail.next_step || '等待 AI 更新下一步',
    risks: detail.risks || [],
    deadline: campaign.period || ''
  };
}

export function progressSort(a, b) {
  if (a.riskCount !== b.riskCount) return b.riskCount - a.riskCount;
  if (a.approvalCount !== b.approvalCount) return b.approvalCount - a.approvalCount;
  return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
}
