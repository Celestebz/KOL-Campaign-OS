const xlsx = require('xlsx');
const { validate, taskFields } = require('./productTaskService');
function sheetDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const parts = xlsx.SSF.parse_date_code(value);
    if (!parts) throw new Error('日期序列无效');
    return `${parts.y}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
  }
  const text = String(value).trim().replaceAll('/', '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('日期请使用YYYY-MM-DD，不推断缺失年份');
  return text;
}
function previewRows(rows, products) {
  const header = rows[0] || [];
  if (header[0] !== 'SKU' || header[2] !== '产品') throw new Error('请使用SKU、链接、产品、送测数量、红人名单审批时间、内容发布时间要求、KOL要求七列结构');
  const ruleStart = rows.findIndex((row) => String(row[0] || '').trim() === '基本要求');
  const common = ruleStart < 0 ? '' : rows.slice(ruleStart + 1).map((r) => String(r[0] || '').trim()).filter(Boolean).join('\n');
  return rows.slice(1, ruleStart < 0 ? undefined : ruleStart).flatMap((row, index) => {
    if (!row[0]) return [];
    const errors = []; const warnings = [];
    const skus = [...new Set(String(row[0]).split(/[+＋]/).map((s) => s.trim()).filter(Boolean))];
    const matched = skus.map((sku) => products.filter((p) => p.sku === sku));
    skus.forEach((sku, i) => { if (matched[i].length !== 1) errors.push(`${sku} 在本项目中${matched[i].length ? '存在歧义' : '尚未关联，请先补齐产品'}`); });
    const task = { name: String(row[2] || row[0]).trim(), task_type: /之前合作|继续催/.test(String(row[6] || '')) ? 'delivery_follow_up' : 'recruitment',
      status: 'active', priority: 0, campaign_product_ids: matched.filter((r) => r.length === 1).map((r) => r[0].campaign_product_id),
      requirements: [row[6], common].filter(Boolean).join('\n\n'), candidate_target: null,
      sample_min: null, sample_max: null, approval_due_at: null, publish_due_at: null };
    const amount = String(row[3] ?? '').trim().match(/^(\d+)(?:\s*[-–～]\s*(\d+))?\s*(?:个|台)?$/);
    if (amount) { task.sample_min = Number(amount[1]); task.sample_max = Number(amount[2] || amount[1]); }
    else if (row[3]) warnings.push('送测数量未识别，请导入后补充');
    for (const [column, key] of [[4, 'approval_due_at'], [5, 'publish_due_at']]) {
      try { task[key] = sheetDate(row[column]); } catch (error) { errors.push(`${key}: ${error.message}`); }
      if (!task[key]) warnings.push(`${key === 'approval_due_at' ? '审批' : '发布'}期限缺失`);
    }
    if (task.approval_due_at && task.approval_due_at < new Date().toISOString().slice(0, 10)) warnings.push('审批日期已过去，请核实；不会自动改日期');
    if (common.includes('10个以上')) warnings.push('“10个以上”的精确目标待确认，候选目标留空');
    try { validate(task, taskFields); } catch (error) { errors.push(error.message); }
    return [{ source_row: index + 2, skus, task, errors, warnings }];
  });
}
function previewWorkbook(buffer, products) {
  const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true, sheetRows: 201 });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('工作簿没有可读取的工作表');
  const range = xlsx.utils.decode_range(sheet['!fullref'] || sheet['!ref'] || 'A1');
  if (range.e.r > 199 || range.e.c > 20) throw new Error('任务清单最多200行、21列，请拆分文件');
  return previewRows(xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null }), products);
}
module.exports = { previewRows, previewWorkbook, sheetDate };
