// 临时助手：通过 app HTTP API 访问 KOL Campaign OS。
// 从 DB 读取 agent token（仅内存使用，绝不打印），从 .env 读取登录口令获取会话 cookie。
// 用法: node _agent_http.js METHOD /api/path [bodyJSON]
const fs = require('fs');
const path = require('path');
const mysql = require('../server/node_modules/mysql2/promise');

const BASE = process.env.KOL_BASE || 'http://localhost:5001';

function readEnv() {
  const env = {};
  const raw = fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function main() {
  const [method, apiPath, bodyJson] = process.argv.slice(2);
  if (!method || !apiPath) { console.error('usage: node _agent_http.js METHOD /api/path [bodyJSON]'); process.exit(1); }

  const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'kol_user', password: 'kol_password', database: 'kol_campaign_os' });
  const [rows] = await conn.query("SELECT api_key FROM api_settings WHERE provider='agent.external_api'");
  await conn.end();
  const agentToken = rows[0]?.api_key || '';

  // 登录拿 cookie（浏览器会话）
  const env = readEnv();
  let cookie = '';
  if (env.APP_ACCESS_PASSWORD) {
    const loginRes = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: env.APP_ACCESS_PASSWORD })
    });
    cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  }

  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (agentToken) headers.Authorization = `Bearer ${agentToken}`;

  const res = await fetch(`${BASE}${apiPath}`, {
    method: method.toUpperCase(),
    headers,
    body: bodyJson ? bodyJson : undefined
  });
  const text = await res.text();
  try { console.log(JSON.stringify(JSON.parse(text), null, 1)); }
  catch { console.log(text); }
  if (!res.ok) process.exitCode = 1;
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
