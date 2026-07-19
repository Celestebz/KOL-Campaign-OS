export function normalizeCampaign(row) {
  if (!row) return row;
  return {
    ...row,
    associatedProductCount: Number(row.associated_product_count ?? 0) || 0,
    activeProductCount: Number(row.active_product_count ?? 0) || 0
  };
}

export function normalizeCampaignProduct(row) {
  if (!row) return row;
  return {
    ...row,
    productName: row.product_name,
    productBrand: row.product_brand,
    productSku: row.product_sku,
    productCategory: row.product_category,
    productUrl: row.product_url,
    productDescription: row.product_description,
    productSellingPoints: row.product_selling_points,
    productStatus: row.product_status,
    campaignBrief: row.campaign_brief
  };
}

export const campaignProductRoleLabels = {
  hero: '主推',
  secondary: '辅推',
  test: '测试'
};

export const campaignProductStatusLabels = {
  planned: '计划中',
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  archived: '已归档'
};

export const campaignProductStatusColors = {
  planned: 'default',
  active: 'green',
  paused: 'orange',
  completed: 'blue',
  archived: 'default'
};

export function productStatusLabel(status) {
  return status === 'archived' ? '已归档' : '正常';
}
