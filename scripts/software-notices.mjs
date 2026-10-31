// Local deterministic production inventory and verbatim notice preparation.
// No package code is executed and no network, credentials or private helpers
// are used. Re-run after a reviewed lockfile change, then inspect the diff.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const modules = realpathSync(join(root, 'node_modules'));
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const upstreamRoot = join(root, 'scripts/upstream-notices');
const upstream = JSON.parse(readFileSync(join(upstreamRoot, 'sources.json'), 'utf8'));
const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = path => path.split(sep).join('/');
const within = (base, path) => { const r = relative(base, path); return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)); };
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const ROOT_DISTRIBUTION = { '@fontsource/inter': 'font_assets', '@fontsource/space-grotesk': 'font_assets',
  '@google-cloud/firestore': 'external_server', 'google-auth-library': 'external_server', parse5: 'external_server', react: 'bundled_client', 'react-dom': 'bundled_client', ws: 'external_server' };
const check = process.argv.slice(2).includes('--check');
const inspect = process.argv.slice(2).includes('--inspect');
if (process.argv.slice(2).some(arg => !['--check', '--inspect'].includes(arg)) || (check && inspect)) throw new Error('Use no flag, --check, or --inspect.');

// Package keys and integrity records are read only from pnpm's packages section;
// peer-specific snapshots are not separate source package versions.
const integrities = new Map();
let packages = false, key = null;
for (const line of lock.split(/\r?\n/)) {
  if (line === 'packages:') { packages = true; continue; }
  if (packages && /^[^\s]/.test(line)) break;
  if (!packages) continue;
  const header = /^  (?:'([^']+)'|([^\s][^:]*)):$/.exec(line);
  if (header) { key = header[1] ?? header[2]; continue; }
  const integrity = /^    resolution: \{integrity: (sha\d+-[A-Za-z0-9+/=]+)\}$/.exec(line);
  if (key && integrity) integrities.set(key, integrity[1]);
}

function locate(name, from) {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) throw new Error('Unsupported dependency name.');
  let dir = from;
  while (within(root, dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) {
      const found = realpathSync(dirname(candidate));
      if (!within(modules, found)) throw new Error('Dependency outside the supported local install.');
      return found;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const NOTICE = /^(?:licen[cs]e|notice|copying|copyright|authors)(?:[._-].*)?$/i;
function originalNotices(dir) {
  const notices = [];
  function visit(here, depth) {
    if (depth > 30) throw new Error('Dependency notice directory is too deep.');
    for (const entry of readdirSync(here, { withFileTypes: true }).sort((a,b) => order(a.name, b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const file = join(here, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (NOTICE.test(entry.name)) {
        const actual = realpathSync(file);
        if (!within(dir, actual)) throw new Error('Dependency notice leaves its package.');
        const bytes = readFileSync(actual);
        if (bytes.length > 1024 * 1024) throw new Error('Dependency notice exceeds the supported bound.');
        decode(bytes);
        notices.push({ path: slash(relative(dir, file)), bytes });
      }
    }
  }
  visit(dir, 0);
  return notices;
}

const visited = new Set(), found = new Map(), missingOptional = new Set();
function walk(name, from, distribution, optional = false) {
  const dir = locate(name, from);
  if (!dir) {
    if (optional) { missingOptional.add(name); return; }
    throw new Error('Required production dependency is not installed: ' + name);
  }
  const visitKey = distribution + ':' + dir;
  if (visited.has(visitKey)) return;
  visited.add(visitKey);
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (meta.name !== name || typeof meta.version !== 'string' || typeof meta.license !== 'string') throw new Error('Unsupported production package metadata.');
  const id = meta.name + '@' + meta.version, integrity = integrities.get(id);
  if (!integrity) throw new Error('No exact lockfile integrity for ' + id);
  const notices = originalNotices(dir), extra = upstream[id];
  let status = 'packaged_original_notices';
  if (extra && extra.license !== meta.license) throw new Error('Reviewed upstream licence changed: ' + id);
  if (notices.length === 0 && id === 'data-uri-to-buffer@4.0.1') {
    const bytes = readFileSync(join(dir, 'README.md')), text = decode(bytes);
    if (!text.includes('Permission is hereby granted, free of charge') || !text.includes('THE SOFTWARE IS PROVIDED')) throw new Error('Embedded packaged MIT notice changed.');
    notices.push({ path: 'README.md', bytes }); status = 'packaged_readme_notice';
  }
  if (notices.length === 0 && extra?.status === 'upstream_verified_notice') {
    if (basename(extra.notice) !== extra.notice || typeof extra.sha256 !== 'string') throw new Error('Invalid reviewed notice location.');
    const bytes = readFileSync(join(upstreamRoot, extra.notice));
    if (sha(bytes) !== extra.sha256) throw new Error('Reviewed upstream notice hash changed: ' + id);
    decode(bytes); notices.push({ path: 'upstream/' + extra.notice, bytes }); status = extra.status;
  }
  if (notices.length === 0) {
    if (extra?.status !== 'declared_license_original_notice_unresolved' || meta.license !== 'MIT' || extra.original_notice !== null) {
      throw new Error('Unreviewed missing original notice: ' + id);
    }
    status = extra.status;
  }
  const record = { id, name, version: meta.version, distribution: [distribution], declared_license: meta.license, integrity, notice_status: status,
    notices: notices.map(notice => ({ path: notice.path, sha256: sha(notice.bytes) })), ...(extra ? { publication_provenance: extra } : {}) };
  const previous = found.get(id);
  if (previous && JSON.stringify(previous.record) !== JSON.stringify({ ...record, distribution: previous.record.distribution })) throw new Error('Same package version has different notice material: ' + id);
  if (previous) record.distribution = [...new Set([...previous.record.distribution, distribution])].sort();
  found.set(id, { record, notices });
  const dependencies = { ...meta.peerDependencies, ...meta.dependencies, ...meta.optionalDependencies };
  for (const dep of Object.keys(dependencies).sort()) {
    walk(dep, dir, distribution, Object.hasOwn(meta.optionalDependencies ?? {}, dep) || meta.peerDependenciesMeta?.[dep]?.optional === true);
  }
}
for (const name of Object.keys(packageJson.dependencies ?? {}).sort()) {
  if (!Object.hasOwn(ROOT_DISTRIBUTION, name)) throw new Error('Review the distribution of new production root: ' + name);
  walk(name, root, ROOT_DISTRIBUTION[name]);
}
const entries = [...found.values()].sort((a,b) => order(a.record.id, b.record.id));
const unresolved = entries.filter(entry => entry.record.notice_status === 'declared_license_original_notice_unresolved').map(entry => entry.record.id);
const inventory = { about: 'Installed production dependency closure from the frozen pnpm lockfile. Original-code MIT does not replace these licences. No private machine paths or credentials.',
  original_notice_unresolved: unresolved, missing_optional_dependencies: [...missingOptional].sort(), packages: entries.map(entry => entry.record) };
if (inspect) { console.log(JSON.stringify(inventory, null, 2)); process.exit(0); }
const parts = ['Wintr third-party software notices\n\nThese are verbatim packaged notices or individually verified, pinned upstream notices. Some upstream notices were added after publication; software.json records their exact-version applicability and separate publication and notice commits. All production dependencies are inventoried there. External server packages must also retain their installed notices. Music and provider data have separate terms.\n'];
for (const { record, notices } of entries) {
  parts.push('\n============================================================\n' + record.id + '\nDeclared licence: ' + record.declared_license + '\nDistribution: ' + record.distribution.join(', ') + '\n');
  if (!notices.length) parts.push('Original notice unresolved: the exact package and publication commit declare MIT but provide no complete original notice. No copyright holder or notice text has been invented. See software.json for primary provenance.\n');
  for (const notice of notices) parts.push('\n--- Original ' + notice.path + ' ---\n' + decode(notice.bytes) + '\n');
}
const output = join(root, 'src/client/public/licenses');
const artefacts = { 'software.json': JSON.stringify(inventory, null, 2) + '\n', 'Software-NOTICES.txt': parts.join('') };
if (!check) mkdirSync(output, { recursive: true });
for (const [name, content] of Object.entries(artefacts)) {
  const target = join(output, name), bytes = Buffer.from(content, 'utf8');
  if (check) {
    if (!existsSync(target) || !readFileSync(target).equals(bytes)) throw new Error('Regenerate and review third-party artefact: ' + name);
  } else writeFileSync(target, bytes);
}
console.log(JSON.stringify({ checked: check, production_package_versions: entries.length,
  original_notice_files: entries.reduce((total, entry) => total + entry.notices.length, 0),
  original_notice_unresolved: unresolved, network_requests: 0 }));
