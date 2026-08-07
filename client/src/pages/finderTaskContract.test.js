import { buildFinderTaskRequest, normalizeEvidenceSignals } from './finderTaskContract';

test('builds the new single-platform Finder request without Cycle fields', () => {
  expect(buildFinderTaskRequest({ strategyId: 12, targetPlatform: 'youtube', limit: 10 })).toEqual({
    strategy_id: 12,
    target_platform: 'youtube',
    limit: 10
  });
});

test('normalizes multiple evidence signals for display', () => {
  expect(normalizeEvidenceSignals('[{"signal":"competitor","reason":"comparison"},{"signal":"feature","reason":"demo"}]')).toEqual([
    { signal: 'competitor', reason: 'comparison' },
    { signal: 'feature', reason: 'demo' }
  ]);
});
test('Finder and Strategy pages contain no legacy Cycle controls', () => {
  const fs = require('fs');
  const path = require('path');
  const pages = ['RawCandidates.js', 'KolStrategy.js']
    .map((name) => fs.readFileSync(path.join(__dirname, name), 'utf8'))
    .join('\n');

  expect(pages).not.toMatch(/\bcycle|search_strategy|search_intensity|execution_mode|target_platforms|limit_per_platform/i);
});
test('buildFinderTaskRequest 仅在显式给出时携带 search_source', () => {
  expect(buildFinderTaskRequest({ strategyId: 1, targetPlatform: 'youtube' })).not.toHaveProperty('search_source');
  expect(buildFinderTaskRequest({ strategyId: 1, targetPlatform: 'youtube', searchSource: 'youtube_watch_next_expansion' }).search_source).toBe('youtube_watch_next_expansion');
});
