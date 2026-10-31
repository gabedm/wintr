import { useEffect, useRef, useState } from 'react';
import { CONCERT_ARTISTS, filterConcerts, isConcertReply, validConcertDate, type ConcertQuery, type ConcertReply } from '../shared/concerts.js';
import type { SavedSong } from '../shared/saved-song.js';
import { TicketIcon } from './mobile-icons.js';
import { ConcertCalendar } from './ConcertCalendar.js';
import { ConcertLocationPicker } from './ConcertLocationPicker.js';
import type { ConcertLocation } from './city-index.js';
import { ActivityDots } from './mobile-views.js';

export interface ConcertClient {
  capability(signal: AbortSignal): Promise<boolean>;
  search(query: ConcertQuery, signal: AbortSignal): Promise<ConcertReply>;
}
export const concertClient: ConcertClient = {
  async capability(signal) {
    const r = await fetch('/api/concerts/capability', { credentials: 'same-origin', cache: 'no-store', signal });
    if (r.status === 404) return false;
    if (!r.ok) throw new Error('unavailable');
    const data: unknown = await r.json();
    if (!data || typeof data !== 'object' || Object.keys(data).join(',') !== 'available' || typeof (data as { available?: unknown }).available !== 'boolean') throw new Error('invalid');
    return (data as { available: boolean }).available;
  },
  async search(query, signal) {
    const r = await fetch('/api/concerts', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query) });
    if (!r.ok) throw new Error(r.status === 429 ? 'limited' : r.status === 401 ? 'expired' : 'unavailable');
    const body = await r.text(); if (body.length > 256 * 1024) throw new Error('invalid');
    const data: unknown = JSON.parse(body); if (!isConcertReply(data)) throw new Error('invalid'); return data;
  },
};
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const prettyDate = (date: string) => validConcertDate(date) ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', ...(date.slice(0, 4) !== today().slice(0, 4) ? { year: 'numeric' as const } : {}) }).format(new Date(`${date}T12:00:00`)) : 'Dates';
function ConcertImage({ url }: { url: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  return url && failed !== url ? <img className="concert-image" src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(url)} /> : <span className="concert-image concert-image-empty" aria-hidden="true"><TicketIcon /></span>;
}
export function ConcertsScreen({ songs, active, revoked, scopeKey, getScope, ensureSession, client = concertClient }: { songs: readonly SavedSong[]; active: boolean; revoked: boolean; scopeKey: string | null; getScope: () => string | null; ensureSession: () => Promise<boolean>; client?: ConcertClient }) {
  const artists = [...new Set(songs.flatMap(s => s.artists))].slice(0, CONCERT_ARTISTS);
  const artistsKey = JSON.stringify(artists);
  const [capability, setCapability] = useState<'checking' | 'available' | 'unavailable' | 'error'>('checking');
  const [capabilityRevision, setCapabilityRevision] = useState(0);
  const capabilityVisit = useRef(0), [readyVisit, setReadyVisit] = useState(0);
  const [filter, setFilter] = useState<'location' | 'dates' | null>(null), [location, setLocation] = useState<ConcertLocation>({ city: null, countryCode: null, label: '' }), [from, setFrom] = useState(today), [to, setTo] = useState('');
  const [storedReply, setReply] = useState<ConcertReply | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const runScope = useRef<string | null>(null), replyScope = useRef<string | null>(null), runArtists = useRef<string | null>(null), replyArtists = useRef<string | null>(null);
  const reply = !revoked && replyScope.current === scopeKey && replyArtists.current === artistsKey ? storedReply : null;
  const visibleEvents = reply ? filterConcerts(reply.events, { city: location.city, countryCode: location.countryCode, from: from < today() ? today() : from, to: to || null }) : [];
  const filtered = location.city !== null || from !== today() || !!to;
  const run = useRef<AbortController | null>(null), locationToggle = useRef<HTMLButtonElement>(null), datesToggle = useRef<HTMLButtonElement>(null);
  const retryAction = useRef<HTMLButtonElement>(null), focusAfterStop = useRef(false);
  const authority = useRef({ active, revoked, scopeKey, getScope, artistsKey }); authority.current = { active, revoked, scopeKey, getScope, artistsKey };
  useEffect(() => {
    if (!active || reply) return;
    const visit = ++capabilityVisit.current;
    const abort = new AbortController(), timeout = setTimeout(() => { abort.abort(); setCapability('error'); }, 10000);
    setCapability('checking');
    void client.capability(abort.signal).then(available => { if (!abort.signal.aborted) { setCapability(available ? 'available' : 'unavailable'); if (available) setReadyVisit(visit); } }).catch(() => { if (!abort.signal.aborted) setCapability('error'); }).finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); abort.abort(); };
  }, [client, active, capabilityRevision]);
  useEffect(() => { if (active && !busy && focusAfterStop.current) { retryAction.current?.focus({ preventScroll: true }); focusAfterStop.current = false; } }, [active, busy]);
  useEffect(() => {
    if (!active || revoked || (runScope.current !== null && runScope.current !== scopeKey) || (runArtists.current !== null && runArtists.current !== artistsKey)) { run.current?.abort(); run.current = null; runScope.current = null; runArtists.current = null; setBusy(false); }
    if (revoked || replyScope.current !== scopeKey || replyArtists.current !== artistsKey) { setReply(null); setNotice(null); }
  }, [active, revoked, scopeKey, artistsKey]);
  useEffect(() => () => { run.current?.abort(); }, []);
  const datesValid = validConcertDate(from) && (!to || (validConcertDate(to) && to >= from && Date.parse(to) - Date.parse(from) <= 366 * 86400000));
  const openFilter = (which: 'location' | 'dates') => {
    // Filters edit a local view of the same owned list. They never dispatch,
    // cancel or retarget its initial unfiltered lookup.
    setFilter(filter === which ? null : which);
  };
  const closeFilter = (which: 'location' | 'dates') => { setFilter(null); (which === 'location' ? locationToggle : datesToggle).current?.focus(); };
  const clearFilters = () => { setLocation({ city: null, countryCode: null, label: '' }); setFrom(today()); setTo(''); setFilter(null); locationToggle.current?.focus(); };
  const stopSearch = () => {
    const stopped = run.current; run.current = null; runScope.current = null; runArtists.current = null;
    focusAfterStop.current = true; setBusy(false); setNotice(null); stopped?.abort();
  };
  const find = async () => {
    if (busy || run.current !== null || capability !== 'available' || !artists.length || revoked || reply) return;
    const abort = new AbortController(), initialScope = getScope(); run.current = abort; runScope.current = initialScope; runArtists.current = artistsKey; setBusy(true); setReply(null); setNotice(null);
    const pending = () => run.current === abort && !abort.signal.aborted && authority.current.active && !authority.current.revoked;
    const current = () => pending() && runScope.current !== null && authority.current.getScope() === runScope.current && runArtists.current === authority.current.artistsKey;
    const timeout = setTimeout(() => abort.abort(), 30000);
    // A stopped request must not leave its deadline timer alive while a test or
    // transport is still settling. Authority is revoked by abort immediately.
    const clearDeadline = () => {
      clearTimeout(timeout);
      if (run.current === abort && abort.signal.aborted) {
        run.current = null; runScope.current = null; runArtists.current = null; setBusy(false);
        if (authority.current.active && !authority.current.revoked) setNotice('Couldn’t load concerts. Try again.');
      }
    };
    abort.signal.addEventListener('abort', clearDeadline, { once: true });
    try {
      if (!await ensureSession() || !pending()) return;
      const ownedScope = authority.current.getScope();
      if (ownedScope === null || (initialScope !== null && ownedScope !== initialScope)) return;
      runScope.current = ownedScope;
      if (!current()) return;
      const result = await client.search({ artists, city: null, from: today(), to: null }, abort.signal);
      if (current()) { replyScope.current = ownedScope; replyArtists.current = artistsKey; setReply(result); }
    } catch (error) { if (current()) setNotice(error instanceof Error && error.message === 'limited' ? 'Too many concert searches. Try again later.' : 'Couldn’t load concerts. Try again.'); }
    finally { clearTimeout(timeout); abort.signal.removeEventListener('abort', clearDeadline); if (run.current === abort) { run.current = null; runScope.current = null; runArtists.current = null; setBusy(false); } }
  };
  // Load one unfiltered list on deliberate entry, then reuse it for this
  // artist set and original Session. Filters and returning never repeat it.
  // A cancelled/failed lookup still needs a deliberate visit or retry.
  useEffect(() => { if (readyVisit > 0 && active && !revoked && capability === 'available' && artists.length && !reply) void find(); }, [readyVisit]);
  return <div className="concert-content">
    <p className="concert-subtitle">Concerts by your discovered artists</p>
    <div className="concert-filters"><button ref={locationToggle} type="button" aria-expanded={filter === 'location'} onClick={() => openFilter('location')}><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M16 8c0 5-6 9-6 9S4 13 4 8a6 6 0 1 1 12 0Z" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="10" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg><span className="concert-filter-label" title={location.label || undefined}>{location.label || 'Location'}</span><span className="filter-chevron" aria-hidden="true">⌄</span></button><button ref={datesToggle} type="button" aria-expanded={filter === 'dates'} onClick={() => openFilter('dates')}><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4" width="14" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M3 8h14M7 2v4M13 2v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg><span className="concert-filter-label">{to ? to === from ? prettyDate(from) : `${prettyDate(from)} – ${prettyDate(to)}` : from === today() ? 'Dates' : prettyDate(from)}</span><span className="filter-chevron" aria-hidden="true">⌄</span></button></div>
    {filter === 'location' && <ConcertLocationPicker value={location} disabled={false} onCancel={() => closeFilter('location')} onApply={place => { setLocation(place); closeFilter('location'); }} />}
    {filter === 'dates' && <div className="concert-filter-editor"><ConcertCalendar value={{ from, to: to || null }} minDate={today()} disabled={false} onCancel={() => closeFilter('dates')} onApply={dates => { setFrom(dates.from); setTo(dates.to ?? ''); closeFilter('dates'); }} /></div>}
    {!artists.length ? <div className="mobile-empty"><TicketIcon /><h2>Find your next favourite. Then see them live.</h2><p>Your discovered artists will appear here.</p></div> : capability === 'unavailable' ? <div className="mobile-empty"><TicketIcon /><h2>Your artists, live.</h2><p>Concert listings aren’t connected yet.</p></div> : capability === 'error' ? <div className="concert-search-action"><p role="status">Concerts couldn’t connect.</p><button type="button" className="secondary" disabled={revoked} onClick={() => { setCapability('checking'); setCapabilityRevision(v => v + 1); }}>Try again</button></div> : <>
      <div className="concert-search-action">{busy ? <><p className="control-loading" role="status"><ActivityDots />Finding concerts…</p><button type="button" className="secondary" onClick={stopSearch}>Stop</button></> : capability === 'checking' ? <p className="support control-loading" role="status"><ActivityDots />Connecting…</p> : !reply && !filter && <button ref={retryAction} type="button" className="secondary" disabled={!datesValid || revoked} onClick={() => void find()}>{notice ? 'Try again' : 'Load concerts'}</button>}</div>
      {!reply && !busy && !notice && <p className="support concert-artists">{artists.join(' · ')}</p>}
    </>}
    {notice && <p role="status" className="concert-notice">{notice}</p>}
    {reply && <>{reply.incomplete && <p className="support">This list may be incomplete.</p>}{!visibleEvents.length ? <div className="concert-notice"><p>{filtered ? 'No shows match these filters.' : reply.incomplete ? 'No shows to display yet.' : 'No upcoming shows in these listings.'}</p>{filtered && <button type="button" className="text-action" onClick={clearFilters}>Clear filters</button>}</div> : <div className="concert-grid">{visibleEvents.map((event, index) => <a key={event.id} className="concert-card" href={event.url} target="_blank" rel="noopener noreferrer" style={{ animationDelay: `${Math.min(index, 5) * 24}ms` }}>
      <ConcertImage url={event.image} />
      <time dateTime={event.date}>{prettyDate(event.date)}{event.time ? ` · ${event.time.slice(0, 5)}` : ''}</time><h2>{event.artists.join(', ')}</h2><p>{event.title}</p><p className="support">{event.venue} · {event.city}</p>{event.status !== 'onsale' && <span className="concert-status">{event.status === 'offsale' ? 'Not on sale' : event.status[0]!.toUpperCase() + event.status.slice(1)}</span>}<span className="concert-link">View on Ticketmaster <span aria-hidden="true">↗</span></span>
    </a>)}</div>}<p className="concert-attribution support">Event listings from Ticketmaster. Availability can change.</p></>}
  </div>;
}
