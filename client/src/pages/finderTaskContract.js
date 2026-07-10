const evidenceSignalTypes = new Set(['competitor', 'category', 'use_case', 'feature', 'community']);

export const evidenceSignalLabels = {
  competitor: '竞品',
  category: '品类',
  use_case: '使用场景',
  feature: '功能',
  community: '社区'
};

export const buildFinderTaskRequest = ({ strategyId, targetPlatform, limit = 10 }) => ({
  strategy_id: strategyId,
  target_platform: targetPlatform,
  limit
});

export const normalizeEvidenceSignals = (value) => {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set();
  return parsed.reduce((signals, item) => {
    const signal = typeof item === 'string' ? item : item?.signal;
    if (!evidenceSignalTypes.has(signal) || seen.has(signal)) return signals;
    seen.add(signal);
    signals.push({ signal, reason: typeof item === 'object' ? String(item.reason || '') : '' });
    return signals;
  }, []);
};