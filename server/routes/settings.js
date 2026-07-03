const express = require('express');
const router = express.Router();
const { dbOperations } = require('../database');

const SYSTEM_SELECTION_KEY = 'system.provider_selection';
const FEISHU_PROVIDER_KEY = 'cloud.feishu_bitable';
const EXTERNAL_AGENT_PROVIDER_KEY = 'agent.external_api';

const PLATFORM_PROVIDERS = {
  youtube: ['google_official', 'maton_gateway', 'scrapecreators', 'brightdata', 'custom'],
  instagram: ['scrapecreators', 'brightdata', 'apify', 'maton_gateway', 'custom'],
  tiktok: ['scrapecreators', 'brightdata', 'apify', 'maton_gateway', 'custom']
};

const AI_PROVIDERS = ['openai', 'deepseek', 'minimax', 'custom_openai_compatible', 'custom_http_api'];
const AGENT_PROVIDERS = ['maton_gateway', 'browseract', 'playwright_local', 'custom_tool_gateway'];

const DEFAULT_SELECTION = {
  platforms: {
    youtube: { primary: 'google_official', fallbacks: [] },
    instagram: { primary: 'scrapecreators', fallbacks: [] },
    tiktok: { primary: 'scrapecreators', fallbacks: [] }
  },
  aiModels: { active: 'deepseek' },
  agents: { active: 'maton_gateway' },
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

function isConfigured(row) {
  return Boolean(row?.api_key || row?.base_url || row?.model || row?.extra_config);
}

function cleanProvider(row, provider) {
  const extra = parseJson(row?.extra_config, {});
  return {
    provider,
    api_key: row?.api_key || '',
    base_url: row?.base_url || '',
    model: row?.model || '',
    auth_header_name: extra.auth_header_name || '',
    auth_scheme: extra.auth_scheme || '',
    connection_id: extra.connection_id || '',
    custom_provider_name: extra.custom_provider_name || '',
    notes: extra.notes || ''
  };
}

function cleanFeishu(row) {
  const extra = parseJson(row?.extra_config, {});
  return {
    provider: 'feishu_bitable',
    app_id: extra.app_id || '',
    app_secret: row?.api_key || '',
    base_url: row?.base_url || extra.base_url || 'https://open.feishu.cn',
    app_token: extra.app_token || '',
    kol_table_id: extra.kol_table_id || '',
    campaign_kol_table_id: extra.campaign_kol_table_id || '',
    campaign_table_id: extra.campaign_table_id || '',
    notes: extra.notes || ''
  };
}

function cleanExternalAgent(row) {
  const extra = parseJson(row?.extra_config, {});
  return {
    provider: 'external_agent_api',
    api_token: row?.api_key || '',
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
    agents: { ...DEFAULT_SELECTION.agents, ...(saved.agents || {}) },
    fallbackStrategy: { ...DEFAULT_SELECTION.fallbackStrategy, ...(saved.fallbackStrategy || {}) }
  };
}

async function upsertProvider(key, row = {}) {
  const extraConfig = {
    auth_header_name: row.auth_header_name || '',
    auth_scheme: row.auth_scheme || '',
    connection_id: row.connection_id || '',
    custom_provider_name: row.custom_provider_name || '',
    notes: row.notes || ''
  };

  await dbOperations.run(
    `INSERT INTO api_settings (provider, api_key, base_url, model, extra_config, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(provider) DO UPDATE SET
       api_key = excluded.api_key,
       base_url = excluded.base_url,
       model = excluded.model,
       extra_config = excluded.extra_config,
       updated_at = CURRENT_TIMESTAMP`,
    [
      key,
      row.api_key || '',
      row.base_url || '',
      row.model || '',
      JSON.stringify(extraConfig)
    ]
  );
}

async function upsertSelection(selection) {
  await dbOperations.run(
    `INSERT INTO api_settings (provider, api_key, base_url, model, extra_config, updated_at)
     VALUES (?, '', '', '', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(provider) DO UPDATE SET
       extra_config = excluded.extra_config,
       updated_at = CURRENT_TIMESTAMP`,
    [SYSTEM_SELECTION_KEY, JSON.stringify(selection)]
  );
}

async function upsertFeishu(row = {}) {
  const extraConfig = {
    app_id: row.app_id || '',
    app_token: row.app_token || '',
    kol_table_id: row.kol_table_id || '',
    campaign_kol_table_id: row.campaign_kol_table_id || '',
    campaign_table_id: row.campaign_table_id || '',
    notes: row.notes || ''
  };

  await dbOperations.run(
    `INSERT INTO api_settings (provider, api_key, base_url, model, extra_config, updated_at)
     VALUES (?, ?, ?, '', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(provider) DO UPDATE SET
       api_key = excluded.api_key,
       base_url = excluded.base_url,
       extra_config = excluded.extra_config,
       updated_at = CURRENT_TIMESTAMP`,
    [
      FEISHU_PROVIDER_KEY,
      row.app_secret || '',
      row.base_url || 'https://open.feishu.cn',
      JSON.stringify(extraConfig)
    ]
  );
}

async function upsertExternalAgent(row = {}) {
  const extraConfig = {
    enabled: row.enabled !== false,
    notes: row.notes || ''
  };
  await dbOperations.run(
    `INSERT INTO api_settings (provider, api_key, base_url, model, extra_config, updated_at)
     VALUES (?, ?, '', '', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(provider) DO UPDATE SET
       api_key = excluded.api_key,
       extra_config = excluded.extra_config,
       updated_at = CURRENT_TIMESTAMP`,
    [
      EXTERNAL_AGENT_PROVIDER_KEY,
      row.api_token || '',
      JSON.stringify(extraConfig)
    ]
  );
}

router.get('/', async (req, res) => {
  try {
    const rows = await dbOperations.query('SELECT provider, api_key, base_url, model, extra_config, updated_at FROM api_settings ORDER BY provider');
    const savedSelection = parseJson(getRow(rows, SYSTEM_SELECTION_KEY)?.extra_config, {});
    const selection = mergeSelection(savedSelection);

    const data = {
      platforms: {},
      aiModels: { active: selection.aiModels.active, providers: {} },
      agents: { active: selection.agents.active, providers: {} },
      cloudStorage: {
        primary: 'feishu_bitable',
        feishu: cleanFeishu(getRow(rows, FEISHU_PROVIDER_KEY))
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

    for (const provider of AGENT_PROVIDERS) {
      const key = providerKey('agent', provider);
      const row = findProviderRow(rows, key);
      data.agents.providers[provider] = cleanProvider(row, provider);
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
      agents: {
        active: settings.agents?.active || DEFAULT_SELECTION.agents.active
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

    for (const provider of AGENT_PROVIDERS) {
      const row = settings.agents?.providers?.[provider];
      if (row) await upsertProvider(providerKey('agent', provider), row);
    }

    if (settings.cloudStorage?.feishu) {
      await upsertFeishu(settings.cloudStorage.feishu);
    }

    if (settings.externalAgent) {
      await upsertExternalAgent(settings.externalAgent);
    }

    res.json({ success: true, message: 'Settings saved' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
