const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInboundBody } = require('./emailBodyParser');

const RAW_MULTIPART = `--0000000000001f42990657cbb638
Content-Type: text/plain; charset="UTF-8"
Content-Transfer-Encoding: quoted-printable

I=E2=80=99m sorry I don=E2=80=99t have a tractor I would totally do this

On Wed, Jul 29, 2026 at 6:28=E2=80=AFPM Celeste wrote:

--0000000000001f42990657cbb638
Content-Type: text/html; charset="UTF-8"
Content-Transfer-Encoding: quoted-printable

<div>I=E2=80=99m sorry</div>

--0000000000001f42990657cbb638--`;

test('parseInboundBody extracts and decodes text/plain from multipart reply', () => {
  assert.equal(
    parseInboundBody(RAW_MULTIPART),
    'I’m sorry I don’t have a tractor I would totally do this\n\nOn Wed, Jul 29, 2026 at 6:28 PM Celeste wrote:'
  );
});

test('parseInboundBody converts an encoded HTML-only part to readable text', () => {
  const raw = `--boundary\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<div>Hello=C2=A0world</div><div>Second line</div>\r\n--boundary--`;
  assert.equal(parseInboundBody(raw), 'Hello world\nSecond line');
});

test('parseInboundBody preserves ordinary plain text', () => {
  assert.equal(parseInboundBody('Thanks, I am interested.'), 'Thanks, I am interested.');
});
