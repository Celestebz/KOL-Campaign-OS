// ScrapeCreators YouTube 响应 → 内部结构的纯函数映射（无 HTTP，便于单测）。
// v3 映射目标：finderTasks 的 youtubeItemsToCandidates / evaluateYoutubePreflight、
// youtubeIntakeSnapshot 的快照映射可直接复用。
function clean(value) {
  return String(value ?? '').trim();
}

function buildBase(baseUrl) {
  return String(baseUrl || 'https://api.scrapecreators.com').replace(/\/+$/, '').replace(/\/v1$/, '');
}

function buildYoutubeSearchUrl(baseUrl, query, continuationToken = '') {
  const token = clean(continuationToken);
  return `${buildBase(baseUrl)}/v1/youtube/search?query=${encodeURIComponent(query)}${token ? `&continuationToken=${encodeURIComponent(token)}` : ''}`;
}

function channelIdentityParam(identity = {}) {
  if (identity.channelId) return `channelId=${encodeURIComponent(identity.channelId)}`;
  if (identity.handle) return `handle=${encodeURIComponent(identity.handle)}`;
  if (identity.url) return `url=${encodeURIComponent(identity.url)}`;
  throw new Error('ScrapeCreators channel 端点需要 channelId / handle / url 之一');
}

function buildYoutubeChannelUrl(baseUrl, identity) {
  return `${buildBase(baseUrl)}/v1/youtube/channel?${channelIdentityParam(identity)}`;
}

function buildYoutubeChannelVideosUrl(baseUrl, identity) {
  return `${buildBase(baseUrl)}/v1/youtube/channel-videos?${channelIdentityParam(identity)}&includeExtras=true`;
}

function buildYoutubeVideoUrl(baseUrl, url) {
  return `${buildBase(baseUrl)}/v1/youtube/video?url=${encodeURIComponent(url)}`;
}

function buildYoutubeCommentsUrl(baseUrl, url, continuationToken = '') {
  const token = clean(continuationToken);
  return `${buildBase(baseUrl)}/v1/youtube/video/comments?url=${encodeURIComponent(url)}${token ? `&continuationToken=${encodeURIComponent(token)}` : ''}`;
}

// SC 在 handle 缺失时返回 'channel/<channelId>' 形式；统一归一化为可用 identity。
function normalizeScHandle(rawHandle, channelId) {
  const h = clean(rawHandle).replace(/^@/, '');
  if (!h) return clean(channelId) ? { channelId: clean(channelId) } : {};
  if (/^channel\//i.test(h)) return { channelId: h.split('/')[1] || clean(channelId) };
  return { handle: h };
}

function secondsToIsoDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const body = `${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s ? `${s}S` : ''}`;
  return `PT${body || '0S'}`;
}

const GROUP_KIND = { videos: 'video', shorts: 'short', lives: 'live' };

function toV3SearchItems(data = {}) {
  const items = [];
  for (const [group, kind] of Object.entries(GROUP_KIND)) {
    for (const entry of data[group] || []) {
      if (!entry?.id || !entry?.channel?.id) continue;
      items.push({
        id: { videoId: entry.id, kind: `youtube#${kind}` },
        snippet: {
          channelId: clean(entry.channel.id),
          channelTitle: clean(entry.channel.title),
          title: clean(entry.title),
          description: clean(entry.description),
          publishedAt: clean(entry.publishedTime)
        },
        _scType: clean(entry.type) || kind
      });
    }
  }
  return items;
}

function toV3ChannelItem(data = {}) {
  return {
    id: clean(data.channelId),
    snippet: {
      title: clean(data.name),
      description: clean(data.description),
      country: clean(data.country)
    },
    statistics: {
      subscriberCount: String(Math.round(Number(data.subscriberCount) || 0)),
      videoCount: data.videoCount != null ? String(Math.round(Number(data.videoCount))) : undefined
    },
    _sc: {
      handle: clean(data.handle).replace(/^@/, ''),
      links: Array.isArray(data.links) ? data.links : [],
      email: data.email || null
    }
  };
}

function toV3VideoItems(data = {}) {
  const mapEntry = (entry, isLive) => {
    if (!entry?.id) return null;
    return {
      id: entry.id,
      snippet: {
        title: clean(entry.title),
        publishedAt: clean(entry.publishedTime),
        channelId: clean(entry.channel?.id),
        channelTitle: clean(entry.channel?.title),
        liveBroadcastContent: isLive ? 'live' : 'none'
      },
      statistics: {
        viewCount: String(Number(entry.viewCountInt) || 0),
        likeCount: entry.likeCountInt != null ? String(Number(entry.likeCountInt)) : undefined,
        commentCount: entry.commentCountInt != null ? String(Number(entry.commentCountInt)) : undefined
      },
      contentDetails: { duration: secondsToIsoDuration(entry.lengthSeconds ?? entry.lengthInSeconds) },
      _scType: clean(entry.type) || (isLive ? 'live' : 'video')
    };
  };
  return [
    ...(data.videos || []).map((e) => mapEntry(e, false)),
    ...(data.shorts || []).map((e) => mapEntry(e, false)),
    ...(data.lives || []).map((e) => mapEntry(e, true))
  ].filter(Boolean);
}

// videos.js 归一化基础结构；exposure/comments/raw 由 videos.js 补充（buildExposure 在其内部）。
function scVideoDetailToNormalized(data = {}, url = '') {
  const type = clean(data.type).toLowerCase();
  const contentType = type === 'short' || type === 'live'
    ? type
    : (/youtube\.com\/shorts\//i.test(url) ? 'short' : 'video');
  return {
    platform: 'youtube',
    platform_video_id: clean(data.id),
    kol_name: clean(data.channel?.title),
    title: clean(data.title),
    author_name: clean(data.channel?.title),
    content_type: contentType,
    published_at: clean(data.publishDate || data.publishedTime),
    metrics: {
      play_count: Number(data.viewCountInt) || 0,
      like_count: Number(data.likeCountInt) || 0,
      comment_count: Number(data.commentCountInt) || 0,
      collect_count: 0,
      share_count: null
    }
  };
}

function scCommentsToNormalized(data = {}, limit = 100) {
  return (Array.isArray(data.comments) ? data.comments : []).slice(0, limit).map((comment) => ({
    id: clean(comment.id),
    parent_id: null,
    user_name: clean(comment.author?.name),
    content: clean(comment.content),
    like_count: Number(comment.engagement?.likes) || 0,
    commented_at: clean(comment.publishedTime),
    raw: comment
  }));
}

module.exports = {
  buildYoutubeSearchUrl,
  buildYoutubeChannelUrl,
  buildYoutubeChannelVideosUrl,
  buildYoutubeVideoUrl,
  buildYoutubeCommentsUrl,
  normalizeScHandle,
  secondsToIsoDuration,
  toV3SearchItems,
  toV3ChannelItem,
  toV3VideoItems,
  scVideoDetailToNormalized,
  scCommentsToNormalized
};
