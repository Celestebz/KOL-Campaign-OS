const crypto = require('crypto');

const SUPPORTED_PLATFORMS = Object.freeze({
  YOUTUBE: 'youtube',
  INSTAGRAM: 'instagram',
  TIKTOK: 'tiktok'
});

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalizeYouTubeUrl(urlObj) {
  const hostname = urlObj.hostname.replace(/^www\./, '').toLowerCase();
  const pathname = urlObj.pathname;

  // youtu.be short link
  if (hostname === 'youtu.be') {
    const videoId = pathname.split('/').filter(Boolean)[0];
    if (!videoId) return null;
    return {
      platform: SUPPORTED_PLATFORMS.YOUTUBE,
      platformVideoId: videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
  }

  // youtube.com/shorts/VIDEO_ID
  const shortsMatch = pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})/);
  if (shortsMatch) {
    const videoId = shortsMatch[1];
    return {
      platform: SUPPORTED_PLATFORMS.YOUTUBE,
      platformVideoId: videoId,
      canonicalUrl: `https://www.youtube.com/shorts/${videoId}`
    };
  }

  // youtube.com/watch?v=VIDEO_ID
  const params = urlObj.searchParams;
  const videoId = params.get('v');
  if (videoId) {
    return {
      platform: SUPPORTED_PLATFORMS.YOUTUBE,
      platformVideoId: videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
  }

  // live / embed / other path-based id
  const embedMatch = pathname.match(/^\/(?:embed|live)\/([a-zA-Z0-9_-]{11})/);
  if (embedMatch) {
    const videoId = embedMatch[1];
    return {
      platform: SUPPORTED_PLATFORMS.YOUTUBE,
      platformVideoId: videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
  }

  return null;
}

function normalizeInstagramUrl(urlObj) {
  const pathname = urlObj.pathname;
  // /reel/SHORTCODE/ or /p/SHORTCODE/ or /reels/SHORTCODE/
  const match = pathname.match(/^\/(?:reel|reels|p)\/([a-zA-Z0-9_-]+)/);
  if (!match) return null;
  const shortcode = match[1];
  return {
    platform: SUPPORTED_PLATFORMS.INSTAGRAM,
    platformVideoId: shortcode,
    canonicalUrl: `https://www.instagram.com/p/${shortcode}/`
  };
}

function normalizeTikTokUrl(urlObj) {
  const pathname = urlObj.pathname;
  // /@username/video/VIDEO_ID
  const match = pathname.match(/^\/@[^/]+\/video\/(\d+)/);
  if (!match) return null;
  const videoId = match[1];
  return {
    platform: SUPPORTED_PLATFORMS.TIKTOK,
    platformVideoId: videoId,
    canonicalUrl: `https://www.tiktok.com${pathname.split('?')[0]}`
  };
}

function normalizeVideoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('Invalid video URL');
  }

  let trimmed = rawUrl.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    trimmed = 'https://' + trimmed;
  }

  let urlObj;
  try {
    urlObj = new URL(trimmed);
  } catch (err) {
    throw new Error(`Cannot parse video URL: ${rawUrl}`);
  }

  const hostname = urlObj.hostname.replace(/^www\./, '').toLowerCase();

  let result = null;
  if (hostname === 'youtube.com' || hostname === 'youtu.be' || hostname.endsWith('.youtube.com')) {
    result = normalizeYouTubeUrl(urlObj);
  } else if (hostname === 'instagram.com' || hostname.endsWith('.instagram.com')) {
    result = normalizeInstagramUrl(urlObj);
  } else if (hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com') || hostname === 'vm.tiktok.com') {
    // TODO: short links require HTTP HEAD fetch to resolve; currently best-effort
    result = normalizeTikTokUrl(urlObj);
  }

  if (!result) {
    // Fallback: keep original URL as canonical for unsupported platforms
    const canonicalUrl = trimmed.split('?')[0];
    return {
      platform: 'unknown',
      platformVideoId: null,
      canonicalUrl,
      canonicalUrlHash: sha256Hex(canonicalUrl)
    };
  }

  return {
    ...result,
    canonicalUrlHash: sha256Hex(result.canonicalUrl)
  };
}

function computeUrlHash(canonicalUrl) {
  return sha256Hex(canonicalUrl);
}

module.exports = {
  SUPPORTED_PLATFORMS,
  normalizeVideoUrl,
  computeUrlHash
};
