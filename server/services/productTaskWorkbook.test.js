const test = require('node:test');
const assert = require('node:assert/strict');
const { previewRows, sheetDate } = require('./productTaskWorkbook');
const header = ['SKU', null, '产品', '送测数量', '红人名单审批时间', '内容发布时间要求', 'KOL要求'];
test('workbook preview keeps combinations and missing dates without fabricating targets', () => {
  const result = previewRows([header,
    ['A+B', null, '组合', '1-2个', new Date('2026-11-20T00:00:00Z'), new Date('2026-12-15T00:00:00Z'), '深度测评'],
    ['A', null, '催视频', 1, null, null, '之前合作的KOL继续催他发视频'],
    [], ['基本要求'], ['每个SKU提交10个以上合格KOL']
  ], [{ sku: 'A', campaign_product_id: 1 }, { sku: 'B', campaign_product_id: 2 }]);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].task.campaign_product_ids, [1, 2]);
  assert.equal(result[0].task.sample_max, 2);
  assert.equal(result[0].task.candidate_target, null);
  assert.equal(result[1].task.task_type, 'delivery_follow_up');
  assert.equal(result[1].task.publish_due_at, null);
  assert.deepEqual(result[0].errors, []);
});
test('missing and ambiguous project SKUs prevent import; dates need explicit years', () => {
  const [row] = previewRows([header, ['A+B', null, '组合', 1, '11-20', '2027-01-15']], [{ sku: 'A', campaign_product_id: 1 }, { sku: 'A', campaign_product_id: 2 }]);
  assert.equal(row.errors.length, 3);
  assert.throws(() => sheetDate('11-20'), /不推断/);
});
