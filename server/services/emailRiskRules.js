// 草稿风险规则引擎（纯函数）。规则先硬编码，后续可配置化。
const RISK_CODES = {
  NO_EMAIL: 'high',
  HARD_BOUNCE: 'high',
  FABRICATED_EVIDENCE: 'high',
  METRIC_MISMATCH: 'high',
  MARKET_MISMATCH: 'high',
  PRICE_COMMITMENT: 'high',
  STALE_SNAPSHOT: 'low',
  MISSING_REQUIRED_TERM: 'low',
  MISSING_VIDEO_REFERENCE: 'low',
  LANGUAGE_MISMATCH: 'low'
};

const PRICE_COMMITMENT_PATTERN = /\$\s?\d|fee|rate card|guarantee|contract|固定费|报价|合同/i;
// 写作规范要求正文必须出现"无固定费"表述，价格承诺检测前先把这类否定表述剔除，避免误报。
const NEGATED_COMMITMENT_PATTERN = /no\s+contract\s+or\s+(?:a\s+)?fixed\s+fees?|no\s+(?:fixed\s+)?fees?|no\s+contract|without\s+(?:a\s+)?(?:fixed\s+)?fee|无固定费/gi;
const COMMISSION_PATTERN = /commission|佣金/i;
const NO_FIXED_FEE_PATTERN = /no\s+(?:contract\s+or\s+)?(?:a\s+)?fixed\s+fees?|without\s+(?:a\s+)?fixed\s+fee|无固定费/i;

const STALE_DAYS = 7;

function normalizeNumber(text) {
  const match = String(text).match(/([\d.]+)\s*([kKmM万])?/);
  if (!match) return null;
  let value = parseFloat(match[1]);
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'k') value *= 1e3;
  else if (unit === 'm') value *= 1e6;
  else if (unit === '万') value *= 1e4;
  return value;
}

function countryMatchesMarket(country, targetMarket) {
  if (!country || !targetMarket) return true; // 数据缺失不判
  const c = String(country).toUpperCase();
  const markets = String(targetMarket).toUpperCase().split(/[,，、\s]+/).filter(Boolean);
  if (!markets.length) return true;
  return markets.some((m) => c.includes(m) || m.includes(c));
}

// 从正文提取 "数字+K/M/万 + views" 类表述并与证据视频播放量比对
function findMetricMismatch(bodyText, evidenceVideos) {
  const viewMentions = String(bodyText).matchAll(/([\d.]+\s*[kKmM万]|\d[\d,]{3,})\s*(views|播放)/gi);
  for (const mention of viewMentions) {
    const stated = normalizeNumber(mention[1]);
    if (stated === null) continue;
    const matched = evidenceVideos.some((v) => {
      const actual = Number(v.play_count);
      if (!actual) return false;
      return Math.abs(stated - actual) / actual <= 0.15; // 15% 容差
    });
    if (!matched) return mention[0];
  }
  return null;
}

// 证据视频 id 已泛化：YouTube 快照行带 youtube_video_id，Finder 证据行带 video_id，两者等价。
function evidenceVideoId(v) {
  return v.video_id ?? v.youtube_video_id;
}

function evaluateDraft({ customer, strategy, bodyText, citedVideoIds = [], evidenceVideos = [], snapshotDate, hasEmail, previousHardBounce = null, staleDays = STALE_DAYS, kind = 'first_touch' }) {
  const reasons = [];
  const push = (code, message) => reasons.push({ code, message });

  if (!hasEmail) push('NO_EMAIL', '达人无邮箱地址');
  if (previousHardBounce) push('HARD_BOUNCE', `该邮箱曾发生硬退信${previousHardBounce.reason ? `：${previousHardBounce.reason}` : ''}`);

  const knownIds = new Set(evidenceVideos.map((v) => String(evidenceVideoId(v))));
  const fabricated = citedVideoIds.filter((id) => !knownIds.has(String(id)));
  if (fabricated.length) push('FABRICATED_EVIDENCE', `引用了快照中不存在的视频ID：${fabricated.join(', ')}`);
  if (!citedVideoIds.length) push('MISSING_VIDEO_REFERENCE', '正文未引用任何真实视频');

  const mismatch = findMetricMismatch(bodyText, evidenceVideos);
  if (mismatch) push('METRIC_MISMATCH', `正文数据「${mismatch}」与快照不符`);

  if (!countryMatchesMarket(customer?.country_region, strategy?.target_market)) {
    push('MARKET_MISMATCH', `达人国家 ${customer.country_region} 与目标市场 ${strategy.target_market} 不符`);
  }

  const priceCheckText = String(bodyText || '').replace(NEGATED_COMMITMENT_PATTERN, '');
  if (PRICE_COMMITMENT_PATTERN.test(priceCheckText)) {
    push('PRICE_COMMITMENT', '正文出现金额/fee/guarantee/contract 等承诺性表述');
  }

  if (snapshotDate) {
    const ageDays = (Date.now() - new Date(snapshotDate).getTime()) / 86400000;
    if (ageDays > staleDays) push('STALE_SNAPSHOT', `起草所用快照已 ${Math.floor(ageDays)} 天，超过 ${staleDays} 天阈值`);
  }

  if (kind !== 'first_touch' && (!COMMISSION_PATTERN.test(bodyText || '') || !NO_FIXED_FEE_PATTERN.test(bodyText || ''))) {
    push('MISSING_REQUIRED_TERM', '缺少佣金说明或"无固定费"表述');
  }

  if (!evidenceVideos.length) {
    const missingReferenceIndex = reasons.findIndex((reason) => reason.code === 'MISSING_VIDEO_REFERENCE');
    if (missingReferenceIndex >= 0) reasons.splice(missingReferenceIndex, 1);
  }

  const riskLevel = reasons.some((r) => RISK_CODES[r.code] === 'high') ? 'high'
    : reasons.length ? 'low' : 'none';
  return { riskLevel, riskReasons: reasons };
}

module.exports = { evaluateDraft, RISK_CODES };
