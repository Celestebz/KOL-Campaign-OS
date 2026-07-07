#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
const skillsRoot = path.join(repoRoot, 'skills');
const manifestPath = path.join(skillsRoot, 'manifest.json');

function usage() {
  return [
    'Usage:',
    '  npm run install-skills',
    '  npm run install-skills -- --target ~/.agents/skills',
    '',
    'Options:',
    '  --target <dir>   Install skills into a specific skills directory'
  ].join('\n');
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseArgs(argv) {
  const args = { target: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--target') {
      args.target = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--target=')) {
      args.target = arg.slice('--target='.length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }
  return args;
}

function readManifest() {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing skills manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.entry_skill || !Array.isArray(manifest.skills) || !manifest.skills.length) {
    throw new Error('skills/manifest.json must include entry_skill and a non-empty skills array');
  }
  return manifest;
}

function validateSkillName(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
    throw new Error(`Invalid skill name in manifest: ${name}`);
  }
}

function validateSources(manifest) {
  for (const skill of manifest.skills) {
    validateSkillName(skill);
    const sourceDir = path.join(skillsRoot, skill);
    const skillFile = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new Error(`Missing skill directory: ${sourceDir}`);
    }
    if (!fs.existsSync(skillFile)) {
      throw new Error(`Missing SKILL.md for ${skill}: ${skillFile}`);
    }
  }
  if (!manifest.skills.includes(manifest.entry_skill)) {
    throw new Error(`entry_skill must be included in skills: ${manifest.entry_skill}`);
  }
}

function defaultTarget() {
  const candidates = [
    path.join(os.homedir(), '.config', 'agents', 'skills'),
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.codex', 'skills'),
    path.join(os.homedir(), '.agents', 'skills'),
    path.join(repoRoot, '.agents', 'skills')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function copyDirectory(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    force: true
  });
}

function installSkill(skill, targetRoot) {
  const sourceDir = path.join(skillsRoot, skill);
  const targetDir = path.join(targetRoot, skill);
  fs.rmSync(targetDir, { recursive: true, force: true });
  copyDirectory(sourceDir, targetDir);
  return targetDir;
}

function verifyInstall(manifest, targetRoot) {
  for (const skill of manifest.skills) {
    const targetDir = path.join(targetRoot, skill);
    const skillFile = path.join(targetDir, 'SKILL.md');
    const nestedSkillFile = path.join(targetDir, skill, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      throw new Error(`Install verification failed, missing ${skillFile}`);
    }
    if (fs.existsSync(nestedSkillFile)) {
      throw new Error(`Install verification failed, nested skill detected: ${nestedSkillFile}`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readManifest();
  validateSources(manifest);
  const targetRoot = path.resolve(expandHome(args.target) || defaultTarget());

  fs.mkdirSync(targetRoot, { recursive: true });
  const installed = manifest.skills.map((skill) => ({
    skill,
    path: installSkill(skill, targetRoot)
  }));
  verifyInstall(manifest, targetRoot);

  console.log('KOL Campaign OS skills installed.');
  console.log(`Target: ${targetRoot}`);
  console.log(`Entry skill: ${manifest.entry_skill}`);
  console.log('Installed skills:');
  for (const item of installed) {
    console.log(`- ${item.skill}: ${item.path}`);
  }
  console.log('');
  console.log('Next: start KOL Campaign OS, then choose the entry skill in your agent.');
  console.log('Backend URL: http://localhost:5001');
}

try {
  main();
} catch (error) {
  console.error(`Skill install failed: ${error.message}`);
  process.exit(1);
}
