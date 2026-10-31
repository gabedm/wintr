export interface CityOption { readonly id: number; readonly city: string; readonly countryCode: string; readonly country: string; readonly region: string; readonly label: string }
export interface ConcertLocation { readonly city: string | null; readonly countryCode: string | null; readonly label: string }
export interface CityIndex { search(query: string): readonly CityOption[] }
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const fold = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').trim().toLocaleLowerCase('en').replace(/\s+/g, ' ');
const countryAliases: Record<string, readonly string[]> = { GB: ['uk', 'united kingdom', 'great britain'], US: ['us', 'usa', 'united states', 'united states of america'] };
export function createCityIndex(raw: unknown): CityIndex {
  if (!plain(raw) || Object.keys(raw).sort().join(',') !== 'cities,countries,regions,version' || raw.version !== 1 || !plain(raw.countries) || !plain(raw.regions) || !Array.isArray(raw.cities) || raw.cities.length > 50000) throw Error('invalid_city_index');
  const { countries, regions } = raw;
  if (Object.keys(countries).length > 300 || !Object.entries(countries).every(([key, value]) => /^[A-Z]{2}$/.test(key) && text(value)) || Object.keys(regions).length > 6000 || !Object.entries(regions).every(([key, value]) => /^[A-Z]{2}\.[\w-]{1,20}$/.test(key) && text(value))) throw Error('invalid_city_index');
  const seen = new Set<number>();
  const entries = raw.cities.map(row => {
    if (!Array.isArray(row) || row.length !== 6 || !Number.isSafeInteger(row[0]) || row[0] < 1 || seen.has(row[0]) || !text(row[1], 100) || (row[2] !== '' && !text(row[2])) || typeof row[3] !== 'string' || !Object.hasOwn(countries, row[3]) || typeof row[4] !== 'string' || !/^[\w-]{0,20}$/.test(row[4]) || !Number.isSafeInteger(row[5]) || row[5] < 0) throw Error('invalid_city_index');
    seen.add(row[0]);
    const country = countries[row[3]] as string, region = regions[`${row[3]}.${row[4]}`] as string | undefined;
    const option: CityOption = Object.freeze({ id: row[0], city: row[1], countryCode: row[3], country, region: region ?? '', label: `${row[1]}, ${country}` });
    return { option, names: [...new Set([fold(row[1]), ...(row[2] ? [fold(row[2])] : [])])], countryTerms: [fold(country), fold(row[3]), fold(region ?? ''), ...(countryAliases[row[3]] ?? [])], population: row[5] as number };
  });
  return Object.freeze({ search(query: string) {
    const parts = fold(query.slice(0, 100)).split(',').map(s => s.trim()), name = parts[0] ?? '', area = parts.slice(1).join(' ').trim();
    if (name.length < 2) return [];
    return entries.filter(e => e.names.some(n => n.startsWith(name)) && (!area || e.countryTerms.some(n => n.startsWith(area)))).sort((a, b) => Number(b.names.includes(name)) - Number(a.names.includes(name)) || b.population - a.population || a.option.id - b.option.id).slice(0, 8).map(e => e.option);
  } });
}
let cached: CityIndex | null = null;
export async function loadCityIndex(signal: AbortSignal): Promise<CityIndex> {
  if (cached) return cached;
  const response = await fetch('/assets/cities-20261031.json', { credentials: 'omit', cache: 'force-cache', signal });
  if (!response.ok) throw Error('city_index_unavailable');
  const body = await response.text(); if (body.length > 4 * 1024 * 1024) throw Error('invalid_city_index');
  const result = createCityIndex(JSON.parse(body)); if (!signal.aborted) cached = result; return result;
}
