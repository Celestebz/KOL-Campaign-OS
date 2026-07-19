const express = require('express');
const { dbOperations } = require('../database');
const { catalogKeyHash } = require('../migrations/20260719000001-add-multi-product-campaign-relations');

const router = express.Router();

const PRODUCT_STATUSES = new Set(['active', 'archived']);
const PRODUCT_COLUMNS = `
  id, brand, name, sku, category, product_url, description, selling_points, status
`;

function cleanText(value) {
  return String(value ?? '').trim();
}

function validateStatus(status) {
  return status === undefined || PRODUCT_STATUSES.has(status);
}

async function getProduct(id) {
  return dbOperations.get(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`, [id]);
}

router.get('/', async (req, res) => {
  try {
    const rows = await dbOperations.query(`
      SELECT ${PRODUCT_COLUMNS}
      FROM products
      ORDER BY created_at DESC, id DESC
    `);
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const brand = cleanText(req.body.brand);
    const name = cleanText(req.body.name);
    const status = req.body.status === undefined ? 'active' : req.body.status;

    if (!name) {
      return res.status(400).json({ success: false, error: 'Product name is required' });
    }
    if (!validateStatus(status)) {
      return res.status(400).json({ success: false, error: 'Invalid Product status' });
    }

    const catalogHash = catalogKeyHash(brand, name);
    const existing = await dbOperations.get(
      `SELECT ${PRODUCT_COLUMNS} FROM products WHERE catalog_key_hash = ?`,
      [catalogHash]
    );
    if (existing) {
      return res.json({ success: true, data: existing, message: 'Product already exists' });
    }

    const result = await dbOperations.run(
      `INSERT INTO products
        (brand, name, sku, category, product_url, description, selling_points, status,
         catalog_key_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        brand,
        name,
        req.body.sku ?? null,
        req.body.category ?? null,
        req.body.product_url ?? null,
        req.body.description ?? null,
        req.body.selling_points ?? null,
        status,
        catalogHash
      ]
    );
    const created = await getProduct(result.id);
    res.json({ success: true, data: created, message: 'Product created' });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      const existing = await dbOperations.get(
        `SELECT ${PRODUCT_COLUMNS} FROM products WHERE catalog_key_hash = ?`,
        [catalogKeyHash(req.body.brand, req.body.name)]
      );
      if (existing) {
        return res.json({ success: true, data: existing, message: 'Product already exists' });
      }
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const product = await getProduct(id);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    const brand = req.body.brand === undefined ? product.brand : cleanText(req.body.brand);
    const name = req.body.name === undefined ? product.name : cleanText(req.body.name);
    const status = req.body.status === undefined ? product.status : req.body.status;
    if (!name) {
      return res.status(400).json({ success: false, error: 'Product name is required' });
    }
    if (!validateStatus(status)) {
      return res.status(400).json({ success: false, error: 'Invalid Product status' });
    }

    const catalogHash = catalogKeyHash(brand, name);
    const duplicate = await dbOperations.get(
      'SELECT id FROM products WHERE catalog_key_hash = ? AND id != ?',
      [catalogHash, id]
    );
    if (duplicate) {
      return res.status(409).json({ success: false, error: 'A matching Product already exists' });
    }

    await dbOperations.run(
      `UPDATE products SET
         brand = ?, name = ?, sku = ?, category = ?, product_url = ?, description = ?,
         selling_points = ?, status = ?, catalog_key_hash = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        brand,
        name,
        req.body.sku === undefined ? product.sku : req.body.sku,
        req.body.category === undefined ? product.category : req.body.category,
        req.body.product_url === undefined ? product.product_url : req.body.product_url,
        req.body.description === undefined ? product.description : req.body.description,
        req.body.selling_points === undefined ? product.selling_points : req.body.selling_points,
        status,
        catalogHash,
        id
      ]
    );
    res.json({ success: true, data: await getProduct(id), message: 'Product updated' });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, error: 'A matching Product already exists' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/archive', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const product = await getProduct(id);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    await dbOperations.run(
      `UPDATE products
       SET status = 'archived', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [id]
    );
    res.json({ success: true, data: await getProduct(id), message: 'Product archived' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
