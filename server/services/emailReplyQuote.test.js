const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeReplySubject,
  buildTextQuote,
  buildHtmlQuote,
  formatQuoteDate,
  QUOTE_MAX_CHARS
} = require('./emailReplyQuote');

test('normalizeReplySubject collapses stacked prefixes into a single Re:', () => {
  assert.equal(normalizeReplySubject('Re: Re: Fwd: 合作'), 'Re: 合作');
  assert.equal(normalizeReplySubject('回复：xx'), 'Re: xx');
  assert.equal(normalizeReplySubject('没有前缀'), 'Re: 没有前缀');
  assert.equal(normalizeReplySubject('re[2]: hello'), 'Re: hello');
  assert.equal(normalizeReplySubject(''), 'Re:');
});

test('formatQuoteDate formats as YYYY/M/D HH:mm in local time', () => {
  assert.equal(formatQuoteDate(new Date(2026, 6, 29, 18, 32)), '2026/7/29 18:32');
  assert.equal(formatQuoteDate(new Date(2026, 0, 5, 9, 5)), '2026/1/5 09:05');
  assert.equal(formatQuoteDate(null), '');
  assert.equal(formatQuoteDate('not-a-date'), '');
});

test('buildTextQuote prefixes every line with > and keeps blank lines', () => {
  const quote = buildTextQuote({
    fromAddress: 'x@y',
    fromName: 'Chris',
    receivedAt: new Date(2026, 6, 29, 18, 32),
    bodyText: '第一行\n\n第二行'
  });
  assert.ok(quote.startsWith('\n\nOn 2026/7/29 18:32, Chris <x@y> wrote:\n\n'));
  assert.ok(quote.includes('> 第一行\n>\n> 第二行'));
});

test('buildTextQuote falls back to the bare address when fromName is missing', () => {
  const quote = buildTextQuote({
    fromAddress: 'x@y',
    receivedAt: new Date(2026, 6, 29, 18, 32),
    bodyText: 'hi'
  });
  assert.ok(quote.includes('On 2026/7/29 18:32, x@y wrote:'));
});

test('buildTextQuote truncates overlong quotes with a marker', () => {
  const quote = buildTextQuote({
    fromAddress: 'x@y',
    receivedAt: new Date(),
    bodyText: `start-${'a'.repeat(QUOTE_MAX_CHARS + 500)}-end`
  });
  assert.ok(quote.includes('已截断'));
  assert.ok(!quote.includes('-end'));
});

test('buildHtmlQuote escapes HTML in the quoted body and preserves newlines', () => {
  const quote = buildHtmlQuote({
    fromAddress: 'x@y',
    receivedAt: new Date(2026, 6, 29, 18, 32),
    bodyText: '<script>alert(1)</script>\n第二行 & "引号"'
  });
  assert.ok(quote.includes('<blockquote'));
  assert.ok(!quote.includes('<script>'));
  assert.ok(quote.includes('&lt;script&gt;alert(1)&lt;/script&gt;<br>第二行 &amp; &quot;引号&quot;'));
  assert.ok(quote.includes('border-left'));
  assert.ok(quote.includes('On 2026/7/29 18:32, x@y wrote:'));
});

test('buildHtmlQuote truncates overlong quotes with a marker', () => {
  const quote = buildHtmlQuote({
    fromAddress: 'x@y',
    receivedAt: new Date(),
    bodyText: 'b'.repeat(QUOTE_MAX_CHARS + 10)
  });
  assert.ok(quote.includes('已截断'));
});
