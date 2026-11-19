const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, id, ids, taskFields, memberFields } = require('./productTaskService');
const { render, validateTaskDraftForSend, VERSION } = require('./productTaskMail');

test('task validation rejects impossible dates, reversed windows and sample ranges', () => {
  assert.throws(() => validate({ publish_due_at: '2027-02-30' }, taskFields), /日期无效/);
  assert.throws(() => validate({ publish_from: '2027-03-02' }, taskFields, { publish_due_at: '2027-03-01' }), /不能晚于/);
  assert.throws(() => validate({ sample_min: 2, sample_max: 1 }, taskFields), /下限/);
  assert.equal(validate({ candidate_target: null }, taskFields).candidate_target, null);
  assert.throws(() => id('1e2'), /正整数/);
  assert.deepEqual(ids([2, '2', 3]), [2, 3]);
});
test('a cooperation decision requires this task approval and delivered evidence', () => {
  assert.throws(() => validate({ cooperation_status: 'confirmed' }, memberFields, { review_status: 'pending' }), /先审核/);
  assert.throws(() => validate({ cooperation_status: 'completed' }, memberFields, { review_status: 'approved' }), /作品链接/);
  assert.throws(() => validate({ video_url: 'javascript:alert(1)' }, memberFields), /http/);
  assert.equal(validate({ review_status: 'approved', cooperation_status: 'confirmed' }, memberFields).cooperation_status, 'confirmed');
});
test('fixed template variables never silently drop missing data', () => {
  assert.equal(render('Hi {{ kol_name }} / {{skus}}', { kol_name: 'Alice', skus: 'A, B' }), 'Hi Alice / A, B');
  assert.throws(() => render('{{task_schedule}}', {}), /缺少值/);
});
test('send validation refuses changed recipients and later task restrictions', async () => {
  const draft = { id: 1, prompt_version: VERSION, customer_id: 3, campaign_id: 2, evidence: JSON.stringify({ recipient_email: 'a@example.com' }) };
  const db = { get: async () => ({ email: 'b@example.com' }), query: async () => [] };
  await assert.rejects(validateTaskDraftForSend(draft, db), /邮箱与预览不一致/);
  db.get = async (sql) => sql.includes('SELECT email') ? { email: 'a@example.com' } : null;
  db.query = async () => [{ campaign_id: 2, customer_id: 3, review_status: 'rejected' }];
  await assert.rejects(validateTaskDraftForSend(draft, db), /状态已变化/);
  let touched = false;
  await validateTaskDraftForSend({ prompt_version: 'p2.4' }, { query: () => { touched = true; } });
  assert.equal(touched, false);
});
