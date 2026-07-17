const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildInstagramReelSearchUrl,
  extractInstagramReels,
  instagramReelToCandidate
} = require('./instagramReelSearch');

const request = {
  discovery: { keywords: 'vocal processor' },
  strategy: { persona_config: { primary_persona: '现场演出型 KOL' } }
};

test('builds the public Instagram Reel keyword-search endpoint', () => {
  assert.equal(
    buildInstagramReelSearchUrl('https://api.scrapecreators.com/v1', 'vocal processor'),
    'https://api.scrapecreators.com/v2/instagram/reels/search?query=vocal+processor'
  );
});

test('maps a public Reel and its owner to existing Finder candidate fields', () => {
  const reel = {
    id: '3723045213787686915',
    shortcode: 'DOq6eV6iIgD',
    url: 'https://www.instagram.com/reel/DOq6eV6iIgD/',
    caption: 'Live vocal processor demo',
    play_count: 12000,
    owner: {
      id: '12345',
      username: 'demo_creator',
      full_name: 'Demo Creator',
      follower_count: 188406
    }
  };

  assert.deepEqual(instagramReelToCandidate(reel, request), {
    platform: 'instagram',
    kol_name: 'Demo Creator',
    profile_url: 'https://www.instagram.com/demo_creator/',
    followers: '188406',
    avg_views: '12000',
    email: '',
    country_region: '',
    matched_keywords: 'vocal processor',
    matched_persona: '现场演出型 KOL',
    representative_video_url: 'https://www.instagram.com/reel/DOq6eV6iIgD/',
    representative_video_title: 'Live vocal processor demo',
    evidence_url: 'https://www.instagram.com/reel/DOq6eV6iIgD/',
    evidence_title: 'Live vocal processor demo',
    evidence_type: 'video',
    source_query: 'vocal processor',
    reason: 'Matched Instagram Reel search: vocal processor',
    raw_data: reel
  });
});

test('extracts only the documented reels array', () => {
  const reel = { url: 'https://www.instagram.com/reel/abc/' };
  assert.deepEqual(extractInstagramReels({ reels: [reel] }), [reel]);
  assert.deepEqual(extractInstagramReels({ users: [reel] }), []);
  assert.deepEqual(extractInstagramReels(null), []);
});

test('rejects profile URLs and records without an identifiable owner', () => {
  assert.equal(instagramReelToCandidate({
    url: 'https://www.instagram.com/demo_creator/',
    owner: { username: 'demo_creator' }
  }, request), null);
  assert.equal(instagramReelToCandidate({
    url: 'https://www.instagram.com/reel/abc/'
  }, request), null);
});

test('leaves unavailable public metadata empty instead of inventing it', () => {
  const result = instagramReelToCandidate({
    url: 'https://www.instagram.com/reel/abc/',
    caption: 'Demo',
    user: { username: 'minimal_creator' }
  }, request);
  assert.equal(result.kol_name, 'minimal_creator');
  assert.equal(result.followers, '');
  assert.equal(result.avg_views, '');
  assert.equal(result.country_region, '');
  assert.equal(result.email, '');
});
