import {
  normalizeCampaign,
  normalizeCampaignProduct,
  campaignProductRoleLabels,
  campaignProductStatusLabels,
  productStatusLabel
} from './productCampaignContract';

test('normalizeCampaign converts string counts to numbers', () => {
  expect(normalizeCampaign({ associated_product_count: '4', active_product_count: '2' }))
    .toMatchObject({ associatedProductCount: 4, activeProductCount: 2 });
});

test('normalizeCampaign defaults missing counts to zero', () => {
  expect(normalizeCampaign({ id: 1, name: 'Test' }))
    .toMatchObject({ associatedProductCount: 0, activeProductCount: 0 });
});

test('normalizeCampaignProduct maps snake_case product fields', () => {
  expect(normalizeCampaignProduct({ status: 'active', product_name: 'Everglow' }))
    .toMatchObject({ status: 'active', productName: 'Everglow' });
});

test('labels cover expected values', () => {
  expect(campaignProductRoleLabels.hero).toBe('主推');
  expect(campaignProductStatusLabels.active).toBe('进行中');
  expect(productStatusLabel('active')).toBe('正常');
  expect(productStatusLabel('archived')).toBe('已归档');
});
