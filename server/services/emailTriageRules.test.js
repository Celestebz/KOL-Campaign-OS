const test = require('node:test');
const assert = require('node:assert/strict');
const { currentBody, validateClassification } = require('./emailTriageRules');

const badPayment = { category: 'payment', priority: 'urgent', summary: '询问发货', reason: '物流属于付款履约', action: '索取购买订单号' };

test('reported shipping question becomes execution follow-up without a model retry', () => {
  const result = validateClassification(badPayment, { clean_body_text:
    'Hi! I just wanted to check whether the product has been shipped yet. If it has, could you please share the tracking information with me? Thank you!' });
  assert.equal(result.category, 'execution_issue');
  assert.equal(result.priority, 'important');
  assert.doesNotMatch(result.action, /购买|订单号/);
  assert.match(result.reason, /属于合作执行中的物流跟进/);
});

for (const body of [
  '请问样品发货了吗？能提供运单号吗？',
  'The package has not arrived. Could you check the delivery status?',
  'Payment has been received. Could you please send the tracking number?',
  'There is no payment problem. When will the shipment arrive?'
]) test(`logistics is not a payment anomaly: ${body}`, () => {
  assert.equal(validateClassification(badPayment, { body_text: body }).category, 'execution_issue');
});

test('a real overdue invoice with a verified current-message quote stays payment', () => {
  const body = 'The invoice is overdue. Please pay the outstanding balance.';
  const result = validateClassification({ ...badPayment, payment_evidence: 'Please pay the outstanding balance.' }, { body_text: body });
  assert.equal(result.category, 'payment');
  assert.equal(result.priority, 'urgent');
});

test('a mixed shipping and unpaid-invoice request is not forced to logistics', () => {
  const body = 'When will the shipment arrive? I have not received the invoice payment.';
  const result = validateClassification({ ...badPayment, payment_evidence: 'I have not received the invoice payment.' }, { body_text: body });
  assert.equal(result.category, 'payment');
});

test('a fabricated payment quote or an old quoted invoice cannot justify payment', () => {
  for (const reply of [
    { clean_body_text: 'Thank you for the collaboration details.' },
    { body_text: 'Thank you!\n\n> Please pay the overdue invoice.' }
  ]) {
    assert.equal(validateClassification({ ...badPayment, payment_evidence: 'Please pay the overdue invoice.' }, reply).category, 'needs_review');
  }
});

test('paid partnership and general commission terms are not payment anomalies', () => {
  for (const body of ['I am interested in a paid partnership with an affiliate commission.',
    'Could we work on a commission-only collaboration?', '请问佣金比例是多少？']) {
    assert.equal(validateClassification({ ...badPayment, payment_evidence: body }, { body_text: body }).category, 'needs_review');
  }
});

test('a direct request for payment remains payment even without an invoice', () => {
  for (const body of ['Please pay me.', 'When will I get paid?', '请问什么时候付款？']) {
    assert.equal(validateClassification({ ...badPayment, payment_evidence: body }, { body_text: body }).category, 'payment');
  }
});

test('a settled payment does not become urgent payment follow-up', () => {
  const body = 'Payment has been received. Thank you!';
  assert.equal(validateClassification({ ...badPayment, payment_evidence: body }, { body_text: body }).category, 'needs_review');
});

test('explicit urgency can be retained for a logistics request', () => {
  assert.equal(validateClassification(badPayment, { body_text: 'Urgent: can you share tracking? We publish tomorrow.' }).priority, 'urgent');
});

test('valid execution urgency based on conversation deadlines is preserved', () => {
  const model = { ...badPayment, category: 'execution_issue', reason: '此前确认的发布时间即将到期', action: '立即核对运单并协调发布' };
  assert.deepEqual(validateClassification(model, { body_text: 'Could you share tracking information?' }), model);
});

test('fallback current body stops before quoted correspondence', () => {
  assert.equal(currentBody({ body_text: 'Can you share tracking?\nOn Monday someone wrote:\nPlease pay an invoice.' }), 'Can you share tracking?');
});
