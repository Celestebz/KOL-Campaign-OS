/**
 * Build the Windows installer for KOL Campaign OS.
 *
 * Stages dist/app/ (server sources + production node_modules, client/build,
 * portable node.exe, portable MariaDB, launcher scripts), then compiles
 * installer/kol-campaign-os.nsi into dist/KOL-Campaign-OS-Setup-<version>.exe.
 *
 * Usage: node scripts/build-installer.js [--skip-client-build]
 *
 * Vendor tools (auto-downloaded into installer/vendor/ when missing):
 *   - MariaDB portable zip  (Aliyun mirror, falls back to archive.mariadb.org)
 *   - NSIS (electron-builder-binaries via npmmirror CDN)
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'installer', 'vendor');
const DIST = path.join(ROOT, 'dist');
const APP = path.join(DIST, 'app');

const MARIADB_VERSION = '11.4.12';
const MARIADB_ZIP = `mariadb-${MARIADB_VERSION}-winx64.zip`;
const MARIADB_URLS = [
  `https://mirrors.aliyun.com/mariadb/mariadb-${MARIADB_VERSION}/winx64-packages/${MARIADB_ZIP}`,
  `https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/winx64-packages/${MARIADB_ZIP}`
];
const NSIS_7Z = 'nsis-3.0.5.0.7z';
const NSIS_URL = `https://registry.npmmirror.com/-/binary/electron-builder-binaries/nsis-3.0.5.0/${NSIS_7Z}`;
const SEVEN_ZIP_NPM = '7zip-bin';

const SKIP_CLIENT_BUILD = process.argv.includes('--skip-client-build');

function log(msg) { console.log(`[build-installer] ${msg}`); }
function die(msg) { console.error(`[build-installer] ERROR: ${msg}`); process.exit(1); }
function run(cmd, opts = {}) {
  log(`$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', shell: true, ...opts });
}
function cp(src, dest) { fs.cpSync(src, dest, { recursive: true }); }
function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

function download(url, dest) {
  log(`download ${url}`);
  execSync(`curl -sfL --retry 2 -o "${dest}" "${url}" -A "Mozilla/5.0"`, { stdio: 'inherit', shell: true });
}

function ensureFile(dest, urls) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) return;
  for (const url of [].concat(urls)) {
    try { download(url, dest); return; } catch (e) { log(`mirror failed: ${url}`); }
  }
  die(`cannot download ${path.basename(dest)} from any mirror`);
}

function ensure7za() {
  const local = path.join(VENDOR, '7zip-bin', 'win', 'x64', '7za.exe');
  if (fs.existsSync(local)) return local;
  log('fetching 7zip-bin from npm...');
  const tgz = execSync(`npm pack ${SEVEN_ZIP_NPM} --silent`, { cwd: VENDOR, shell: true, encoding: 'utf8' }).trim().split('\n').pop();
  execSync(`tar -xzf "${tgz}"`, { cwd: VENDOR, shell: true });
  fs.renameSync(path.join(VENDOR, 'package'), path.join(VENDOR, '7zip-bin'));
  fs.rmSync(path.join(VENDOR, tgz), { force: true });
  if (!fs.existsSync(local)) die('7zip-bin layout unexpected');
  return local;
}

function ensureMariaDb() {
  const zipPath = path.join(VENDOR, MARIADB_ZIP);
  ensureFile(zipPath, MARIADB_URLS);
  return zipPath;
}

function ensureMakensis() {
  const exe = path.join(VENDOR, 'nsis-extracted', 'makensis.exe');
  if (fs.existsSync(exe)) return exe;
  const sevenZip = ensure7za();
  const sevenZPath = path.join(VENDOR, NSIS_7Z);
  ensureFile(sevenZPath, NSIS_URL);
  execSync(`"${sevenZip}" x -y -o"${path.join(VENDOR, 'nsis-extracted')}" "${sevenZPath}"`, { stdio: 'inherit' });
  if (!fs.existsSync(exe)) die('makensis.exe not found after extracting NSIS bundle');
  return exe;
}

function findNodeExe() {
  const out = execSync('where node', { shell: true, encoding: 'utf8' }).trim().split('\n')[0].trim();
  if (!fs.existsSync(out)) die(`node.exe not found: ${out}`);
  return out;
}

function stage() {
  rmrf(APP);
  mkdir(APP);

  // 1. Client build
  if (!SKIP_CLIENT_BUILD) {
    run('npm run build');
  }
  const clientBuild = path.join(ROOT, 'client', 'build', 'index.html');
  if (!fs.existsSync(clientBuild)) die('client/build/index.html missing; run npm run build first');
  cp(path.join(ROOT, 'client', 'build'), path.join(APP, 'client', 'build'));

  // 2. Server sources (no node_modules, no scratch/tmp/test files)
  const serverDest = path.join(APP, 'server');
  mkdir(serverDest);
  const skip = new Set(['node_modules', '.env']);
  for (const entry of fs.readdirSync(path.join(ROOT, 'server'), { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    if (/^(_tmp|scratch_)/.test(entry.name)) continue;
    if (entry.name.endsWith('.test.js')) continue;
    cp(path.join(ROOT, 'server', entry.name), path.join(serverDest, entry.name));
  }

  // 3. Production dependencies
  log('installing server production dependencies (npm ci --omit=dev)...');
  execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: serverDest, stdio: 'inherit', shell: true });

  // 4. Portable node.exe
  mkdir(path.join(APP, 'node'));
  fs.copyFileSync(findNodeExe(), path.join(APP, 'node', 'node.exe'));

  // 5. Portable MariaDB (strip dev/test baggage)
  const mariaZip = ensureMariaDb();
  log('extracting MariaDB...');
  execSync(`powershell -NoProfile -Command "Expand-Archive -Force -LiteralPath '${mariaZip}' -DestinationPath '${VENDOR}'"`, { shell: true });
  const mariaSrc = path.join(VENDOR, `mariadb-${MARIADB_VERSION}-winx64`);
  const mariaDest = path.join(APP, 'mariadb');
  rmrf(mariaDest);
  mkdir(mariaDest);
  for (const sub of ['bin', 'lib', 'share']) {
    cp(path.join(mariaSrc, sub), path.join(mariaDest, sub));
  }
  // mysqld needs the MSVC runtime; take it from the build machine's System32.
  const sys32 = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32';
  for (const dll of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) {
    const src = path.join(sys32, dll);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(mariaDest, 'bin', dll));
    else log(`warning: ${dll} not found in System32; target machine needs VC++ 2015-2022 redist`);
  }

  // 6. Launcher scripts + installer templates
  const scriptsDest = path.join(APP, 'scripts');
  mkdir(scriptsDest);
  for (const f of ['start-service.bat', 'start-hidden.vbs', 'init-db.sql']) {
    fs.copyFileSync(path.join(ROOT, 'installer', 'templates', f), path.join(scriptsDest, f));
  }
  mkdir(path.join(APP, 'data'));
  mkdir(path.join(APP, 'logs'));

  log(`staged ${APP}`);
}

function build(makensis) {
  const version = require(path.join(ROOT, 'package.json')).version;
  const nsi = path.join(ROOT, 'installer', 'kol-campaign-os.nsi');
  if (!fs.existsSync(nsi)) die(`NSIS script missing: ${nsi}`);
  // makensis only auto-detects UTF-8 scripts when they carry a BOM; edits may
  // strip it, so enforce it here (idempotent).
  const src = fs.readFileSync(nsi);
  if (!(src[0] === 0xEF && src[1] === 0xBB && src[2] === 0xBF)) {
    fs.writeFileSync(nsi, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), src]));
    log('added UTF-8 BOM to NSIS script');
  }
  execFileSync(makensis, [`/DVERSION=${version}`, `/DOUTDIR=${DIST}`, nsi], { stdio: 'inherit' });
  const exe = path.join(DIST, `KOL-Campaign-OS-Setup-${version}.exe`);
  if (!fs.existsSync(exe)) die(`expected output missing: ${exe}`);
  log(`OK -> ${exe} (${(fs.statSync(exe).size / 1024 / 1024).toFixed(1)} MB)`);
}

const makensis = ensureMakensis();
stage();
build(makensis);
