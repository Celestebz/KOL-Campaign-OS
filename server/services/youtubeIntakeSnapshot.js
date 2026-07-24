const { dbOperations } = require('../database');

const GOOGLE_PROVIDER = 'youtube.google_official';
const MATON_PROVIDER = 'youtube.maton_gateway';

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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error?.message || `YouTube API HTTP ${response.status}`);
  return data;
}

async function youtubeConfig() {
  const google = await dbOperations.get('SELECT api_key, base_url, extra_config FROM api_settings WHERE provider = ?', [GOOGLE_PROVIDER]);
  if (google?.api_key) {
    return {
      endpoint(path, params) { return `${String(google.base_url || 'https://www.googleapis.com').replace(/\/$/, '')}/youtube/v3/${path}?${params}&key=${encodeURIComponent(google.api_key)}`; },
      options: {}
    };
  }
  const maton = await dbOperations.get('SELECT api_key, base_url, extra_config FROM api_settings WHERE provider = ?', [MATON_PROVIDER]);
  if (!maton?.api_key) throw new Error('Google Official YouTube API Key 或 Maton Gateway 未配置');
  const extra = parseJson(maton.extra_config);
  const headers = { Authorization: `Bearer ${maton.api_key}` };
  if (extra.connection_id) headers['Maton-Connection'] = extra.connection_id;
  return {
    endpoint(path, params) { return `${String(maton.base_url || 'https://api.maton.ai').replace(/\/$/, '')}/youtube/youtube/v3/${path}?${params}`; },
    options: { headers }
  };
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
    const config = await youtubeConfig();
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
    const channel = channelData.items?.[0];
    if (!channel) throw new Error('YouTube 未找到对应频道');
    const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) throw new Error('YouTube 频道没有 uploads 播放列表');

    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const playlistItems = [];
    let pageToken = '';
    for (let page = 0; page < 10; page += 1) {
      const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const playlistData = await fetchJson(
        config.endpoint('playlistItems', `part=snippet,contentDetails&playlistId=${encodeURIComponent(uploads)}&maxResults=50${tokenParam}`),
        config.options
      );
      const items = playlistData.items || [];
      playlistItems.push(...items);
      const reachedCutoff = items.some((item) => {
        const publishedAt = item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt;
        return publishedAt && new Date(publishedAt).getTime() < cutoff;
      });
      pageToken = playlistData.nextPageToken || '';
      if (reachedCutoff || !pageToken) break;
    }
    const recent = playlistItems.filter((item) => new Date(item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt).getTime() >= cutoff);
    const ids = recent.map((item) => item.contentDetails?.videoId).filter(Boolean);
    // videos.list accepts at most 50 ids per call; chunk to avoid invalidFilters on busy channels.
    const videoItems = [];
    for (let offset = 0; offset < ids.length; offset += 50) {
      const chunk = ids.slice(offset, offset + 50);
      const chunkData = await fetchJson(
        config.endpoint('videos', `part=snippet,statistics,contentDetails,liveStreamingDetails&id=${encodeURIComponent(chunk.join(','))}`),
        config.options
      );
      videoItems.push(...(chunkData.items || []));
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
    if (account && followers) {
      await dbOperations.run('UPDATE kol_platform_accounts SET followers_count = ?, followers_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [followers, String(followers), account.id]);
    }
    return { customerId, profileUrl, followers, fetched: videos.length, excluded: videos.length - included.length, ...aggregate, updatedAt: snapshotAt };
  } catch (error) {
    await dbOperations.run(
      "UPDATE customers SET youtube_snapshot_status = 'failed', youtube_snapshot_error = ?, youtube_snapshot_updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [error.message, customerId]
    );
    throw error;
  }
}

module.exports = { runYoutubeIntakeSnapshot, durationSeconds, median };
