const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
require('dotenv').config();

process.env.NODE_ENV = 'test';
process.env.DB_NAME = 'kol_campaign_os_products_test';
process.env.DB_NAME_TEST = 'kol_campaign_os_products_test';

const express = require('express');
const supertest = require('supertest');
const { Sequelize: SequelizeClient } = require('sequelize');
const { initDatabase, sequelize, models, dbOperations } = require('../database');
const campaignRoutes = require('./campaigns');

let productRoutes;
try {
  productRoutes = require('./products');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' || !error.message.includes("'./products'")) {
    throw error;
  }
  productRoutes = express.Router();
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/products', productRoutes);
  app.use('/api/campaigns', campaignRoutes);
  return app;
}

async function resetTestDatabase() {
  const databaseName = process.env.DB_NAME;
  assert.match(databaseName, /^kol_campaign_os_.*_test$/);

  const admin = new SequelizeClient('mysql', 'root', process.env.DB_ROOT_PASSWORD || 'root_password', {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    dialect: 'mysql',
    logging: false
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
  await admin.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.query(`GRANT ALL PRIVILEGES ON \`${databaseName}\`.* TO '${process.env.DB_USER || 'kol_user'}'@'%'`);
  await admin.query('FLUSH PRIVILEGES');
  await admin.close();
}

async function createCampaign(label) {
  return models.Campaign.create({
    name: `Product API ${label}`,
    brand: '',
    product: ''
  });
}

function assertProductContract(product) {
  assert.deepEqual(Object.keys(product).sort(), [
    'brand',
    'category',
    'description',
    'id',
    'name',
    'product_url',
    'selling_points',
    'sku',
    'status'
  ]);
}

let app;

test.before(async () => {
  await resetTestDatabase();
  await initDatabase();
  app = buildApp();
});

test.after(async () => {
  await sequelize.close();
});

test('Product API validates required name and allowed status values', async () => {
  await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: '   ' })
    .expect(400);

  await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Everglow', status: 'paused' })
    .expect(400);
});

test('Product create and update require string name and brand values', async () => {
  for (const name of [true, false, {}, [], 42]) {
    await supertest(app)
      .post('/api/products')
      .send({ brand: 'Vivatrees', name })
      .expect(400);
  }

  for (const [index, brand] of [null, true, {}, [], 42].entries()) {
    await supertest(app)
      .post('/api/products')
      .send({ brand, name: `Invalid Brand Product ${index}` })
      .expect(400);
  }

  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Strict String Product' })
    .expect(200);

  for (const name of [null, true, {}, [], 42]) {
    await supertest(app)
      .put(`/api/products/${product.body.data.id}`)
      .send({ name })
      .expect(400);
  }

  for (const brand of [null, true, {}, [], 42]) {
    await supertest(app)
      .put(`/api/products/${product.body.data.id}`)
      .send({ brand })
      .expect(400);
  }
});

test('Product API reuses the normalized catalog product across Campaigns', async () => {
  const firstCampaign = await createCampaign('Reuse A');
  const secondCampaign = await createCampaign('Reuse B');

  const created = await supertest(app)
    .post('/api/products')
    .send({
      brand: '  VIVATRÉES ',
      name: ' EverGlow ',
      category: 'Artificial Christmas Tree',
      product_url: 'https://www.thevivatrees.com/products/everglow'
    })
    .expect(200);

  assertProductContract(created.body.data);
  assert.equal(created.body.data.brand, 'VIVATRÉES');
  assert.equal(created.body.data.name, 'EverGlow');

  const reused = await supertest(app)
    .post('/api/products')
    .send({ brand: 'vivatrées', name: 'everglow' })
    .expect(200);

  assert.equal(reused.body.data.id, created.body.data.id);

  const firstAttachment = await supertest(app)
    .post(`/api/campaigns/${firstCampaign.id}/products`)
    .send({
      product_id: created.body.data.id,
      role: 'hero',
      status: 'active',
      campaign_brief: 'Premium lighting story'
    })
    .expect(200);

  const secondAttachment = await supertest(app)
    .post(`/api/campaigns/${secondCampaign.id}/products`)
    .send({ product_id: reused.body.data.id, role: 'secondary' })
    .expect(200);

  assert.equal(firstAttachment.body.data.product.id, created.body.data.id);
  assert.equal(secondAttachment.body.data.product.id, created.body.data.id);
  assert.equal(firstAttachment.body.data.campaign_brief, 'Premium lighting story');
});

test('Product API updates fields and moves reuse to the recalculated catalog key', async () => {
  const original = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Original Product', sku: 'OLD-SKU' })
    .expect(200);

  const updated = await supertest(app)
    .put(`/api/products/${original.body.data.id}`)
    .send({
      brand: ' New Brand ',
      name: ' New Name ',
      sku: 'NEW-SKU',
      description: 'Updated catalog description'
    })
    .expect(200);

  assertProductContract(updated.body.data);
  assert.equal(updated.body.data.id, original.body.data.id);
  assert.equal(updated.body.data.brand, 'New Brand');
  assert.equal(updated.body.data.name, 'New Name');
  assert.equal(updated.body.data.sku, 'NEW-SKU');
  assert.equal(updated.body.data.status, 'active');

  const reused = await supertest(app)
    .post('/api/products')
    .send({ brand: 'new brand', name: 'new name' })
    .expect(200);
  assert.equal(reused.body.data.id, original.body.data.id);

  const oldKey = await supertest(app)
    .post('/api/products')
    .send({ brand: 'vivatrees', name: 'original product' })
    .expect(200);
  assert.notEqual(oldKey.body.data.id, original.body.data.id);
});

test('Product partial update preserves a disjoint field changed after its initial read', async () => {
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Product Disjoint Update', sku: 'INITIAL-SKU' })
    .expect(200);
  const originalRun = dbOperations.run;
  let injected = false;

  dbOperations.run = async (sql, params = []) => {
    if (!injected && /^\s*UPDATE products SET\b/i.test(sql)) {
      injected = true;
      await originalRun(
        'UPDATE products SET sku = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['CONCURRENT-SKU', product.body.data.id]
      );
    }
    return originalRun(sql, params);
  };

  try {
    const updated = await supertest(app)
      .put(`/api/products/${product.body.data.id}`)
      .send({ description: 'Only this field was submitted' })
      .expect(200);

    assert.equal(updated.body.data.description, 'Only this field was submitted');
    assert.equal(updated.body.data.sku, 'CONCURRENT-SKU');
  } finally {
    dbOperations.run = originalRun;
  }
});

test('Product update validates required name and rejects all direct status changes', async () => {
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Update Validation Product' })
    .expect(200);

  await supertest(app)
    .put(`/api/products/${product.body.data.id}`)
    .send({ name: ' ' })
    .expect(400);

  for (const status of ['active', 'archived', 'paused']) {
    await supertest(app)
      .put(`/api/products/${product.body.data.id}`)
      .send({ status })
      .expect(400);
  }
});

test('Product archive is one-way and idempotent', async () => {
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'One-way Product' })
    .expect(200);

  await supertest(app)
    .post(`/api/products/${product.body.data.id}/archive`)
    .send({})
    .expect(200);
  const archivedAgain = await supertest(app)
    .post(`/api/products/${product.body.data.id}/archive`)
    .send({})
    .expect(200);
  assert.equal(archivedAgain.body.data.status, 'archived');

  await supertest(app)
    .put(`/api/products/${product.body.data.id}`)
    .send({ status: 'active' })
    .expect(400);

  const products = await supertest(app).get('/api/products').expect(200);
  assert.equal(products.body.data.find((item) => item.id === product.body.data.id).status, 'archived');
});

test('Product archive does not return success with null data if the row disappears during final read', async () => {
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Product Archive Race' })
    .expect(200);
  const originalRun = dbOperations.run;
  let injected = false;

  dbOperations.run = async (sql, params = []) => {
    const result = await originalRun(sql, params);
    if (!injected && /^\s*UPDATE products\b/i.test(sql)) {
      injected = true;
      await originalRun('DELETE FROM products WHERE id = ?', [product.body.data.id]);
    }
    return result;
  };

  try {
    const response = await supertest(app)
      .post(`/api/products/${product.body.data.id}/archive`)
      .send({});
    assert.ok([404, 409].includes(response.status), `expected 404/409, got ${response.status}`);
    assert.notEqual(response.body.data, null);
  } finally {
    dbOperations.run = originalRun;
  }
});

test('Campaign Product API rejects duplicate attachments', async () => {
  const campaign = await createCampaign('Duplicate');
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Duplicate Product' })
    .expect(200);

  await supertest(app)
    .post(`/api/campaigns/${campaign.id}/products`)
    .send({ product_id: product.body.data.id })
    .expect(200);

  await supertest(app)
    .post(`/api/campaigns/${campaign.id}/products`)
    .send({ product_id: product.body.data.id })
    .expect(409);
});

test('Campaign Product API validates roles and statuses when updating an association', async () => {
  const campaign = await createCampaign('Validation');
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Validation Product' })
    .expect(200);
  const attachment = await supertest(app)
    .post(`/api/campaigns/${campaign.id}/products`)
    .send({ product_id: product.body.data.id })
    .expect(200);

  await supertest(app)
    .put(`/api/campaigns/${campaign.id}/products/${attachment.body.data.id}`)
    .send({ role: 'primary' })
    .expect(400);

  await supertest(app)
    .put(`/api/campaigns/${campaign.id}/products/${attachment.body.data.id}`)
    .send({ status: 'deleted' })
    .expect(400);

  const updated = await supertest(app)
    .put(`/api/campaigns/${campaign.id}/products/${attachment.body.data.id}`)
    .send({ role: 'test', priority: 7, status: 'paused', campaign_brief: 'Test the niche angle' })
    .expect(200);

  assert.equal(updated.body.data.role, 'test');
  assert.equal(updated.body.data.priority, 7);
  assert.equal(updated.body.data.status, 'paused');
  assert.equal(updated.body.data.campaign_brief, 'Test the niche angle');
});

test('Campaign Product partial update preserves a disjoint field changed after its initial read', async () => {
  const campaign = await createCampaign('Campaign Product Disjoint Update');
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Campaign Product Disjoint Update' })
    .expect(200);
  const attachment = await supertest(app)
    .post(`/api/campaigns/${campaign.id}/products`)
    .send({ product_id: product.body.data.id, priority: 0, campaign_brief: 'Initial brief' })
    .expect(200);
  const originalRun = dbOperations.run;
  let injected = false;

  dbOperations.run = async (sql, params = []) => {
    if (!injected && /^\s*UPDATE campaign_products SET\b/i.test(sql)) {
      injected = true;
      await originalRun(
        'UPDATE campaign_products SET priority = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [11, attachment.body.data.id]
      );
    }
    return originalRun(sql, params);
  };

  try {
    const updated = await supertest(app)
      .put(`/api/campaigns/${campaign.id}/products/${attachment.body.data.id}`)
      .send({ campaign_brief: '  Updated brief only  ' })
      .expect(200);

    assert.equal(updated.body.data.campaign_brief, 'Updated brief only');
    assert.equal(updated.body.data.priority, 11);
  } finally {
    dbOperations.run = originalRun;
  }
});

test('Campaign Product priority accepts signed INT max and rejects overflow', async () => {
  const maxPriority = 2147483647;
  const overflowPriority = 2147483648;
  const firstCampaign = await createCampaign('Priority Max Create');
  const secondCampaign = await createCampaign('Priority Overflow Create');
  const firstProduct = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Priority Max Product' })
    .expect(200);
  const secondProduct = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Priority Overflow Product' })
    .expect(200);

  const attachment = await supertest(app)
    .post(`/api/campaigns/${firstCampaign.id}/products`)
    .send({ product_id: firstProduct.body.data.id, priority: maxPriority })
    .expect(200);
  assert.equal(attachment.body.data.priority, maxPriority);

  await supertest(app)
    .post(`/api/campaigns/${secondCampaign.id}/products`)
    .send({ product_id: secondProduct.body.data.id, priority: overflowPriority })
    .expect(400);

  await supertest(app)
    .put(`/api/campaigns/${firstCampaign.id}/products/${attachment.body.data.id}`)
    .send({ priority: 0 })
    .expect(200);
  await supertest(app)
    .put(`/api/campaigns/${firstCampaign.id}/products/${attachment.body.data.id}`)
    .send({ priority: maxPriority })
    .expect(200);
  await supertest(app)
    .put(`/api/campaigns/${firstCampaign.id}/products/${attachment.body.data.id}`)
    .send({ priority: overflowPriority })
    .expect(400);
});

test('Campaign Product campaign_brief is trimmed and rejects non-string values before writing', async () => {
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Brief Validation Product' })
    .expect(200);
  const campaign = await createCampaign('Brief Trim');
  const attachment = await supertest(app)
    .post(`/api/campaigns/${campaign.id}/products`)
    .send({ product_id: product.body.data.id, campaign_brief: '  Original brief  ' })
    .expect(200);
  assert.equal(attachment.body.data.campaign_brief, 'Original brief');

  const updated = await supertest(app)
    .put(`/api/campaigns/${campaign.id}/products/${attachment.body.data.id}`)
    .send({ campaign_brief: '  Updated brief  ' })
    .expect(200);
  assert.equal(updated.body.data.campaign_brief, 'Updated brief');

  for (const [index, campaignBrief] of [null, true, false, 7, {}, []].entries()) {
    const invalidCampaign = await createCampaign(`Invalid Brief Create ${index}`);
    await supertest(app)
      .post(`/api/campaigns/${invalidCampaign.id}/products`)
      .send({ product_id: product.body.data.id, campaign_brief: campaignBrief })
      .expect(400);
  }

  for (const campaignBrief of [null, true, false, 7, {}, []]) {
    await supertest(app)
      .put(`/api/campaigns/${campaign.id}/products/${attachment.body.data.id}`)
      .send({ campaign_brief: campaignBrief })
      .expect(400);
  }
});

test('Product and Campaign Product APIs reject malformed IDs and priorities', async () => {
  for (const invalidPathId of ['0', '-1', '1.5', 'NaN', 'true', '%20']) {
    await supertest(app)
      .post(`/api/products/${invalidPathId}/archive`)
      .send({})
      .expect(400);
    await supertest(app)
      .get(`/api/campaigns/${invalidPathId}/products`)
      .expect(400);
  }

  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Strict Integer Product' })
    .expect(200);
  const campaign = await createCampaign('Strict Integers');

  for (const productId of [true, null, '', 1.5, 0, -1, 'NaN']) {
    await supertest(app)
      .post(`/api/campaigns/${campaign.id}/products`)
      .send({ product_id: productId })
      .expect(400);
  }

  for (const priority of [true, null, '', 1.5, -1, '7']) {
    await supertest(app)
      .post(`/api/campaigns/${campaign.id}/products`)
      .send({ product_id: product.body.data.id, priority })
      .expect(400);
  }

  const attachment = await supertest(app)
    .post(`/api/campaigns/${campaign.id}/products`)
    .send({ product_id: String(product.body.data.id), priority: 0 })
    .expect(200);

  for (const priority of [true, null, '', 1.5, -1, '7']) {
    await supertest(app)
      .put(`/api/campaigns/${campaign.id}/products/${attachment.body.data.id}`)
      .send({ priority })
      .expect(400);
  }

  for (const invalidPathId of ['0', '-1', '1.5', 'NaN', 'true', '%20']) {
    await supertest(app)
      .put(`/api/campaigns/${invalidPathId}/products/${attachment.body.data.id}`)
      .send({ role: 'hero' })
      .expect(400);
    await supertest(app)
      .put(`/api/campaigns/${campaign.id}/products/${invalidPathId}`)
      .send({ role: 'hero' })
      .expect(400);
  }
});

test('an archived Product cannot be newly attached to a Campaign', async () => {
  const campaign = await createCampaign('Archived Product Guard');
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Archived Attachment Product' })
    .expect(200);
  await supertest(app)
    .post(`/api/products/${product.body.data.id}/archive`)
    .send({})
    .expect(200);

  await supertest(app)
    .post(`/api/campaigns/${campaign.id}/products`)
    .send({ product_id: product.body.data.id })
    .expect(409);
});

test('an archived Campaign Product cannot be restored through PUT', async () => {
  const campaign = await createCampaign('Archived Association Guard');
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Archived Association Product' })
    .expect(200);
  const attachment = await supertest(app)
    .post(`/api/campaigns/${campaign.id}/products`)
    .send({ product_id: product.body.data.id })
    .expect(200);
  await supertest(app)
    .post(`/api/campaigns/${campaign.id}/products/${attachment.body.data.id}/archive`)
    .send({})
    .expect(200);

  await supertest(app)
    .put(`/api/campaigns/${campaign.id}/products/${attachment.body.data.id}`)
    .send({ status: 'active' })
    .expect(409);

  const list = await supertest(app)
    .get(`/api/campaigns/${campaign.id}/products`)
    .expect(200);
  assert.equal(list.body.data[0].status, 'archived');
});

test('Campaign deletion is rejected while any Campaign Product history exists', async () => {
  const campaign = await createCampaign('Delete Guard');
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Delete Guard Product' })
    .expect(200);
  const attachment = await supertest(app)
    .post(`/api/campaigns/${campaign.id}/products`)
    .send({ product_id: product.body.data.id })
    .expect(200);

  await supertest(app).delete(`/api/campaigns/${campaign.id}`).expect(400);

  assert.ok(await models.Campaign.findByPk(campaign.id));
  assert.ok(await models.CampaignProduct.findByPk(attachment.body.data.id));
});

test('Campaign without protected relationships remains deletable', async () => {
  const campaign = await createCampaign('Delete Allowed');

  await supertest(app).delete(`/api/campaigns/${campaign.id}`).expect(200);

  assert.equal(await models.Campaign.findByPk(campaign.id), null);
});

test('Campaign Product creation maps a concurrent parent deletion to 404 or 409', async () => {
  const campaign = await createCampaign('Create Race');
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Create Race Product' })
    .expect(200);
  const originalRun = dbOperations.run;
  let injected = false;

  dbOperations.run = async (sql, params = []) => {
    if (!injected && /^\s*INSERT INTO campaign_products\b/i.test(sql)) {
      injected = true;
      await originalRun('DELETE FROM campaigns WHERE id = ?', [campaign.id]);
    }
    return originalRun(sql, params);
  };

  try {
    const response = await supertest(app)
      .post(`/api/campaigns/${campaign.id}/products`)
      .send({ product_id: product.body.data.id });
    assert.ok([404, 409].includes(response.status), `expected 404/409, got ${response.status}`);
  } finally {
    dbOperations.run = originalRun;
  }
});

test('Campaign Product update does not return success with null data after concurrent parent deletion', async () => {
  const campaign = await createCampaign('Update Race');
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Update Race Product' })
    .expect(200);
  const attachment = await supertest(app)
    .post(`/api/campaigns/${campaign.id}/products`)
    .send({ product_id: product.body.data.id })
    .expect(200);
  const originalRun = dbOperations.run;
  let injected = false;

  dbOperations.run = async (sql, params = []) => {
    const result = await originalRun(sql, params);
    if (!injected && /^\s*UPDATE campaign_products SET\b/i.test(sql)) {
      injected = true;
      await originalRun('DELETE FROM campaigns WHERE id = ?', [campaign.id]);
    }
    return result;
  };

  try {
    const response = await supertest(app)
      .put(`/api/campaigns/${campaign.id}/products/${attachment.body.data.id}`)
      .send({ priority: 2 });
    assert.ok([404, 409].includes(response.status), `expected 404/409, got ${response.status}`);
    assert.notEqual(response.body.data, null);
  } finally {
    dbOperations.run = originalRun;
  }
});

test('Campaign Product archive does not return success with null data after concurrent parent deletion', async () => {
  const campaign = await createCampaign('Archive Race');
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Archive Race Product' })
    .expect(200);
  const attachment = await supertest(app)
    .post(`/api/campaigns/${campaign.id}/products`)
    .send({ product_id: product.body.data.id })
    .expect(200);
  const originalRun = dbOperations.run;
  let injected = false;

  dbOperations.run = async (sql, params = []) => {
    const result = await originalRun(sql, params);
    if (!injected && /^\s*UPDATE campaign_products\s+SET status = 'archived'/i.test(sql)) {
      injected = true;
      await originalRun('DELETE FROM campaigns WHERE id = ?', [campaign.id]);
    }
    return result;
  };

  try {
    const response = await supertest(app)
      .post(`/api/campaigns/${campaign.id}/products/${attachment.body.data.id}/archive`)
      .send({});
    assert.ok([404, 409].includes(response.status), `expected 404/409, got ${response.status}`);
    assert.notEqual(response.body.data, null);
  } finally {
    dbOperations.run = originalRun;
  }
});

test('archiving preserves Product and Campaign Product history and updates Campaign counts', async () => {
  const campaign = await createCampaign('Archive');
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Archive Product' })
    .expect(200);
  const attachment = await supertest(app)
    .post(`/api/campaigns/${campaign.id}/products`)
    .send({ product_id: product.body.data.id, status: 'active' })
    .expect(200);

  let campaigns = await supertest(app).get('/api/campaigns').expect(200);
  let campaignRow = campaigns.body.data.find((item) => item.id === campaign.id);
  assert.equal(Number(campaignRow.associated_product_count), 1);
  assert.equal(Number(campaignRow.active_product_count), 1);

  const archivedAssociation = await supertest(app)
    .post(`/api/campaigns/${campaign.id}/products/${attachment.body.data.id}/archive`)
    .send({})
    .expect(200);
  assert.equal(archivedAssociation.body.data.status, 'archived');

  const campaignProducts = await supertest(app)
    .get(`/api/campaigns/${campaign.id}/products`)
    .expect(200);
  assert.equal(campaignProducts.body.data.length, 1);
  assert.equal(campaignProducts.body.data[0].status, 'archived');

  campaigns = await supertest(app).get('/api/campaigns').expect(200);
  campaignRow = campaigns.body.data.find((item) => item.id === campaign.id);
  assert.equal(Number(campaignRow.associated_product_count), 1);
  assert.equal(Number(campaignRow.active_product_count), 0);

  const archivedProduct = await supertest(app)
    .post(`/api/products/${product.body.data.id}/archive`)
    .send({})
    .expect(200);
  assert.equal(archivedProduct.body.data.status, 'archived');

  const products = await supertest(app).get('/api/products').expect(200);
  const productRow = products.body.data.find((item) => item.id === product.body.data.id);
  assert.ok(productRow, 'archived Product should remain listable');
  assert.equal(productRow.status, 'archived');

  await supertest(app).delete(`/api/products/${product.body.data.id}`).expect(404);
  await supertest(app)
    .delete(`/api/campaigns/${campaign.id}/products/${attachment.body.data.id}`)
    .expect(404);
});
