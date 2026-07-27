const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PROJECT_STATUSES,
  PRIORITY_LEVELS,
  normalizeProjectStatus,
  normalizePriorityLevel
} = require('./campaignKolEnums');

test('normalizes legacy project statuses to the current workflow', () => {
  assert.equal(normalizeProjectStatus('confirmed'), 'pending_shipping');
  assert.equal(normalizeProjectStatus('candidate'), 'pending_confirmation');
  assert.equal(normalizeProjectStatus('PUBLISHED'), 'published');
  assert.equal(PROJECT_STATUSES.has(normalizeProjectStatus('confirmed')), true);
});

test('normalizes legacy and uppercase priority levels', () => {
  assert.equal(normalizePriorityLevel('normal'), 't2');
  assert.equal(normalizePriorityLevel('T1'), 't1');
  assert.equal(PRIORITY_LEVELS.has(normalizePriorityLevel('normal')), true);
});
