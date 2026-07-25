// 六类 approval builder 的共享工具函数（原 workbench.js 阶段 B 的拼装辅助，阶段 C 迁入）。
const INTENT_LABELS = {
  interested: '有意向',
  question: '有疑问',
  rejected: '拒绝',
  other: '其他'
};

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function truncate(value, max) {
  const text = clean(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function openAction(href) {
  return [{ key: 'open', label: '去处理', href }];
}

function summarizeFinderHandoff(handoff) {
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) return '';
  const parts = [];
  const keywords = handoff.keywords || handoff.search_keywords || handoff.queries;
  if (Array.isArray(keywords) && keywords.length) {
    parts.push(`关键词 ${keywords.slice(0, 5).map((k) => clean(typeof k === 'object' ? (k.keyword || k.query || k.text) : k)).filter(Boolean).join('、')}`);
  }
  const platforms = handoff.platforms || handoff.target_platforms;
  if (Array.isArray(platforms) && platforms.length) parts.push(`平台 ${platforms.join('、')}`);
  if (!parts.length) {
    const keys = Object.keys(handoff);
    if (keys.length) parts.push(`含 ${keys.slice(0, 4).join('、')} 配置`);
  }
  return parts.join('；');
}

module.exports = {
  INTENT_LABELS,
  parseJson,
  iso,
  clean,
  truncate,
  openAction,
  summarizeFinderHandoff
};
