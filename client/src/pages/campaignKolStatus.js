// 达人合作主状态映射（spec 8.3）：细分状态仅用于执行记录，
// 列表/详情等老板视角展示收敛为 5 个主状态。纯显示层映射，不改变数据库值。

export const SUB_STATUS_LABELS = {
  pending_confirmation: '待确认',
  pending_shipping: '待发货',
  shipped: '已发货',
  delivered: '已签收',
  content_preparation: '待制作',
  pending_publish: '待上线',
  published: '已完成',
  partially_published: '部分发布',
  completed: '已完成',
  cancelled: '已取消'
};

export const COOPERATION_STAGE_OPTIONS = ['pending_shipping', 'shipped', 'delivered', 'content_preparation', 'pending_publish', 'partially_published', 'completed'].map((value) => ({ value, label: SUB_STATUS_LABELS[value] }));

export const MAIN_STATUSES = {
  pending_confirmation: { value: 'pending_confirmation', label: '待确认', color: 'blue' },
  in_progress: { value: 'in_progress', label: '合作执行中', color: 'gold' },
  pending_publish: { value: 'pending_publish', label: '待上线', color: 'purple' },
  partially_published: { value: 'partially_published', label: '部分发布', color: 'cyan' },
  completed: { value: 'completed', label: '已完成', color: 'green' },
  terminated: { value: 'terminated', label: '已终止', color: 'red' }
};

const SUB_TO_MAIN = {
  pending_confirmation: 'pending_confirmation',
  pending_shipping: 'in_progress',
  shipped: 'in_progress',
  delivered: 'in_progress',
  content_preparation: 'in_progress',
  pending_publish: 'pending_publish',
  published: 'completed',
  partially_published: 'partially_published',
  completed: 'completed',
  cancelled: 'terminated'
};

// 细分状态 → 主状态；未知值原样兜底，不猜归属。
export function getMainStatus(subStatus) {
  const mainKey = SUB_TO_MAIN[subStatus];
  if (mainKey) return MAIN_STATUSES[mainKey];
  return { value: subStatus || '', label: subStatus || '-', color: 'default' };
}

export function getSubStatusLabel(subStatus) {
  return SUB_STATUS_LABELS[subStatus] || subStatus || '';
}
