function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function buildInstagramReelSearchUrl(baseUrl, query) {
  const root = clean(baseUrl)
    .replace(/\/$/, '')
    .replace(/\/v[12]$/, '');
  const url = new URL(`${root}/v2/instagram/reels/search`);
  url.searchParams.set('query', clean(query));
  return url.toString();
}

function extractInstagramReels(data) {
  return Array.isArray(data?.reels) ? data.reels : [];
}

function isInstagramReelUrl(value) {
  try {
    const url = new URL(clean(value));
    const hostname = url.hostname.toLowerCase();
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (hostname === 'instagram.com' || hostname === 'www.instagram.com')
      && /^\/reel\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname);
  } catch (error) {
    return false;
  }
}

function isInstagramUsername(value) {
  return /^[a-zA-Z0-9._]{1,30}$/.test(clean(value));
}

function firstDefinedMetric(...values) {
  const value = values.find((item) => item !== undefined && item !== null && item !== '');
  return value === undefined ? '' : value;
}

function instagramReelToCandidate(reel, request) {
  const owner = reel?.owner || reel?.user || reel?.author || {};
  const username = clean(owner.username || owner.handle || reel?.username);
  const videoUrl = clean(reel?.url || reel?.video_url || reel?.post_url);
  if (!isInstagramReelUrl(videoUrl) || !isInstagramUsername(username)) return null;

  const title = clean(reel?.caption || reel?.title || reel?.description);
  const query = clean(request?.discovery?.keywords);
  return {
    platform: 'instagram',
    kol_name: clean(owner.full_name || owner.name || username),
    profile_url: `https://www.instagram.com/${username}/`,
    followers: clean(owner.follower_count || owner.followers_count || owner.followers),
    avg_views: clean(firstDefinedMetric(
      reel?.video_play_count,
      reel?.play_count,
      reel?.video_view_count,
      reel?.view_count,
      reel?.views
    )),
    email: '',
    country_region: clean(owner.country || owner.region),
    matched_keywords: query,
    matched_persona: clean(request?.strategy?.persona_config?.primary_persona),
    representative_video_url: videoUrl,
    representative_video_title: title,
    evidence_url: videoUrl,
    evidence_title: title,
    evidence_type: 'video',
    source_query: query,
    reason: `Matched Instagram Reel search: ${query}`,
    raw_data: reel
  };
}

module.exports = {
  buildInstagramReelSearchUrl,
  extractInstagramReels,
  instagramReelToCandidate
};
