import { parseCampaignSubtableMap, serializeCampaignSubtableRows } from './feishuSubtableMappingUtils';

const campaigns = [{ id: 7, name: 'Vivatrees EverJoy' }, { id: 9, name: 'Summer Launch' }];

test('parses current and legacy mappings while preserving unresolved entries', () => {
  expect(parseCampaignSubtableMap('{"7":"tblOne"}', campaigns)).toEqual({ rows: [{ campaign_id: 7, table_id: 'tblOne' }], unresolved: [] });
  expect(parseCampaignSubtableMap('Vivatrees EverJoy=tblLegacy', campaigns)).toEqual({ rows: [{ campaign_id: 7, table_id: 'tblLegacy' }], unresolved: [] });
  expect(parseCampaignSubtableMap('{"Unknown":"tblLost"}', campaigns)).toEqual({ rows: [], unresolved: [{ key: 'Unknown', table_id: 'tblLost' }] });
});

test('returns empty mappings for empty or malformed values', () => {
  expect(parseCampaignSubtableMap('', campaigns)).toEqual({ rows: [], unresolved: [] });
  expect(parseCampaignSubtableMap('{broken json', campaigns)).toEqual({ rows: [], unresolved: [] });
});

test('serializes complete rows by campaign id in stable order', () => {
  expect(serializeCampaignSubtableRows([{ campaign_id: 9, table_id: ' tblTwo ' }, { campaign_id: 7, table_id: 'tblOne' }])).toBe('{"7":"tblOne","9":"tblTwo"}');
  expect(serializeCampaignSubtableRows([{ campaign_id: null, table_id: 'tblSkip' }])).toBe('{}');
});
