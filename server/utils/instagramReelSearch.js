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
    return /(^|\.)instagram\.com$/i.test(url.hostname) && /^\/reel\/[^/]+/i.test(url.pathname);
  } catch (error) {
    return false;
  }
}

function instagramReelToCandidate(reel, request) {
  const owner = reel?.owner || reel?.user || reel?.author || {};
  const username = clean(owner.username || owner.handle || reel?.username);
  const videoUrl = clean(reel?.url || reel?.video_url || reel?.post_url);
  if (!isInstagramReelUrl(videoUrl) || !username) return null;

  const title = clean(reel?.caption || reel?.title || reel?.description);
  const query = clean(request?.discovery?.keywords);
  return {
    platform: 'instagram',
    kol_name: clean(owner.full_name || owner.name || username),
    profile_url: `https://www.instagram.com/${username}/`,
    followers: clean(owner.follower_count || owner.followers_count || owner.followers),
    avg_views: clean(reel?.play_count || reel?.view_count || reel?.views),
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
