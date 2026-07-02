const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const { dbOperations } = require('../database');

const router = express.Router();

const SYSTEM_SELECTION_KEY = 'system.provider_selection';
const MAX_MATERIAL_CHARS = 50000;
const MAX_MATERIAL_FILES = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

function getDataDir() {
  if (process.pkg) return path.join(path.dirname(process.execPath), 'data');
  return path.join(__dirname, '..', '..', 'data');
}

const materialUploadsDir = path.join(getDataDir(), 'uploads', 'strategy-materials');
if (!fs.existsSync(materialUploadsDir)) fs.mkdirSync(materialUploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, materialUploadsDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_MATERIAL_FILES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.txt', '.pdf', '.docx'].includes(ext)) cb(null, true);
    else cb(new Error('Only TXT, PDF, and DOCX files are supported'));
  }
});

const DEFAULT_SCORING_WEIGHTS = {
  content_relevance: 25,
  audience_market_fit: 20,
  content_quality: 15,
  engagement_quality: 15,
  commercial_collaboration_fit: 10,
  conversion_potential: 15,
  risk_deduction_max: 10,
  approval_threshold: 75,
  hero_threshold: 85,
  mid_tier_threshold: 75,
  micro_threshold: 65
};

const DEFAULT_SEARCH_CYCLES = [
  { cycle: 'C1', name: 'Competitor Reviews', priority: 1, keywords: '', platforms: '', target_count: '', exclusions: '', purpose: 'Find creators already reviewing competitors.' },
  { cycle: 'C2', name: 'Category Search', priority: 2, keywords: '', platforms: '', target_count: '', exclusions: '', purpose: 'Find creators ranking or reviewing the category.' },
  { cycle: 'C3', name: 'Use-case Search', priority: 3, keywords: '', platforms: '', target_count: '', exclusions: '', purpose: 'Find creators around specific usage scenarios.' },
  { cycle: 'C4', name: 'Feature / Technical Search', priority: 4, keywords: '', platforms: '', target_count: '', exclusions: '', purpose: 'Find technical demos and feature-led creators.' },
  { cycle: 'C5', name: 'Community / Audience Search', priority: 5, keywords: '', platforms: '', target_count: '', exclusions: '', purpose: 'Find audience communities and niche experts.' },
  { cycle: 'C6', name: 'Platform Native Search', priority: 6, keywords: '', platforms: '', target_count: '', exclusions: '', purpose: 'Use hashtags, playlists, reels, shorts, and native search.' },
  { cycle: 'C7', name: 'Spider-web Expansion', priority: 7, keywords: '', platforms: '', target_count: '', exclusions: '', purpose: 'Expand from similar creators, collaborations, tags, and comments.' }
];

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function asJson(value, fallback) {
  if (value === undefined || value === null || value === '') return JSON.stringify(fallback);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function normalizeStrategy(row) {
  if (!row) return row;
  return {
    ...row,
    secondary_platforms: parseJson(row.secondary_platforms, []),
    product_context: parseJson(row.product_context, {}),
    persona_config: parseJson(row.persona_config, {}),
    search_strategy: parseJson(row.search_strategy, DEFAULT_SEARCH_CYCLES),
    scoring_weights: parseJson(row.scoring_weights, DEFAULT_SCORING_WEIGHTS),
    finder_handoff: parseJson(row.finder_handoff, {}),
    source_material_meta: parseJson(row.source_material_meta, {}),
    research_sources: parseJson(row.research_sources, [])
  };
}

function extractJson(content) {
  const raw = String(content || '').trim();
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const candidates = [stripped];
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(stripped.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      // try next
    }
  }
  throw new Error('AI did not return valid JSON');
}

function readTextFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return '';
  }
}

function loadKolStrategySkillContext() {
  const skillRoot = path.join(__dirname, '..', '..', 'skills', 'kol-strategy');
  const skill = readTextFileIfExists(path.join(skillRoot, 'SKILL.md'));
  const schema = readTextFileIfExists(path.join(skillRoot, 'references', 'strategy-output-schema.md'));
  return [skill, schema].filter(Boolean).join('\n\n---\n\n');
}

async function extractMaterialFileText(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.txt') {
    return fs.readFileSync(file.path, 'utf8');
  }
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: file.path });
    return result.value || '';
  }
  if (ext === '.pdf') {
    const buffer = fs.readFileSync(file.path);
    const result = await pdfParse(buffer);
    return result.text || '';
  }
  throw new Error(`Unsupported file type: ${ext}`);
}

async function collectMaterialContext(briefText, files = []) {
  const fileDetails = [];
  const parts = [];
  const cleanBrief = clean(briefText);
  if (cleanBrief) {
    parts.push(`Pasted Brief:\n${cleanBrief}`);
  }

  for (const file of files) {
    const text = clean(await extractMaterialFileText(file));
    fileDetails.push({
      original_name: file.originalname,
      size: file.size,
      extracted_chars: text.length
    });
    if (text) {
      parts.push(`File: ${file.originalname}\n${text}`);
    }
  }

  const fullText = parts.join('\n\n---\n\n');
  if (!clean(fullText)) throw new Error('Please paste a brief or upload TXT, PDF, or DOCX files');
  const truncatedText = fullText.length > MAX_MATERIAL_CHARS
    ? fullText.slice(0, MAX_MATERIAL_CHARS)
    : fullText;
  const materialType = cleanBrief && files.length
    ? 'mixed'
    : files.length
      ? 'user_uploaded'
      : 'pasted_text';

  return {
    text: truncatedText,
    type: materialType,
    meta: {
      source_material_type: materialType,
      pasted_chars: cleanBrief.length,
      file_count: files.length,
      files: fileDetails,
      original_chars: fullText.length,
      used_chars: truncatedText.length,
      max_chars: MAX_MATERIAL_CHARS,
      truncated: fullText.length > MAX_MATERIAL_CHARS
    }
  };
}

async function getSelection() {
  const row = await dbOperations.get('SELECT extra_config FROM api_settings WHERE provider = ?', [SYSTEM_SELECTION_KEY]);
  return parseJson(row?.extra_config, { aiModels: { active: 'deepseek' } });
}

async function getAiSetting(provider) {
  const key = `ai.${provider}`;
  const direct = await dbOperations.get('SELECT * FROM api_settings WHERE provider = ?', [key]);
  if (direct?.api_key || direct?.base_url || direct?.model) return direct;
  if (provider === 'deepseek') {
    return dbOperations.get('SELECT * FROM api_settings WHERE provider = ?', ['ai']);
  }
  return direct;
}

async function fetchJson(url, options = {}) {
  if (typeof fetch !== 'function') throw new Error('Node.js 18+ is required for AI strategy generation');
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `HTTP ${response.status}`);
  }
  return data;
}

async function callOpenAiCompatible(setting, provider, systemPrompt, userPrompt) {
  if (!setting?.api_key) throw new Error(`${provider} API Key is not configured`);
  const defaultBaseUrl = provider === 'openai'
    ? 'https://api.openai.com/v1'
    : provider === 'deepseek'
      ? 'https://api.deepseek.com'
      : '';
  const baseUrl = (setting.base_url || defaultBaseUrl).replace(/\/$/, '');
  if (!baseUrl) throw new Error(`${provider} Base URL is not configured`);
  const model = setting.model || (provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini');

  const data = await fetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${setting.api_key}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });
  return data.choices?.[0]?.message?.content || '{}';
}

async function callMiniMax(setting, systemPrompt, userPrompt) {
  if (!setting?.api_key) throw new Error('MiniMax API Key is not configured');
  const baseUrl = (setting.base_url || 'https://api.minimax.com/v1').replace(/\/$/, '');
  const model = setting.model || 'MiniMax-M3';
  const data = await fetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${setting.api_key}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });
  return data.choices?.[0]?.message?.content || '{}';
}

function buildStrategyPrompt(strategy, campaign, materialContext = null) {
  return JSON.stringify({
    task: materialContext
      ? 'Analyze the provided product materials and generate a KOL campaign strategy draft by following the bundled kol-strategy skill. Return JSON only.'
      : 'Generate a KOL campaign strategy draft by following the bundled kol-strategy skill. Return JSON only.',
    campaign: {
      name: campaign?.name || strategy.name,
      brand: strategy.brand || campaign?.brand || '',
      product: strategy.product || campaign?.product || '',
      category: strategy.category || '',
      target_market: strategy.target_market || '',
      language: strategy.language || '',
      primary_platform: strategy.primary_platform || '',
      secondary_platforms: parseJson(strategy.secondary_platforms, []),
      campaign_goal: strategy.campaign_goal || ''
    },
    required_json_schema: {
      product_context: {
        product_line: '',
        key_selling_points: [],
        must_show_functions: [],
        target_users: [],
        buying_triggers: [],
        objections: [],
        price_positioning: '',
        competitors: [],
        alternatives: [],
        scenarios: []
      },
      persona_config: {
        primary_persona: '',
        secondary_personas: [],
        exclusion_personas: [],
        positive_audience_signals: [],
        negative_signals: [],
        best_content_formats: []
      },
      search_strategy: DEFAULT_SEARCH_CYCLES,
      scoring_weights: DEFAULT_SCORING_WEIGHTS,
      finder_handoff: {
        required_platforms: [],
        required_keywords: [],
        competitor_keywords: [],
        exclusion_keywords: [],
        minimum_followers: '',
        minimum_avg_views: '',
        required_evidence: [],
        approve_threshold: 75,
        tier_rules: {
          hero: 'final_score >= 85 and strong strategic fit',
          mid_tier: 'final_score 75-84 or strong niche fit',
          micro: 'final_score 65-74 with clear use-case/community value'
        }
      }
    },
    existing_strategy_sections: {
      product_context: parseJson(strategy.product_context, {}),
      persona_config: parseJson(strategy.persona_config, {}),
      search_strategy: parseJson(strategy.search_strategy, DEFAULT_SEARCH_CYCLES),
      scoring_weights: parseJson(strategy.scoring_weights, DEFAULT_SCORING_WEIGHTS),
      finder_handoff: parseJson(strategy.finder_handoff, {})
    },
    material_context: materialContext ? {
      source_material_type: materialContext.type,
      meta: materialContext.meta,
      text: materialContext.text
    } : undefined,
    required_extra_output: materialContext ? {
      source_material_summary: 'Summarize the AI understanding of the provided materials in Chinese or the user material language. Mention product, target user, selling points, doubts, competitors, and evidence gaps.'
    } : undefined,
    instruction: materialContext
      ? 'Base the strategy primarily on material_context. Preserve useful existing strategy details only when they do not conflict with the material. Include source_material_summary.'
      : 'Preserve useful user-provided details from existing_strategy_sections, improve weak or empty fields, and keep the output brand-agnostic and reusable across categories.'
  }, null, 2);
}

async function generateDraft(strategy, materialContext = null) {
  const selection = await getSelection();
  const provider = selection.aiModels?.active || 'deepseek';
  if (provider === 'custom_http_api') throw new Error('Custom HTTP API is reserved and cannot generate strategy drafts yet');
  const setting = await getAiSetting(provider);
  const campaign = await dbOperations.get('SELECT * FROM campaigns WHERE id = ?', [strategy.campaign_id]);
  const skillContext = loadKolStrategySkillContext();
  const systemPrompt = [
    'You are a senior KOL campaign strategist inside KOL Campaign OS.',
    'Return valid JSON only. Do not include Markdown, comments, or chain-of-thought.',
    'Follow the bundled kol-strategy skill instructions and output schema exactly.',
    skillContext || 'Use a structured KOL strategy schema with product_context, persona_config, search_strategy, scoring_weights, and finder_handoff.'
  ].join('\n\n');
  const userPrompt = buildStrategyPrompt(strategy, campaign, materialContext);
  const content = provider === 'minimax'
    ? await callMiniMax(setting, systemPrompt, userPrompt)
    : await callOpenAiCompatible(setting, provider, systemPrompt, userPrompt);
  return extractJson(content);
}

async function getStrategy(id) {
  const row = await dbOperations.get(`
    SELECT ks.*, c.name as campaign_name
    FROM kol_strategies ks
    LEFT JOIN campaigns c ON c.id = ks.campaign_id
    WHERE ks.id = ?
  `, [id]);
  return normalizeStrategy(row);
}

function validateReady(strategy) {
  const missing = [];
  if (!clean(strategy.name)) missing.push('Strategy name');
  if (!strategy.campaign_id) missing.push('Campaign');
  if (!clean(strategy.target_market)) missing.push('Target market');
  if (!clean(strategy.primary_platform)) missing.push('Primary platform');
  if (!clean(strategy.campaign_goal)) missing.push('Campaign goal');
  if (!Object.keys(strategy.product_context || {}).length) missing.push('Product Breakdown');
  if (!Object.keys(strategy.persona_config || {}).length) missing.push('KOL Persona');
  if (!Array.isArray(strategy.search_strategy) || !strategy.search_strategy.length) missing.push('Search Strategy');
  if (!Object.keys(strategy.finder_handoff || {}).length) missing.push('Finder Handoff');
  if (missing.length) throw new Error(`Cannot mark ready. Missing: ${missing.join(', ')}`);
}

router.get('/', async (req, res) => {
  try {
    const { campaign_id, status, search } = req.query;
    let sql = `
      SELECT ks.*, c.name as campaign_name
      FROM kol_strategies ks
      LEFT JOIN campaigns c ON c.id = ks.campaign_id
      WHERE 1=1
    `;
    const params = [];
    if (campaign_id) {
      sql += ' AND ks.campaign_id = ?';
      params.push(campaign_id);
    }
    if (status) {
      sql += ' AND ks.status = ?';
      params.push(status);
    }
    if (search) {
      sql += ' AND (ks.name LIKE ? OR ks.brand LIKE ? OR ks.product LIKE ? OR ks.category LIKE ? OR c.name LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term, term, term);
    }
    sql += ' ORDER BY CASE WHEN ks.status = "ready" THEN 0 ELSE 1 END, ks.updated_at DESC, ks.id DESC';
    const rows = await dbOperations.query(sql, params);
    res.json({ success: true, data: rows.map(normalizeStrategy) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const campaignId = Number(body.campaign_id || 1);
    const campaign = await dbOperations.get('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    const name = clean(body.name || `${campaign?.name || 'Campaign'} Strategy`);
    const result = await dbOperations.run(
      `INSERT INTO kol_strategies
       (campaign_id, name, brand, product, category, target_market, language, primary_platform,
        secondary_platforms, campaign_goal, status, product_context, persona_config,
        search_strategy, scoring_weights, finder_handoff)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        campaignId,
        name,
        body.brand ?? campaign?.brand ?? '',
        body.product ?? campaign?.product ?? campaign?.name ?? '',
        clean(body.category),
        clean(body.target_market),
        clean(body.language),
        clean(body.primary_platform),
        asJson(body.secondary_platforms, []),
        clean(body.campaign_goal),
        clean(body.status) || 'draft',
        asJson(body.product_context, {}),
        asJson(body.persona_config, {}),
        asJson(body.search_strategy, DEFAULT_SEARCH_CYCLES),
        asJson(body.scoring_weights, DEFAULT_SCORING_WEIGHTS),
        asJson(body.finder_handoff, {})
      ]
    );
    res.json({ success: true, data: await getStrategy(result.id), message: 'Strategy created' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const body = req.body || {};
    await dbOperations.run(
      `UPDATE kol_strategies SET
       campaign_id = ?, name = ?, brand = ?, product = ?, category = ?, target_market = ?,
       language = ?, primary_platform = ?, secondary_platforms = ?, campaign_goal = ?,
       product_context = ?, persona_config = ?, search_strategy = ?, scoring_weights = ?,
       finder_handoff = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        Number(body.campaign_id || 1),
        clean(body.name),
        clean(body.brand),
        clean(body.product),
        clean(body.category),
        clean(body.target_market),
        clean(body.language),
        clean(body.primary_platform),
        asJson(body.secondary_platforms, []),
        clean(body.campaign_goal),
        asJson(body.product_context, {}),
        asJson(body.persona_config, {}),
        asJson(body.search_strategy, DEFAULT_SEARCH_CYCLES),
        asJson(body.scoring_weights, DEFAULT_SCORING_WEIGHTS),
        asJson(body.finder_handoff, {}),
        req.params.id
      ]
    );
    res.json({ success: true, data: await getStrategy(req.params.id), message: 'Strategy saved' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/generate-draft', async (req, res) => {
  try {
    const strategy = await getStrategy(req.params.id);
    if (!strategy) return res.status(404).json({ success: false, error: 'Strategy not found' });
    const draft = await generateDraft(strategy);
    const merged = {
      product_context: draft.product_context || strategy.product_context || {},
      persona_config: draft.persona_config || strategy.persona_config || {},
      search_strategy: draft.search_strategy || strategy.search_strategy || DEFAULT_SEARCH_CYCLES,
      scoring_weights: draft.scoring_weights || strategy.scoring_weights || DEFAULT_SCORING_WEIGHTS,
      finder_handoff: draft.finder_handoff || strategy.finder_handoff || {}
    };
    await dbOperations.run(
      `UPDATE kol_strategies SET product_context = ?, persona_config = ?, search_strategy = ?,
       scoring_weights = ?, finder_handoff = ?, status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [
        JSON.stringify(merged.product_context),
        JSON.stringify(merged.persona_config),
        JSON.stringify(merged.search_strategy),
        JSON.stringify(merged.scoring_weights),
        JSON.stringify(merged.finder_handoff),
        req.params.id
      ]
    );
    res.json({ success: true, data: await getStrategy(req.params.id), message: 'AI draft generated' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/:id/analyze-materials', upload.array('files', MAX_MATERIAL_FILES), async (req, res) => {
  const files = req.files || [];
  try {
    const strategy = await getStrategy(req.params.id);
    if (!strategy) return res.status(404).json({ success: false, error: 'Strategy not found' });

    const materialContext = await collectMaterialContext(req.body.brief_text, files);
    const draft = await generateDraft(strategy, materialContext);
    const merged = {
      source_material_summary: clean(draft.source_material_summary),
      product_context: draft.product_context || strategy.product_context || {},
      persona_config: draft.persona_config || strategy.persona_config || {},
      search_strategy: draft.search_strategy || strategy.search_strategy || DEFAULT_SEARCH_CYCLES,
      scoring_weights: draft.scoring_weights || strategy.scoring_weights || DEFAULT_SCORING_WEIGHTS,
      finder_handoff: draft.finder_handoff || strategy.finder_handoff || {}
    };

    if (!merged.source_material_summary) {
      merged.source_material_summary = 'AI 已读取材料并生成 Strategy 草稿，但没有返回单独的材料摘要。';
    }

    await dbOperations.run(
      `UPDATE kol_strategies SET
       source_material_summary = ?, source_material_meta = ?, source_material_type = ?,
       research_status = ?, research_sources = ?,
       product_context = ?, persona_config = ?, search_strategy = ?,
       scoring_weights = ?, finder_handoff = ?, status = 'draft',
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        merged.source_material_summary,
        JSON.stringify(materialContext.meta),
        materialContext.type,
        'not_started',
        JSON.stringify([]),
        JSON.stringify(merged.product_context),
        JSON.stringify(merged.persona_config),
        JSON.stringify(merged.search_strategy),
        JSON.stringify(merged.scoring_weights),
        JSON.stringify(merged.finder_handoff),
        req.params.id
      ]
    );

    res.json({
      success: true,
      data: await getStrategy(req.params.id),
      meta: materialContext.meta,
      message: 'Materials analyzed and strategy draft generated'
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  } finally {
    files.forEach((file) => {
      if (file?.path) fs.unlink(file.path, () => {});
    });
  }
});

router.post('/:id/mark-ready', async (req, res) => {
  try {
    const strategy = await getStrategy(req.params.id);
    if (!strategy) return res.status(404).json({ success: false, error: 'Strategy not found' });
    validateReady(strategy);
    await dbOperations.run(
      'UPDATE kol_strategies SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['ready', req.params.id]
    );
    res.json({ success: true, data: await getStrategy(req.params.id), message: 'Strategy is ready' });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/:id/archive', async (req, res) => {
  try {
    await dbOperations.run('UPDATE kol_strategies SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['archived', req.params.id]);
    res.json({ success: true, data: await getStrategy(req.params.id), message: 'Strategy archived' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:id/duplicate', async (req, res) => {
  try {
    const strategy = await getStrategy(req.params.id);
    if (!strategy) return res.status(404).json({ success: false, error: 'Strategy not found' });
    const result = await dbOperations.run(
      `INSERT INTO kol_strategies
       (campaign_id, name, brand, product, category, target_market, language, primary_platform,
        secondary_platforms, campaign_goal, status, product_context, persona_config,
        search_strategy, scoring_weights, finder_handoff)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      [
        strategy.campaign_id,
        `${strategy.name} Copy`,
        strategy.brand || '',
        strategy.product || '',
        strategy.category || '',
        strategy.target_market || '',
        strategy.language || '',
        strategy.primary_platform || '',
        JSON.stringify(strategy.secondary_platforms || []),
        strategy.campaign_goal || '',
        JSON.stringify(strategy.product_context || {}),
        JSON.stringify(strategy.persona_config || {}),
        JSON.stringify(strategy.search_strategy || DEFAULT_SEARCH_CYCLES),
        JSON.stringify(strategy.scoring_weights || DEFAULT_SCORING_WEIGHTS),
        JSON.stringify(strategy.finder_handoff || {})
      ]
    );
    res.json({ success: true, data: await getStrategy(result.id), message: 'Strategy duplicated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const usage = await dbOperations.get('SELECT COUNT(*) as count FROM raw_candidates WHERE strategy_id = ?', [req.params.id]);
    if (usage?.count > 0) {
      return res.status(400).json({ success: false, error: `Strategy has ${usage.count} Raw Candidates and cannot be deleted. Archive it instead.` });
    }
    await dbOperations.run('DELETE FROM kol_strategies WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Strategy deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
