// 标准 MIME 邮件解析服务：基于 mailparser，替代 emailBodyParser 的自写解析。
// 负责：RFC822 解析、HTML 清洗（sanitize-html）、回复正文拆分（新写/引用/签名）。
// 不处理 raw_source 的存储决策（由调用方决定，超过约 2MB 可不存）。
const { simpleParser } = require('mailparser');
const sanitizeHtml = require('sanitize-html');

function decodeHtmlEntities(input) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(input || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()] || entity;
    const value = code[1].toLowerCase() === 'x'
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
    try { return String.fromCodePoint(value); } catch { return entity; }
  });
}

const SANITIZE_OPTIONS = {
  allowedTags: [
    'p', 'br', 'div', 'span', 'b', 'i', 'em', 'strong', 'u',
    'ul', 'ol', 'li', 'a', 'blockquote',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'h1', 'h2', 'h3', 'h4', 'font', 'img'
  ],
  allowedAttributes: {
    a: ['href', 'target'],
    img: ['src', 'alt']
  },
  // a 允许 http/https/mailto；img 仅 http/https（data: 太大，不允许）
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false
};

// 去掉 Message-ID 的尖括号并 trim
function normalizeMessageId(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const stripped = text.replace(/^</, '').replace(/>\s*$/, '').trim();
  return stripped || null;
}

// 库存 message_id 统一保留尖括号（与 envelope.messageId / nodemailer info.messageId 一致），
// 写入 in_reply_to / references_json 及会话匹配前用它对齐格式
function toStoredMessageId(value) {
  const stripped = normalizeMessageId(value);
  return stripped ? `<${stripped}>` : null;
}

// References 头可能一行多个、折叠多行，统一解析为不带尖括号的数组
function normalizeReferences(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .flatMap((item) => String(item).split(/\s+/))
    .map((token) => normalizeMessageId(token))
    .filter(Boolean);
}

// mailparser 的地址字段可能是 AddressObject 或其数组（含 group），统一拍平
function flattenAddresses(field) {
  if (!field) return [];
  const groups = Array.isArray(field) ? field : [field];
  const addresses = [];
  for (const group of groups) {
    for (const entry of group.value || []) {
      if (entry.address) addresses.push(entry.address);
    }
  }
  return addresses;
}

// 简单 html -> text：块级标签转换行、<li> 转 "- "、<blockquote> 内容行前缀 "> "
const QUOTE_OPEN = String.fromCharCode(1);
const QUOTE_CLOSE = String.fromCharCode(2);
function htmlToText(html) {
  let text = String(html || '');
  // 丢弃 script/style 及其内容
  text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '');
  // blockquote 用占位符包住，去标签后再加 "> " 前缀
  text = text.replace(/<blockquote[^>]*>/gi, '\n' + QUOTE_OPEN)
    .replace(/<\/\s*blockquote\s*>/gi, QUOTE_CLOSE + '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '\n- ');
  text = text.replace(/<\/\s*(p|div|tr|h[1-6]|ul|ol|table|thead|tbody)\s*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text).replace(/\u00a0/g, ' ');
  // blockquote 占位符区间内的行加 "> " 前缀
  text = text.replace(new RegExp(QUOTE_OPEN + '([\\s\\S]*?)' + QUOTE_CLOSE, 'g'), (match, inner) => {
    const quoted = inner.split('\n')
      .map((line) => (line.trim() ? `> ${line.trim()}` : ''))
      .join('\n');
    return `\n${quoted}\n`;
  });
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 判断一行是否是引用起点（不含 ">" 块，那个需要看多行）
function isQuoteMarkerLine(lines, index) {
  const line = lines[index];
  if (/^On .+ wrote:?\s*$/i.test(line)) return true;
  if (/^在.{0,60}写道[：:]\s*$/.test(line)) return true;
  if (/^-+\s*Original Message\s*-+\s*$/i.test(line)) return true;
  // Outlook 头块：From: 后紧跟 Sent:/To:/Subject:
  if (/^From:\s*\S/.test(line)) {
    const following = lines.slice(index + 1, index + 5);
    const hasSent = following.some((l) => /^Sent:\s*\S/.test(l));
    const hasToOrSubject = following.some((l) => /^(To|Subject):\s*\S/.test(l));
    if (hasSent && hasToOrSubject) return true;
  }
  // 连续 3 行以上以 ">" 开头的块的首行
  if (/^>/.test(line)) {
    let run = 0;
    for (let i = index; i < lines.length && /^>/.test(lines[i]); i += 1) run += 1;
    if (run >= 3) return true;
  }
  return false;
}

function trimBlankEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

// 拆分回复正文：本次新写 / 引用历史 / 签名。
// 签名识别保守：只认 "-- " 分隔线和末尾单行手机签名，宁可不拆也不误删业务内容。
function splitReplyParts(text) {
  const input = String(text || '').replace(/\r\n/g, '\n');
  if (!input.trim()) return { cleanBodyText: '', quotedBodyText: null, signatureText: null };

  const lines = input.split('\n');
  let quoteStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isQuoteMarkerLine(lines, i)) { quoteStart = i; break; }
  }

  const cleanLines = quoteStart >= 0 ? lines.slice(0, quoteStart) : lines.slice();
  const quotedLines = quoteStart >= 0 ? lines.slice(quoteStart) : null;

  // 签名识别（只在 clean 部分内做）
  let signatureText = null;
  const trimmedClean = trimBlankEdges(cleanLines);
  for (let i = 0; i < trimmedClean.length; i += 1) {
    if (/^--\s+$/.test(trimmedClean[i])) {
      signatureText = trimmedClean.slice(i).join('\n').trim() || null;
      trimmedClean.length = i;
      break;
    }
  }
  if (signatureText === null && trimmedClean.length > 0) {
    const last = trimmedClean[trimmedClean.length - 1];
    if (/^(Sent from my |发自我的 |Get Outlook for)/i.test(last.trim())) {
      signatureText = last.trim();
      trimmedClean.pop();
    }
  }

  const cleanBodyText = trimBlankEdges(trimmedClean).join('\n');
  const quotedBodyText = quotedLines ? (trimBlankEdges(quotedLines).join('\n') || null) : null;
  return { cleanBodyText, quotedBodyText, signatureText };
}

// 解析失败时尽量从原始头里捞 envelope 字段
function fallbackEnvelope(input) {
  const text = input.toString('utf8');
  const head = text.split(/\r?\n\r?\n/)[0] || '';
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep < 1) continue;
    headers[line.slice(0, sep).trim().toLowerCase()] = line.slice(sep + 1).trim();
  }
  const fromMatch = String(headers.from || '').match(/^(?:"?([^"<]*)"?\s*)?<?([^\s<>]+@[^\s<>]+)>?/);
  return {
    messageId: normalizeMessageId(headers['message-id']),
    inReplyTo: normalizeMessageId(headers['in-reply-to']),
    references: normalizeReferences(headers.references),
    fromAddress: fromMatch ? fromMatch[2] : null,
    fromName: fromMatch && fromMatch[1] ? fromMatch[1].trim() : null,
    subject: headers.subject || '',
    date: headers.date ? (Number.isNaN(Date.parse(headers.date)) ? null : new Date(headers.date)) : null
  };
}

function emptyResult(overrides) {
  return {
    parseStatus: 'ok',
    messageId: null,
    inReplyTo: null,
    references: [],
    fromAddress: null,
    fromName: null,
    toAddresses: [],
    ccAddresses: [],
    subject: '',
    date: null,
    bodyText: null,
    bodyHtmlRaw: null,
    bodyHtml: null,
    cleanBodyText: null,
    quotedBodyText: null,
    signatureText: null,
    attachments: [],
    parseError: null,
    ...overrides
  };
}

// 是否像一封真正的邮件：至少要有一个可识别的头
const KNOWN_HEADER_KEYS = new Set(['from', 'to', 'subject', 'date', 'message-id', 'content-type', 'mime-version']);
function looksLikeEmail(mail) {
  return (mail.headerLines || []).some((line) => KNOWN_HEADER_KEYS.has(line.key));
}

async function parseRawEmail(raw) {
  const input = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
  let mail;
  try {
    mail = await simpleParser(input);
  } catch (err) {
    return emptyResult({
      parseStatus: 'failed',
      parseError: err.message,
      ...fallbackEnvelope(input)
    });
  }

  if (!looksLikeEmail(mail)) {
    return emptyResult({
      parseStatus: 'failed',
      parseError: '输入不包含可识别的邮件头，非 RFC822 邮件',
      bodyText: mail.text || null
    });
  }

  const bodyHtmlRaw = typeof mail.html === 'string' && mail.html ? mail.html : null;
  const bodyHtml = bodyHtmlRaw ? sanitizeHtml(bodyHtmlRaw, SANITIZE_OPTIONS) : null;
  const bodyText = mail.text || (bodyHtmlRaw ? htmlToText(bodyHtmlRaw) : null);
  const { cleanBodyText, quotedBodyText, signatureText } = splitReplyParts(bodyText || '');

  return emptyResult({
    messageId: normalizeMessageId(mail.messageId),
    inReplyTo: normalizeMessageId(mail.inReplyTo),
    references: normalizeReferences(mail.references),
    fromAddress: mail.from?.value?.[0]?.address || null,
    fromName: mail.from?.value?.[0]?.name || null,
    toAddresses: flattenAddresses(mail.to),
    ccAddresses: flattenAddresses(mail.cc),
    subject: mail.subject || '',
    date: mail.date instanceof Date ? mail.date : null,
    bodyText,
    bodyHtmlRaw,
    bodyHtml,
    cleanBodyText,
    quotedBodyText,
    signatureText,
    attachments: (mail.attachments || []).map((att) => ({
      filename: att.filename || null,
      contentType: att.contentType || null,
      size: typeof att.size === 'number' ? att.size : (att.content ? att.content.length : 0)
    }))
  });
}

module.exports = { parseRawEmail, splitReplyParts, htmlToText, toStoredMessageId, SANITIZE_OPTIONS };
