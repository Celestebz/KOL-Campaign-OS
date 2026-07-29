export const CAMPAIGN_PROGRESS_CHANGED = 'kol-os:campaign-progress-changed';
const STORAGE_KEY = 'kol-os:campaign-progress-version';

export function notifyCampaignProgressChanged(campaignIds = []) {
  const ids = [...new Set((Array.isArray(campaignIds) ? campaignIds : [campaignIds])
    .map((id) => Number(id))
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  const detail = { campaignIds: ids, at: Date.now() };
  window.dispatchEvent(new CustomEvent(CAMPAIGN_PROGRESS_CHANGED, { detail }));
  // localStorage 让其他同源标签页也能收到；当前标签页由 CustomEvent 立即处理。
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(detail));
}

export function subscribeCampaignProgressChanged(listener) {
  const handleCustom = (event) => listener(event.detail || { campaignIds: [] });
  const handleStorage = (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try { listener(JSON.parse(event.newValue)); } catch { listener({ campaignIds: [] }); }
  };
  window.addEventListener(CAMPAIGN_PROGRESS_CHANGED, handleCustom);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(CAMPAIGN_PROGRESS_CHANGED, handleCustom);
    window.removeEventListener('storage', handleStorage);
  };
}
