// 回复引用块构造：纯函数模块，供发送侧把"最近一封来信"附加为可读引用。
// 不嵌套整条历史，只引用被回复的那一封。
const { normalizeSubject } = require('./emailThreader');

// 引用正文最长保留字符数，防止超长历史撑爆邮件
const QUOTE_MAX_CHARS = 3000;
const TRUNCATED_MARK = '……（引用内容过长，已截断）';

function htmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 主题规范化：剥掉任意层数的 Re:/Fwd:/回复: 等前缀后，恰好补回一个 "Re: "
function normalizeReplySubject(subject) {
  const base = normalizeSubject(subject);
  return base ? `Re: ${base}` : 'Re:';
}

// 引用头日期格式：2026/7/29 18:32（本地时间，月/日不补零，时/分补零）
function formatQuoteDate(date) {
  const d = date ? new Date(date) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncateQuote(bodyText) {
  const text = String(bodyText || '').trim();
  if (text.length <= QUOTE_MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, QUOTE_MAX_CHARS), truncated: true };
}

// 纯文本引用头：On 2026/7/29 18:32, Chris <x@y> wrote:
function attributionLine({ fromAddress, fromName, receivedAt }) {
  const dateText = formatQuoteDate(receivedAt) || 'unknown date';
  const sender = fromName
    ? `${fromName} <${fromAddress || ''}>`
    : String(fromAddress || '未知发件人');
  return `On ${dateText}, ${sender} wrote:`;
}

// 纯文本引用块：\n\nOn ..., ... wrote:\n\n> 引用行...
function buildTextQuote({ fromAddress, fromName, receivedAt, bodyText }) {
  const { text, truncated } = truncateQuote(bodyText);
  const quoted = text
    .split(/\r?\n/)
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
  const tail = truncated ? `\n> ${TRUNCATED_MARK}` : '';
  return `\n\n${attributionLine({ fromAddress, fromName, receivedAt })}\n\n${quoted}${tail}`;
}

// HTML 引用块：灰色小字引用头 + 安全内联样式的 blockquote，正文转义后保留换行
function buildHtmlQuote({ fromAddress, fromName, receivedAt, bodyText }) {
  const { text, truncated } = truncateQuote(bodyText);
  const quoted = htmlEscape(text).replace(/\r?\n/g, '<br>');
  const tail = truncated ? `<br>${htmlEscape(TRUNCATED_MARK)}` : '';
  return (
    `<div style="margin-top:16px;padding-top:8px;font-size:12px;color:#999">${
      htmlEscape(attributionLine({ fromAddress, fromName, receivedAt }))
    }</div>`
    + `<blockquote style="margin:8px 0 0;padding:4px 0 4px 12px;border-left:2px solid #cccccc;color:#666666">${
      quoted
    }${tail}</blockquote>`
  );
}

module.exports = {
  normalizeReplySubject,
  buildTextQuote,
  buildHtmlQuote,
  formatQuoteDate,
  QUOTE_MAX_CHARS,
  TRUNCATED_MARK
};
