const test = require('node:test');
const assert = require('node:assert/strict');

const customersRoute = require('./customers');

test('normalized platform accounts take precedence and legacy fills missing platforms', () => {
  const customer = {
    id: 7,
    youtube_url: 'https://youtube.com/legacy',
    youtube_followers: '10K',
    instagram_url: 'https://instagram.com/legacy',
    instagram_followers: '5K'
  };
  const normalized = [{
    id: 11,
    customer_id: 7,
    platform: 'youtube',
    username: '@new',
    profile_url: 'https://youtube.com/new',
    followers_text: '20K'
  }];

  assert.deepEqual(customersRoute.mergePlatformAccounts(customer, normalized), [
    {
      id: 11, platform: 'youtube', username: '@new',
      profile_url: 'https://youtube.com/new', followers_text: '20K',
      followers_count: null, source: 'normalized'
    },
    {
      id: null, platform: 'instagram', username: null,
      profile_url: 'https://instagram.com/legacy', followers_text: '5K',
      followers_count: null, source: 'legacy'
    }
  ]);
});

test('project history uses compatibility fields when v2 fields are empty', () => {
  assert.deepEqual(customersRoute.toProjectHistory({
    id: 3,
    campaign_id: 4,
    campaign_name: 'Launch',
    project_status: 'contacted',
    quoted_fee: null,
    quoted_price: '$500',
    final_fee: null,
    price_rmb: '3600',
    project_notes: null,
    notes: 'legacy note'
  }), {
    id: 3,
    campaign_id: 4,
    campaign_name: 'Launch',
    project_status: 'contacted',
    quoted_fee: '$500',
    final_fee: '3600',
    currency: null,
    owner: null,
    best_evidence_url: null,
    youtube_video_link: null,
    instagram_video_link: null,
    tiktok_video_link: null,
    project_notes: 'legacy note',
    created_at: null,
    updated_at: null
  });
});

test('evidence summaries and completed cooperation statuses are normalized for the KOL view', () => {
  assert.equal(
    customersRoute.parseEvidenceSummary(JSON.stringify({ summary: 'Relevant workshop evidence' })),
    'Relevant workshop evidence'
  );
  assert.equal(customersRoute.isHistoricalCooperation({ project_status: 'confirmed' }), true);
  assert.equal(customersRoute.isHistoricalCooperation({ content_status: 'published' }), true);
  assert.equal(customersRoute.isHistoricalCooperation({ project_status: 'candidate' }), false);
  assert.equal(customersRoute.isActiveProject({ project_status: 'negotiating' }), true);
  assert.equal(customersRoute.isActiveProject({ project_status: 'published' }), false);
  assert.equal(customersRoute.projectStatusLabel('confirmed'), '已确认');
});
