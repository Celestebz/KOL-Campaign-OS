// 工作台常量：审核类型与风险等级的中文/颜色映射、排序权重，集中在此维护。

export const ITEM_TYPE = {
  strategy: { label: '达人策略', color: 'geekblue' },
  candidate: { label: '候选达人', color: 'blue' },
  outreach: { label: '对外沟通', color: 'purple' },
  reply: { label: '达人回复', color: 'cyan' },
  budget: { label: '预算与履约', color: 'orange' },
  exception: { label: '异常处理', color: 'red' }
};

export const RISK_LEVEL = {
  none: { label: '无风险', color: 'default', order: 2 },
  low: { label: '低风险', color: 'gold', order: 1 },
  high: { label: '高风险', color: 'red', order: 0 }
};

export function getItemType(type) {
  return ITEM_TYPE[type] || { label: type || '未知类型', color: 'default' };
}

export function getRiskLevel(level) {
  return RISK_LEVEL[level] || RISK_LEVEL.none;
}

// 决策队列排序：高风险 > 低风险 > 无风险，同级保持原有顺序（稳定排序）。
export function sortItemsByRisk(items = []) {
  return [...items].sort(
    (a, b) => getRiskLevel(a.risk_level).order - getRiskLevel(b.risk_level).order
  );
}

// 决定按钮配置：label 为按钮文案，primary 为主按钮，
// needNote 表示点击后弹出备注输入，noteRequired 表示备注必填。
export const DECISIONS = {
  approve: { label: '批准并继续', primary: true },
  reject: { label: '驳回', needNote: true, noteRequired: true, danger: true },
  request_changes: { label: '要求修改', needNote: true, noteRequired: true },
  pause: { label: '暂缓', needNote: true },
  retry: { label: '从失败节点重试', primary: true },
  skip: { label: '跳过', needNote: true },
  stop: { label: '停止', needNote: true, danger: true }
};

// 决定按钮分组：审批类事项与异常处理事项使用不同按钮组。
export const DECISION_GROUPS = {
  approval: ['approve', 'reject', 'request_changes', 'pause'],
  exception: ['retry', 'skip', 'stop']
};

export function getDecisionGroup(type) {
  return DECISION_GROUPS[type === 'exception' ? 'exception' : 'approval'];
}
