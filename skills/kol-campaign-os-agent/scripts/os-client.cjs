#!/usr/bin/env node
// Standalone Node 18+ client; no environment variable or npm install is needed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const DEFAULT_URL = 'http://59.110.45.218';
const digest = (text) => crypto.createHash('sha256').update(text).digest('base64url');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const userError = (message) => Object.assign(new Error(message), { safeForUser: true });
function normalizeBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('OS 地址必须是 http(s) 网站根地址');
  return url.origin;
}
function windowsProtect(value, decrypt = false) {
  const command = decrypt
    ? '$b = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($value), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))'
    : '$b = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($b))';
  try {
    return execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; [void][Reflection.Assembly]::LoadWithPartialName("System.Security"); $value = [Console]::In.ReadToEnd(); ' + command], {
        input: value, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
  } catch { throw new Error('无法读写本机加密授权，请使用当前 Windows 用户重试'); }
}
function createCredentialStore({ baseUrl, home = os.homedir(), platform = process.platform, protect = windowsProtect } = {}) {
  const directory = path.join(home, '.kol-campaign-os', 'auth');
  const filename = path.join(directory, digest(baseUrl) + '.json');
  function prepare() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('授权目录不能是符号链接');
    if (platform !== 'win32') fs.chmodSync(directory, 0o700);
  }
  return {
    read() {
      if (!fs.existsSync(filename)) return null;
      if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('授权文件不能是符号链接');
      const stored = fs.readFileSync(filename, 'utf8');
      const data = JSON.parse(platform === 'win32' ? protect(stored, true) : stored);
      if (data.base_url !== baseUrl) throw new Error('授权与 OS 地址不匹配');
      return data;
    },
    write(data) {
      prepare();
      const serialized = JSON.stringify({ ...data, base_url: baseUrl });
      // Windows uses the current user's DPAPI; Unix uses a private 0700/0600 directory/file.
      const content = platform === 'win32' ? protect(serialized) : serialized;
      const temporary = filename + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
      try {
        fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, filename);
        if (platform !== 'win32') fs.chmodSync(filename, 0o600);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    },
    clear() { if (fs.existsSync(filename)) fs.unlinkSync(filename); }
  };
}
function openBrowser(url) {
  const command = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); // The verification URL is also displayed for manual opening.
  child.unref();
}
function createClient({ baseUrl = DEFAULT_URL, store, fetchImpl = global.fetch, browser = openBrowser, sleep = delay, now = () => Date.now(), notify = console.log } = {}) {
  baseUrl = normalizeBase(baseUrl);
  store = store || createCredentialStore({ baseUrl });
  async function json(route, body, access) {
    const response = await fetchImpl(baseUrl + route, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/json', ...(access ? { Authorization: 'Bearer ' + access } : {}) },
      body: JSON.stringify(body) });
    let data;
    try { data = await response.json(); }
    catch { throw userError('当前 OS 未提供可用的 Skill 登录接口，请检查服务版本或网络。'); }
    if (!response.ok && !['authorization_pending', 'slow_down'].includes(data.error)) {
      const reasons = { login_required: 'Skill 登录已过期或被撤销，请重新运行 login。', access_denied: '你已拒绝此次连接；如需使用，请重新运行 login。',
        expired_device: '连接请求已过期，请重新运行 login。', too_many_requests: '登录请求过于频繁，请稍后重试。' };
      const error = userError(reasons[data.error] || (response.status === 401 ? '请重新运行 login 完成浏览器授权。' : 'OS 授权操作失败，请稍后重试。'));
      error.status = response.status;
      error.code = data.error;
      throw error;
    }
    return data;
  }
  async function renew(credentials) {
    try {
      const updated = await json('/api/auth/agent/refresh', { refresh_token: credentials.refresh_token });
      const value = { ...credentials, ...updated };
      store.write(value);
      return value;
    } catch (error) {
      if (error.status === 401) store.clear();
      throw error;
    }
  }
  async function credentials() {
    const saved = store.read();
    if (!saved) throw new Error('尚未登录：请运行 login，浏览器登录一次即可');
    return new Date(saved.expires_at).getTime() > now() + 30000 ? saved : renew(saved);
  }
  return {
    async login() {
      // An explicit login reconnects; ordinary requests use the existing authorization.
      const verifier = crypto.randomBytes(32).toString('base64url');
      const device = await json('/api/auth/agent/device', { challenge: digest(verifier), label: `${os.hostname()} · KOL Skill` });
      if (!/^\/agent\/connect\?code=[A-Z2-9-]+$/.test(device.verification_path || '') || !Number.isFinite(device.expires_in) || !Number.isFinite(device.interval)) throw new Error('OS 返回的授权信息无效');
      const url = baseUrl + device.verification_path;
      notify(`请在浏览器登录 OS 并确认连接。核对连接码：${device.user_code}\n${url}`);
      browser(url);
      const deadline = now() + Math.min(device.expires_in, 600) * 1000;
      let interval = Math.max(5, device.interval) * 1000;
      while (now() < deadline) {
        await sleep(interval);
        const result = await json('/api/auth/agent/token', { device_code: device.device_code, verifier });
        if (result.error === 'slow_down') { interval += 5000; continue; }
        if (result.error === 'authorization_pending') continue;
        if (!result.access_token || !result.refresh_token || !result.expires_at) throw new Error('OS 未返回完整授权');
        store.write(result);
        notify('OS 已连接。之后可直接使用 Skill，无需配置 Token。');
        return;
      }
      throw new Error('连接请求已过期，请重新运行 login');
    },
    async request(method, route, body) {
      const url = new URL(route, baseUrl);
      if (url.origin !== baseUrl || !/^\/api\/(agent(?:\/|$)|customers(?:\/|$)|emails(?:\/|$)|finder-tasks(?:\/|$)|settings\/health\/config$)/.test(url.pathname)) throw new Error('仅支持 OS 业务 API，相对路径须以 /api/ 开头');
      if (!route.startsWith('/api/') || url.hash) throw new Error('无效的 API 路径');
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('不支持的请求方法');
      if (method === 'GET' && body !== undefined) throw new Error('GET 请求不能包含正文');
      let saved = await credentials();
      const send = () => fetchImpl(url.toString(), { method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: 'Bearer ' + saved.access_token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      let response = await send();
      if (response.status === 401) { saved = await renew(saved); response = await send(); }
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401) store.clear();
        throw new Error(`OS 请求失败（${response.status}）：${result.error || '请检查权限或参数'}`);
      }
      return result;
    },
    async logout() {
      if (!store.read()) { notify('本机未连接 OS。'); return; }
      try {
        const saved = await credentials();
        await json('/api/auth/agent/logout', {}, saved.access_token);
      } catch (error) {
        if (error.status !== 401) throw error; // Keep the cache if server revocation failed, so logout can be retried.
      }
      store.clear();
      notify('已退出，本机授权已清除。');
    },
    async status() {
      await credentials(); // Refresh also detects expired/revoked authorization when needed.
      notify('本机已有 OS 授权；业务请求会自动验证并续期。');
    }
  };
}
async function main(args = process.argv.slice(2)) {
  let baseUrl = DEFAULT_URL;
  const baseIndex = args.indexOf('--base-url');
  if (baseIndex >= 0) { baseUrl = args[baseIndex + 1]; args.splice(baseIndex, 2); }
  if (!args.length || args[0] === '--help') {
    console.log('用法：node os-client.cjs login | status | logout | request GET /api/...\n写入：request POST /api/... --body-file <JSON文件>\n可选：--base-url <OS地址>（默认生产环境）');
    return;
  }
  const client = createClient({ baseUrl });
  if (['login', 'status', 'logout'].includes(args[0]) && args.length === 1) return client[args[0]]();
  if (args[0] === 'request') {
    const index = args.indexOf('--body-file');
    if (index >= 0 && !args[index + 1]) throw new Error('缺少正文文件路径');
    const body = index >= 0 ? JSON.parse(fs.readFileSync(args[index + 1], 'utf8')) : undefined;
    if (args.length !== (index >= 0 ? 5 : 3) || (index >= 0 && index !== 3)) throw new Error('请求参数无效');
    console.log(JSON.stringify(await client.request(args[1], args[2], body)));
    return;
  }
  throw new Error('未知命令，请使用 --help');
}
if (require.main === module) main().catch((error) => {
  // Do not echo arbitrary server/network errors, which may contain request headers.
  console.error(error.safeForUser ? error.message : '操作未完成。若尚未连接或授权过期，请运行 login；其他情况请检查 OS 状态和访问权限。');
  process.exitCode = 1;
});
module.exports = { createClient, createCredentialStore, normalizeBase, windowsProtect, main };
