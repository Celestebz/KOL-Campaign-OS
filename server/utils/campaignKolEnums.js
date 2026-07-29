const PROJECT_STATUSES = new Set([
  'pending_confirmation', 'pending_shipping', 'shipped', 'delivered',
  'content_preparation', 'pending_publish', 'published', 'cancelled'
]);

const PRIORITY_LEVELS = new Set(['t1', 't2', 't3', 't4']);

const PIPELINE_STAGES = new Set(['candidate', 'confirmed', 'historical']);

// 候选外联状态（七个标准值）；replied/rejected 为旧数据兼容值
const OUTREACH_STATUSES = new Set([
  'not_contacted', 'contacted', 'waiting_reply', 'negotiating',
  'interested', 'confirmed', 'terminated'
]);

const LEGACY_OUTREACH_STATUS_MAP = {
  replied: 'negotiating',
  rejected: 'terminated'
};

function normalizeOutreachStatus(value) {
  if (value === undefined || value === null || value === '') return value;
  const normalized = String(value).trim().toLowerCase();
  return LEGACY_OUTREACH_STATUS_MAP[normalized] || normalized;
}

const LEGACY_PROJECT_STATUS_MAP = {
  confirmed: 'pending_shipping',
  candidate: 'pending_confirmation'
};

const LEGACY_PRIORITY_LEVEL_MAP = {
  normal: 't2'
};

function normalizeProjectStatus(value) {
  if (value === undefined || value === null || value === '') return value;
  const normalized = String(value).trim().toLowerCase();
  return LEGACY_PROJECT_STATUS_MAP[normalized] || normalized;
}

function normalizePriorityLevel(value) {
  if (value === undefined || value === null || value === '') return value;
  const normalized = String(value).trim().toLowerCase();
  return LEGACY_PRIORITY_LEVEL_MAP[normalized] || normalized;
}

module.exports = {
  PROJECT_STATUSES,
  PRIORITY_LEVELS,
  PIPELINE_STAGES,
  OUTREACH_STATUSES,
  normalizeOutreachStatus,
  normalizeProjectStatus,
  normalizePriorityLevel
};
