const { dbOperations } = require('../database');
const { getSetting, getSelection, providerKey, legacyKeysFor } = require('./aiClient');
const brightdata = require('./brightdataClient');

const LIMIT = 10;

function clean(value) { return String(value ?? '').trim(); }
function number(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function publishedAtDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}
function aggregateSocialVideos(videos) {
  const videosWithViews = videos.filter((video) => video.views !== null);
  const views = videosWithViews.map((video) => video.views);
  const totalViews = views.reduce((sum, value) => sum + value, 0);
  const totalEngagement = videosWithViews.reduce((sum, video) => sum + video.likes + video.comments, 0);
  return {
    posts: videos.length,
    averageViews: views.length ? Math.round(totalViews / views.length) : null,
    medianViews: median(views),
    engagementRate: totalViews ? totalEngagement / totalViews : null
  };
}
function profileHandle(platform, value) {
  const text = clean(value).split(String.fromCharCode(92)).join('');
  let handle = text;
  try {
    const parsed = new URL(text.startsWith('http') ? text : 'https://' + text);
    handle = parsed.pathname.split('/').filter(Boolean)[0] || text;
  } catch (_) {}
  handle = handle.replace(/^@/, '').split('/')[0].split('?')[0].split('#')[0];
  if (!/^[A-Za-z0-9._]{2,64}$/.test(handle)) throw new Error('无法识别' + platform + '主页账号');
  return handle;
}
async function setting(platform) {
  const result = await getSetting(providerKey(platform, 'scrapecreators'), legacyKeysFor(platform, 'scrapecreators'));
  if (!result?.api_key) throw new Error(platform + ' ScrapeCreators API Key 未配置');
  return result;
}
async function fetchJson(url, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { headers: { 'x-api-key': config.api_key }, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (response.status === 402) throw new Error('ScrapeCreators 额度耗尽（402），请充值后重试');
    if (!response.ok) throw new Error('ScrapeCreators HTTP ' + response.status + ': ' + (body.message || body.error || 'request failed'));
    return body;
  } finally { clearTimeout(timer); }
}
function instagramVideo(item, handle) {
  const media = item.media || item;
  const id = clean(media.code || media.shortcode || media.pk || media.id);
  const isVideo = media.media_type === 2 || media.product_type === 'clips' || Array.isArray(media.video_versions);
  if (!id || !isVideo) return null;
  return {
    id, title: clean(media.caption?.text || media.caption || media.accessibility_caption),
    url: 'https://www.instagram.com/reel/' + id + '/',
    publishedAt: media.created_at || (media.taken_at ? new Date(number(media.taken_at) * 1000).toISOString() : null),
    views: optionalNumber(media.play_count ?? media.video_play_count ?? media.view_count),
    likes: number(media.like_count), comments: number(media.comment_count), handle
  };
}
function tiktokVideo(item, handle) {
  if (!item?.aweme_id || item.content_type === 'multi_photo' || (Array.isArray(item.image_infos) && item.image_infos.length)) return null;
  return {
    id: clean(item.aweme_id), title: clean(item.desc),
    url: 'https://www.tiktok.com/@' + encodeURIComponent(handle) + '/video/' + item.aweme_id,
    publishedAt: item.create_time ? new Date(number(item.create_time) * 1000).toISOString() : null,
    views: number(item.statistics?.play_count), likes: number(item.statistics?.digg_count),
    comments: number(item.statistics?.comment_count), handle
  };
}
function instagramFollowers(data = {}) {
  const user = data.data?.user || data.user || {};
  const value = user.edge_followed_by?.count ?? user.follower_count ?? user.followers_count ?? user.followers;
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
async function fetchInstagram(config, handle) {
  const base = clean(config.base_url || 'https://api.scrapecreators.com').replace(/\/+$/, '').replace(/\/v[12]$/, '');
  const profileUrl = new URL(base + '/v1/instagram/profile');
  profileUrl.searchParams.set('handle', handle);
  profileUrl.searchParams.set('trim', 'true');
  const profile = await fetchJson(profileUrl.toString(), config);
  const videos = [];
  const pinned = new Set();
  let cursor = '';
  const followers = instagramFollowers(profile);
  for (let page = 0; page < 5 && videos.length < LIMIT; page += 1) {
    const url = new URL(base + '/v2/instagram/user/posts');
    url.searchParams.set('handle', handle);
    url.searchParams.set('trim', 'true');
    if (cursor) url.searchParams.set('next_max_id', cursor);
    const data = await fetchJson(url.toString(), config);
    for (const id of data.pinned_profile_grid_items_ids || []) pinned.add(String(id));
    videos.push(...(data.items || []).map((item) => instagramVideo(item, handle)).filter(Boolean));
    const next = clean(data.next_max_id || data.nextMaxId);
    if (!next || next === cursor || !(data.items || []).length) break;
    cursor = next;
  }
  return { videos: videos.filter((item) => !pinned.has(item.id)), followers };
}
async function fetchTikTok(config, handle) {
  const base = clean(config.base_url || 'https://api.scrapecreators.com').replace(/\/+$/, '').replace(/\/v[123]$/, '');
  const videos = [];
  let cursor = '';
  let followers = null;
  for (let page = 0; page < 5 && videos.length < LIMIT; page += 1) {
    const url = new URL(base + '/v3/tiktok/profile/videos');
    url.searchParams.set('handle', handle);
    if (cursor) url.searchParams.set('max_cursor', cursor);
    const data = await fetchJson(url.toString(), config);
    const items = data.aweme_list || [];
    followers ||= number(items[0]?.author?.follower_count) || null;
    videos.push(...items.map((item) => tiktokVideo(item, handle)).filter(Boolean));
    const next = clean(data.max_cursor);
    if (!data.has_more || !next || next === cursor || !items.length) break;
    cursor = next;
  }
  return { videos, followers };
}

// Bright Data 采集：资料 + 主页近况视频（discover 类数据集需在设置里填 dataset_id）。
async function fetchInstagramBrightData(config, profileUrl) {
  const result = await brightdata.fetchInstagramProfileVideos(config, profileUrl, LIMIT);
  return { videos: result.videos, followers: result.followers };
}

async function fetchTikTokBrightData(config, profileUrl) {
  const result = await brightdata.fetchTikTokProfileVideos(config, profileUrl, LIMIT);
  return { videos: result.videos, followers: result.followers };
}

// 平台数据源顺序：主源优先（缺省 scrapecreators）；开启 Fallback 时追加备用源。
function socialProviderOrder(selection, platform) {
  const config = selection.platforms?.[platform] || {};
  const order = [config.primary || 'scrapecreators'];
  if (selection.fallbackStrategy?.enableFallback) order.push(...(config.fallbacks || []));
  return [...new Set(order.filter(Boolean))];
}

async function fetchPlatformVideos(platform, profileUrl, handle) {
  const selection = await getSelection();
  const order = socialProviderOrder(selection, platform);
  const attempts = [];
  for (const provider of order) {
    try {
      if (provider === 'scrapecreators') {
        const config = await setting(platform);
        return platform === 'instagram'
          ? await fetchInstagram(config, handle)
          : await fetchTikTok(config, handle);
      }
      if (provider === 'brightdata') {
        const config = await brightdata.getBrightDataSetting(platform);
        return platform === 'instagram'
          ? await fetchInstagramBrightData(config, profileUrl)
          : await fetchTikTokBrightData(config, profileUrl);
      }
    } catch (error) {
      attempts.push(`${provider}: ${error.message}`);
    }
  }
  if (attempts.length) throw new Error(attempts.join('；'));
  throw new Error('没有可用的 ' + platform + ' 数据源 Provider');
}
async function runSocialIntakeSnapshot(customerId, platform) {
  if (!['instagram', 'tiktok'].includes(platform)) throw new Error('仅支持 Instagram 或 TikTok');
  const customer = await dbOperations.get('SELECT * FROM customers WHERE id = ?', [customerId]);
  if (!customer) throw new Error('KOL 不存在');
  const account = await dbOperations.get('SELECT * FROM kol_platform_accounts WHERE customer_id = ? AND LOWER(platform) = ? ORDER BY id LIMIT 1', [customerId, platform]);
  const profileUrl = account?.profile_url || customer[platform + '_url'];
  if (!profileUrl) throw new Error('KOL 没有 ' + platform + ' 主页链接');
  await dbOperations.run('UPDATE customers SET ' + platform + "_snapshot_status = 'fetching', " + platform + '_snapshot_error = NULL WHERE id = ?', [customerId]);
  try {
    const handle = profileHandle(platform, profileUrl);
    const fetched = await fetchPlatformVideos(platform, profileUrl, handle);
    const videos = fetched.videos.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)).slice(0, LIMIT);
    const snapshotAt = new Date();
    const aggregate = aggregateSocialVideos(videos);
    await dbOperations.run('DELETE FROM kol_social_snapshot_videos WHERE customer_id = ? AND platform = ?', [customerId, platform]);
    for (const video of videos) {
      await dbOperations.run('INSERT INTO kol_social_snapshot_videos (customer_id, platform, platform_video_id, title, video_url, published_at, play_count, like_count, comment_count, snapshot_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)', [customerId, platform, video.id, video.title, video.url, publishedAtDate(video.publishedAt), video.views, video.likes, video.comments, snapshotAt]);
    }
    await dbOperations.run('UPDATE customers SET ' + platform + '_avg_views_10 = ?, ' + platform + '_median_views_10 = ?, ' + platform + '_posts_10 = ?, ' + platform + "_engagement_rate_10 = ?, " + platform + "_snapshot_status = 'success', " + platform + '_snapshot_error = NULL, ' + platform + '_snapshot_updated_at = ?, ' + platform + '_followers = COALESCE(?, ' + platform + "_followers), sync_status = 'sync_pending' WHERE id = ?", [aggregate.averageViews, aggregate.medianViews, aggregate.posts, aggregate.engagementRate, snapshotAt, fetched.followers, customerId]);
    if (account && fetched.followers !== null) {
      await dbOperations.run(
        'UPDATE kol_platform_accounts SET followers_count = ?, followers_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [fetched.followers, String(fetched.followers), account.id]
      );
    }
    return { customerId, platform, profileUrl, followers: fetched.followers, videos, ...aggregate, updatedAt: snapshotAt };
  } catch (error) {
    await dbOperations.run('UPDATE customers SET ' + platform + "_snapshot_status = 'failed', " + platform + '_snapshot_error = ?, ' + platform + '_snapshot_updated_at = CURRENT_TIMESTAMP WHERE id = ?', [error.message, customerId]);
    throw error;
  }
}

module.exports = { LIMIT, median, optionalNumber, aggregateSocialVideos, publishedAtDate, profileHandle, instagramFollowers, instagramVideo, tiktokVideo, socialProviderOrder, fetchPlatformVideos, runSocialIntakeSnapshot };
