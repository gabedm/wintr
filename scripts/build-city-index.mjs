// Rebuild the committed, local-only suggestions from GeoNames public extracts.
// Download the three named files from https://download.geonames.org/export/dump/
// and pass their directory as the only argument. No network or executable data.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
if (process.argv.length !== 3) throw Error('Pass the directory containing cities15000.zip, admin1CodesASCII.txt and countryInfo.txt');
const input = path.resolve(process.argv[2]), root = path.resolve(import.meta.dirname, '..');
const source = name => fs.readFileSync(path.join(input, name));
const text = execFileSync('tar', ['-xOf', path.join(input, 'cities15000.zip'), 'cities15000.txt'], { maxBuffer: 32 * 1024 * 1024, windowsHide: true }).toString('utf8');
const countries = {}, allRegions = {}, regions = {};
for (const line of source('countryInfo.txt').toString('utf8').split(/\r?\n/)) { if (!line || line.startsWith('#')) continue; const row = line.split('\t'); if (/^[A-Z]{2}$/.test(row[0] ?? '') && row[4]) countries[row[0]] = row[0] === 'GB' ? 'UK' : row[4]; }
for (const line of source('admin1CodesASCII.txt').toString('utf8').split(/\r?\n/)) { const [code, name] = line.split('\t'); if (code && name) allRegions[code] = name; }
const cities = [];
for (const line of text.split(/\r?\n/)) {
  if (!line) continue; const row = line.split('\t');
  const id = Number(row[0]), name = row[1], ascii = row[2], country = row[8], admin = row[10], population = Number(row[14]);
  if (!Number.isSafeInteger(id) || id < 1 || !name || name.length > 100 || !ascii || ascii.length > 200 || !countries[country] || !Number.isSafeInteger(population) || population < 0) continue;
  const region = `${country}.${admin}`; if (allRegions[region]) regions[region] = allRegions[region];
  cities.push([id, name, ascii === name ? '' : ascii, country, admin, population]);
}
cities.sort((a, b) => b[5] - a[5] || a[0] - b[0]);
const output = path.join(root, 'src/client/public/assets/cities-20261031.json');
fs.writeFileSync(output, JSON.stringify({ version: 1, countries, regions, cities }) + '\n');
const evidence = { source: 'GeoNames cities15000: cities over15000people or capitals; not exhaustive', licence: 'CC BY4.0', date: '2026-10-31', changes: 'Keep public ID/name/ASCII/country/admin1/population only; omit names over100characters; sort by population; GB label UK', records: cities.length, countries: Object.keys(countries).length, sources: Object.fromEntries(['cities15000.zip', 'admin1CodesASCII.txt', 'countryInfo.txt'].map(n => [n, createHash('sha256').update(source(n)).digest('hex')])), outputSha256: createHash('sha256').update(fs.readFileSync(output)).digest('hex') };
fs.writeFileSync(path.join(root, 'docs/design/CITY_DATA_RECEIPT.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ records: cities.length, bytes: fs.statSync(output).size, sha256: evidence.outputSha256 }));
