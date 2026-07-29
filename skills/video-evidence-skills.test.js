const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const forbidden = /\bcycle\b|C[1-7]|search_strategy|search_intensity|execution_mode|target_platforms|limit_per_platform|raw-candidates\/import|Subagent Hybrid|Quick \/ Standard \/ Full/i;
const signals = ['competitor', 'category', 'use_case', 'feature', 'community'];

const skill = read('kol-campaign-os-agent', 'SKILL.md');
const strategy = read('kol-campaign-os-agent', 'references', 'strategy.md');
const schema = read('kol-campaign-os-agent', 'references', 'strategy-output-schema.md');
const metadata = read('kol-campaign-os-agent', 'agents', 'openai.yaml');
const all = [skill, strategy, schema, metadata].join('\n');

test('single campaign agent skill contains strategy and one-platform evidence workflow', () => {
  assert.doesNotMatch(all, forbidden);
  assert.match(schema, /"evidence_signals"/);
  assert.match(skill, /"strategy_id": 1,[\s\S]*"target_platform": "instagram",[\s\S]*"limit": 10/);
  for (const signal of signals) assert.match(all, new RegExp(signal));
  assert.match(all, /multiple evidence signals|zero or more evidence signals/i);
});

test('single campaign agent skill contains restricted candidate and email review flows', () => {
  assert.match(skill, /kol-master\/search/);
  assert.match(skill, /candidate-pool\/batch/);
  assert.match(skill, /email-drafts\/batch-upsert/);
  assert.match(skill, /validate_only/);
  assert.match(skill, /pending_review/);
  assert.match(skill, /Never approve, send, reject, or delete email/i);
});

test('manifest installs only the consolidated campaign agent skill', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.entry_skill, 'kol-campaign-os-agent');
  assert.deepEqual(manifest.skills, ['kol-campaign-os-agent']);
  assert.deepEqual(new Set(manifest.removed_skills), new Set(['kol-strategy', 'kol-finder']));
  assert.equal(fs.existsSync(path.join(root, 'kol-finder')), false);
  assert.equal(fs.existsSync(path.join(root, 'kol-strategy')), false);
});
