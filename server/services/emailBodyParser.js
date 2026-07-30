const BODY_TEXT_LIMIT = 8000;

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

function decodeQuotedPrintable(input) {
  const unfolded = String(input || '').replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < unfolded.length; i += 1) {
    const match = unfolded.slice(i).match(/^=([0-9A-Fa-f]{2})/);
    if (match) {
      bytes.push(Number.parseInt(match[1], 16));
      i += 2;
      continue;
    }
    bytes.push(...Buffer.from(unfolded[i], 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeTransfer(body, encoding) {
  const normalized = String(encoding || '').trim().toLowerCase();
  if (normalized === 'quoted-printable') return decodeQuotedPrintable(body);
  if (normalized === 'base64') {
    try { return Buffer.from(String(body || '').replace(/\s/g, ''), 'base64').toString('utf8'); } catch { return String(body || ''); }
  }
  return String(body || '');
}

function parseHeaders(block) {
  const headers = {};
  const unfolded = String(block || '').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function htmlToText(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitPart(rawPart) {
  const match = String(rawPart || '').match(/^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
  if (!match) return { headers: {}, body: String(rawPart || '') };
  return { headers: parseHeaders(match[1]), body: match[2] };
}

function findBoundary(raw, contentType = '') {
  const declared = String(contentType).match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  if (declared) return declared[1] || declared[2];
  const firstLine = String(raw || '').match(/^--([^\r\n]+)\r?\n/);
  return firstLine?.[1] || null;
}

function parseMime(raw, contentType = '') {
  const boundary = findBoundary(raw, contentType);
  if (!boundary) return null;
  const chunks = String(raw).split(`--${boundary}`)
    .slice(1)
    .map((part) => part.replace(/^\r?\n/, '').replace(/\r?\n$/, ''))
    .filter((part) => part && part !== '--');
  const candidates = [];
  for (const chunk of chunks) {
    const { headers, body } = splitPart(chunk.replace(/--$/, ''));
    const type = String(headers['content-type'] || 'text/plain').toLowerCase();
    const nested = parseMime(body, type);
    if (nested) candidates.push({ type: 'text/plain', text: nested });
    else {
      const decoded = decodeTransfer(body, headers['content-transfer-encoding']);
      if (type.startsWith('text/plain')) candidates.push({ type: 'text/plain', text: decoded });
      else if (type.startsWith('text/html')) candidates.push({ type: 'text/html', text: htmlToText(decoded) });
    }
  }
  return (candidates.find((item) => item.type === 'text/plain') || candidates[0])?.text || null;
}

function parseInboundBody(raw) {
  const input = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  // ImapFlow 的 bodyParts['text'] 对 multipart 邮件不包含最外层 Content-Type，
  // 但会从首个 boundary 开始；先按这种常见形态解析，避免把首个 part 当成顶层头。
  if (/^--[^\r\n]+\r?\n/.test(input)) {
    const multipartText = parseMime(input);
    if (multipartText !== null) {
      return multipartText.replace(/\r\n/g, '\n').trim().slice(0, BODY_TEXT_LIMIT);
    }
  }
  const { headers, body } = splitPart(input);
  const hasTopLevelHeaders = Boolean(headers['content-type'] || headers['content-transfer-encoding']);
  const payload = hasTopLevelHeaders ? body : input;
  const parsed = parseMime(payload, headers['content-type']);
  const decoded = parsed || decodeTransfer(payload, headers['content-transfer-encoding']);
  return decoded.replace(/\r\n/g, '\n').trim().slice(0, BODY_TEXT_LIMIT);
}

module.exports = { parseInboundBody, decodeQuotedPrintable, htmlToText, BODY_TEXT_LIMIT };
