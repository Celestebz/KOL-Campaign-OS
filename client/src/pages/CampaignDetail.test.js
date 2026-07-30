import { normalizeCampaignProductMaterial } from './campaignProductMaterial';

test('项目资料读取接口返回的嵌套产品结构', () => {
  expect(normalizeCampaignProductMaterial({
    id: 9,
    campaign_brief: '本项目主推产品',
    product: {
      id: 3,
      name: 'Flail Mower',
      sku: 'TMB-1404',
      category: 'Mower',
      price: '1599.00',
      currency: 'USD',
      description: '重型割草机',
      selling_points: '["耐用","高效率"]',
      product_url: 'https://example.com/product'
    }
  })).toEqual({
    id: 9,
    name: 'Flail Mower',
    sku: 'TMB-1404',
    category: 'Mower',
    price: '1599.00',
    currency: 'USD',
    description: '重型割草机',
    productUrl: 'https://example.com/product',
    sellingPoints: '耐用、高效率',
    campaignBrief: '本项目主推产品'
  });
});
