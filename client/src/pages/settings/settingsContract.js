export const SECRET_MASK = '••••••••';

export const SETTINGS_SECTIONS = [
  { key: 'overview', label: '概览' },
  { key: 'platforms', label: '平台数据源' },
  { key: 'ai', label: 'AI 模型' },
  { key: 'external', label: 'External Agent API' },
  { key: 'storage', label: '云端存储' },
  { key: 'runtime', label: '运行与备用策略' }
];

const provider = (value, label, options = {}) => ({
  value,
  label,
  reserved: false,
  fields: ['api_key', 'base_url'],
  required: ['api_key'],
  ...options
});

export const PLATFORM_META = {
  youtube: {
    label: 'YouTube',
    providers: [
      provider('google_official', 'Google Official'),
      provider('maton_gateway', 'Maton Gateway', { fields: ['api_key', 'base_url', 'connection_id'] }),
      provider('scrapecreators', 'ScrapeCreators', { reserved: true }),
      provider('brightdata', 'Bright Data', { reserved: true }),
      provider('custom', 'Custom', {
        reserved: true,
        fields: ['custom_provider_name', 'api_key', 'base_url', 'auth_header_name', 'auth_scheme', 'notes']
      })
    ]
  },
  instagram: {
    label: 'Instagram',
    providers: [
      provider('scrapecreators', 'ScrapeCreators'),
      provider('brightdata', 'Bright Data', { reserved: true }),
      provider('apify', 'Apify', { reserved: true }),
      provider('custom', 'Custom', {
        reserved: true,
        fields: ['custom_provider_name', 'api_key', 'base_url', 'auth_header_name', 'auth_scheme', 'notes']
      })
    ]
  },
  tiktok: {
    label: 'TikTok',
    providers: [
      provider('scrapecreators', 'ScrapeCreators'),
      provider('brightdata', 'Bright Data', { reserved: true }),
      provider('apify', 'Apify', { reserved: true }),
      provider('custom', 'Custom', {
        reserved: true,
        fields: ['custom_provider_name', 'api_key', 'base_url', 'auth_header_name', 'auth_scheme', 'notes']
      })
    ]
  }
};

export const AI_PROVIDERS = [
  provider('openai', 'OpenAI', { fields: ['api_key', 'base_url', 'model'] }),
  provider('deepseek', 'DeepSeek', { fields: ['api_key', 'base_url', 'model'] }),
  provider('minimax', 'MiniMax', { fields: ['api_key', 'base_url', 'model'] }),
  provider('custom_openai_compatible', 'Custom OpenAI-Compatible', {
    fields: ['custom_provider_name', 'api_key', 'base_url', 'model', 'auth_header_name', 'auth_scheme', 'notes']
  }),
  provider('custom_http_api', 'Custom HTTP API', {
    reserved: true,
    fields: ['custom_provider_name', 'api_key', 'base_url', 'model', 'auth_header_name', 'auth_scheme', 'notes']
  })
];

export const DEFAULT_SETTINGS = {
  platforms: {
    youtube: { primary: 'google_official', fallbacks: [], providers: {} },
    instagram: { primary: 'scrapecreators', fallbacks: [], providers: {} },
    tiktok: { primary: 'scrapecreators', fallbacks: [], providers: {} }
  },
  aiModels: { active: 'deepseek', providers: {} },
  cloudStorage: {
    primary: 'feishu_bitable',
    feishu: {
      app_id: '', app_secret: '', base_url: 'https://open.feishu.cn', app_token: '',
      kol_table_id: '', campaign_table_id: '',
      campaign_subtable_map: '', notes: ''
    }
  },
  externalAgent: { enabled: true, api_token: '', notes: '' },
  fallbackStrategy: {
    enableFallback: false,
    saveFailureReasons: true,
    saveRawResponses: true,
    allowAiToolCalls: false
  }
};

export const mergeSettings = (defaults, remote) => {
  if (Array.isArray(defaults)) return Array.isArray(remote) ? [...remote] : [...defaults];
  if (defaults === null || typeof defaults !== 'object') return remote === undefined ? defaults : remote;
  const source = remote && typeof remote === 'object' && !Array.isArray(remote) ? remote : {};
  return Object.keys({ ...defaults, ...source }).reduce((result, key) => {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      result[key] = mergeSettings(defaults[key], source[key]);
    } else {
      result[key] = mergeSettings(defaults[key], undefined);
    }
    return result;
  }, {});
};

export const updateAtPath = (source, path, value) => {
  if (!path.length) return value;
  const [head, ...tail] = path;
  return {
    ...(source || {}),
    [head]: updateAtPath(source?.[head], tail, value)
  };
};

export const hasProviderHistory = (value = {}) => Object.entries(value).some(([key, item]) => {
  if (key === 'provider' || item === undefined || item === null || item === false) return false;
  if (Array.isArray(item)) return item.length > 0;
  return String(item).trim() !== '';
});

export const getProviderState = (meta, value = {}, active = false, showReserved = false) => {
  const history = hasProviderHistory(value);
  const required = meta.required || [];
  const presentCount = required.filter((key) => String(value?.[key] || '').trim()).length;
  const configured = required.length === 0 ? history : presentCount === required.length;
  const partial = history && !configured;
  const status = configured ? 'configured' : partial ? 'partial' : 'unconfigured';
  const summary = configured
    ? '关键配置已完成'
    : partial
      ? '配置不完整'
      : meta.reserved
        ? '预留接入'
        : '尚未配置';

  return {
    configured,
    partial,
    status,
    summary,
    visible: !meta.reserved || showReserved || history,
    active
  };
};

export const providerOptions = (items) => items.map(({ value, label, reserved }) => ({
  value,
  label: reserved ? `${label}（预留）` : label
}));
