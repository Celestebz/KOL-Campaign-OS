// ScrapeCreators YouTube HTTP 服务层：配置解析 + 超时/重试 + 端点封装。
// 纯映射见 utils/scrapecreatorsYoutubeSearch.js。
const { getSetting, providerKey, legacyKeysFor } = require('./aiClient');
const {
  buildYoutubeSearchUrl,
  buildYoutubeChannelUrl,
  buildYoutubeChannelVideosUrl,
  buildYoutubeVideoUrl,
  buildYoutubeCommentsUrl
} = require('../utils/scrapecreatorsYoutubeSearch');

const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;

// key 读取顺序：youtube.scrapecreators → legacy scrapecreators → instagram/tiktok 共享 key
async function getYoutubeScrapeCreatorsSetting() {
  const direct = await getSetting(providerKey('youtube', 'scrapecreators'), legacyKeysFor('youtube', 'scrapecreators'));
  if (direct?.api_key) return direct;
  for (const scope of ['instagram', 'tiktok']) {
    const shared = await getSetting(providerKey(scope, 'scrapecreators'), legacyKeysFor(scope, 'scrapecreators'));
    if (shared?.api_key) return shared;
  }
  return direct || null;
}

async function fetchScJson(url, setting) {
  if (!setting?.api_key) {
    throw new Error('ScrapeCreators API Key 未配置（youtube/instagram/tiktok.scrapecreators 均无可用 key）');
  }
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'x-api-key': setting.api_key }, signal: ctrl.signal });
      const data = await res.json().catch(() => ({}));
      if (res.status === 402) throw Object.assign(new Error('ScrapeCreators 额度耗尽（402），请充值后重试'), { noRetry: true });
      if (res.status === 401) throw Object.assign(new Error('ScrapeCreators API Key 无效或未配置（401）'), { noRetry: true });
      if (!res.ok && !(res.status >= 200 && res.status < 300)) throw new Error(`ScrapeCreators HTTP ${res.status}${data.message || data.error ? `: ${data.message || data.error}` : ''}`);
      return data;
    } catch (error) {
      lastError = error;
      if (error.noRetry || attempt >= MAX_RETRIES) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * 4 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError?.name === 'AbortError') throw new Error('ScrapeCreators 请求超时（30s）');
  throw lastError;
}

async function search(setting, query, continuationToken = '') {
  return fetchScJson(buildYoutubeSearchUrl(setting.base_url, query, continuationToken), setting);
}

async function channel(setting, identity) {
  return fetchScJson(buildYoutubeChannelUrl(setting.base_url, identity), setting);
}

async function channelVideos(setting, identity) {
  return fetchScJson(buildYoutubeChannelVideosUrl(setting.base_url, identity), setting);
}

async function video(setting, url) {
  return fetchScJson(buildYoutubeVideoUrl(setting.base_url, url), setting);
}

async function videoComments(setting, url, continuationToken = '') {
  return fetchScJson(buildYoutubeCommentsUrl(setting.base_url, url, continuationToken), setting);
}

module.exports = {
  REQUEST_TIMEOUT_MS,
  getYoutubeScrapeCreatorsSetting,
  fetchScJson,
  search,
  channel,
  channelVideos,
  video,
  videoComments
};
