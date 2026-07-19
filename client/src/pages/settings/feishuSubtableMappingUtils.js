const emptyResult = () => ({ rows: [], unresolved: [] });

const toEntries = (value) => {
  if (!value) return [];
  if (typeof value === 'object' && !Array.isArray(value)) return Object.entries(value);
  const text = String(value).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.entries(parsed) : [];
  } catch (error) {
    return text.split(/\r?\n|,/).flatMap((line) => {
      const separator = line.indexOf('=');
      return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
    });
  }
};

export const parseCampaignSubtableMap = (value, campaigns = []) => {
  const byId = new Map(campaigns.map((campaign) => [Number(campaign.id), campaign]));
  const byName = new Map(campaigns.map((campaign) => [String(campaign.name), campaign]));
  return toEntries(value).reduce((result, [rawKey, rawTableId]) => {
    const key = String(rawKey ?? '').trim();
    const tableId = String(rawTableId ?? '').trim();
    if (!key || !tableId) return result;
    const numericKey = /^[1-9]\d*$/.test(key) ? Number(key) : null;
    const campaign = numericKey !== null ? byId.get(numericKey) : byName.get(key);
    if (campaign) result.rows.push({ campaign_id: Number(campaign.id), table_id: tableId });
    else result.unresolved.push({ key, table_id: tableId });
    return result;
  }, emptyResult());
};

export const serializeCampaignSubtableRows = (rows = []) => JSON.stringify(Object.fromEntries(
  rows.flatMap((row) => {
    const campaignId = Number(row?.campaign_id);
    const tableId = String(row?.table_id ?? '').trim();
    return Number.isSafeInteger(campaignId) && campaignId > 0 && tableId ? [[campaignId, tableId]] : [];
  }).sort(([left], [right]) => left - right).map(([campaignId, tableId]) => [String(campaignId), tableId])
));
