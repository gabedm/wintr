import { useEffect, useRef, useState } from 'react';
import { isSongUrl, searchSongs, songDateGroup, type SavedSong } from '../shared/saved-song.js';
import { isAppleArtwork } from '../shared/apple-artwork.js';
import { LibraryIcon, SearchIcon, SnowflakeIcon, TicketIcon } from './mobile-icons.js';
import type { LibraryView } from './song-library.js';

export type MobileTab = 'home' | 'library' | 'concerts';
export function ActivityDots() { return <span className="activity-dots" aria-hidden="true"><i /><i /><i /></span>; }
export function MobileNavigation({ tab, onSelect, busy = false }: { tab: MobileTab; onSelect: (tab: MobileTab) => void; busy?: boolean }) {
  return <nav className="mobile-navigation" data-tab={tab} aria-label="Main navigation">
    {([['home', 'Home', <SnowflakeIcon key="home" />], ['library', 'Library', <LibraryIcon key="library" />], ['concerts', 'Concerts', <TicketIcon key="concerts" />]] as const).map(([id, label, icon]) =>
      <button type="button" key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => onSelect(id)}>{icon}<span>{label}{id === 'home' && busy && tab !== 'home' && <span className="nav-work-dot" aria-label="Music search in progress" />}</span></button>)}
  </nav>;
}
/** A verified thumbnail when available; otherwise an original neutral record sleeve. */
export function SongArtwork({ song }: { song: SavedSong }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = import.meta.env.VITE_HOSTED_ARTWORK !== 'placeholder' && song.artwork && isAppleArtwork(song.artwork, song.url) ? song.artwork.url : null;
  if (url && url !== failedUrl) return <span className="song-artwork" aria-hidden="true"><img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} /></span>;
  return <span className="song-artwork" aria-hidden="true"><svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="28" fill="currentColor" /><circle cx="40" cy="40" r="20" fill="none" stroke="var(--canvas)" strokeOpacity=".22" /><circle cx="40" cy="40" r="13" fill="none" stroke="var(--canvas)" strokeOpacity=".22" /><circle cx="40" cy="40" r="4" fill="var(--canvas)" /></svg><span>{song.title.slice(0, 1).toLocaleUpperCase()}</span></span>;
}
const hasAppleMusic = (song: SavedSong) => song.service === 'apple_music' && isSongUrl(song.url, 'apple_music');
function SongLinks({ song }: { song: SavedSong }) {
  return hasAppleMusic(song) ? <div className="song-links"><a className="apple-music-link" href={song.url} target="_blank" rel="noopener noreferrer" title="Open in Apple Music" aria-label={`Open ${song.title} by ${song.artists.join(', ')} on Apple Music`}><img src="/assets/apple-music-icon.svg" width="32" height="32" alt="" /></a></div> : null;
}
const destination = (song: SavedSong) => song.service === 'apple_music' ? 'Apple Music' : 'YouTube';
export function RecentSongs({ songs }: { songs: readonly SavedSong[] }) {
  const strip = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ before: false, after: false });
  const measure = () => {
    const el = strip.current;
    if (!el) return;
    const before = el.scrollLeft > 4, after = el.scrollWidth - el.clientWidth - el.scrollLeft > 4;
    setEdges(old => old.before === before && old.after === after ? old : { before, after });
  };
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    for (const card of el.children) observer?.observe(card);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [songs]);
  const move = (direction: number) => {
    const el = strip.current;
    if (!el) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: direction * el.clientWidth * .9, behavior: reduced ? 'instant' : 'smooth' });
  };
  if (!songs.length) return null;
  const overflow = edges.before || edges.after;
  return <section className="recent-discoveries" aria-labelledby="recent-title"><div className="recent-heading"><h2 id="recent-title">Recently found</h2>{overflow && <div className="recent-controls"><button type="button" aria-label="Previous songs" aria-controls="recent-songs" disabled={!edges.before} onClick={() => move(-1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg></button><button type="button" aria-label="Next songs" aria-controls="recent-songs" disabled={!edges.after} onClick={() => move(1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg></button></div>}</div><div ref={strip} id="recent-songs" className="recent-song-strip" role="region" aria-label="Recently found songs" tabIndex={overflow ? 0 : undefined} onScroll={measure} onKeyDown={e => { if (e.target !== e.currentTarget || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return; e.preventDefault(); move(e.key === 'ArrowRight' ? 1 : -1); }}>{songs.slice(0, 8).map((song, index) => <article key={song.url} className="recent-song" data-apple-music={hasAppleMusic(song) || undefined} style={{ animationDelay: `${Math.min(index, 5) * 24}ms` }}>
    <a className="recent-song-main" href={song.url} target="_blank" rel="noopener noreferrer" aria-label={`Listen to ${song.title} by ${song.artists.join(', ')} on ${destination(song)}`}><SongArtwork song={song} /><span className="recent-song-copy"><strong>{song.title}</strong><span>{song.artists.join(', ')}</span>{song.service === 'youtube' && <small>{destination(song)} <span aria-hidden="true">↗</span></small>}</span></a><SongLinks song={song} />
  </article>)}</div></section>;
}
export function LibraryScreen({ view, searchOpen, onCloseSearch, onRemove, onClear }: { view: LibraryView; searchOpen: boolean; onCloseSearch: () => void; onRemove: (song: SavedSong) => Promise<boolean>; onClear: () => Promise<boolean> }) {
  const [query, setQuery] = useState(''), [options, setOptions] = useState<string | null>(null), [clearing, setClearing] = useState(false), [busy, setBusy] = useState(false);
  const search = useRef<HTMLInputElement>(null), heading = useRef<HTMLHeadingElement>(null), clearTrigger = useRef<HTMLButtonElement>(null), keepButton = useRef<HTMLButtonElement>(null);
  const optionTriggers = useRef(new Map<string, HTMLButtonElement>()), restoreClearFocus = useRef(false), mutation = useRef(false);
  const dismissOptions = () => { if (options) optionTriggers.current.get(options)?.focus({ preventScroll: true }); setOptions(null); };
  const dismissClear = () => { restoreClearFocus.current = true; setClearing(false); };
  useEffect(() => { if (searchOpen) { setOptions(null); setClearing(false); restoreClearFocus.current = false; search.current?.focus({ preventScroll: true }); } else setQuery(''); }, [searchOpen]);
  useEffect(() => { if (busy) return; if (clearing) keepButton.current?.focus({ preventScroll: true }); else if (restoreClearFocus.current) { clearTrigger.current?.focus({ preventScroll: true }); restoreClearFocus.current = false; } }, [clearing, busy]);
  const found = searchSongs(view.songs, searchOpen ? query : ''), groups = new Map<string, SavedSong[]>();
  for (const song of found) { const name = songDateGroup(song.foundAt); groups.set(name, [...(groups.get(name) ?? []), song]); }
  const remove = async (song: SavedSong) => { if (mutation.current) return; mutation.current = true; setBusy(true); try { if (await onRemove(song)) { setOptions(null); heading.current?.focus({ preventScroll: true }); } } finally { mutation.current = false; setBusy(false); } };
  const clear = async () => { if (mutation.current) return; mutation.current = true; setBusy(true); try { if (await onClear()) { restoreClearFocus.current = false; setClearing(false); heading.current?.focus({ preventScroll: true }); } } finally { mutation.current = false; setBusy(false); } };
  return <div className="library-content" onKeyDown={event => { if (event.key !== 'Escape' || event.defaultPrevented) return; if (options) { event.preventDefault(); dismissOptions(); } else if (clearing) { event.preventDefault(); dismissClear(); } }}>
    <h2 className="visually-hidden" tabIndex={-1} ref={heading}>Saved songs</h2>
    {searchOpen && <div className="library-search"><SearchIcon /><input ref={search} type="search" aria-label="Search Library" placeholder="Song or artist" value={query} maxLength={200} onChange={e => { setOptions(null); setClearing(false); restoreClearFocus.current = false; setQuery(e.target.value); }} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setQuery(''); onCloseSearch(); document.getElementById('library-search-trigger')?.focus({ preventScroll: true }); } }} /><button type="button" onClick={() => { setQuery(''); onCloseSearch(); document.getElementById('library-search-trigger')?.focus({ preventScroll: true }); }}>Cancel</button></div>}
    {view.notice && <p className="support library-notice" role="status">{view.notice}</p>}
    {view.state === 'loading' ? <p className="support control-loading" role="status"><ActivityDots />Opening your Library…</p> : !view.songs.length ? <div className="mobile-empty"><LibraryIcon /><h2>Your next favourite belongs here.</h2><p>Songs you discover are saved on this device.</p></div> : found.length === 0 ? <p className="library-no-results" role="status">No songs match “{query}”.</p> : [...groups].map(([label, songs]) => <section key={label} className="song-date-group" aria-label={label}><h2>{label}</h2><ul className="saved-song-list">{songs.map(song => <li key={song.url} className="saved-song">
      <div className="saved-song-entry" data-apple-music={hasAppleMusic(song) || undefined}><a className="saved-song-main" href={song.url} target="_blank" rel="noopener noreferrer" aria-label={`Listen to ${song.title} by ${song.artists.join(', ')} on ${destination(song)}`}><SongArtwork song={song} /><span className="saved-song-copy"><strong>{song.title}</strong><span>{song.artists.join(', ')}</span><time dateTime={new Date(song.foundAt).toISOString()}>{new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(song.foundAt)}</time>{song.service === 'youtube' && <span className="song-service">{destination(song)} <span aria-hidden="true">↗</span></span>}</span></a></div>
      <button ref={node => { if (node) optionTriggers.current.set(song.url, node); else optionTriggers.current.delete(song.url); }} type="button" className="icon-button song-options" aria-label={`Options for ${song.title}`} aria-expanded={options === song.url} onClick={() => { setClearing(false); restoreClearFocus.current = false; setOptions(options === song.url ? null : song.url); }}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></button>
      <SongLinks song={song} />
      {options === song.url && <div className="song-options-expansion"><div><div className="song-options-row"><button type="button" disabled={busy} onClick={() => void remove(song)}>Remove from Library</button><button type="button" disabled={busy} onClick={dismissOptions}>Cancel</button></div></div></div>}
    </li>)}</ul></section>)}
    {view.songs.length > 0 && <div className="library-footer"><p>Songs stay on this device.</p>{clearing ? <div className="action-row"><p>Remove all saved songs?</p><button type="button" className="primary" disabled={busy} onClick={() => void clear()}>Clear Library</button><button ref={keepButton} type="button" className="secondary" disabled={busy} onClick={dismissClear}>Keep them</button></div> : <button ref={clearTrigger} type="button" className="text-action" disabled={busy} onClick={() => { setOptions(null); setClearing(true); }}>Clear Library</button>}</div>}
  </div>;
}
export function LibrarySearchButton({ onClick, expanded }: { onClick: () => void; expanded: boolean }) { return <button id="library-search-trigger" type="button" className="icon-button mobile-search-button" aria-label="Search Library" aria-expanded={expanded} onClick={onClick}><SearchIcon /></button>; }
