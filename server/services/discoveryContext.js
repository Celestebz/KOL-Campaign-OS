const productContextSql = `SELECT c.id AS campaign_id, c.name AS campaign_name,
  cp.id AS campaign_product_id, cp.product_id, cp.role, cp.priority, cp.campaign_brief,
  cp.status AS campaign_product_status, p.brand AS product_brand, p.name AS product_name,
  p.sku AS product_sku, p.category AS product_category, p.product_url,
  p.price AS product_price, p.currency AS product_currency, p.description AS product_description,
  p.selling_points AS product_selling_points, p.status AS product_status
  FROM campaigns c JOIN campaign_products cp ON cp.campaign_id = c.id
  JOIN products p ON p.id = cp.product_id
  WHERE c.id = ? AND cp.id = ? AND c.status = 'active' AND cp.status = 'active' AND p.status = 'active'`;

function buildDiscoveryContext(product, requirements) {
  return { ...product, id: null, name: `${product.campaign_name} / ${product.product_name}`,
    brand: product.product_brand, product: product.product_name, category: product.product_category,
    requirements, campaign_goal: requirements, secondary_platforms: [],
    product_context: { requirements, product_description: product.product_description },
    persona_config: {}, scoring_weights: {}, finder_handoff: { requirements } };
}

async function getTaskDiscoveryContext(task, transaction) {
  const { sequelize, Sequelize } = require('../database');
  const query = (sql, replacements) => sequelize.query(sql, { replacements, transaction, type: Sequelize.QueryTypes.SELECT, logging: false });
  const [request] = await query('SELECT * FROM discovery_requests WHERE finder_task_id = ? AND campaign_id = ? AND campaign_product_id = ?',
    [task.id, task.campaign_id, task.campaign_product_id]);
  if (!request) throw Object.assign(new Error('Finder task has no matching discovery request'), { status: 409 });
  const [product] = await query(productContextSql, [request.campaign_id, request.campaign_product_id]);
  if (!product) throw Object.assign(new Error('Project or product is no longer active'), { status: 409 });
  let snapshot;
  try { snapshot = JSON.parse(request.context_json || 'null'); } catch { snapshot = null; }
  return buildDiscoveryContext(snapshot || product, request.requirements);
}
module.exports = { productContextSql, buildDiscoveryContext, getTaskDiscoveryContext };
