const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildYoutubeSearchUrl,
  buildYoutubeChannelUrl,
  buildYoutubeChannelVideosUrl,
  normalizeScHandle,
  secondsToIsoDuration,
  toV3SearchItems,
  toV3ChannelItem,
  toV3VideoItems,
  scVideoDetailToNormalized,
  scCommentsToNormalized
} = require('./scrapecreatorsYoutubeSearch');

test('buildYoutubeSearchUrl 拼接 query 与 continuationToken', () => {
  assert.equal(
    buildYoutubeSearchUrl('https://api.scrapecreators.com', 'flail mower', 'tok 1'),
    'https://api.scrapecreators.com/v1/youtube/search?query=flail%20mower&continuationToken=tok%201'
  );
  assert.equal(
    buildYoutubeSearchUrl(undefined, 'brush hog'),
    'https://api.scrapecreators.com/v1/youtube/search?query=brush%20hog'
  );
});

test('buildYoutubeChannelUrl 支持三种 identity', () => {
  assert.equal(buildYoutubeChannelUrl('https://api.scrapecreators.com', { channelId: 'UC1' }),
    'https://api.scrapecreators.com/v1/youtube/channel?channelId=UC1');
  assert.equal(buildYoutubeChannelUrl('https://api.scrapecreators.com', { handle: 'mrbeast' }),
    'https://api.scrapecreators.com/v1/youtube/channel?handle=mrbeast');
  assert.equal(buildYoutubeChannelUrl('https://api.scrapecreators.com', { url: 'https://www.youtube.com/@mrbeast' }),
    'https://api.scrapecreators.com/v1/youtube/channel?url=https%3A%2F%2Fwww.youtube.com%2F%40mrbeast');
  assert.throws(() => buildYoutubeChannelUrl('https://api.scrapecreators.com', {}));
});

test('buildYoutubeChannelVideosUrl 固定 includeExtras', () => {
  assert.equal(buildYoutubeChannelVideosUrl('https://api.scrapecreators.com', { channelId: 'UC1' }),
    'https://api.scrapecreators.com/v1/youtube/channel-videos?channelId=UC1&includeExtras=true');
});

test('normalizeScHandle 归一化 channel/<id> 形式与 @ 前缀', () => {
  assert.deepEqual(normalizeScHandle('channel/UCabc', 'UCabc'), { channelId: 'UCabc' });
  assert.deepEqual(normalizeScHandle('@MrBeast', 'UCx'), { handle: 'MrBeast' });
  assert.deepEqual(normalizeScHandle('', 'UCx'), { channelId: 'UCx' });
  assert.deepEqual(normalizeScHandle('', ''), {});
});

test('secondsToIsoDuration', () => {
  assert.equal(secondsToIsoDuration(0), 'PT0S');
  assert.equal(secondsToIsoDuration(254), 'PT4M14S');
  assert.equal(secondsToIsoDuration(3723), 'PT1H2M3S');
  assert.equal(secondsToIsoDuration(null), 'PT0S');
});

test('toV3SearchItems 汇总 videos/shorts/lives 并跳过缺 channel 的条目', () => {
  const items = toV3SearchItems({
    videos: [{ id: 'v1', title: 'A', publishedTime: '2026-01-01T00:00:00Z', channel: { id: 'UC1', title: 'Chan' } }],
    shorts: [{ id: 's1', title: 'B', publishedTime: null, channel: { id: 'UC1', title: 'Chan' } }],
    lives: [{ id: 'l1', title: 'C', channel: { id: 'UC2', title: 'Other' } }],
    channels: [{ id: 'nope' }]
  });
  assert.equal(items.length, 3);
  assert.deepEqual(items[0].id, { videoId: 'v1', kind: 'youtube#video' });
  assert.equal(items[0].snippet.channelId, 'UC1');
  assert.equal(items[1].snippet.publishedAt, '');
  assert.equal(items[2]._scType, 'live');
});

test('toV3ChannelItem 映射为 v3 channel 形状并取整订阅数', () => {
  const item = toV3ChannelItem({
    channelId: 'UC1', name: 'Chan', description: 'd', country: 'United States',
    subscriberCount: 65099.99, videoCount: 30, handle: '@chan', links: ['https://x.com/a']
  });
  assert.equal(item.id, 'UC1');
  // SC 返回国家全名，需对齐 v3 的 ISO 代码语义
  assert.equal(item.snippet.country, 'US');
  assert.equal(item.statistics.subscriberCount, '65100');
  assert.equal(item._sc.handle, 'chan');
  // 非美国国家全名原样保留
  assert.equal(toV3ChannelItem({ channelId: 'UC2', country: 'Canada' }).snippet.country, 'Canada');
});

test('toV3VideoItems 映射时长/统计，lives 标记 liveBroadcastContent', () => {
  const items = toV3VideoItems({
    videos: [{ id: 'v1', title: 'A', publishedTime: '2026-01-01T00:00:00Z', lengthSeconds: 484, viewCountInt: 29382, likeCountInt: 100, commentCountInt: 9, channel: { id: 'UC1', title: 'C' } }],
    shorts: [{ id: 's1', title: 'S', lengthSeconds: 44, viewCountInt: 5, channel: { id: 'UC1' } }],
    lives: [{ id: 'l1', title: 'L', lengthSeconds: 3600, viewCountInt: 7, channel: { id: 'UC1' } }]
  });
  assert.equal(items.length, 3);
  assert.equal(items[0].contentDetails.duration, 'PT8M4S');
  assert.equal(items[0].statistics.viewCount, '29382');
  assert.equal(items[1].snippet.liveBroadcastContent, 'none');
  assert.equal(items[2].snippet.liveBroadcastContent, 'live');
});

test('scVideoDetailToNormalized 产出 videos.js 归一化基础结构', () => {
  const n = scVideoDetailToNormalized({
    id: 'abc', title: 'T', type: 'video', publishDate: '2019-02-22T03:19:54-08:00',
    viewCountInt: 372864, likeCountInt: 4043, commentCountInt: 358,
    channel: { title: 'Chan' }
  }, 'https://www.youtube.com/watch?v=abc');
  assert.equal(n.platform, 'youtube');
  assert.equal(n.platform_video_id, 'abc');
  assert.equal(n.kol_name, 'Chan');
  assert.equal(n.content_type, 'video');
  assert.deepEqual(n.metrics, { play_count: 372864, like_count: 4043, comment_count: 358, collect_count: 0, share_count: null });
  const short = scVideoDetailToNormalized({ id: 'x', type: 'short', channel: {} }, 'https://www.youtube.com/watch?v=x');
  assert.equal(short.content_type, 'short');
  const byUrl = scVideoDetailToNormalized({ id: 'y', channel: {} }, 'https://www.youtube.com/shorts/y');
  assert.equal(byUrl.content_type, 'short');
});

test('scCommentsToNormalized 截取前 100 条并映射作者/点赞', () => {
  const comments = Array.from({ length: 120 }, (_, i) => ({
    id: `c${i}`, content: `text ${i}`, publishedTime: '2026-01-01T00:00:00Z',
    author: { name: '@user' }, engagement: { likes: i }
  }));
  const out = scCommentsToNormalized({ comments }, 100);
  assert.equal(out.length, 100);
  assert.deepEqual(out[1], {
    id: 'c1', parent_id: null, user_name: '@user', content: 'text 1',
    like_count: 1, commented_at: '2026-01-01T00:00:00Z', raw: out[1].raw
  });
});

const { extractWatchNext, positionWeight, graphScore } = require('./scrapecreatorsYoutubeSearch');

test('extractWatchNext 提取关联视频并兜底空值', () => {
  const out = extractWatchNext({
    watchNextVideos: [
      { id: 'a', title: 'T1', viewCountInt: 1000, lengthInSeconds: 300, publishedTime: '2026-01-01T00:00:00Z', channel: { id: 'UC1', title: 'C1', handle: 'c1' }, videoUrl: 'https://www.youtube.com/watch?v=a' },
      { id: 'b', title: 'T2', channel: { id: 'UC2' } },
      { title: 'no id' },
      { id: 'c', title: 'no channel' }
    ]
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: 'a', title: 'T1', views: 1000, lengthSeconds: 300, publishedTime: '2026-01-01T00:00:00Z', channel: { id: 'UC1', title: 'C1', handle: 'c1' }, videoUrl: 'https://www.youtube.com/watch?v=a' });
  assert.deepEqual(out[1], { id: 'b', title: 'T2', views: null, lengthSeconds: 0, publishedTime: '', channel: { id: 'UC2', title: '', handle: '' }, videoUrl: 'https://www.youtube.com/watch?v=b' });
  assert.deepEqual(extractWatchNext({}), []);
  assert.deepEqual(extractWatchNext(null), []);
});

test('positionWeight 分段', () => {
  assert.equal(positionWeight(1), 20);
  assert.equal(positionWeight(5), 20);
  assert.equal(positionWeight(6), 12);
  assert.equal(positionWeight(10), 12);
  assert.equal(positionWeight(11), 5);
  assert.equal(positionWeight(20), 5);
  assert.equal(positionWeight(21), 0);
});

test('graphScore 纯位置权重求和（不乘种子数）', () => {
  assert.equal(graphScore([3, 8]), 32);
  assert.equal(graphScore([1]), 20);
  assert.equal(graphScore([]), 0);
  assert.equal(graphScore([1, 1, 1]), 60);
});
