export interface ConcertQuery { readonly artists: readonly string[]; readonly city: string | null; readonly countryCode?: string | null; readonly from: string; readonly to: string | null }
export interface Concert {
  readonly id: string; readonly title: string; readonly artists: readonly string[];
  readonly date: string; readonly time: string | null; readonly venue: string; readonly city: string;
  /** Absent only in older replies; never infer a country from a city name. */
  readonly countryCode?: string | null;
  readonly url: string; readonly image: string | null; readonly status: 'onsale' | 'offsale' | 'cancelled' | 'postponed' | 'rescheduled';
}
export interface ConcertReply { readonly events: readonly Concert[]; readonly incomplete: boolean; readonly checkedAt: number }
export const CONCERT_ARTISTS = 12;
export const compareConcerts = (a: Concert, b: Concert) => a.date.localeCompare(b.date) || (a.time ?? '99:99').localeCompare(b.time ?? '99:99') || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
export function filterConcerts(events: readonly Concert[], filter: Pick<ConcertQuery, 'city' | 'countryCode' | 'from' | 'to'>): Concert[] {
  const fold = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase('en');
  return events.filter(e => e.date >= filter.from && (!filter.to || e.date <= filter.to) && (!filter.city || fold(e.city) === fold(filter.city)) && (!filter.countryCode || e.countryCode === filter.countryCode)).sort(compareConcerts);
}
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: unknown, keys: readonly string[]) => plain(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k) && Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, 'value'));
const text = (v: unknown, max = 300): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const dataArray = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max && Reflect.ownKeys(v).length === v.length + 1 && Array.from({length:v.length},(_,i)=>Object.getOwnPropertyDescriptor(v,i)).every(d=>!!d&&Object.hasOwn(d,'value'));
export const validConcertDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const TICKET_HOSTS = new Set(['www.ticketmaster.com', 'www.ticketmaster.co.uk', 'www.ticketmaster.ie', 'www.ticketmaster.ca', 'www.ticketmaster.com.au', 'www.ticketmaster.co.nz', 'www.ticketmaster.de', 'www.ticketmaster.fr', 'www.ticketmaster.nl', 'www.ticketmaster.es', 'www.ticketmaster.se', 'www.ticketmaster.dk', 'www.ticketmaster.no', 'www.ticketmaster.fi', 'www.livenation.com', 'www.livenation.co.uk']);
export function isConcertUrl(v: unknown): v is string {
  if (!text(v, 2048)) return false;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.search && !u.hash && TICKET_HOSTS.has(u.hostname) && /\/event\/[A-Za-z0-9_-]+\/?$/.test(u.pathname) && u.href === v; } catch { return false; }
}
export function canonicalConcertUrl(v: unknown): string | null {
  if (!text(v, 2048)) return null;
  try { const u = new URL(v); if (u.username || u.password || u.port) return null; u.search = ''; u.hash = ''; return isConcertUrl(u.href) ? u.href : null; } catch { return null; }
}
export function isConcertImage(v: unknown): v is string {
  if (!text(v, 2048)) return false;
  try { const u = new URL(v); return u.protocol === 'https:' && u.hostname === 's1.ticketm.net' && u.pathname.startsWith('/dam/') && !u.username && !u.password && !u.port && !u.search && !u.hash && u.href === v && /\.(jpe?g|png|webp)$/i.test(u.pathname); } catch { return false; }
}
export function isConcertQuery(v: unknown): v is ConcertQuery {
  if (!exact(v, ['artists', 'city', 'from', 'to']) && !exact(v, ['artists', 'city', 'countryCode', 'from', 'to'])) return false;
  const q = v as unknown as ConcertQuery;
  const country = Object.hasOwn(q, 'countryCode') ? q.countryCode : null;
  return dataArray(q.artists, CONCERT_ARTISTS) && q.artists.length > 0 && q.artists.every(a => text(a, 128)) && new Set(q.artists).size === q.artists.length &&
    (q.city === null || text(q.city, 100)) && (country === null || (typeof country === 'string' && /^[A-Z]{2}$/.test(country) && q.city !== null)) && validConcertDate(q.from) && (q.to === null || (validConcertDate(q.to) && q.to >= q.from && Date.parse(q.to) - Date.parse(q.from) <= 366 * 86400000));
}
export function isConcertReply(v: unknown): v is ConcertReply {
  if (!exact(v, ['events', 'incomplete', 'checkedAt'])) return false;
  const r = v as unknown as ConcertReply;
  const fields = ['id', 'title', 'artists', 'date', 'time', 'venue', 'city', 'url', 'image', 'status'];
  return typeof r.incomplete === 'boolean' && Number.isSafeInteger(r.checkedAt) && r.checkedAt > 0 && dataArray(r.events, 60) && new Set(r.events.map(e => e?.id)).size === r.events.length && r.events.every(e => (exact(e, fields) || exact(e, [...fields, 'countryCode'])) && (!Object.hasOwn(e, 'countryCode') || e.countryCode === null || (typeof e.countryCode === 'string' && /^[A-Z]{2}$/.test(e.countryCode))) && text(e.id, 128) && text(e.title) && dataArray(e.artists, CONCERT_ARTISTS) && e.artists.length > 0 && e.artists.every((a: unknown) => text(a, 128)) && validConcertDate(e.date) && (e.time === null || /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(e.time)) && text(e.venue) && text(e.city) && isConcertUrl(e.url) && (e.image === null || isConcertImage(e.image)) && ['onsale', 'offsale', 'cancelled', 'postponed', 'rescheduled'].includes(e.status));
}
