import {
  DEFAULT_SETTINGS,
  SECRET_MASK,
  getProviderState,
  mergeSettings,
  updateAtPath
} from './settingsContract';

test('mergeSettings preserves nested defaults while accepting server values', () => {
  const result = mergeSettings(DEFAULT_SETTINGS, {
    platforms: { youtube: { primary: 'maton_gateway' } }
  });

  expect(result.platforms.youtube.primary).toBe('maton_gateway');
  expect(result.platforms.instagram.primary).toBe('scrapecreators');
  expect(result.cloudStorage.feishu.base_url).toBe('https://open.feishu.cn');
});

test('updateAtPath returns a new tree without mutating loaded settings', () => {
  const loaded = mergeSettings(DEFAULT_SETTINGS, {});
  const next = updateAtPath(loaded, ['aiModels', 'active'], 'openai');

  expect(next.aiModels.active).toBe('openai');
  expect(loaded.aiModels.active).toBe('deepseek');
});

test('reserved providers stay hidden unless configured or explicitly shown', () => {
  const reserved = { value: 'browseract', reserved: true, required: ['api_key'] };

  expect(getProviderState(reserved, {}, false, false).visible).toBe(false);
  expect(getProviderState(reserved, {}, false, true).visible).toBe(true);
  expect(getProviderState(reserved, { base_url: 'http://localhost:3001' }, false, false).visible).toBe(true);
});

test('provider status distinguishes configured and partial values', () => {
  const meta = {
    value: 'maton_gateway',
    reserved: false,
    required: ['api_key', 'connection_id']
  };

  expect(getProviderState(meta, { api_key: SECRET_MASK }, true, false).status).toBe('partial');
  expect(getProviderState(meta, {
    api_key: SECRET_MASK,
    connection_id: 'conn-1'
  }, true, false).status).toBe('configured');
});
