const PROJECT_STATUSES = new Set([
  'pending_confirmation', 'pending_shipping', 'shipped', 'delivered',
  'content_preparation', 'pending_publish', 'published', 'cancelled'
]);

const PRIORITY_LEVELS = new Set(['t1', 't2', 't3', 't4']);

const PIPELINE_STAGES = new Set(['candidate', 'confirmed', 'historical']);

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
  normalizeProjectStatus,
  normalizePriorityLevel
};
