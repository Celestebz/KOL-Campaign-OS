const assert = require('node:assert/strict');
const test = require('node:test');
const bd = require('./brightdataClient');

test('resolveDatasetId falls back to documented defaults and explains missing discover datasets', () => {
  const config = { api_key: 'k', base_url: 'https://api.brightdata.com', dataset_ids: { ...bd.DEFAULT_DATASETS } };
  assert.equal(bd.resolveDatasetId(config, 'instagram_profile'), 'gd_l1vikfch901nx3by4');
  assert.equal(bd.resolveDatasetId(config, 'tiktok_profile'), 'gd_l1villgoiiidt09ci');

  const withoutSearch = { ...config, dataset_ids: { ...bd.DEFAULT_DATASETS, instagram_search: '' } };
  assert.throws(
    () => bd.resolveDatasetId(withoutSearch, 'instagram_search'),
    /数据集未配置.*dataset_id/
  );

  const overridden = { ...config, dataset_ids: { ...bd.DEFAULT_DATASETS, instagram_search: 'gd_custom' } };
  assert.equal(bd.resolveDatasetId(overridden, 'instagram_search'), 'gd_custom');
});

test('configFromSettingRow merges dataset overrides from extra_config', () => {
  const config = bd.configFromSettingRow({
    api_key: 'token',
    base_url: 'https://api.brightdata.com/',
    extra_config: JSON.stringify({ dataset_ids: { instagram_search: 'gd_mine' } })
  });
  assert.equal(config.api_key, 'token');
  assert.equal(config.base_url, 'https://api.brightdata.com');
  assert.equal(config.dataset_ids.instagram_profile, 'gd_l1vikfch901nx3by4');
  assert.equal(config.dataset_ids.instagram_search, 'gd_mine');

  assert.throws(() => bd.configFromSettingRow({ api_key: '' }), /未配置/);
});

test('profile url helpers build canonical links', () => {
  assert.equal(bd.instagramProfileUrl('demo.creator'), 'https://www.instagram.com/demo.creator/');
  assert.equal(bd.instagramProfileUrl('https://www.instagram.com/demo.creator/'), 'https://www.instagram.com/demo.creator/');
  assert.equal(bd.tiktokProfileUrl('demo_creator'), 'https://www.tiktok.com/@demo_creator');
  assert.equal(bd.tiktokProfileUrl('https://www.tiktok.com/@demo_creator'), 'https://www.tiktok.com/@demo_creator');
});

test('normalizeInstagramProfile maps Bright Data profile records', () => {
  const profile = bd.normalizeInstagramProfile({
    account: 'demo.creator', followers: 25116, posts_count: 210,
    bio: 'DIY builds', public_email: 'demo@example.com', is_verified: false, is_business_account: true,
    url: 'https://www.instagram.com/demo.creator/'
  });
  assert.equal(profile.username, 'demo.creator');
  assert.equal(profile.followers, 25116);
  assert.equal(profile.postsCount, 210);
  assert.equal(profile.email, 'demo@example.com');
  assert.equal(profile.isBusiness, true);

  assert.equal(bd.normalizeInstagramProfile({}).followers, null);
});

test('normalizeInstagramMedia maps post and reel records', () => {
  const media = bd.normalizeInstagramMedia({
    url: 'https://www.instagram.com/reel/C5Rdyj_q7YN/',
    description: 'Chipper day', video_play_count: 4321, likes: 90, num_comments: 8,
    date_posted: '2026-02-26T03:23:20.000Z'
  }, 'demo');
  assert.equal(media.id, 'C5Rdyj_q7YN');
  assert.equal(media.views, 4321);
  assert.equal(media.likes, 90);
  assert.equal(media.comments, 8);
  assert.equal(media.publishedAt, '2026-02-26T03:23:20.000Z');

  // shortcode 优先于 URL 兜底
  assert.equal(bd.normalizeInstagramMedia({ shortcode: 'XYZ123', url: 'https://www.instagram.com/p/ABC/' }).id, 'XYZ123');
  // video_view_count 兜底
  assert.equal(bd.normalizeInstagramMedia({ url: 'u', video_view_count: '77' }).views, 77);
  assert.equal(bd.normalizeInstagramMedia({ url: 'u' }).views, null);
});

test('normalizeTikTokProfile and normalizeTikTokMedia map Bright Data records', () => {
  const profile = bd.normalizeTikTokProfile({ username: 'demo', follower_count: 9800, bio: 'builder' });
  assert.equal(profile.username, 'demo');
  assert.equal(profile.followers, 9800);

  const media = bd.normalizeTikTokMedia({
    url: 'https://www.tiktok.com/@demo/video/7301',
    description: 'Sawmill tour', play_count: 5555, likes: 100, comment_count: 12,
    create_time: '2026-01-02T00:00:00.000Z'
  }, 'demo');
  assert.equal(media.id, '7301');
  assert.equal(media.views, 5555);
  assert.equal(media.likes, 100);
  assert.equal(media.comments, 12);
});

test('snapshotEnvelopeOf only treats snapshot envelopes as pending', () => {
  assert.equal(bd.snapshotEnvelopeOf([{ snapshot_id: 'snap_1', status: 'running' }]).length, 1);
  assert.equal(bd.snapshotEnvelopeOf([{ url: 'https://www.instagram.com/reel/X/', views: 10 }]), null);
  assert.equal(bd.snapshotEnvelopeOf([]), null);
  assert.equal(bd.snapshotEnvelopeOf({ snapshot_id: 'x' }), null);
});

test('isFailedRecord flags Bright Data error records', () => {
  assert.equal(bd.isFailedRecord({ status: 'failed', error: { url: 'x' } }), true);
  assert.equal(bd.isFailedRecord({ status: 'ready' }), false);
  assert.equal(bd.isFailedRecord({ url: 'x', views: 1 }), false);
});

test('parseNdjson handles line-delimited snapshot payloads', () => {
  const records = bd.parseNdjson('{"url":"a"}\n{"url":"b"}');
  assert.deepEqual(records.map((r) => r.url), ['a', 'b']);
});

test('scrapeDataset posts inputs and returns completed records', async () => {
  const calls = [];
  const config = {
    api_key: 'token',
    base_url: 'https://api.brightdata.com',
    dataset_ids: { ...bd.DEFAULT_DATASETS }
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ url: 'https://www.instagram.com/reel/X/', views: 12 }])
    };
  };
  try {
    const records = await bd.scrapeDataset(config, 'instagram_reel', [{ url: 'https://www.instagram.com/reel/X/' }]);
    assert.equal(records.length, 1);
    assert.equal(records[0].views, 12);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('dataset_id=gd_lyclm20il4r5helnj'));
    assert.ok(calls[0].url.includes('/datasets/v3/scrape'));
    assert.equal(calls[0].options.headers.Authorization, 'Bearer token');
    assert.deepEqual(JSON.parse(calls[0].options.body), { input: [{ url: 'https://www.instagram.com/reel/X/' }] });
  } finally {
    global.fetch = originalFetch;
  }
});

test('scrapeDataset polls snapshot when sync response is pending', async () => {
  const config = { api_key: 'token', base_url: 'https://api.brightdata.com', dataset_ids: { ...bd.DEFAULT_DATASETS } };
  const responses = [
    JSON.stringify([{ snapshot_id: 'snap_2', status: 'running' }]),
    JSON.stringify({ status: 'ready' }),
    JSON.stringify([{ url: 'https://www.instagram.com/demo/', followers: 5 }])
  ];
  const originalFetch = global.fetch;
  global.fetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () => responses.shift()
  });
  try {
    const records = await bd.scrapeDataset(config, 'instagram_profile', [{ url: 'https://www.instagram.com/demo/' }], { pollIntervalMs: 1 });
    assert.equal(records.length, 1);
    assert.equal(records[0].followers, 5);
  } finally {
    global.fetch = originalFetch;
  }
});

test('scrapeDataset surfaces failed records', async () => {
  const config = { api_key: 'token', base_url: 'https://api.brightdata.com', dataset_ids: { ...bd.DEFAULT_DATASETS } };
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify([{ status: 'failed', error: { url: 'x', message: 'not found' } }])
  });
  try {
    await assert.rejects(
      () => bd.scrapeDataset(config, 'instagram_profile', [{ url: 'x' }]),
      /采集失败/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('discoverDataset triggers discover_new and polls', async () => {
  const config = { api_key: 'token', base_url: 'https://api.brightdata.com', dataset_ids: { ...bd.DEFAULT_DATASETS, instagram_search: 'gd_search' } };
  const urls = [];
  const responses = [
    JSON.stringify([{ snapshot_id: 'snap_3', status: 'collecting' }]),
    JSON.stringify({ status: 'ready' }),
    JSON.stringify([{ url: 'https://www.instagram.com/reel/Y/', user_posted: 'demo' }])
  ];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    urls.push(url);
    return { ok: true, status: 200, text: async () => responses.shift() };
  };
  try {
    const records = await bd.discoverDataset(config, 'instagram_search', [{ keyword: 'wood chipper', num_of_posts: 50 }], { pollIntervalMs: 1 });
    assert.equal(records.length, 1);
    assert.ok(urls[0].includes('type=discover_new'));
    assert.ok(urls[0].includes('dataset_id=gd_search'));
    assert.ok(urls[2].includes('/datasets/v3/snapshot/snap_3'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchInstagramProfileVideos combines profile and reels datasets', async () => {
  const config = { api_key: 'token', base_url: 'https://api.brightdata.com', dataset_ids: { ...bd.DEFAULT_DATASETS, instagram_reels_from_profile: 'gd_reels' } };
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.includes('dataset_id=gd_l1vikfch901nx3by4')) {
      return { ok: true, status: 200, text: async () => JSON.stringify([{ account: 'demo.creator', followers: 1234, url: 'https://www.instagram.com/demo.creator/' }]) };
    }
    if (url.includes('dataset_id=gd_reels')) {
      return { ok: true, status: 200, text: async () => JSON.stringify([{ snapshot_id: 'snap_4', status: 'collecting' }]) };
    }
    if (url.includes('/progress')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ready' }) };
    }
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify([
        { url: 'https://www.instagram.com/reel/A/', video_play_count: 10, date_posted: '2026-08-01T00:00:00.000Z' },
        { url: 'https://www.instagram.com/reel/B/', video_play_count: 20, date_posted: '2026-08-02T00:00:00.000Z' }
      ])
    };
  };
  try {
    const result = await bd.fetchInstagramProfileVideos(config, 'demo.creator', 10);
    assert.equal(result.followers, 1234);
    assert.equal(result.videos.length, 2);
    assert.equal(result.videos[0].handle, 'demo.creator');
    assert.ok(requests.some((r) => r.url.includes('dataset_id=gd_reels')));
    const reelsRequest = requests.find((r) => r.url.includes('dataset_id=gd_reels'));
    const endpoint = new URL(reelsRequest.url);
    assert.equal(endpoint.pathname, '/datasets/v3/scrape');
    assert.equal(endpoint.searchParams.get('type'), 'discover_new');
    assert.equal(endpoint.searchParams.get('discover_by'), 'url_all_reels');
    assert.deepEqual(JSON.parse(reelsRequest.options.body), { input: [{
      url: 'https://www.instagram.com/demo.creator/', num_of_posts: 10, country_code: ''
    }] });
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchInstagramProfileVideos accepts immediate results and respects the requested limit', async () => {
  const config = { api_key: 'token', base_url: 'https://api.brightdata.com', dataset_ids: { ...bd.DEFAULT_DATASETS, instagram_reels_from_profile: 'gd_reels' } };
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const isReels = url.includes('dataset_id=gd_reels');
    if (isReels) assert.equal(JSON.parse(options.body).input[0].num_of_posts, 1);
    return { ok: true, status: 200, text: async () => JSON.stringify(isReels
      ? [{ url: 'https://www.instagram.com/reel/A/' }, { url: 'https://www.instagram.com/reel/B/' }]
      : [{ account: 'demo', followers: 3 }]) };
  };
  try {
    const result = await bd.fetchInstagramProfileVideos(config, 'demo', 1);
    assert.equal(result.videos.length, 1);
    assert.equal(result.videos[0].id, 'A');
    assert.equal(result.followers, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchInstagramMediaByUrl picks reel dataset for reel links', async () => {
  const config = { api_key: 'token', base_url: 'https://api.brightdata.com', dataset_ids: { ...bd.DEFAULT_DATASETS } };
  const urls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify([{ url: 'https://www.instagram.com/reel/X/', video_play_count: 9 }]) };
  };
  try {
    const media = await bd.fetchInstagramMediaByUrl(config, 'https://www.instagram.com/reel/X/');
    assert.equal(media.views, 9);
    assert.ok(urls[0].includes('dataset_id=gd_lyclm20il4r5helnj'));
    await bd.fetchInstagramMediaByUrl(config, 'https://www.instagram.com/p/ABC123/');
    assert.ok(urls[1].includes('dataset_id=gd_lk5ns7kz21pck8jpis'));
  } finally {
    global.fetch = originalFetch;
  }
});
