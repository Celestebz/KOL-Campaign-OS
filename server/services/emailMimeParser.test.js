const test = require('node:test');
const assert = require('node:assert');

const { parseRawEmail, splitReplyParts, toStoredMessageId } = require('./emailMimeParser');

// 把头部+正文拼成 RFC822 Buffer（统一 CRLF）
function buildRaw(headers, body) {
  const head = headers.map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return Buffer.from(`${head}\r\n\r\n${body}`, 'utf8');
}

function toQuotedPrintable(text) {
  return Buffer.from(text, 'utf8').toString('hex')
    .replace(/../g, (hex) => `=${hex.toUpperCase()}`)
    .replace(/=3D/gi, '=');
}

test('纯文本 quoted-printable 中文邮件：中文正确解码，clean/quoted 正确拆分', async () => {
  const bodyText = '好的，这个价格可以接受，我们下周签合同。\n\nOn 2026/7/29, at 18:32, Chris <chris@brand.com> wrote:\n> 我们这边报价是 5000 美元，你看可以吗？';
  const raw = buildRaw([
    ['From', 'Chris <chris@brand.com>'],
    ['To', 'me@company.com'],
    ['Subject', 'Re: 合作报价'],
    ['Message-ID', '<abc123@brand.com>'],
    ['Content-Type', 'text/plain; charset=utf-8'],
    ['Content-Transfer-Encoding', 'quoted-printable']
  ], toQuotedPrintable(bodyText));

  const result = await parseRawEmail(raw);
  assert.strictEqual(result.parseStatus, 'ok');
  assert.strictEqual(result.messageId, 'abc123@brand.com');
  assert.strictEqual(result.fromAddress, 'chris@brand.com');
  assert.strictEqual(result.fromName, 'Chris');
  assert.ok(result.bodyText.includes('好的，这个价格可以接受'));
  assert.ok(result.bodyText.includes('我们这边报价是 5000 美元'));
  assert.ok(result.cleanBodyText.includes('我们下周签合同'));
  assert.ok(!result.cleanBodyText.includes('5000 美元'));
  assert.ok(result.quotedBodyText.includes('On 2026/7/29, at 18:32, Chris <chris@brand.com> wrote:'));
  assert.ok(result.quotedBodyText.includes('5000 美元'));
});

test('multipart/alternative：bodyText 与 bodyHtml 都有值，bodyText 不含 MIME 源码', async () => {
  const boundary = '----ALT_BOUNDARY_001';
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    '这是纯文本版本',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    '<html><body><p>这是 <b>HTML</b> 版本</p></body></html>',
    `--${boundary}--`,
    ''
  ].join('\r\n');
  const raw = buildRaw([
    ['From', 'kol@example.com'],
    ['To', 'me@company.com'],
    ['Subject', 'multipart test'],
    ['MIME-Version', '1.0'],
    ['Content-Type', `multipart/alternative; boundary="${boundary}"`]
  ], body);

  const result = await parseRawEmail(raw);
  assert.strictEqual(result.parseStatus, 'ok');
  assert.ok(result.bodyText.includes('这是纯文本版本'));
  assert.ok(!result.bodyText.includes('ALT_BOUNDARY'));
  assert.ok(!/Content-Type/i.test(result.bodyText));
  assert.ok(result.bodyHtmlRaw.includes('<b>HTML</b>'));
  assert.ok(result.bodyHtml.includes('<b>HTML</b>'));
});

test('multipart/mixed 带附件：附件元数据正确，正文不含 base64 块', async () => {
  const boundary = '----MIXED_BOUNDARY_002';
  const pdfBase64 = Buffer.from('fake-pdf-content-for-test').toString('base64');
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    '请查收附件报价单。',
    `--${boundary}`,
    'Content-Type: application/pdf; name="quote.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="quote.pdf"',
    '',
    pdfBase64,
    `--${boundary}--`,
    ''
  ].join('\r\n');
  const raw = buildRaw([
    ['From', 'kol@example.com'],
    ['To', 'me@company.com'],
    ['Subject', '报价单'],
    ['MIME-Version', '1.0'],
    ['Content-Type', `multipart/mixed; boundary="${boundary}"`]
  ], body);

  const result = await parseRawEmail(raw);
  assert.strictEqual(result.parseStatus, 'ok');
  assert.strictEqual(result.attachments.length, 1);
  assert.strictEqual(result.attachments[0].filename, 'quote.pdf');
  assert.strictEqual(result.attachments[0].contentType, 'application/pdf');
  assert.strictEqual(result.attachments[0].size, Buffer.byteLength('fake-pdf-content-for-test'));
  assert.ok(result.bodyText.includes('请查收附件报价单'));
  assert.ok(!result.bodyText.includes(pdfBase64));
});

test('只有 HTML 的邮件：bodyText 由 HTML 转出且含换行', async () => {
  const raw = buildRaw([
    ['From', 'kol@example.com'],
    ['To', 'me@company.com'],
    ['Subject', 'html only'],
    ['Content-Type', 'text/html; charset=utf-8']
  ], '<html><body><p>第一段</p><p>第二段</p></body></html>');

  const result = await parseRawEmail(raw);
  assert.strictEqual(result.parseStatus, 'ok');
  assert.ok(result.bodyText.includes('第一段'));
  assert.ok(result.bodyText.includes('第二段'));
  assert.ok(/\n/.test(result.bodyText), '转换后的纯文本应保留换行');
  assert.ok(!result.bodyText.includes('<p>'));
  assert.ok(result.bodyHtml.includes('<p>第一段</p>'));
});

test('HTML 清洗：script/onclick 被剥除，http 图片保留', async () => {
  const html = '<html><body>'
    + '<p onclick="steal()">点我</p>'
    + '<script>alert(1)</script>'
    + '<img src="http://track.example.com/pixel.gif" onerror="hack()">'
    + '<a href="javascript:evil()">坏链接</a>'
    + '<a href="https://good.example.com/page">好链接</a>'
    + '</body></html>';
  const raw = buildRaw([
    ['From', 'kol@example.com'],
    ['To', 'me@company.com'],
    ['Subject', 'xss test'],
    ['Content-Type', 'text/html; charset=utf-8']
  ], html);

  const result = await parseRawEmail(raw);
  assert.strictEqual(result.parseStatus, 'ok');
  assert.ok(!result.bodyHtml.includes('<script'));
  assert.ok(!result.bodyHtml.includes('alert(1)'));
  assert.ok(!/onclick/i.test(result.bodyHtml));
  assert.ok(!/onerror/i.test(result.bodyHtml));
  assert.ok(!/javascript:/i.test(result.bodyHtml));
  assert.ok(result.bodyHtml.includes('src="http://track.example.com/pixel.gif"'));
  assert.ok(result.bodyHtml.includes('href="https://good.example.com/page"'));
  assert.ok(result.bodyHtml.includes('点我'));
});

test('Outlook 风格引用块与 -----Original Message----- 拆分', async () => {
  const body = [
    '收到，我们按这个新方案推进。',
    '',
    '-----Original Message-----',
    'From: Alice <alice@brand.com>',
    'Sent: Tuesday, July 29, 2026 6:32 PM',
    'To: me@company.com',
    'Subject: RE: 新品合作',
    '',
    '原邮件内容在这里。'
  ].join('\r\n');
  const raw = buildRaw([
    ['From', 'me@company.com'],
    ['To', 'alice@brand.com'],
    ['Subject', 'RE: 新品合作'],
    ['Content-Type', 'text/plain; charset=utf-8']
  ], body);

  const result = await parseRawEmail(raw);
  assert.strictEqual(result.parseStatus, 'ok');
  assert.strictEqual(result.cleanBodyText, '收到，我们按这个新方案推进。');
  assert.ok(result.quotedBodyText.includes('-----Original Message-----'));
  assert.ok(result.quotedBodyText.includes('原邮件内容在这里'));

  // 无 Original Message 分隔线时，Outlook 头块本身也应被识别
  const parts = splitReplyParts('好的。\nFrom: Bob <bob@x.com>\nSent: Monday, July 28, 2026 10:00 AM\nTo: me@company.com\nSubject: hi\n\n旧内容');
  assert.strictEqual(parts.cleanBodyText, '好的。');
  assert.ok(parts.quotedBodyText.includes('旧内容'));
});

test('标准签名分隔线 "-- " 拆出 signatureText', async () => {
  const parts = splitReplyParts('正文内容\n-- \n张三\nCEO, Example Inc.\n+86 13800000000');
  assert.strictEqual(parts.cleanBodyText, '正文内容');
  assert.ok(parts.signatureText.includes('张三'));
  assert.ok(parts.signatureText.includes('CEO, Example Inc.'));

  // 手机签名单行
  const mobile = splitReplyParts('好的，明天见\nSent from my iPhone');
  assert.strictEqual(mobile.cleanBodyText, '好的，明天见');
  assert.strictEqual(mobile.signatureText, 'Sent from my iPhone');

  // 无可识别签名时不要误拆业务内容
  const none = splitReplyParts('第一段\n第二段\n第三段');
  assert.strictEqual(none.signatureText, null);
  assert.ok(none.cleanBodyText.includes('第三段'));
});

test('垃圾输入：parseStatus=failed 且有 parseError，不抛异常', async () => {
  const result = await parseRawEmail(Buffer.from('这不是一封邮件，只是随机的垃圾字符串，没有任何邮件头。', 'utf8'));
  assert.strictEqual(result.parseStatus, 'failed');
  assert.ok(result.parseError);
});

test('References 头折叠多行：解析为多个 Message-ID', async () => {
  const raw = buildRaw([
    ['From', 'kol@example.com'],
    ['To', 'me@company.com'],
    ['Subject', 'thread test'],
    ['Message-ID', '<c3@example.com>'],
    ['In-Reply-To', '<b2@example.com>'],
    ['References', '<a1@example.com>\r\n\t<b2@example.com>'],
    ['Content-Type', 'text/plain; charset=utf-8']
  ], '线程回复内容');

  const result = await parseRawEmail(raw);
  assert.strictEqual(result.parseStatus, 'ok');
  assert.strictEqual(result.messageId, 'c3@example.com');
  assert.strictEqual(result.inReplyTo, 'b2@example.com');
  assert.deepStrictEqual(result.references, ['a1@example.com', 'b2@example.com']);
});

test('toStoredMessageId normalizes to the bracketed storage format', () => {
  assert.strictEqual(toStoredMessageId('abc@x'), '<abc@x>');
  assert.strictEqual(toStoredMessageId('<abc@x>'), '<abc@x>', '已带尖括号不重复包裹');
  assert.strictEqual(toStoredMessageId('  <abc@x>  '), '<abc@x>');
  assert.strictEqual(toStoredMessageId(''), null);
  assert.strictEqual(toStoredMessageId(null), null);
});
