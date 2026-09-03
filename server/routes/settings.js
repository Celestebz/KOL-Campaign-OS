const express = require('express');
const router = express.Router();
const { dbOperations } = require('../database');
const { currentUserId } = require('../utils/requestContext');
const ownerId = (req = null) => Number(req?.user?.id || currentUserId()) || 1;

const SYSTEM_SELECTION_KEY = 'system.provider_selection';
const FEISHU_PROVIDER_KEY = 'cloud.feishu_bitable';
const FEISHU_SHEET_PROVIDER_KEY = 'cloud.feishu_sheet';
const EXTERNAL_AGENT_PROVIDER_KEY = 'agent.external_api';
const SECRET_MASK = '••••••••';

const PLATFORM_PROVIDERS = {
  youtube: ['google_official', 'maton_gateway', 'scrapecreators', 'brightdata', 'custom'],
  instagram: ['scrapecreators', 'brightdata', 'apify', 'maton_gateway', 'custom'],
  tiktok: ['scrapecreators', 'brightdata', 'apify', 'maton_gateway', 'custom']
};

const AI_PROVIDERS = ['openai', 'deepseek', 'minimax', 'custom_openai_compatible', 'custom_http_api'];

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

function isMaskedSecret(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return text === SECRET_MASK
    || /^[*•]{6,}$/.test(text)
    || /^(â€¢){2,}$/.test(text);
}

function hasUsableSecret(value) {
  const text = String(value || '').trim();
  return Boolean(text) && !isMaskedSecret(text);
}

function isConfigured(row) {
  return Boolean(hasUsableSecret(row?.api_key) || row?.base_url || row?.model);
}

function isPlatformConfigured(row) {
  return Boolean(hasUsableSecret(row?.api_key) || row?.base_url);
}

function isAiConfigured(row) {
  return Boolean(hasUsableSecret(row?.api_key) && row?.base_url && row?.model);
}

function maskSecret(value) {
  return value ? SECRET_MASK : '';
}

function preserveSecret(nextValue, currentValue = '') {
  if (nextValue === undefined || nextValue === null) return currentValue || '';
  const text = String(nextValue);
  if (!text.trim() || isMaskedSecret(text)) return currentValue || '';
  return text;
}

function cleanProvider(row, provider) {
  const extra = parseJson(row?.extra_config, {});
  return {
    provider,
    api_key: maskSecret(row?.api_key),
    base_url: row?.base_url || '',
    model: row?.model || '',
    api_protocol: extra.api_protocol || (provider === 'minimax' ? 'anthropic_token_plan' : 'openai'),
    auth_header_name: extra.auth_header_name || '',
    auth_scheme: extra.auth_scheme || '',
    connection_id: extra.connection_id || '',
    custom_provider_name: extra.custom_provider_name || '',
    notes: extra.notes || ''
  };
}

function cleanFeishu(row, sheetRow) {
  const extra = parseJson(row?.extra_config, {});
  const sheetExtra = parseJson(sheetRow?.extra_config, {});
  const hasSeparateSheetConfig = Boolean(sheetRow);
  return {
    provider: 'feishu_bitable',
    app_id: extra.app_id || '',
    app_secret: maskSecret(row?.api_key),
    base_url: row?.base_url || extra.base_url || 'https://open.feishu.cn',
    app_token: maskSecret(extra.app_token),
    sync_kol_master: extra.sync_kol_master !== false,
    kol_table_id: extra.kol_table_id || '',
    campaign_subtable_map: extra.campaign_subtable_map || '',
    campaign_tracking_map: extra.campaign_tracking_map || '',
    sheet_app_id: hasSeparateSheetConfig ? (sheetExtra.app_id || '') : (extra.app_id || ''),
    sheet_app_secret: maskSecret(hasSeparateSheetConfig ? sheetRow?.api_key : row?.api_key),
    sheet_base_url: (hasSeparateSheetConfig ? (sheetRow?.base_url || sheetExtra.base_url) : (row?.base_url || extra.base_url)) || 'https://open.feishu.cn',
    sheet_wiki_node_token: (hasSeparateSheetConfig ? sheetExtra.sheet_wiki_node_token : extra.sheet_wiki_node_token) || '',
    sheet_id: (hasSeparateSheetConfig ? sheetExtra.sheet_id : extra.sheet_id) || '',
    sheet_purpose_map: (hasSeparateSheetConfig ? sheetExtra.sheet_purpose_map : extra.sheet_purpose_map) || '',
    notes: extra.notes || ''
  };
}

function cleanExternalAgent(row) {
  const extra = parseJson(row?.extra_config, {});
  return {
    provider: 'external_agent_api',
    api_token: maskSecret(row?.api_key),
    enabled: extra.enabled !== false,
    notes: extra.notes || ''
  };
}

function getRow(rows, key) {
  return rows.find((row) => row.provider === key);
}

function findProviderRow(rows, key, legacyKeys = []) {
  const direct = getRow(rows, key);
  if (isConfigured(direct)) return direct;
  for (const legacyKey of legacyKeys) {
    const legacy = getRow(rows, legacyKey);
    if (isConfigured(legacy)) return legacy;
  }
  return direct || null;
}

function legacyKeysFor(scope, provider) {
  if (scope === 'youtube' && provider === 'google_official') return ['youtube'];
  if (provider === 'scrapecreators') return ['scrapecreators'];
  if (provider === 'brightdata') return ['brightdata'];
  if (provider === 'apify') return ['apify'];
  if (scope === 'ai' && provider === 'deepseek') return ['ai'];
  return [];
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

async function upsertProvider(key, row = {}) {
  const ownerUserId = ownerId();
  const current = await dbOperations.get('SELECT api_key FROM api_settings WHERE provider = ? AND owner_user_id = ?', [key, ownerUserId]);
  const apiProtocol = row.api_protocol || (key === 'ai.minimax' ? 'anthropic_token_plan' : 'openai');
  const submittedBaseUrl = String(row.base_url || '').trim();
  const baseUrl = key === 'ai.minimax'
    && apiProtocol === 'anthropic_token_plan'
    && (!submittedBaseUrl || /^https:\/\/api\.minimaxi?\.com\/v1\/?$/i.test(submittedBaseUrl) || /^https:\/\/api\.minimax\.io\/v1\/?$/i.test(submittedBaseUrl))
    ? 'https://api.minimaxi.com/anthropic'
    : submittedBaseUrl;
  const extraConfig = {
    api_protocol: apiProtocol,
    auth_header_name: row.auth_header_name || '',
    auth_scheme: row.auth_scheme || '',
    connection_id: row.connection_id || '',
    custom_provider_name: row.custom_provider_name || '',
    notes: row.notes || ''
  };

  await dbOperations.run(
    `INSERT INTO api_settings (owner_user_id, provider, api_key, base_url, model, extra_config, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       api_key = VALUES(api_key),
       base_url = VALUES(base_url),
       model = VALUES(model),
       extra_config = VALUES(extra_config),
       updated_at = CURRENT_TIMESTAMP`,
    [
      ownerUserId, key,
      preserveSecret(row.api_key, current?.api_key),
      baseUrl,
      row.model || '',
      JSON.stringify(extraConfig)
    ]
  );
}

async function upsertSelection(selection) {
  const ownerUserId = ownerId();
  await dbOperations.run(
    `INSERT INTO api_settings (owner_user_id, provider, api_key, base_url, model, extra_config, updated_at)
     VALUES (?, ?, '', '', '', ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       extra_config = VALUES(extra_config),
       updated_at = CURRENT_TIMESTAMP`,
    [ownerUserId, SYSTEM_SELECTION_KEY, JSON.stringify(selection)]
  );
}

async function upsertFeishu(row = {}) {
  const ownerUserId = ownerId();
  const current = await dbOperations.get('SELECT api_key, extra_config FROM api_settings WHERE provider = ? AND owner_user_id = ?', [FEISHU_PROVIDER_KEY, ownerUserId]);
  const currentExtra = parseJson(current?.extra_config, {});
  const extraConfig = {
    app_id: row.app_id || '',
    app_token: preserveSecret(row.app_token, currentExtra.app_token),
    sync_kol_master: row.sync_kol_master !== false,
    kol_table_id: row.kol_table_id || '',
    campaign_subtable_map: row.campaign_subtable_map || '',
    campaign_tracking_map: row.campaign_tracking_map || '',
    notes: row.notes || ''
  };

  await dbOperations.run(
    `INSERT INTO api_settings (owner_user_id, provider, api_key, base_url, model, extra_config, updated_at)
     VALUES (?, ?, ?, ?, '', ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       api_key = VALUES(api_key),
       base_url = VALUES(base_url),
       extra_config = VALUES(extra_config),
       updated_at = CURRENT_TIMESTAMP`,
    [
      ownerUserId,
      FEISHU_PROVIDER_KEY,
      preserveSecret(row.app_secret, current?.api_key),
      row.base_url || 'https://open.feishu.cn',
      JSON.stringify(extraConfig)
    ]
  );
}

async function upsertFeishuSheet(row = {}) {
  const ownerUserId = ownerId();
  const current = await dbOperations.get('SELECT api_key FROM api_settings WHERE provider = ? AND owner_user_id = ?', [FEISHU_SHEET_PROVIDER_KEY, ownerUserId]);
  const extraConfig = {
    app_id: row.sheet_app_id || '',
    sheet_wiki_node_token: row.sheet_wiki_node_token || '',
    sheet_id: row.sheet_id || '',
    sheet_purpose_map: row.sheet_purpose_map || ''
  };

  await dbOperations.run(
    `INSERT INTO api_settings (owner_user_id, provider, api_key, base_url, model, extra_config, updated_at)
     VALUES (?, ?, ?, ?, '', ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       api_key = VALUES(api_key),
       base_url = VALUES(base_url),
       extra_config = VALUES(extra_config),
       updated_at = CURRENT_TIMESTAMP`,
    [
      ownerUserId,
      FEISHU_SHEET_PROVIDER_KEY,
      preserveSecret(row.sheet_app_secret, current?.api_key),
      row.sheet_base_url || 'https://open.feishu.cn',
      JSON.stringify(extraConfig)
    ]
  );
}

async function upsertExternalAgent(row = {}) {
  const ownerUserId = ownerId();
  const current = await dbOperations.get('SELECT api_key FROM api_settings WHERE provider = ? AND owner_user_id = ?', [EXTERNAL_AGENT_PROVIDER_KEY, ownerUserId]);
  const extraConfig = {
    enabled: row.enabled !== false,
    notes: row.notes || ''
  };
  await dbOperations.run(
    `INSERT INTO api_settings (owner_user_id, provider, api_key, base_url, model, extra_config, updated_at)
     VALUES (?, ?, ?, '', '', ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       api_key = VALUES(api_key),
       extra_config = VALUES(extra_config),
       updated_at = CURRENT_TIMESTAMP`,
    [
      ownerUserId,
      EXTERNAL_AGENT_PROVIDER_KEY,
      preserveSecret(row.api_token, current?.api_key),
      JSON.stringify(extraConfig)
    ]
  );
}

router.get('/', async (req, res) => {
  try {
    const rows = await dbOperations.query('SELECT provider, api_key, base_url, model, extra_config, updated_at FROM api_settings WHERE owner_user_id = ? ORDER BY provider', [ownerId(req)]);
    const savedSelection = parseJson(getRow(rows, SYSTEM_SELECTION_KEY)?.extra_config, {});
    const selection = mergeSelection(savedSelection);

    const data = {
      platforms: {},
      aiModels: { active: selection.aiModels.active, providers: {} },
      cloudStorage: {
        primary: 'feishu_bitable',
        feishu: cleanFeishu(getRow(rows, FEISHU_PROVIDER_KEY), getRow(rows, FEISHU_SHEET_PROVIDER_KEY))
      },
      externalAgent: cleanExternalAgent(getRow(rows, EXTERNAL_AGENT_PROVIDER_KEY)),
      fallbackStrategy: selection.fallbackStrategy
    };

    for (const [platform, providers] of Object.entries(PLATFORM_PROVIDERS)) {
      data.platforms[platform] = {
        primary: selection.platforms[platform].primary,
        fallbacks: selection.platforms[platform].fallbacks || [],
        providers: {}
      };

      for (const provider of providers) {
        const key = providerKey(platform, provider);
        const row = findProviderRow(rows, key, legacyKeysFor(platform, provider));
        data.platforms[platform].providers[provider] = cleanProvider(row, provider);
      }
    }

    for (const provider of AI_PROVIDERS) {
      const key = providerKey('ai', provider);
      const row = findProviderRow(rows, key, legacyKeysFor('ai', provider));
      data.aiModels.providers[provider] = cleanProvider(row, provider);
    }

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const settings = req.body.settings || req.body;
    const selection = {
      platforms: {
        youtube: {
          primary: settings.platforms?.youtube?.primary || DEFAULT_SELECTION.platforms.youtube.primary,
          fallbacks: settings.platforms?.youtube?.fallbacks || []
        },
        instagram: {
          primary: settings.platforms?.instagram?.primary || DEFAULT_SELECTION.platforms.instagram.primary,
          fallbacks: settings.platforms?.instagram?.fallbacks || []
        },
        tiktok: {
          primary: settings.platforms?.tiktok?.primary || DEFAULT_SELECTION.platforms.tiktok.primary,
          fallbacks: settings.platforms?.tiktok?.fallbacks || []
        }
      },
      aiModels: {
        active: settings.aiModels?.active || DEFAULT_SELECTION.aiModels.active
      },
      fallbackStrategy: {
        ...DEFAULT_SELECTION.fallbackStrategy,
        ...(settings.fallbackStrategy || {})
      }
    };

    await upsertSelection(selection);

    for (const [platform, providers] of Object.entries(PLATFORM_PROVIDERS)) {
      for (const provider of providers) {
        const row = settings.platforms?.[platform]?.providers?.[provider];
        if (row) await upsertProvider(providerKey(platform, provider), row);
      }
    }

    for (const provider of AI_PROVIDERS) {
      const row = settings.aiModels?.providers?.[provider];
      if (row) await upsertProvider(providerKey('ai', provider), row);
    }

    if (settings.cloudStorage?.feishu) {
      await upsertFeishu(settings.cloudStorage.feishu);
      await upsertFeishuSheet(settings.cloudStorage.feishu);
    }

    if (settings.externalAgent) {
      await upsertExternalAgent(settings.externalAgent);
    }

    res.json({ success: true, message: 'Settings saved' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/test-ai', async (req, res) => {
  try {
    const aiClient = require('../services/aiClient');
    const result = await aiClient.callActiveAi(
      'Return valid JSON only.',
      'Return exactly {"summary":"connection ok"}.'
    );
    res.json({ success: true, data: { provider: result.provider, model: result.model } });
  } catch (error) {
    res.status(error.status || 502).json({ success: false, error: error.message });
  }
});

router.get('/health/config', async (req, res) => {
  try {
    const ownerUserId = ownerId(req);
    const setting = (provider) => dbOperations.get('SELECT * FROM api_settings WHERE provider = ? AND owner_user_id = ?', [provider, ownerUserId]);
    const selectionRow = await setting(SYSTEM_SELECTION_KEY);
    const selection = parseJson(selectionRow?.extra_config, DEFAULT_SELECTION);

    const aiActive = selection.aiModels?.active || DEFAULT_SELECTION.aiModels.active;
    const aiRow = await setting(providerKey('ai', aiActive));

    const platforms = {};
    for (const [platform, providers] of Object.entries(PLATFORM_PROVIDERS)) {
      const platformConfig = selection.platforms?.[platform] || DEFAULT_SELECTION.platforms[platform];
      const primary = platformConfig?.primary || DEFAULT_SELECTION.platforms[platform].primary;
      const primaryRow = await setting(providerKey(platform, primary));
      const fallbackStatus = [];
      for (const fb of (platformConfig?.fallbacks || [])) {
        const fbRow = await setting(providerKey(platform, fb));
        fallbackStatus.push({ provider: fb, configured: isPlatformConfigured(fbRow) });
      }
      const missing = [];
      if (!isPlatformConfigured(primaryRow)) {
        missing.push(`${primary} provider config (api_key/base_url)`);
      }
      platforms[platform] = {
        primary,
        configured: isPlatformConfigured(primaryRow),
        fallbacks: fallbackStatus,
        missing
      };
    }

    const externalAgentRow = await setting(EXTERNAL_AGENT_PROVIDER_KEY);
    const externalAgentExtra = parseJson(externalAgentRow?.extra_config, {});

    const feishuRow = await setting(FEISHU_PROVIDER_KEY);
    const feishuExtra = parseJson(feishuRow?.extra_config, {});

    const checks = {
      database: { ok: true },
      ai: {
        active: aiActive,
        configured: isAiConfigured(aiRow),
        required_fields: ['api_key', 'base_url', 'model'],
        missing: []
      },
      platforms,
      external_agent: {
        enabled: Boolean(externalAgentExtra.enabled),
        token_configured: hasUsableSecret(externalAgentRow?.api_key) || hasUsableSecret(externalAgentExtra.token),
        missing: []
      },
      feishu: {
        configured: hasUsableSecret(feishuRow?.api_key) && hasUsableSecret(feishuExtra.app_token)
      }
    };

    if (!checks.ai.configured) {
      if (!hasUsableSecret(aiRow?.api_key)) checks.ai.missing.push('api_key');
      if (!aiRow?.base_url) checks.ai.missing.push('base_url');
      if (!aiRow?.model) checks.ai.missing.push('model');
    }

    if (checks.external_agent.enabled && !checks.external_agent.token_configured) {
      checks.external_agent.missing.push('token');
    }

    const allOk = checks.ai.configured && Object.values(platforms).every((p) => p.configured) && checks.external_agent.token_configured;
    checks.summary = {
      total_platforms: Object.keys(platforms).length,
      configured_platforms: Object.values(platforms).filter((p) => p.configured).length,
      primary_providers: Object.fromEntries(Object.entries(platforms).map(([k, v]) => [k, v.primary]))
    };

    res.json({ success: true, data: { ready: allOk, checks } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
