import { canonicalConcertUrl, compareConcerts, isConcertImage, isConcertQuery, isConcertReply, validConcertDate, type Concert, type ConcertQuery, type ConcertReply } from '../shared/concerts.js';
import type { HttpTransport } from './providers/http.js';
import { refuseDuplicateKeys } from './providers/json-keys.js';
import type { TicketmasterAdmission, TicketmasterAuthorization } from './ticketmaster-rate.js';

export interface ConcertContext { readonly signal: AbortSignal; readonly authorize: () => Promise<boolean>; readonly isCurrent: () => boolean; readonly authorizeAdmission?: TicketmasterAuthorization }
export interface ConcertSearch { available(): boolean; search(query: ConcertQuery, context: ConcertContext): Promise<ConcertReply> }
export interface TicketmasterAccess { readonly apiKey: string; readonly validUntil: number }
export interface TicketmasterPreparation { readonly access: () => TicketmasterAccess | null; readonly dailyLimit: number }
export function captureTicketmasterPreparation(raw: unknown): TicketmasterPreparation {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error('ticketmaster_binding_invalid');
  const d = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).length !== 2 || !['access','dailyLimit'].every(k=>Object.hasOwn(d,k)&&Object.hasOwn(d[k]!,'value')) || typeof d.access!.value !== 'function' || !Number.isSafeInteger(d.dailyLimit!.value) || d.dailyLimit!.value < 1 || d.dailyLimit!.value > 5000) throw new Error('ticketmaster_binding_invalid');
  return Object.freeze({ access:d.access!.value as TicketmasterPreparation['access'], dailyLimit:d.dailyLimit!.value as number });
}
export interface TicketmasterOptions {
  readonly transport: HttpTransport;
  /** Controller-owned ongoing authority. No env default or client-selected key. */
  readonly access: () => TicketmasterAccess | null;
  /** Stable shared gate counts each request BEFORE dispatch, including unknown outcomes; no refund/retry. */
  readonly admit: (signal: AbortSignal, authorize?: TicketmasterAuthorization) => Promise<TicketmasterAdmission>;
  readonly now?: () => number;
  /** Offline timing seam. Ordinary composition always uses the abortable delay. */
  readonly pause?: (ms: number, signal: AbortSignal) => Promise<void>;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 300): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const fold = (s: string) => s.normalize('NFKC').trim().toLocaleLowerCase('en');
const keyOk = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(s);
const idOk = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const collection = (result: Record<string, unknown>, key: 'attractions' | 'events', max: number): unknown[] => {
  if (result._embedded !== undefined && !object(result._embedded)) throw new Error('unavailable');
  const list = object(result._embedded) ? result._embedded[key] : undefined;
  if (list === undefined) {
    // Ticketmaster omits _embedded for a genuine zero-result page. Missing or
    // corrupt metadata without that explicit zero is an operational failure.
    if (object(result.page) && result.page.totalElements === 0) return [];
    throw new Error('unavailable');
  }
  if (!Array.isArray(list) || list.length > max) throw new Error('unavailable');
  return list;
};
const pacedDelay = (ms: number, signal: AbortSignal) => new Promise<void>((yes, no) => {
  if (signal.aborted) { no(new Error('unavailable')); return; }
  const cancelled = () => { clearTimeout(timer); signal.removeEventListener('abort', cancelled); no(new Error('unavailable')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); yes(); }, ms);
  signal.addEventListener('abort', cancelled, { once: true });
});

/** Fixed first-party routes, exact attraction matching, bounded results, no music-model calls or automatic retry. */
export function createTicketmasterSearch(options: TicketmasterOptions): ConcertSearch {
  const now = options.now ?? Date.now;
  const pause = options.pause ?? pacedDelay;
  let lastDispatchAt: number | null = null;
  const access = () => { const a = options.access(); return a && keyOk(a.apiKey) && Number.isSafeInteger(a.validUntil) && a.validUntil > now() ? a : null; };
  const available = () => { try { return access() !== null; } catch { return false; } };
  return Object.freeze({
    available,
    async search(input: ConcertQuery, ctx: ConcertContext): Promise<ConcertReply> {
      if (!isConcertQuery(input) || !available() || ctx.signal.aborted) throw new Error('unavailable');
      const query = Object.freeze({ artists: Object.freeze([...input.artists]), city: input.city, countryCode: Object.hasOwn(input, 'countryCode') ? input.countryCode : null, from: input.from, to: input.to });
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(25000)]);
      const startedAt = now(), atomic = ctx.authorizeAdmission !== undefined;
      if (atomic && typeof ctx.authorizeAdmission !== 'function') throw new Error('unavailable');
      const locallyCurrent = () => !signal.aborted && available() && ctx.isCurrent();
      const current = async () => locallyCurrent() && await ctx.authorize() && locallyCurrent();
      const request = async (path: 'attractions.json' | 'events.json', params: Record<string, string>): Promise<Record<string, unknown>> => {
        if (!(atomic ? locallyCurrent() : await current()) || !locallyCurrent()) throw new Error('unavailable');
        // Space this instance's intended requests before admission. This is one
        // bounded search, never a retry of a dispatched or refused request.
        const spacing = lastDispatchAt === null ? 0 : Math.min(550, Math.max(0, 550 - (now() - lastDispatchAt)));
        if (spacing > 0) await pause(spacing, signal);
        if (!locallyCurrent()) throw new Error('unavailable');
        let authorizedInAdmission = false;
        const authorizeAdmission: TicketmasterAuthorization | undefined = ctx.authorizeAdmission ? async work => {
          let planned: TicketmasterAdmission | null = null;
          const result = await ctx.authorizeAdmission!(async tx => (planned = await work(tx)));
          authorizedInAdmission = result !== null && result === planned; return result;
        } : undefined;
        const admission = await options.admit(signal, authorizeAdmission);
        if (!admission.allowed) throw new Error(admission.reason);
        if ((atomic ? !authorizedInAdmission : !await current()) || !locallyCurrent() || !Number.isSafeInteger(admission.dispatchBy) || now() >= admission.dispatchBy) throw new Error('unavailable');
        const a = access(); if (!a) throw new Error('unavailable');
        const url = new URL(`https://app.ticketmaster.com/discovery/v2/${path}`);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        url.searchParams.set('apikey', a.apiKey);
        let response;
        if (!locallyCurrent() || now() >= admission.dispatchBy) throw new Error('unavailable');
        lastDispatchAt = now();
        try { response = await options.transport({ method: 'GET', url, headers: { Accept: 'application/json' }, signal, maxResponseBytes: 512 * 1024 }); }
        catch { throw new Error('unavailable'); }
        if (response.status === 429) throw new Error('limited');
        if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.contentType ?? '') || response.body.byteLength > 512 * 1024 || !(atomic ? locallyCurrent() : await current()) || !locallyCurrent()) throw new Error('unavailable');
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
          const data: unknown = JSON.parse(text); refuseDuplicateKeys(text, () => new Error('unavailable')); if (!object(data)) throw new Error(); return data;
        } catch { throw new Error('unavailable'); }
      };
      const events = new Map<string, Concert>(); let incomplete = false;
      for (const [index, artist] of query.artists.entries()) {
        // Leave time for a last artist's two requests and final authorization.
        // Completed real coverage may be partial; a timeout must not erase it
        // merely because another artist was started at the budget's edge.
        if (index > 0 && now() - startedAt >= 17000) { incomplete = true; break; }
        if (!(atomic ? locallyCurrent() : await current()) || !locallyCurrent()) throw new Error('unavailable');
        try {
          const result = await request('attractions.json', { keyword: artist, classificationName: 'music', size: '6', locale: 'en' });
          const attractions = collection(result, 'attractions', 6);
          if (attractions.some(a => !object(a) || !str(a.name, 128) || !idOk(a.id))) incomplete = true;
          if (object(result.page) && typeof result.page.totalElements === 'number' && result.page.totalElements > attractions.length) incomplete = true;
          const matches = attractions.filter((a): a is Record<string, unknown> => object(a) && str(a.name, 128) && fold(a.name) === fold(artist));
          // Name alone cannot select between separate provider identities. No silent first-result choice.
          if (matches.length !== 1 || !idOk(matches[0]?.id)) { if (matches.length > 1) incomplete = true; continue; }
          const attractionId = matches[0].id as string;
          const from = new Date(`${query.from}T00:00:00Z`); from.setUTCDate(from.getUTCDate() - 1);
          const params: Record<string, string> = { attractionId, classificationName: 'music', startDateTime: from.toISOString().replace('.000Z', 'Z'), sort: 'date,asc', size: '10', locale: 'en', includeTest: 'no' };
          if (query.city) params.city = query.city;
          if (query.countryCode) params.countryCode = query.countryCode;
          if (query.to) { const end = new Date(`${query.to}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 2); params.endDateTime = end.toISOString().replace('.000Z', 'Z'); }
          const found = await request('events.json', params), listings = collection(found, 'events', 10);
          if (object(found.page) && typeof found.page.totalElements === 'number' && found.page.totalElements > listings.length) incomplete = true;
          for (const raw of listings) {
            if (!object(raw) || !object(raw.dates) || !object(raw.dates.start) || !object(raw.dates.status) || !object(raw._embedded)) { incomplete = true; continue; }
            const attractionList = raw._embedded.attractions, venues = raw._embedded.venues, start = raw.dates.start;
            if (!Array.isArray(attractionList) || !attractionList.some(v => object(v) && v.id === attractionId && str(v.name, 128) && fold(v.name) === fold(artist)) || !Array.isArray(venues) || !object(venues[0])) { incomplete = true; continue; }
            const venue = venues[0], city = object(venue.city) ? venue.city.name : null, url = canonicalConcertUrl(raw.url);
            if (query.countryCode && (!object(venue.country) || venue.country.countryCode !== query.countryCode)) { incomplete = true; continue; }
            if (!idOk(raw.id) || !str(raw.name) || !str(venue.name) || !str(city) || !validConcertDate(start.localDate) || !url || !['onsale', 'offsale', 'cancelled', 'postponed', 'rescheduled'].includes(String(raw.dates.status.code))) { incomplete = true; continue; }
            if (start.localDate < query.from || (query.to && start.localDate > query.to)) continue;
            const image = Array.isArray(raw.images) ? raw.images.find(v => object(v) && isConcertImage(v.url)) : null;
            const countryCode = object(venue.country) && typeof venue.country.countryCode === 'string' && /^[A-Z]{2}$/.test(venue.country.countryCode) ? venue.country.countryCode : null;
            const event: Concert = { id: raw.id, title: raw.name, artists: [artist], date: start.localDate, time: typeof start.localTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(start.localTime) ? start.localTime : null, venue: venue.name, city, url, image: image && object(image) && isConcertImage(image.url) ? image.url : null, status: raw.dates.status.code as Concert['status'] };
            const old = events.get(event.id); events.set(event.id, old ? { ...old, artists: [...new Set([...old.artists, artist])] } : { ...event, countryCode });
          }
        } catch (error) { throw new Error(error instanceof Error && error.message === 'limited' ? 'limited' : 'unavailable'); }
      }
      if (!await current() || !locallyCurrent()) throw new Error('unavailable');
      const reply = { events: [...events.values()].sort(compareConcerts).slice(0, 60), incomplete: incomplete || events.size > 60, checkedAt: now() };
      if (!isConcertReply(reply)) throw new Error('unavailable'); return reply;
    },
  });
}
