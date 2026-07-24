const XLSX = require('xlsx');
const { initDatabase, dbOperations } = require('../database');
const { catalogKeyHash } = require('../migrations/20260719000001-add-multi-product-campaign-relations');

const workbookPath = process.argv[2];
if (!workbookPath) throw new Error('Missing workbook path');

const text = (value) => String(value ?? '').trim();
const identity = (value) => text(value).toLowerCase().replace(/[（(].*?[）)]/g, '').replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
const emailKey = (value) => text(value).toLowerCase();
const skuList = (value) => Array.from(new Set(text(value).split(/[\n,+]/).map(text).filter((sku) => sku && sku !== '/')));

async function findCustomer(row, customers) {
  const email = emailKey(row.Email);
  if (email) {
    const match = customers.find((customer) => emailKey(customer.email) === email);
    if (match) return match;
  }
  const key = identity(row['红人名称']);
  return customers.find((customer) => identity(customer.name) === key)
    || customers.find((customer) => key && (identity(customer.name).includes(key) || key.includes(identity(customer.name))));
}

async function ensureProduct(sku, row) {
  const existing = await dbOperations.get('SELECT * FROM products WHERE UPPER(sku) = UPPER(?) ORDER BY id LIMIT 1', [sku]);
  if (existing) return existing;
  const baseName = text(row['官网对应产品/系列']) || sku;
  const name = `${baseName} (${sku})`;
  const result = await dbOperations.run(
    `INSERT INTO products (brand, name, sku, category, status, catalog_key_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ['BILTHARD', name, sku, text(row['官网一级分类']) || null, catalogKeyHash('BILTHARD', name)]
  );
  return dbOperations.get('SELECT * FROM products WHERE id = ?', [result.id]);
}

async function main() {
  await initDatabase();
  const workbook = XLSX.readFile(workbookPath, { cellDates: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['红人合作进度'], { defval: '' })
    .filter((row) => text(row['红人名称']));
  const customers = await dbOperations.query('SELECT id, name, email FROM customers');
  const summary = { scanned: rows.length, imported: 0, already_imported: 0, matched_customers: [], unmatched: [], errors: [] };

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const source = `historical_import:bilthard:${index + 2}`;
    try {
      let already = await dbOperations.get('SELECT id, customer_id, campaign_id FROM campaign_kols WHERE source = ?', [source]);
      if (already) {
        const assignment = await dbOperations.get('SELECT id FROM campaign_kol_products WHERE campaign_kol_id = ? LIMIT 1', [already.id]);
        if (!assignment) {
          await dbOperations.run('DELETE FROM campaigns WHERE id = ?', [already.campaign_id]);
          already = null;
        }
      }
      if (already) {
        summary.already_imported += 1;
        summary.matched_customers.push(already.customer_id);
        continue;
      }
      const customer = await findCustomer(row, customers);
      if (!customer) {
        summary.unmatched.push(text(row['红人名称']));
        continue;
      }
      const skus = skuList(row['原始产品/SKU']);
      const displaySku = skus.join(' + ') || text(row['原始产品/SKU']) || '未标注SKU';
      const campaignResult = await dbOperations.run(
        'INSERT INTO campaigns (name, brand, product, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
        [`BILTHARD 历史合作｜${displaySku}`, 'BILTHARD', text(row['官网对应产品/系列']) || displaySku]
      );
      const statusText = text(row['当前状态']);
      const videoUrl = /^https?:\/\//i.test(text(row['素材/视频链接'])) ? text(row['素材/视频链接']) : null;
      const review = [statusText, text(row['素材/视频链接']), text(row['备注']), text(row['视频可用时间段'])].filter(Boolean).join('｜');
      const returned = /已返|已发布|可用/.test(statusText);
      const kolResult = await dbOperations.run(
        `INSERT INTO campaign_kols
         (campaign_id, customer_id, target_platform, source, project_status, content_status, project_notes,
          internal_notes, best_evidence_url, youtube_video_link, sync_status, created_at, updated_at)
         VALUES (?, ?, 'youtube', ?, ?, ?, ?, ?, ?, ?, 'sync_pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [campaignResult.id, customer.id, source, returned ? 'published' : 'confirmed', returned ? 'published' : 'pending',
          review || null, `来源：BILTHARD 历史资料，第 ${index + 2} 行`, videoUrl, videoUrl]
      );
      for (const sku of skus) {
        const product = await ensureProduct(sku, row);
        let campaignProduct = await dbOperations.get('SELECT * FROM campaign_products WHERE campaign_id = ? AND product_id = ?', [campaignResult.id, product.id]);
        if (!campaignProduct) {
          const result = await dbOperations.run(
            `INSERT INTO campaign_products (campaign_id, product_id, role, priority, status, created_at, updated_at)
             VALUES (?, ?, 'hero', 0, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [campaignResult.id, product.id]
          );
          campaignProduct = { id: result.id };
        }
        await dbOperations.run(
          `INSERT INTO campaign_kol_products
           (campaign_kol_id, campaign_product_id, fit_status, assignment_status, content_status, result_summary, created_at, updated_at)
           VALUES (?, ?, 'approved', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [kolResult.id, campaignProduct.id, returned ? 'completed' : 'active', returned ? 'published' : 'pending', review || null]
        );
      }
      summary.imported += 1;
      summary.matched_customers.push(customer.id);
    } catch (error) {
      summary.errors.push({ row: index + 2, name: text(row['红人名称']), error: error.message });
    }
  }
  summary.matched_customers = Array.from(new Set(summary.matched_customers));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.errors.length ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
