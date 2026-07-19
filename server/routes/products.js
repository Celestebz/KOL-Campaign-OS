const express = require('express');
const { dbOperations } = require('../database');
const { catalogKeyHash } = require('../migrations/20260719000001-add-multi-product-campaign-relations');

const router = express.Router();

const PRODUCT_STATUSES = new Set(['active', 'archived']);
const PRODUCT_COLUMNS = `
  id, brand, name, sku, category, product_url, description, selling_points, status
`;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isString(value) {
  return typeof value === 'string';
}

function validateStatus(status) {
  return status === undefined || PRODUCT_STATUSES.has(status);
}

function parsePathId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
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
    if (!isString(req.body.name) || !req.body.name.trim()) {
      return res.status(400).json({ success: false, error: 'Product name must be a non-empty string' });
    }
    if (hasOwn(req.body, 'brand') && !isString(req.body.brand)) {
      return res.status(400).json({ success: false, error: 'Product brand must be a string' });
    }

    const brand = hasOwn(req.body, 'brand') ? req.body.brand.trim() : '';
    const name = req.body.name.trim();
    const status = req.body.status === undefined ? 'active' : req.body.status;

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
    const id = parsePathId(req.params.id);
    if (id === null) {
      return res.status(400).json({ success: false, error: 'Product id must be a positive integer' });
    }
    if (hasOwn(req.body, 'status')) {
      return res.status(400).json({ success: false, error: 'Product status can only be changed through archive' });
    }

    if (hasOwn(req.body, 'name') && (!isString(req.body.name) || !req.body.name.trim())) {
      return res.status(400).json({ success: false, error: 'Product name must be a non-empty string' });
    }
    if (hasOwn(req.body, 'brand') && !isString(req.body.brand)) {
      return res.status(400).json({ success: false, error: 'Product brand must be a string' });
    }

    const product = await getProduct(id);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    const assignments = [];
    const values = [];
    const mutableFields = ['brand', 'name', 'sku', 'category', 'product_url', 'description', 'selling_points'];

    for (const field of mutableFields) {
      if (!hasOwn(req.body, field)) continue;
      assignments.push(`${field} = ?`);
      values.push(field === 'brand' || field === 'name' ? req.body[field].trim() : req.body[field]);
    }

    if (hasOwn(req.body, 'brand') || hasOwn(req.body, 'name')) {
      const brand = hasOwn(req.body, 'brand') ? req.body.brand.trim() : product.brand;
      const name = hasOwn(req.body, 'name') ? req.body.name.trim() : product.name;
      const catalogHash = catalogKeyHash(brand, name);
      const duplicate = await dbOperations.get(
        'SELECT id FROM products WHERE catalog_key_hash = ? AND id != ?',
        [catalogHash, id]
      );
      if (duplicate) {
        return res.status(409).json({ success: false, error: 'A matching Product already exists' });
      }
      assignments.push('catalog_key_hash = ?');
      values.push(catalogHash);
    }

    if (assignments.length > 0) {
      await dbOperations.run(
        `UPDATE products SET
         ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [...values, id]
      );
    }
    const updated = await getProduct(id);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    res.json({ success: true, data: updated, message: 'Product updated' });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, error: 'A matching Product already exists' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/archive', async (req, res) => {
  try {
    const id = parsePathId(req.params.id);
    if (id === null) {
      return res.status(400).json({ success: false, error: 'Product id must be a positive integer' });
    }

    const result = await dbOperations.run(
      `UPDATE products
       SET status = 'archived', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status <> 'archived'`,
      [id]
    );
    const archived = await getProduct(id);
    if (!archived) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    if (archived.status !== 'archived') {
      return res.status(409).json({ success: false, error: 'Product archive conflicted with another update' });
    }
    res.json({
      success: true,
      data: archived,
      message: result.changes === 0 ? 'Product already archived' : 'Product archived'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
