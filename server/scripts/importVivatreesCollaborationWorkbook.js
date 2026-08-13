const XLSX = require('xlsx');
const mysql = require('mysql2/promise');

const WORKBOOK = process.argv.find((arg) => arg.endsWith('.xlsx'));
const APPLY = process.argv.includes('--apply');
const CAMPAIGN_ID = 61;

if (!WORKBOOK) {
  throw new Error('Workbook path is required');
}

const H = {
  name: '自动带入｜达人名称', platform: '自动带入｜平台', followers: '自动带入｜粉丝数',
  owner: '自动带入｜负责人', email: '自动带入｜邮箱', tier: '自动带入｜达人等级',
  sku: '自动带入｜推荐产品/SKU', cooperation: '自动带入｜合作方式', address: '人工｜收货地址',
  deliverables: '人工｜交付内容', publish: '人工｜预计上线时间', contentFormat: '人工｜内容模板',
  quote: '人工｜达人现金报价USD', paypal: '人工｜PayPal账号', totalCost: '系统｜总预估成本USD',
  medianViews: '自动带入｜近30天中位曝光', expectedViews: '人工｜预估合作曝光', cpm: '系统｜预估CPM',
  budgetJudgment: '系统｜预算判断', budgetApproval: '人工｜预算审批状态', notes: '人工｜合作备注',
  shippingDate: '系统｜发货日期', orderNo: '系统｜达人系统单号', tracking: '人工｜物流单号',
  deliveredDate: '系统/API｜签收日期', stage: '推进｜当前阶段'
};

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function firstEmail(value) {
  const match = text(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : '';
}

function normalizeName(value) {
  return text(value).toLowerCase().replace(/\s+/g, ' ');
}

function numberOrNull(value) {
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mysqlDate(value) {
  if (value === '' || value === undefined || value === null) return null;
  if (typeof value === 'number') {
    const d = XLSX.SSF.parse_date_code(value);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')} ${String(d.H || 0).padStart(2, '0')}:${String(d.M || 0).padStart(2, '0')}:${String(Math.floor(d.S || 0)).padStart(2, '0')}`;
  }
  const source = text(value).split(/\r?\n/)[0];
  const parsed = new Date(source.replace(/\//g, '-'));
  if (Number.isNaN(parsed.getTime())) return null;
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 19).replace('T', ' ');
}

function projectStatus(stage, hasShippingDate, hasDeliveredDate) {
  const value = text(stage);
  if (value.includes('已上线') || value.includes('已发布')) return 'published';
  if (value.includes('待上线') || value.includes('待发布')) return 'pending_publish';
  if (value.includes('制作') || value.includes('内容')) return 'content_preparation';
  if (value.includes('已签收') || hasDeliveredDate) return 'delivered';
  if (value.includes('已发货') || hasShippingDate) return 'shipped';
  if (value.includes('待发货')) return 'pending_shipping';
  if (value.includes('取消') || value.includes('终止')) return 'cancelled';
  return 'pending_confirmation';
}

function budgetStatus(value) {
  const source = text(value);
  if (source.includes('通过')) return 'approved';
  if (source.includes('拒绝')) return 'rejected';
  if (source) return 'pending';
  return null;
}

function productSampleStatus(status) {
  if (status === 'delivered' || status === 'content_preparation' || status === 'pending_publish' || status === 'published') return 'received';
  if (status === 'shipped') return 'sent';
  return 'pending';
}

function productContentStatus(status) {
  if (status === 'published') return 'published';
  if (status === 'pending_publish') return 'review';
  if (status === 'content_preparation') return 'draft';
  return 'pending';
}

function priority(tier) {
  return ({ S: 't1', A: 't1', B: 't2', C: 't3', D: 't4' })[text(tier).toUpperCase()] || 't2';
}

function notesFor(row) {
  return [
    text(row[H.sku]) && `推荐产品/SKU：${text(row[H.sku])}`,
    text(row[H.notes]) && `合作备注：${text(row[H.notes])}`,
    text(row[H.budgetJudgment]) && `预算判断：${text(row[H.budgetJudgment])}`,
    text(row[H.paypal]) && `PayPal：${text(row[H.paypal])}`,
    text(row[H.orderNo]) && `达人系统单号：${text(row[H.orderNo])}`,
    text(row[H.publish]) && `原预计上线时间：${text(row[H.publish])}`,
    text(row[H.deliveredDate]) && `签收日期：${text(row[H.deliveredDate])}`,
    text(row[H.stage]) && `表格当前阶段：${text(row[H.stage])}`
  ].filter(Boolean).join('\n');
}

async function main() {
  const workbook = XLSX.readFile(WORKBOOK, { cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true }).filter((row) => text(row[H.name]));
  const db = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'kol_user', password: 'kol_password', database: 'kol_campaign_os' });
  const summary = { mode: APPLY ? 'apply' : 'dry-run', workbook_rows: rows.length, customers_created: 0, customers_matched: 0, campaign_kols_created: 0, campaign_kols_updated: 0, products_attached: 0, kol_products_created: 0, kol_products_updated: 0, missing_skus: [], warnings: [] };

  await db.beginTransaction();
  try {
    const [campaigns] = await db.execute('SELECT id,name,brand FROM campaigns WHERE id=? FOR UPDATE', [CAMPAIGN_ID]);
    const campaign = campaigns[0];
    if (!campaign || campaign.brand !== 'VivaTrees' || !campaign.name.includes('Christmas Tree 2026')) throw new Error('Target campaign identity mismatch');

    const uniqueSkus = [...new Set(rows.map((row) => text(row[H.sku]).toUpperCase()).filter(Boolean))];
    for (const sku of uniqueSkus) {
      const [products] = await db.execute('SELECT id,status FROM products WHERE UPPER(sku)=? ORDER BY id LIMIT 1', [sku]);
      if (!products[0]) summary.missing_skus.push(sku);
      else if (products[0].status !== 'active') summary.warnings.push(`Archived product skipped: ${sku}`);
      else {
        const [links] = await db.execute('SELECT id FROM campaign_products WHERE campaign_id=? AND product_id=?', [CAMPAIGN_ID, products[0].id]);
        if (!links[0]) {
          await db.execute("INSERT INTO campaign_products (campaign_id,product_id,role,priority,campaign_brief,status,created_at,updated_at) VALUES (?,?,'hero',0,'2026 Holiday Season','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)", [CAMPAIGN_ID, products[0].id]);
          summary.products_attached += 1;
        }
      }
    }

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const excelRow = index + 2;
      const name = text(row[H.name]);
      const email = firstEmail(row[H.email]);
      const platform = text(row[H.platform]);
      const followers = numberOrNull(row[H.followers]);
      let customer = null;

      if (email) {
        const [matches] = await db.execute('SELECT * FROM customers WHERE LOWER(email)=? LIMIT 1 FOR UPDATE', [email]);
        customer = matches[0] || null;
      }
      if (!customer) {
        const [matches] = await db.execute('SELECT * FROM customers WHERE LOWER(TRIM(name))=? ORDER BY id', [normalizeName(name)]);
        if (matches.length === 1) customer = matches[0];
        else if (matches.length > 1) summary.warnings.push(`Row ${excelRow}: multiple name matches for ${name}; a new customer was created`);
      }

      if (!customer) {
        const instagramFollowers = platform.toLowerCase() === 'instagram' && followers !== null ? String(followers) : null;
        const tiktokFollowers = platform.toLowerCase() === 'tiktok' && followers !== null ? String(followers) : null;
        const youtubeFollowers = platform.toLowerCase() === 'youtube' && followers !== null ? String(followers) : null;
        const [created] = await db.execute(`INSERT INTO customers
          (name,email,platform,instagram_followers,tiktok_followers,youtube_followers,rating,status,sync_status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'active','sync_pending',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
          [name, email || null, platform || null, instagramFollowers, tiktokFollowers, youtubeFollowers, text(row[H.tier]) || null]);
        const [createdRows] = await db.execute('SELECT * FROM customers WHERE id=?', [created.insertId]);
        customer = createdRows[0];
        summary.customers_created += 1;
      } else {
        summary.customers_matched += 1;
        const followerColumn = platform.toLowerCase() === 'instagram' ? 'instagram_followers' : platform.toLowerCase() === 'tiktok' ? 'tiktok_followers' : platform.toLowerCase() === 'youtube' ? 'youtube_followers' : null;
        if (followerColumn && followers !== null) await db.execute(`UPDATE customers SET ${followerColumn}=COALESCE(NULLIF(${followerColumn},''),?), rating=COALESCE(NULLIF(rating,''),?), sync_status='sync_pending', updated_at=CURRENT_TIMESTAMP WHERE id=?`, [String(followers), text(row[H.tier]) || null, customer.id]);
      }

      const shippingDate = mysqlDate(row[H.shippingDate]);
      const deliveredDate = mysqlDate(row[H.deliveredDate]);
      const status = projectStatus(row[H.stage], shippingDate, deliveredDate);
      const cooperationType = text(row[H.cooperation]).includes('付费') ? 'paid_product' : 'product_exchange';
      const quotedFee = numberOrNull(row[H.quote]);
      const finalFee = cooperationType === 'product_exchange' ? 0 : quotedFee;
      const tracking = text(row[H.tracking]);
      const data = {
        kol_name_snapshot: name, email_snapshot: email, contact_email_override: email || null,
        target_platform: platform || null, cooperation_platforms: platform ? JSON.stringify([platform]) : null,
        owner: text(row[H.owner]) || null, priority_level: priority(row[H.tier]), pipeline_stage: 'confirmed',
        confirmed_at: new Date(), project_status: status, status: status, cooperation_type: cooperationType,
        quoted_fee: quotedFee === null ? null : String(quotedFee), final_fee: finalFee === null ? null : String(finalFee), currency: quotedFee === null ? null : 'USD',
        deliverables: text(row[H.deliverables]) || null, shipping_address: text(row[H.address]) || null,
        expected_publish_at: mysqlDate(row[H.publish]), content_format: text(row[H.contentFormat]) || null,
        estimated_total_cost_usd: numberOrNull(row[H.totalCost]), median_views_30d_snapshot: numberOrNull(row[H.medianViews]),
        expected_views: numberOrNull(row[H.expectedViews]), estimated_cpm: numberOrNull(row[H.cpm]),
        budget_approval_status: budgetStatus(row[H.budgetApproval]), shipping_date: shippingDate,
        tracking_number: tracking || null, project_notes: notesFor(row) || null, source: 'vivatrees_collaboration_workbook', sync_status: 'sync_pending'
      };

      const [existingRows] = await db.execute('SELECT * FROM campaign_kols WHERE campaign_id=? AND customer_id=? ORDER BY id LIMIT 1 FOR UPDATE', [CAMPAIGN_ID, customer.id]);
      let campaignKolId;
      const fields = Object.keys(data);
      if (!existingRows[0]) {
        const columns = ['campaign_id', 'customer_id', ...fields, 'created_at', 'updated_at'];
        const placeholders = columns.map((field) => ['created_at', 'updated_at'].includes(field) ? 'CURRENT_TIMESTAMP' : '?');
        const values = [CAMPAIGN_ID, customer.id, ...fields.map((field) => data[field])];
        const [created] = await db.execute(`INSERT INTO campaign_kols (${columns.join(',')}) VALUES (${placeholders.join(',')})`, values);
        campaignKolId = created.insertId;
        summary.campaign_kols_created += 1;
      } else {
        campaignKolId = existingRows[0].id;
        await db.execute(`UPDATE campaign_kols SET ${fields.map((field) => `${field}=?`).join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [...fields.map((field) => data[field]), campaignKolId]);
        summary.campaign_kols_updated += 1;
      }

      const sku = text(row[H.sku]).toUpperCase();
      if (sku && !summary.missing_skus.includes(sku)) {
        const [campaignProducts] = await db.execute(`SELECT cp.id FROM campaign_products cp JOIN products p ON p.id=cp.product_id WHERE cp.campaign_id=? AND UPPER(p.sku)=? AND cp.status='active' ORDER BY cp.id LIMIT 1`, [CAMPAIGN_ID, sku]);
        if (campaignProducts[0]) {
          const campaignProductId = campaignProducts[0].id;
          const productData = {
            fit_status: 'approved', assignment_status: status === 'published' ? 'completed' : 'active',
            quoted_fee: quotedFee === null ? null : String(quotedFee), sample_status: productSampleStatus(status),
            deliverables: text(row[H.deliverables]) || null, content_status: productContentStatus(status),
            result_summary: text(row[H.notes]) || null
          };
          const [existingProductRows] = await db.execute('SELECT id FROM campaign_kol_products WHERE campaign_kol_id=? AND campaign_product_id=? FOR UPDATE', [campaignKolId, campaignProductId]);
          const productFields = Object.keys(productData);
          if (!existingProductRows[0]) {
            await db.execute(`INSERT INTO campaign_kol_products (campaign_kol_id,campaign_product_id,${productFields.join(',')},created_at,updated_at) VALUES (?,?,${productFields.map(() => '?').join(',')},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [campaignKolId, campaignProductId, ...productFields.map((field) => productData[field])]);
            summary.kol_products_created += 1;
          } else {
            await db.execute(`UPDATE campaign_kol_products SET ${productFields.map((field) => `${field}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`, [...productFields.map((field) => productData[field]), existingProductRows[0].id]);
            summary.kol_products_updated += 1;
          }
        }
      }
    }

    if (APPLY) await db.commit();
    else await db.rollback();
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
