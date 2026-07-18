function clean(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function firstDefined(...values) {
  const value = values.find((item) => item !== undefined && item !== null && item !== '');
  return clean(value);
}

function buildTikTokKeywordSearchUrl(baseUrl, query) {
  const root = clean(baseUrl).replace(/\/$/, '').replace(/\/v[123]$/, '');
  const url = new URL(`${root}/v1/tiktok/search/keyword`);
  url.searchParams.set('query', clean(query));
  return url.toString();
}

function extractTikTokVideos(data) {
  if (!Array.isArray(data?.search_item_list)) return [];
  return data.search_item_list.map((item) => item?.aweme_info).filter(Boolean);
}

function validTikTokHandle(value) {
  const handle = clean(value);
  return /^[A-Za-z0-9._]{2,24}$/.test(handle)
    && !handle.startsWith('.')
    && !handle.endsWith('.')
    && !handle.includes('..');
}

function tiktokVideoToCandidate(video, request) {
  const videoId = clean(video?.aweme_id || video?.id);
  const author = video?.author || {};
  const handle = clean(author.unique_id || author.username);
  if (!/^\d+$/.test(videoId) || !validTikTokHandle(handle)) return null;
  if (Array.isArray(video?.image_infos) && video.image_infos.length) return null;
  if (clean(video?.content_type) === 'multi_photo') return null;

  const encodedHandle = encodeURIComponent(handle);
  const videoUrl = `https://www.tiktok.com/@${encodedHandle}/video/${videoId}`;
  const profileUrl = `https://www.tiktok.com/@${encodedHandle}`;
  const title = clean(video?.desc || video?.title);
  const query = clean(request?.discovery?.keywords);
  return {
    platform: 'tiktok',
    kol_name: clean(author.nickname || author.display_name || handle),
    profile_url: profileUrl,
    followers: firstDefined(author.follower_count, author.followers),
    avg_views: firstDefined(video?.statistics?.play_count, video?.stats?.play_count, video?.play_count),
    email: '',
    country_region: clean(video?.region || author?.region),
    matched_keywords: query,
    matched_persona: clean(request?.strategy?.persona_config?.primary_persona),
    representative_video_url: videoUrl,
    representative_video_title: title,
    evidence_url: videoUrl,
    evidence_title: title,
    evidence_type: 'video',
    source_query: query,
    reason: `Matched TikTok Keyword Search: ${query}`,
    raw_data: video
  };
}

module.exports = {
  buildTikTokKeywordSearchUrl,
  extractTikTokVideos,
  tiktokVideoToCandidate
};
