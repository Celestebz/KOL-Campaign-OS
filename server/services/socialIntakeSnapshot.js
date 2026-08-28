const { dbOperations } = require('../database');
const { getSetting, providerKey, legacyKeysFor } = require('./aiClient');

const LIMIT = 10;

function clean(value) { return String(value ?? '').trim(); }
function number(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
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
    views: number(media.play_count ?? media.video_play_count ?? media.view_count),
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
async function fetchInstagram(config, handle) {
  const base = clean(config.base_url || 'https://api.scrapecreators.com').replace(/\/+$/, '').replace(/\/v[12]$/, '');
  const videos = [];
  const pinned = new Set();
  let cursor = '';
  let followers = null;
  for (let page = 0; page < 5 && videos.length < LIMIT; page += 1) {
    const url = new URL(base + '/v2/instagram/user/posts');
    url.searchParams.set('handle', handle);
    url.searchParams.set('trim', 'true');
    if (cursor) url.searchParams.set('next_max_id', cursor);
    const data = await fetchJson(url.toString(), config);
    for (const id of data.pinned_profile_grid_items_ids || []) pinned.add(String(id));
    followers ||= number(data.user?.follower_count || data.user?.edge_followed_by?.count) || null;
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
async function runSocialIntakeSnapshot(customerId, platform) {
  if (!['instagram', 'tiktok'].includes(platform)) throw new Error('仅支持 Instagram 或 TikTok');
  const customer = await dbOperations.get('SELECT * FROM customers WHERE id = ?', [customerId]);
  if (!customer) throw new Error('KOL 不存在');
  const account = await dbOperations.get('SELECT * FROM kol_platform_accounts WHERE customer_id = ? AND LOWER(platform) = ? ORDER BY id LIMIT 1', [customerId, platform]);
  const profileUrl = account?.profile_url || customer[platform + '_url'];
  if (!profileUrl) throw new Error('KOL 没有 ' + platform + ' 主页链接');
  await dbOperations.run('UPDATE customers SET ' + platform + "_snapshot_status = 'fetching', " + platform + '_snapshot_error = NULL WHERE id = ?', [customerId]);
  try {
    const config = await setting(platform);
    const handle = profileHandle(platform, profileUrl);
    const fetched = platform === 'instagram' ? await fetchInstagram(config, handle) : await fetchTikTok(config, handle);
    const videos = fetched.videos.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)).slice(0, LIMIT);
    const snapshotAt = new Date();
    const views = videos.map((video) => video.views);
    const totalViews = views.reduce((sum, value) => sum + value, 0);
    const totalEngagement = videos.reduce((sum, video) => sum + video.likes + video.comments, 0);
    const aggregate = { posts: videos.length, averageViews: videos.length ? Math.round(totalViews / videos.length) : null, medianViews: median(views), engagementRate: totalViews ? totalEngagement / totalViews : null };
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

module.exports = { LIMIT, median, publishedAtDate, profileHandle, instagramVideo, tiktokVideo, runSocialIntakeSnapshot };
