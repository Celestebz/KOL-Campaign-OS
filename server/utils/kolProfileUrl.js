const crypto = require('crypto');

const RESERVED_INSTAGRAM_PATHS = new Set([
  'accounts', 'direct', 'explore', 'p', 'reel', 'reels', 'stories', 'tv'
]);

function clean(value) {
  return String(value || '').trim();
}

function withProtocol(rawUrl) {
  const value = clean(rawUrl);
  if (!value) throw new Error('链接不能为空');
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function canonicalHash(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

function parseKolProfileUrl(rawUrl) {
  let url;
  try {
    url = new URL(withProtocol(rawUrl));
  } catch (error) {
    throw new Error('链接格式无效');
  }

  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const first = segments[0] || '';
    if (first.startsWith('@') && first.length > 1) {
      const username = first.slice(1);
      return profile('youtube', username, `https://www.youtube.com/@${encodeURIComponent(username)}`);
    }
    if (['channel', 'c', 'user'].includes(first.toLowerCase()) && segments[1]) {
      const username = segments[1];
      return profile('youtube', username, `https://www.youtube.com/${first.toLowerCase()}/${encodeURIComponent(username)}`);
    }
    throw new Error('YouTube 链接中未识别到频道账号，请使用频道主页链接');
  }

  if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
    const username = segments[0] || '';
    if (!username || RESERVED_INSTAGRAM_PATHS.has(username.toLowerCase())) {
      throw new Error('Instagram 链接中未识别到账号，请使用账号主页链接');
    }
    return profile('instagram', username, `https://www.instagram.com/${encodeURIComponent(username)}/`);
  }

  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    const handle = segments.find((segment) => segment.startsWith('@') && segment.length > 1);
    if (!handle) throw new Error('TikTok 链接中未识别到账号，请使用账号主页链接');
    const username = handle.slice(1);
    return profile('tiktok', username, `https://www.tiktok.com/@${encodeURIComponent(username)}`);
  }

  throw new Error('暂不支持该平台，仅支持 YouTube、Instagram、TikTok');
}

function profile(platform, username, canonicalUrl) {
  return {
    platform,
    username,
    displayName: username,
    canonicalUrl,
    profileUrlHash: canonicalHash(canonicalUrl)
  };
}

module.exports = { parseKolProfileUrl, canonicalHash };
