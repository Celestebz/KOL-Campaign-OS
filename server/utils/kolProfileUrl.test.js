const test = require('node:test');
const assert = require('node:assert/strict');
const { parseKolProfileUrl } = require('./kolProfileUrl');

test('recognizes YouTube handles and canonicalizes the profile URL', () => {
  assert.deepEqual(
    parseKolProfileUrl('youtube.com/@DemoCreator/videos?view=0'),
    {
      platform: 'youtube',
      username: 'DemoCreator',
      displayName: 'DemoCreator',
      canonicalUrl: 'https://www.youtube.com/@DemoCreator',
      profileUrlHash: parseKolProfileUrl('https://youtube.com/@DemoCreator').profileUrlHash
    }
  );
});

test('recognizes Instagram and TikTok profile identities', () => {
  const instagram = parseKolProfileUrl('https://instagram.com/demo.creator/?igsh=abc');
  assert.equal(instagram.platform, 'instagram');
  assert.equal(instagram.username, 'demo.creator');
  assert.equal(instagram.canonicalUrl, 'https://www.instagram.com/demo.creator/');

  const tiktok = parseKolProfileUrl('https://www.tiktok.com/@demo_creator/video/123456789');
  assert.equal(tiktok.platform, 'tiktok');
  assert.equal(tiktok.username, 'demo_creator');
  assert.equal(tiktok.canonicalUrl, 'https://www.tiktok.com/@demo_creator');
});

test('rejects video links that do not contain an account identity', () => {
  assert.throws(
    () => parseKolProfileUrl('https://www.instagram.com/reel/ABC123/'),
    /请使用账号主页链接/
  );
  assert.throws(
    () => parseKolProfileUrl('https://www.youtube.com/watch?v=abcdefghijk'),
    /请使用频道主页链接/
  );
});

test('rejects unsupported platforms', () => {
  assert.throws(() => parseKolProfileUrl('https://example.com/@demo'), /暂不支持该平台/);
});
