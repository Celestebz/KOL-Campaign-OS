const { dbOperations } = require('../database');
const scYoutube = require('./scrapecreatorsYoutube');
const { toV3ChannelItem, toV3VideoItems } = require('../utils/scrapecreatorsYoutubeSearch');
const { getSelection, getSetting, providerKey, legacyKeysFor } = require('./aiClient');

const GOOGLE_PROVIDER = 'youtube.google_official';
const MATON_PROVIDER = 'youtube.maton_gateway';
const SNAPSHOT_VIDEO_LIMIT = 10;

function scIdentityFromLookup(lookup = {}) {
  if (lookup.id) return { channelId: lookup.id };
  if (lookup.forHandle) return { handle: lookup.forHandle };
  if (lookup.forUsername) return { handle: lookup.forUsername };
  throw new Error('ScrapeCreators 快照需要频道 ID 或 Handle（视频链接请先解析为频道）');
}

function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch (error) { return fallback; }
}

function durationSeconds(value = '') {
  const match = String(value).match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) return 0;
  return Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function isIncludedLongVideo(item = {}) {
  const seconds = durationSeconds(item.contentDetails?.duration);
  const isLive = item.snippet?.liveBroadcastContent !== 'none' || Boolean(item.liveStreamingDetails);
  const isShort = seconds > 0 && seconds <= 180;
  return !isLive && !isShort;
}

function latestLongVideoItems(items = [], limit = SNAPSHOT_VIDEO_LIMIT) {
  return [...items]
    .filter(isIncludedLongVideo)
    .sort((a, b) => new Date(b.snippet?.publishedAt || 0).getTime() - new Date(a.snippet?.publishedAt || 0).getTime())
    .slice(0, limit);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error?.message || `YouTube API HTTP ${response.status}`);
  return data;
}

async function providerConfig(provider) {
  if (provider === 'google_official') {
    const google = await getSetting(GOOGLE_PROVIDER, legacyKeysFor('youtube', provider));
    if (!google?.api_key) return null;
    return {
      provider,
      mode: 'v3',
      endpoint(path, params) { return `${String(google.base_url || 'https://www.googleapis.com').replace(/\/$/, '')}/youtube/v3/${path}?${params}&key=${encodeURIComponent(google.api_key)}`; },
      options: {}
    };
  }
  if (provider === 'maton_gateway') {
    const maton = await getSetting(MATON_PROVIDER, legacyKeysFor('youtube', provider));
    if (!maton?.api_key) return null;
    const extra = parseJson(maton.extra_config);
    const headers = { Authorization: `Bearer ${maton.api_key}` };
    if (extra.connection_id) headers['Maton-Connection'] = extra.connection_id;
    return {
      provider,
      mode: 'v3',
      endpoint(path, params) { return `${String(maton.base_url || 'https://api.maton.ai').replace(/\/$/, '')}/youtube/youtube/v3/${path}?${params}`; },
      options: { headers }
    };
  }
  if (provider === 'scrapecreators') {
    const scSetting = await scYoutube.getYoutubeScrapeCreatorsSetting();
    return scSetting?.api_key ? { provider, mode: 'scrapecreators', setting: scSetting } : null;
  }
  return null;
}

async function youtubeConfigs() {
  const selection = await getSelection();
  const providers = youtubeProviderOrder(selection);
  const configs = [];
  const missing = [];
  for (const provider of providers) {
    const config = await providerConfig(provider);
    if (config) configs.push(config);
    else missing.push(provider);
  }
  if (!configs.length) throw new Error(`YouTube 数据源未配置：${missing.join('、') || '无可用 Provider'}`);
  return configs;
}

function youtubeProviderOrder(selection = {}) {
  const youtube = selection.platforms?.youtube || {};
  const order = [youtube.primary];
  if (selection.fallbackStrategy?.enableFallback) order.push(...(youtube.fallbacks || []));
  return [...new Set(order.filter(Boolean))];
}

function hasInteractionStats(items = []) {
  return items.some((item) => item.statistics?.likeCount !== undefined || item.statistics?.commentCount !== undefined);
}

function channelLookup(profileUrl) {
  const text = String(profileUrl || '').trim();
  const videoId = text.match(/[?&]v=([^&#]+)/i)?.[1] || text.match(/youtu\.be\/([^/?#]+)/i)?.[1];
  if (videoId) return { videoId };
  const channel = text.match(/youtube\.com\/channel\/([^/?#]+)/i)?.[1];
  if (channel) return { id: channel };
  const handle = text.match(/youtube\.com\/@([^/?#]+)/i)?.[1];
  if (handle) return { forHandle: handle };
  const username = text.match(/youtube\.com\/user\/([^/?#]+)/i)?.[1];
  if (username) return { forUsername: username };
  throw new Error('无法从 YouTube 主页链接识别频道 ID 或 Handle');
}

async function runYoutubeIntakeSnapshot(customerId) {
  const customer = await dbOperations.get('SELECT * FROM customers WHERE id = ?', [customerId]);
  if (!customer) throw new Error('KOL 不存在');
  const account = await dbOperations.get(
    "SELECT * FROM kol_platform_accounts WHERE customer_id = ? AND LOWER(platform) = 'youtube' ORDER BY id LIMIT 1",
    [customerId]
  );
  const profileUrl = account?.profile_url || customer.youtube_url;
  if (!profileUrl) throw new Error('KOL 没有 YouTube 主页链接');

  await dbOperations.run(
    "UPDATE customers SET youtube_snapshot_status = 'fetching', youtube_snapshot_error = NULL WHERE id = ?",
    [customerId]
  );

  try {
    const configs = await youtubeConfigs();
    let channel;
    let videoItems;
    let usedProvider = '';
    const attempts = [];
    for (let sourceIndex = 0; sourceIndex < configs.length; sourceIndex += 1) {
      const config = configs[sourceIndex];
      try {
        if (config.mode === 'scrapecreators') {
      let lookup = channelLookup(profileUrl);
      if (lookup.videoId) {
        const videoData = await scYoutube.video(config.setting, profileUrl);
        const channelId = videoData.channel?.id;
        if (!channelId) throw new Error('无法从 YouTube 视频链接识别所属频道');
        lookup = { id: channelId };
      }
      const identity = scIdentityFromLookup(lookup);
      const channelData = await scYoutube.channel(config.setting, identity);
      channel = toV3ChannelItem(channelData);
      if (!channel.id) throw new Error('YouTube 未找到对应频道');
      // SC channel-videos 单页 30 条；继续翻页，直到收集到最近 10 条长视频。
      const scItems = [];
      let continuationToken = '';
      for (let page = 0; page < 3; page += 1) {
        const data = await scYoutube.channelVideos(config.setting, identity, continuationToken);
        const pageItems = toV3VideoItems(data);
        scItems.push(...pageItems);
        continuationToken = String(data.continuationToken || '').trim();
        if (latestLongVideoItems(scItems).length >= SNAPSHOT_VIDEO_LIMIT || !continuationToken || !pageItems.length) break;
      }
          videoItems = latestLongVideoItems(scItems);
        } else {
      let lookup = channelLookup(profileUrl);
      if (lookup.videoId) {
        const videoData = await fetchJson(
          config.endpoint('videos', `part=snippet&id=${encodeURIComponent(lookup.videoId)}`),
          config.options
        );
        const channelId = videoData.items?.[0]?.snippet?.channelId;
        if (!channelId) throw new Error('无法从 YouTube 视频链接识别所属频道');
        lookup = { id: channelId };
      }
      const lookupParam = Object.entries(lookup).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
      const channelData = await fetchJson(config.endpoint('channels', `part=contentDetails,statistics&${lookupParam}`), config.options);
      channel = channelData.items?.[0];
      if (!channel) throw new Error('YouTube 未找到对应频道');
      const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) throw new Error('YouTube 频道没有 uploads 播放列表');

      // Maton / Google v3：逐页补齐详情，直到得到最近 10 条长视频。
      videoItems = [];
      let pageToken = '';
      for (let page = 0; page < 10; page += 1) {
        const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
        const playlistData = await fetchJson(
          config.endpoint('playlistItems', `part=snippet,contentDetails&playlistId=${encodeURIComponent(uploads)}&maxResults=50${tokenParam}`),
          config.options
        );
        const items = playlistData.items || [];
        const ids = items.map((item) => item.contentDetails?.videoId).filter(Boolean);
        if (ids.length) {
          const details = await fetchJson(
            config.endpoint('videos', `part=snippet,statistics,contentDetails,liveStreamingDetails&id=${encodeURIComponent(ids.join(','))}`),
            config.options
          );
          videoItems.push(...(details.items || []));
        }
        pageToken = playlistData.nextPageToken || '';
        if (latestLongVideoItems(videoItems).length >= SNAPSHOT_VIDEO_LIMIT || !pageToken || !items.length) break;
      }
          videoItems = latestLongVideoItems(videoItems);
        }
        if (!hasInteractionStats(videoItems) && sourceIndex < configs.length - 1) {
          throw new Error('返回的视频缺少点赞和评论统计');
        }
        usedProvider = config.provider;
        break;
      } catch (error) {
        attempts.push(`${config.provider}: ${error.message}`);
        channel = null;
        videoItems = null;
        if (sourceIndex === configs.length - 1) throw new Error(attempts.join('；'));
      }
    }
    const videosData = { items: videoItems };
    const snapshotAt = new Date();
    const videos = (videosData.items || []).map((item) => {
      const seconds = durationSeconds(item.contentDetails?.duration);
      const isLive = item.snippet?.liveBroadcastContent !== 'none' || Boolean(item.liveStreamingDetails);
      const isShort = seconds > 0 && seconds <= 180;
      return {
        id: item.id, title: item.snippet?.title || '', publishedAt: item.snippet?.publishedAt ? new Date(item.snippet.publishedAt) : null,
        seconds, views: Number(item.statistics?.viewCount || 0), likes: Number(item.statistics?.likeCount || 0),
        comments: Number(item.statistics?.commentCount || 0), isLive, isShort,
        included: !isLive && !isShort,
        exclusion: isLive ? 'live_or_replay' : isShort ? 'short_or_under_180_seconds' : null
      };
    });

    await dbOperations.run('DELETE FROM kol_youtube_snapshot_videos WHERE customer_id = ?', [customerId]);
    for (const video of videos) {
      await dbOperations.run(
        `INSERT INTO kol_youtube_snapshot_videos
         (customer_id, youtube_video_id, title, video_url, published_at, duration_seconds, play_count, like_count, comment_count,
          is_short, is_live, included_in_aggregate, exclusion_reason, snapshot_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [customerId, video.id, video.title, `https://www.youtube.com/watch?v=${video.id}`, video.publishedAt || null,
          video.seconds, video.views, video.likes, video.comments, video.isShort, video.isLive, video.included, video.exclusion, snapshotAt]
      );
    }
    const included = videos.filter((video) => video.included);
    const views = included.map((video) => video.views);
    const totalViews = views.reduce((sum, value) => sum + value, 0);
    const totalEngagement = included.reduce((sum, video) => sum + video.likes + video.comments, 0);
    const aggregate = {
      posts: included.length,
      averageViews: included.length ? Math.round(totalViews / included.length) : null,
      medianViews: median(views),
      engagementRate: totalViews > 0 ? totalEngagement / totalViews : null
    };
    const followers = Number(channel.statistics?.subscriberCount || 0) || null;
    await dbOperations.run(
      `UPDATE customers SET youtube_avg_views_30d = ?, youtube_median_views_30d = ?, youtube_posts_30d = ?,
       youtube_engagement_rate_30d = ?, youtube_snapshot_status = 'success', youtube_snapshot_error = NULL,
       youtube_snapshot_updated_at = ?, youtube_followers = COALESCE(?, youtube_followers), sync_status = 'sync_pending'
       WHERE id = ?`,
      [aggregate.averageViews, aggregate.medianViews, aggregate.posts, aggregate.engagementRate, snapshotAt, followers, customerId]
    );
    await dbOperations.run(
      `UPDATE campaign_kols
       SET avg_views_30d_snapshot = ?, median_views_30d_snapshot = ?, posts_30d_snapshot = ?,
           engagement_rate_30d_snapshot = ?, youtube_snapshot_updated_at = ?,
           sync_status = 'sync_pending', updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = ? AND project_status IN ('candidate', 'pending_confirmation')`,
      [aggregate.averageViews, aggregate.medianViews, aggregate.posts, aggregate.engagementRate, snapshotAt, customerId]
    );
    if (account && followers !== null) {
      await dbOperations.run('UPDATE kol_platform_accounts SET followers_count = ?, followers_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [followers, String(followers), account.id]);
    }
    return { customerId, profileUrl, followers, provider: usedProvider, fetched: videos.length, excluded: videos.length - included.length, ...aggregate, updatedAt: snapshotAt };
  } catch (error) {
    await dbOperations.run(
      "UPDATE customers SET youtube_snapshot_status = 'failed', youtube_snapshot_error = ?, youtube_snapshot_updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [error.message, customerId]
    );
    throw error;
  }
}

module.exports = { runYoutubeIntakeSnapshot, durationSeconds, median, scIdentityFromLookup, latestLongVideoItems, hasInteractionStats, youtubeProviderOrder };
