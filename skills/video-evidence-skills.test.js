const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const forbidden = /\bcycle\b|C[1-7]|search_strategy|search_intensity|execution_mode|target_platforms|limit_per_platform|raw-candidates\/import|Subagent Hybrid|Quick \/ Standard \/ Full/i;
const signals = ['competitor', 'category', 'use_case', 'feature', 'community'];

const strategyFiles = [
  read('kol-strategy', 'SKILL.md'),
  read('kol-strategy', 'references', 'strategy-output-schema.md'),
  read('kol-strategy', 'agents', 'openai.yaml')
];
const finder = read('kol-finder', 'SKILL.md');
const campaignFiles = [
  read('kol-campaign-os-agent', 'SKILL.md'),
  read('kol-campaign-os-agent', 'agents', 'openai.yaml')
];

test('strategy skill uses evidence signal guidance and no legacy model', () => {
  const all = strategyFiles.join('\n');
  assert.doesNotMatch(all, forbidden);
  assert.match(strategyFiles[1], /"evidence_signals"/);
  for (const signal of signals) assert.match(all, new RegExp(signal));
  assert.match(all, /multiple evidence signals|zero or more evidence signals/i);
});

test('finder skill uses one target platform and multi-label evidence', () => {
  assert.doesNotMatch(finder, forbidden);
  assert.match(finder, /"strategy_id": 1,[\s\S]*"target_platform": "instagram",[\s\S]*"limit": 10/);
  for (const signal of signals) assert.match(finder, new RegExp(signal));
  assert.match(finder, /multiple evidence signals|zero or more evidence signals/i);
});

test('campaign agent skill uses one target platform and multi-label evidence', () => {
  const all = campaignFiles.join('\n');
  assert.doesNotMatch(all, forbidden);
  assert.match(campaignFiles[0], /"strategy_id": 1,[\s\S]*"target_platform": "instagram",[\s\S]*"limit": 10/);
  for (const signal of signals) assert.match(all, new RegExp(signal));
  assert.match(all, /multiple evidence signals|zero or more evidence signals/i);
});