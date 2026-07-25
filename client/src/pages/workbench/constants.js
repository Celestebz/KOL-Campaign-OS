// 工作台常量：审核类型与风险等级的中文/颜色映射、排序权重，集中在此维护。

export const ITEM_TYPE = {
  strategy: { label: '策略审核', color: 'geekblue' },
  candidate: { label: '候选达人', color: 'blue' },
  outreach: { label: '触达邮件', color: 'purple' },
  reply: { label: '达人回复', color: 'cyan' },
  budget: { label: '预算审核', color: 'orange' },
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
