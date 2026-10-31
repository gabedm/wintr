// Regenerates the shipped font notices from the installed, lockfile-pinned
// @fontsource packages: copies each packaged LICENSE byte-for-byte into
// src/client/public/licenses/ (Vite ships that directory unchanged) and pins
// versions, lockfile integrity and SHA-256 hashes of every font file the client
// imports in fonts.json. Relative paths only. Run after a font upgrade:
//   node scripts/font-notices.mjs
// tests/server-shell.test.ts verifies the result against the installed
// packages and an actual client build.
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const FONTS = [
  { family: 'Inter', pkg: '@fontsource/inter', notice: 'Inter-OFL.txt', imports: ['400.css', '500.css', '600.css', '700.css', '800.css'] },
];
const OUT = 'src/client/public/licenses';
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const lock = readFileSync('pnpm-lock.yaml', 'utf8');

mkdirSync(OUT, { recursive: true });
const fonts = FONTS.map((f) => {
  const dir = `node_modules/${f.pkg}`;
  const meta = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  const integrity = lock.match(new RegExp(`'${f.pkg}@${meta.version.replace(/\./g, '\\.')}':\\s*\\n\\s*resolution: \\{integrity: ([^}]+)\\}`))?.[1];
  if (!integrity) throw new Error(`no lockfile integrity for ${f.pkg}@${meta.version}`);
  copyFileSync(`${dir}/LICENSE`, `${OUT}/${f.notice}`);
  const files = [...new Set(f.imports.flatMap((css) => [...readFileSync(`${dir}/${css}`, 'utf8').matchAll(/url\(\.\/(files\/[^)]+)\)/g)].map((m) => m[1])))].sort();
  return {
    family: f.family,
    package: f.pkg,
    version: meta.version,
    license: meta.license,
    integrity,
    repository: meta.repository,
    notice: { path: f.notice, source: `${dir}/LICENSE`, sha256: sha256(`${dir}/LICENSE`) },
    imports: f.imports,
    files: files.map((p) => ({ path: `${dir}/${p}`, sha256: sha256(`${dir}/${p}`) })),
  };
});
writeFileSync(
  `${OUT}/fonts.json`,
  JSON.stringify(
    {
      about:
        'Self-hosted fonts shipped with Wintr. Each notice file is the packaged SIL Open Font License 1.1 text and copyright notice, copied verbatim. The MIT licence covers Wintr original code only.',
      fonts,
    },
    null,
    2,
  ) + '\n',
);
console.log(`wrote ${OUT}: ${fonts.map((f) => `${f.package}@${f.version} (${f.files.length} files)`).join(', ')}`);
