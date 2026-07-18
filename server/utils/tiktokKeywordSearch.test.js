const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildTikTokKeywordSearchUrl,
  extractTikTokVideos,
  tiktokVideoToCandidate
} = require('./tiktokKeywordSearch');

const request = {
  discovery: { keywords: 'vocal processor' },
  strategy: { persona_config: { primary_persona: '现场演出型 KOL' } }
};

const officialVideo = {
  aweme_id: '7334621391758642478',
  desc: 'Live vocal processor demo',
  region: 'US',
  author: {
    unique_id: 'demo.creator',
    nickname: 'Demo Creator',
    follower_count: 0
  },
  statistics: { play_count: 0, digg_count: 45, comment_count: 4 }
};

test('builds only the TikTok Keyword Search endpoint', () => {
  const url = buildTikTokKeywordSearchUrl('https://api.scrapecreators.com/v1', 'vocal processor');
  assert.equal(url, 'https://api.scrapecreators.com/v1/tiktok/search/keyword?query=vocal+processor');
  assert.equal(url.includes('/users/search'), false);
  assert.equal(url.includes('/search/hashtag'), false);
  assert.equal(url.includes('/search/top'), false);
});

test('extracts only aweme_info video records', () => {
  assert.deepEqual(
    extractTikTokVideos({ search_item_list: [{ aweme_info: officialVideo }, { type: 1 }] }),
    [officialVideo]
  );
  assert.deepEqual(extractTikTokVideos({ users: [officialVideo] }), []);
  assert.deepEqual(extractTikTokVideos(null), []);
});

test('maps aweme id and author handle to canonical TikTok identities', () => {
  assert.deepEqual(tiktokVideoToCandidate(officialVideo, request), {
    platform: 'tiktok',
    kol_name: 'Demo Creator',
    profile_url: 'https://www.tiktok.com/@demo.creator',
    followers: '0',
    avg_views: '0',
    email: '',
    country_region: 'US',
    matched_keywords: 'vocal processor',
    matched_persona: '现场演出型 KOL',
    representative_video_url: 'https://www.tiktok.com/@demo.creator/video/7334621391758642478',
    representative_video_title: 'Live vocal processor demo',
    evidence_url: 'https://www.tiktok.com/@demo.creator/video/7334621391758642478',
    evidence_title: 'Live vocal processor demo',
    evidence_type: 'video',
    source_query: 'vocal processor',
    reason: 'Matched TikTok Keyword Search: vocal processor',
    raw_data: officialVideo
  });
});

test('rejects missing ids, missing handles, invalid handles, and photo mode', () => {
  assert.equal(tiktokVideoToCandidate({ ...officialVideo, aweme_id: '' }, request), null);
  assert.equal(tiktokVideoToCandidate({ ...officialVideo, aweme_id: '', id: '7334621391758642478' }, request), null);
  assert.equal(tiktokVideoToCandidate({ ...officialVideo, author: {} }, request), null);
  assert.equal(tiktokVideoToCandidate({ ...officialVideo, author: { username: 'demo.creator' } }, request), null);
  assert.equal(tiktokVideoToCandidate({ ...officialVideo, author: { unique_id: '../bad' } }, request), null);
  assert.equal(tiktokVideoToCandidate({ ...officialVideo, image_infos: [{}] }, request), null);
});

test('rejects ids and handles that cannot form canonical TikTok URLs', () => {
  for (const aweme_id of ['abc', '../123', '123?lang=en']) {
    assert.equal(tiktokVideoToCandidate({ ...officialVideo, aweme_id }, request), null);
  }
  for (const unique_id of ['.', '..', '.name', 'name.', 'name..x', 'bad/name', 'bad?name']) {
    assert.equal(tiktokVideoToCandidate({
      ...officialVideo,
      author: { ...officialVideo.author, unique_id }
    }, request), null);
  }
});

test('rejects numeric aweme ids before JavaScript can corrupt their precision', () => {
  assert.equal(tiktokVideoToCandidate({
    ...officialVideo,
    aweme_id: 7334621391758642478
  }, request), null);
});

test('never trusts provider CDN or profile URLs as evidence identity', () => {
  const result = tiktokVideoToCandidate({
    ...officialVideo,
    url: 'https://v45.tiktokcdn.com/video.mp4',
    profile_url: 'https://www.tiktok.com/@wrong'
  }, request);
  assert.equal(result.representative_video_url, 'https://www.tiktok.com/@demo.creator/video/7334621391758642478');
  assert.equal(result.profile_url, 'https://www.tiktok.com/@demo.creator');
});

test('rejects Photo Mode response variants', () => {
  assert.equal(tiktokVideoToCandidate({ ...officialVideo, image_infos: [{}] }, request), null);
  assert.equal(tiktokVideoToCandidate({ ...officialVideo, content_type: 'multi_photo' }, request), null);
});

test('preserves provider metrics without inventing absent values', () => {
  const zero = tiktokVideoToCandidate(officialVideo, request);
  assert.equal(zero.followers, '0');
  assert.equal(zero.avg_views, '0');
});

test('uses the current query in every candidate reason and source field', () => {
  const result = tiktokVideoToCandidate(officialVideo, request);
  assert.equal(result.source_query, 'vocal processor');
  assert.equal(result.reason, 'Matched TikTok Keyword Search: vocal processor');
});

test('leaves unavailable provider metadata empty', () => {
  const result = tiktokVideoToCandidate({
    aweme_id: '7334621391758642479',
    author: { unique_id: 'minimal_creator' }
  }, request);
  assert.equal(result.kol_name, 'minimal_creator');
  assert.equal(result.followers, '');
  assert.equal(result.avg_views, '');
  assert.equal(result.country_region, '');
  assert.equal(result.email, '');
});
