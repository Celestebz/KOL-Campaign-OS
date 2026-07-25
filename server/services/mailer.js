// SMTP 发送封装（nodemailer 已在依赖中）。
const nodemailer = require('nodemailer');

function createTransporter(settings) {
  return nodemailer.createTransport({
    host: settings.smtp_host,
    port: Number(settings.smtp_port) || 465,
    secure: settings.smtp_secure === undefined ? true : Boolean(settings.smtp_secure),
    auth: { user: settings.username, pass: settings.password }
  });
}

function parseCc(text) {
  if (!text || typeof text !== 'string') return [];
  return text.split(/[,;\n，；]/).map((s) => s.trim()).filter(Boolean);
}

async function verifySettings(settings) {
  if (!settings || !settings.smtp_host || !settings.username) {
    throw new Error('请先配置邮箱设置');
  }
  try {
    await createTransporter(settings).verify();
  } catch (error) {
    throw new Error(`SMTP 连接失败：${error.message}`);
  }
}

function textToHtml(text) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">${escaped.replace(/\n/g, '<br>')}</div>`;
}

// 发送单封并返回 { messageId }
async function sendMail({ settings, to, cc = [], subject, text }) {
  const from = settings.sender_name
    ? `"${settings.sender_name}" <${settings.username}>`
    : settings.username;
  const info = await createTransporter(settings).sendMail({
    from,
    to,
    cc: cc.length ? cc.join(',') : undefined,
    subject,
    text,
    html: textToHtml(text)
  });
  return { messageId: info.messageId || null };
}

module.exports = { createTransporter, parseCc, verifySettings, sendMail, textToHtml };
