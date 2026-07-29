// 共享 AI 调用客户端：finderTasks / videos / 邮件模块共用。
// 配置读取：api_settings 表（provider 形如 ai.minimax，deepseek 兼容 legacy key 'ai'），
// 激活的 provider 读 system.provider_selection 的 aiModels.active。
const { dbOperations } = require('../database');

const SYSTEM_SELECTION_KEY = 'system.provider_selection';

const DEFAULT_SELECTION = {
  platforms: {
    youtube: { primary: 'google_official', fallbacks: [] },
    instagram: { primary: 'scrapecreators', fallbacks: [] },
    tiktok: { primary: 'scrapecreators', fallbacks: [] }
  },
  aiModels: { active: 'deepseek' },
  fallbackStrategy: {
    enableFallback: false,
    saveFailureReasons: true,
    saveRawResponses: true,
    allowAiToolCalls: false
  }
};

const PROVIDER_LABELS = {
  maton_agent: 'Maton Agent',
  google_web: 'Google Web',
  youtube_search: 'YouTube Search',
  instagram_search: 'Instagram Search',
  tiktok_search: 'TikTok Search',
  youtube_to_instagram: 'YouTube -> Instagram',
  google_web_to_instagram: 'Google/Web -> Instagram',
  seed_posts_to_profile: 'Seed Posts -> Profile',
  instagram_native_small_batch: 'Instagram Native Small Batch',
  reddit_to_instagram: 'Reddit -> Instagram',
  youtube_native_search: 'YouTube Native Search',
  google_web_to_youtube: 'Google/Web -> YouTube',
  google_web_to_tiktok: 'Google/Web -> TikTok',
  youtube_to_tiktok: 'YouTube -> TikTok',
  instagram_to_tiktok: 'Instagram -> TikTok',
  reddit_to_tiktok: 'Reddit -> TikTok',
  tiktok_native_small_batch: 'TikTok Native Small Batch',
  google_official: 'Google Official',
  scrapecreators: 'ScrapeCreators',
  brightdata: 'Bright Data',
  apify: 'Apify',
  maton_gateway: 'Maton Gateway',
  custom: 'Custom',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  custom_openai_compatible: 'Custom OpenAI-Compatible',
  custom_http_api: 'Custom HTTP API'
};

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function providerKey(scope, provider) {
  return `${scope}.${provider}`;
}

function legacyKeysFor(scope, provider) {
  if (scope === 'youtube' && provider === 'google_official') return ['youtube'];
  if (provider === 'scrapecreators') return ['scrapecreators'];
  if (provider === 'maton_gateway') return ['maton_gateway'];
  if (provider === 'brightdata') return ['brightdata'];
  if (provider === 'apify') return ['apify'];
  if (scope === 'ai' && provider === 'deepseek') return ['ai'];
  return [];
}

function hasUsableSetting(row) {
  if (!row) return false;
  if (row.api_key || row.base_url || row.model || row.extra_config) return true;
  const extra = parseJson(row.extra_config, {});
  return Boolean(
    extra.connection_id ||
    extra.auth_header_name ||
    extra.custom_provider_name
  );
}

async function getSetting(key, legacyKeys = []) {
  const direct = await dbOperations.get('SELECT * FROM api_settings WHERE provider = ?', [key]);
  if (hasUsableSetting(direct)) return direct;
  for (const legacyKey of legacyKeys) {
    const legacy = await dbOperations.get('SELECT * FROM api_settings WHERE provider = ?', [legacyKey]);
    if (hasUsableSetting(legacy)) return legacy;
  }
  return direct || null;
}

function mergeSelection(saved) {
  return {
    platforms: {
      youtube: { ...DEFAULT_SELECTION.platforms.youtube, ...(saved.platforms?.youtube || {}) },
      instagram: { ...DEFAULT_SELECTION.platforms.instagram, ...(saved.platforms?.instagram || {}) },
      tiktok: { ...DEFAULT_SELECTION.platforms.tiktok, ...(saved.platforms?.tiktok || {}) }
    },
    aiModels: { ...DEFAULT_SELECTION.aiModels, ...(saved.aiModels || {}) },
    fallbackStrategy: { ...DEFAULT_SELECTION.fallbackStrategy, ...(saved.fallbackStrategy || {}) }
  };
}

async function getSelection() {
  const row = await dbOperations.get('SELECT extra_config FROM api_settings WHERE provider = ?', [SYSTEM_SELECTION_KEY]);
  return mergeSelection(parseJson(row?.extra_config, {}));
}

async function fetchJson(url, options = {}) {
  if (typeof fetch !== 'function') throw new Error('Node.js 18+ is required');
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const detail = error?.cause?.message || error?.cause?.code || error.message;
    throw new Error(`无法连接 AI 接口 ${url}: ${detail}`);
  }
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { raw: text };
  }
  if (!response.ok) {
    throw Object.assign(
      new Error(data?.error?.message || data?.message || `HTTP ${response.status}`),
      { status: response.status }
    );
  }
  return data;
}

// 容错解析 AI 返回的 JSON（去代码围栏/think 标签/截取花括号）。
function parseAiContentRobust(content) {
  const raw = String(content || '').trim();
  const candidates = [];
  const withoutFences = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  candidates.push(withoutFences);
  candidates.push(withoutFences.replace(/<think>[\s\S]*?<\/think>/gi, '').trim());

  for (const candidate of [...candidates]) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) candidates.push(candidate.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch (error) {
      // Try the next extraction strategy.
    }
  }

  return { summary: raw || '', full_report: raw || '', score: null };
}

// 按 provider 分发 AI 调用，返回 { parsed, raw, model, content }。
async function callAi(setting, provider, systemPrompt, userPrompt) {
  if (!setting?.api_key) throw new Error(`${PROVIDER_LABELS[provider] || provider} API Key is not configured`);

  if (provider === 'minimax') {
    const extra = parseJson(setting.extra_config, {});
    const configuredBase = (setting.base_url || 'https://api.minimaxi.com/anthropic').replace(/\/$/, '');
    const model = setting.model || 'MiniMax-M3';
    const protocol = extra.api_protocol || (/\/anthropic(?:\/|$)/i.test(configuredBase) ? 'anthropic_token_plan' : 'openai');
    if (protocol === 'anthropic_token_plan') {
      const endpoint = /\/v1\/messages$/i.test(configuredBase)
        ? configuredBase
        : `${configuredBase}/v1/messages`;
      const data = await fetchJson(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': setting.api_key,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          temperature: 0.2
        })
      });
      const content = (data.content || [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text || '')
        .join('\n')
        .trim();
      if (!content) throw new Error(data?.error?.message || 'MiniMax Token Plan 未返回文本内容');
      return { parsed: parseAiContentRobust(content), raw: data, model, content };
    }
    const endpoint = /\/v1$/i.test(configuredBase) || /minimax-m3/i.test(model)
      ? `${configuredBase}/chat/completions`
      : `${configuredBase.replace(/\/v1$/i, '')}/v1/text/chatcompletion_v2`;
    const modern = endpoint.endsWith('/chat/completions');
    const data = await fetchJson(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${setting.api_key}`
      },
      body: JSON.stringify(modern ? {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2
      } : {
        model,
        messages: [
          { sender_type: 'BOT', text: systemPrompt },
          { sender_type: 'USER', text: userPrompt }
        ],
        temperature: 0.2
      })
    });
    const content = data.reply || data.output_text || data.choices?.[0]?.message?.content || data.data?.reply || JSON.stringify(data);
    return { parsed: parseAiContentRobust(content), raw: data, model, content };
  }

  const defaultBaseUrl = provider === 'openai'
    ? 'https://api.openai.com/v1'
    : provider === 'deepseek'
      ? 'https://api.deepseek.com'
      : '';
  const baseUrl = (setting.base_url || defaultBaseUrl).replace(/\/$/, '');
  if (!baseUrl) throw new Error(`${PROVIDER_LABELS[provider] || provider} Base URL is not configured`);
  const model = setting.model || (provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini');
  const data = await fetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${setting.api_key}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2
    })
  });
  const content = data.choices?.[0]?.message?.content || '{}';
  return { parsed: parseAiContentRobust(content), raw: data, model, content };
}

async function getActiveAiSetting() {
  const selection = await getSelection();
  const provider = selection.aiModels.active || 'deepseek';
  const setting = await getSetting(providerKey('ai', provider), legacyKeysFor('ai', provider));
  return { provider, setting };
}

async function callActiveAi(systemPrompt, userPrompt) {
  const { provider, setting } = await getActiveAiSetting();
  if (provider === 'custom_http_api') throw new Error('Custom HTTP API 当前仅预留，暂不可用于分析');
  if (!['minimax', 'openai', 'deepseek', 'custom_openai_compatible'].includes(provider)) {
    throw new Error(`${PROVIDER_LABELS[provider] || provider} 当前暂不可用于 AI 分析`);
  }
  return callAi(setting, provider, systemPrompt, userPrompt);
}

module.exports = {
  SYSTEM_SELECTION_KEY,
  DEFAULT_SELECTION,
  PROVIDER_LABELS,
  parseJson,
  providerKey,
  legacyKeysFor,
  getSetting,
  mergeSelection,
  getSelection,
  fetchJson,
  parseAiContentRobust,
  callAi,
  getActiveAiSetting,
  callActiveAi
};
