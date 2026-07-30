const pick = (obj, keys) => {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

const toText = (value) => {
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) return value.filter(Boolean).join('、');
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter(Boolean).join('、');
    } catch (error) { /* 非 JSON 时按原文展示 */ }
  }
  return String(value);
};

export const normalizeCampaignProductMaterial = (campaignProduct) => {
  const product = campaignProduct?.product || campaignProduct || {};
  return {
    id: pick(campaignProduct, ['id', 'product_id']) || pick(product, ['id']),
    name: pick(product, ['product_name', 'productName', 'name']),
    sku: pick(product, ['product_sku', 'productSku', 'sku']),
    category: pick(product, ['product_category', 'productCategory', 'category']),
    price: pick(product, ['product_price', 'price']),
    currency: pick(product, ['product_currency', 'currency']),
    description: toText(pick(product, ['product_description', 'description'])),
    productUrl: pick(product, ['product_url', 'productUrl']),
    sellingPoints: toText(pick(product, ['product_selling_points', 'productSellingPoints', 'selling_points'])),
    campaignBrief: toText(pick(campaignProduct, ['campaign_brief', 'campaignBrief']))
  };
};
