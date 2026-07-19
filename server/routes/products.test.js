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
const { initDatabase, sequelize, models } = require('../database');
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
      description: 'Updated catalog description',
      status: 'archived'
    })
    .expect(200);

  assertProductContract(updated.body.data);
  assert.equal(updated.body.data.id, original.body.data.id);
  assert.equal(updated.body.data.brand, 'New Brand');
  assert.equal(updated.body.data.name, 'New Name');
  assert.equal(updated.body.data.sku, 'NEW-SKU');
  assert.equal(updated.body.data.status, 'archived');

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

test('Product update validates required name and allowed status values', async () => {
  const product = await supertest(app)
    .post('/api/products')
    .send({ brand: 'Vivatrees', name: 'Update Validation Product' })
    .expect(200);

  await supertest(app)
    .put(`/api/products/${product.body.data.id}`)
    .send({ name: ' ' })
    .expect(400);

  await supertest(app)
    .put(`/api/products/${product.body.data.id}`)
    .send({ status: 'paused' })
    .expect(400);
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
