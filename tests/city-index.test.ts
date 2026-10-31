import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createCityIndex } from '../src/client/city-index.js';
const raw = JSON.parse(readFileSync(new URL('../src/client/public/assets/cities-20261031.json', import.meta.url), 'utf8'));
const index = createCityIndex(raw);
it('finds real prefix cities from the shipped global index and ranks London UK first for lon', () => {
  expect(raw.cities.length).toBeGreaterThan(25000); expect(index.search('lon')[0]).toMatchObject({ city: 'London', countryCode: 'GB', label: 'London, UK' });
  expect(index.search('london').some(c => c.countryCode === 'CA')).toBe(true); expect(index.search('lon').length).toBeLessThanOrEqual(8); expect(index.search('l')).toEqual([]);
});
it('matches case and accents and lets country or region disambiguate namesakes', () => {
  expect(index.search('LONDON, canada')[0]).toMatchObject({ city: 'London', countryCode: 'CA', region: 'Ontario' });
  expect(index.search('london, uk')[0]?.countryCode).toBe('GB'); expect(index.search('london, ontario')[0]?.countryCode).toBe('CA'); expect(index.search('sao paulo')[0]?.countryCode).toBe('BR');
  expect(index.search('invented missing place')).toEqual([]);
});
it('rejects malformed, duplicate or country-less city rows instead of using a partial corrupt index', () => {
  const small = { version: 1, countries: { GB: 'UK' }, regions: { 'GB.ENG': 'England' }, cities: [[1, 'London', '', 'GB', 'ENG', 9000000]] };
  expect(createCityIndex(small).search('lon')[0]?.city).toBe('London');
  for (const value of [{ ...small, version: 2 }, { ...small, cities: [small.cities[0], small.cities[0]] }, { ...small, cities: [[1, 'London', '', 'XX', 'ENG', 1]] }, { ...small, cities: [[1, 'bad\nname', '', 'GB', 'ENG', 1]] }, { ...small, countries: { GB: '<bad\nname>' } }]) expect(() => createCityIndex(value)).toThrow();
});
