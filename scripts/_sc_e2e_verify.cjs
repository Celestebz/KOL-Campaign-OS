// SC YouTube 端到端验证（真实 DB 配置 + 真实 SC API）。绝不打印 key。
// 用法: node scripts/_sc_e2e_verify.cjs
const path = require('path');
process.chdir(path.resolve(__dirname, '../server')); // 让 database 相对路径/配置生效
const { getYoutubeScrapeCreatorsSetting } = require('../server/services/scrapecreatorsYoutube');
const { fetchYouTubeScrapeCreators } = require('../server/routes/videos');
const { youtubeScrapeCreatorsAdapter } = require('../server/routes/finderTasks');
const scYoutube = require('../server/services/scrapecreatorsYoutube');
const { toV3ChannelItem, toV3VideoItems } = require('../server/utils/scrapecreatorsYoutubeSearch');

(async () => {
  // 0. key 解析链
  const setting = await getYoutubeScrapeCreatorsSetting();
  console.log('[0] setting resolved:', Boolean(setting?.api_key), '| base_url:', setting?.base_url || '(default)');

  // 1. 视频详情 + 评论（Living On 80 的 King Kutter 评测）
  const v = await fetchYouTubeScrapeCreators('https://www.youtube.com/watch?v=yshz5L9CWAI', setting);
  console.log('[1] video detail:', JSON.stringify({
    platform: v.platform, video_id: v.platform_video_id, kol: v.kol_name,
    content_type: v.content_type, published_at: v.published_at,
    metrics: v.metrics, comments: v.comments.length,
    exposure_type: v.exposure && v.exposure.exposure_metric_type
  }, null, 1));

  // 2. Finder 适配器（策略 #8 口径，limit=3）
  const request = {
    finder_task_id: null,
    target_platform: 'youtube',
    limit: 3,
    discovery: { keywords: 'flail mower, brush hog, food plot' },
    campaign: { name: 'TMB-1404 | Flail Mower', product: '53-inch PTO Flail Mower', target_market: 'US' },
    strategy: {
      persona_config: {},
      finder_handoff: {
        minimum_followers: 10000,
        maximum_followers: 300000,
        minimum_median_views: 10000,
        minimum_video_duration_seconds: 181,
        minimum_recent_videos: 3
      }
    }
  };
  const r = await youtubeScrapeCreatorsAdapter(request);
  console.log('[2] finder:', JSON.stringify({
    provider: r.provider,
    candidates: r.candidates.map(c => ({ name: c.kol_name, followers: c.followers, country: c.country_region, avg_views: c.avg_views })),
    preflight_rejected: r.preflight_rejected.length,
    scanned: r.scanned_channel_count,
    external_requests: r.external_request_count,
    cache_hits: r.cache_hit_count
  }, null, 1));

  // 3. 快照 SC 分支 shadow run（只读，不写库）：Gierok Farms 30 天聚合
  const identity = { handle: 'GierokFarms' };
  const ch = toV3ChannelItem(await scYoutube.channel(setting, identity));
  const cutoff = Date.now() - 30 * 86400000;
  const items = [];
  let token = '';
  for (let page = 0; page < 3; page += 1) {
    const data = await scYoutube.channelVideos(setting, identity, token);
    const pageItems = toV3VideoItems(data);
    items.push(...pageItems);
    const reached = pageItems.some(i => { const t = new Date(i.snippet.publishedAt || 0).getTime(); return t > 0 && t < cutoff; });
    token = String(data.continuationToken || '').trim();
    if (reached || !token || !pageItems.length) break;
  }
  const recent = items.filter(i => new Date(i.snippet.publishedAt || 0).getTime() >= cutoff);
  const longs = recent.filter(i => i.snippet.liveBroadcastContent !== 'live' && Number(i.statistics.viewCount) >= 0 && i.contentDetails.duration !== 'PT0S')
    .filter(i => { const m = i.contentDetails.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); const s = (+(m[1]||0))*3600+(+(m[2]||0))*60+(+(m[3]||0)); return s > 180; });
  const views = longs.map(i => Number(i.statistics.viewCount)).sort((a,b)=>a-b);
  const median = views.length ? (views.length % 2 ? views[(views.length-1)/2] : Math.round((views[views.length/2-1]+views[views.length/2])/2)) : null;
  console.log('[3] snapshot shadow:', JSON.stringify({
    channel: ch.snippet.title, subs: ch.statistics.subscriberCount, country: ch.snippet.country,
    videos_30d: recent.length, long_videos_30d: longs.length, median_views_30d: median
  }, null, 1));

  console.log('E2E DONE');
  process.exit(0);
})().catch(e => { console.error('E2E FAIL:', e.message); process.exit(1); });
