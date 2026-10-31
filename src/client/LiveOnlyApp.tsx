import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { api } from './api.js';
import { SessionController } from './controller.js';
import { browserClearIntents } from './clear-intent.js';
import { browserChatIntents } from './chat-intent.js';
import { createLiveMusicCapture, IDLE_LIVE_CAPTURE, type LiveMusicCapture } from './live-music-capture.js';
import { Emblem } from './emblem-view.js';
import { LibraryScreen, LibrarySearchButton, MobileNavigation, RecentSongs, type MobileTab } from './mobile-views.js';
import { ConcertsScreen } from './ConcertsScreen.js';
import { SongLibrary } from './song-library.js';
import { isStreamedReference, type SafePanel, type SafeSnapshot } from '../shared/records.js';
import { parseYouTubeReference } from '../shared/youtube.js';
import { songsFromPanel } from '../shared/saved-song.js';

type Phase = 'idle' | 'starting' | 'listening' | 'matching' | 'artist' | 'complete' | 'error';
type Run = { source?: 'youtube'; capture: LiveMusicCapture | null; context: string | null; wipe: number; navigation: number; analysis: string | null };

/** One tap authorises one bounded Live discovery. Restore, render and motion
 * never start capture or provider work. Internal scopes are not a chat UI. */
export function LiveOnlyApp() {
  const [controller] = useState(() => new SessionController(api, { intents: browserClearIntents(), chatIntents: browserChatIntents() }));
  const view = useSyncExternalStore(controller.subscribe, controller.getView);
  const [library] = useState(() => new SongLibrary());
  const libraryView = useSyncExternalStore(library.subscribe, library.getSnapshot);
  const [tab, setTab] = useState<MobileTab>('home'), [search, setSearch] = useState(false), [privacy, setPrivacy] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle'), [message, setMessage] = useState(''), [artist, setArtist] = useState('');
  const [link, setLink] = useState('');
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible');
  const [capture, setCapture] = useState<LiveMusicCapture | null>(null);
  const captured = useSyncExternalStore(capture?.subscribe ?? (() => () => {}), capture?.getSnapshot ?? (() => IDLE_LIVE_CAPTURE));
  const run = useRef<Run | null>(null), mounted = useRef(true), heading = useRef<HTMLHeadingElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const listenButton = useRef<HTMLButtonElement>(null), closeButton = useRef<HTMLButtonElement>(null), returnFocus = useRef(false);
  const scrollPositions = useRef<Record<MobileTab, number>>({ home: 0, library: 0, concerts: 0 });
  const snap = view.snapshot;
  const blocked = view.clearing || view.redacted || view.recovery !== null || view.expiry !== null;
  const busy = ['starting', 'listening', 'matching'].includes(phase);
  const externalBusy = (view.pending || snap?.attempt?.active === true) && !run.current;
  const active = (r: Run) => {
    const v = controller.getView();
    return mounted.current && run.current === r && !v.clearing && !v.redacted && !v.recovery && !v.expiry && !controller.barrierActive() &&
      v.wipe === r.wipe && v.navigationEpoch === r.navigation && v.snapshot?.session?.context === r.context;
  };
  useEffect(() => {
    mounted.current = true; controller.activate(); library.activate(); void controller.refresh();
    const interrupt = () => { if (!run.current) return; const old = run.current; run.current = null; old.capture?.cancel(); returnFocus.current = true; setCapture(null); setPhase('idle'); setMessage(''); setArtist(''); void controller.stop(); };
    const visible = () => { const shown = document.visibilityState === 'visible'; setPageVisible(shown); if (shown) controller.onReturn(false); else interrupt(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !dialog.current?.open) interrupt(); };
    const returned = (e: PageTransitionEvent) => controller.onReturn(e.persisted);
    document.addEventListener('visibilitychange', visible); window.addEventListener('pageshow', returned); window.addEventListener('pagehide', interrupt); window.addEventListener('keydown', escape);
    return () => { mounted.current = false; run.current?.capture?.cancel(); run.current = null; controller.dispose(); library.dispose(); document.removeEventListener('visibilitychange', visible); window.removeEventListener('pageshow', returned); window.removeEventListener('pagehide', interrupt); window.removeEventListener('keydown', escape); };
  }, [controller, library]);
  useLayoutEffect(() => { window.scrollTo({ top: scrollPositions.current[tab], behavior: 'instant' }); heading.current?.focus({ preventScroll: true }); }, [tab]);
  useEffect(() => { if (privacy && !dialog.current?.open) { dialog.current?.showModal(); dialog.current?.querySelector('h2')?.focus(); } if (!privacy && dialog.current?.open) dialog.current.close(); }, [privacy]);
  useEffect(() => {
    if (phase === 'artist') document.querySelector<HTMLElement>('.live-artist-choice input,.live-artist-choice button')?.focus({ preventScroll: true });
    else if (returnFocus.current && !busy && !blocked && !view.pending && !view.stopping && !view.saving) { returnFocus.current = false; if (tab === 'home') listenButton.current?.focus({ preventScroll: true }); }
    else if (busy && (document.activeElement === document.body || document.activeElement === listenButton.current)) closeButton.current?.focus({ preventScroll: true });
  }, [phase, captured.phase, busy, blocked, tab, view.pending, view.stopping, view.saving]);
  useEffect(() => {
    if (run.current && (run.current.context ? !active(run.current) : blocked || view.wipe !== run.current.wipe)) { run.current.capture?.cancel(); run.current = null; setCapture(null); setPhase('idle'); setArtist(''); setMessage(''); }
  }, [view.wipe, view.navigationEpoch, snap?.session?.context, blocked]);
  const saved = useRef(new Set<string>()), skipped = useRef(new Set<string>()), saving = useRef(new Map<string, Promise<boolean>>());
  const completedSongs = useRef<readonly { url: string; foundAt: number }[]>([]);
  const persistPanel = useCallback((panel: SafePanel): Promise<boolean> => {
    if (skipped.current.has(panel.handle)) return Promise.resolve(false);
    if (saved.current.has(panel.handle)) return Promise.resolve(true);
    const pending = saving.current.get(panel.handle); if (pending) return pending;
    const originatingRun = run.current;
    const v = controller.getView(), context = v.snapshot?.session?.context, wipe = v.wipe, navigation = v.navigationEpoch;
    const authorized = () => {
      const latest = controller.getView(), state = latest.snapshot;
      return mounted.current && (!originatingRun || run.current === originatingRun) && !skipped.current.has(panel.handle) && !!context && state?.session?.context === context && latest.wipe === wipe && latest.navigationEpoch === navigation &&
        !latest.redacted && !latest.clearing && !latest.recovery && !latest.expiry && !controller.barrierActive() &&
        [...state.history, ...(state.panel ? [state.panel] : [])].some(p => p.handle === panel.handle);
    };
    const songs = songsFromPanel(panel, Date.now());
    if (!songs.length || !authorized()) return Promise.resolve(false);
    // Snapshot refreshes and React effect cleanup do not cancel a valid public
    // metadata commit. Actual owner/navigation/revocation changes still do.
    const task = library.add(songs, authorized).then(ok => {
      if (originatingRun && run.current !== originatingRun) { skipped.current.add(panel.handle); return false; }
      if (ok) saved.current.add(panel.handle); return ok;
    }).finally(() => saving.current.delete(panel.handle));
    saving.current.set(panel.handle, task); return task;
  }, [controller, library]);
  useEffect(() => {
    if (!snap?.session || snap.mode !== 'live' || blocked || libraryView.state === 'loading') return;
    for (const panel of [...snap.history, ...(snap.panel ? [snap.panel] : [])]) void persistPanel(panel);
  }, [snap, blocked, libraryView.state, persistPanel]);
  useEffect(() => {
    if (phase === 'complete' && completedSongs.current.length && libraryView.state !== 'loading' &&
      !completedSongs.current.some(found => libraryView.songs.some(song => song.url === found.url && song.foundAt >= found.foundAt))) {
      completedSongs.current = []; setPhase('idle'); setMessage('');
    }
  }, [libraryView, phase]);
  const fail = (r: Run, text: string) => { if (run.current !== r || !mounted.current || (r.context && !active(r))) return; r.capture?.cancel(); setCapture(null); returnFocus.current = true; setPhase('error'); setMessage(text); run.current = null; };
  const finishDiscovery = async (r: Run) => {
    if (!active(r)) return;
    const brief = controller.getView().snapshot?.brief;
    if (!brief || controller.getView().snapshot?.analysis?.handle !== r.analysis) return fail(r, 'Couldn’t finish that match. Try again.');
    setPhase('matching'); await controller.discover(brief.handle);
    if (!active(r)) return;
    const result = controller.getView().snapshot;
    if (result?.identity?.awaiting) { setPhase('artist'); setMessage('Choose a starting artist.'); return; }
    if (!result?.panel) return fail(r, 'Couldn’t find a match. Try again.');
    if (result.panel.outcome === 'source_unavailable') return fail(r, 'Couldn’t verify those matches. Try another song.');
    const found = songsFromPanel(result.panel, Date.now());
    if (found.length && !(await persistPanel(result.panel))) return fail(r, 'Couldn’t save those songs. Try again.');
    if (!active(r)) return;
    completedSongs.current = found;
    returnFocus.current = true; setPhase('complete'); setMessage(found.length ? `${found.length} ${found.length === 1 ? 'song' : 'songs'} found` : 'No matches this time. Try another song.'); run.current = null;
  };
  const match = async (r: Run, name: string) => {
    if (!active(r) || !r.analysis || !name.trim()) return;
    setPhase('matching');
    const ok = await controller.savePreference({ analysis: r.analysis as NonNullable<SafeSnapshot['analysis']>['handle'], ...(r.source === 'youtube' ? {} : { automatic: true as const }), relationship: { choice: 0 }, artists: [name.trim()] });
    if (!active(r)) return;
    if (!ok) return fail(r, 'Couldn’t finish that match. Try again.');
    await finishDiscovery(r);
  };
  const start = async () => {
    if (run.current || blocked || view.pending || view.saving || view.stopping || view.chatAction || !snap?.liveListening || snap.mode !== 'live') return;
    const r: Run = { capture: null, context: null, wipe: view.wipe, navigation: view.navigationEpoch, analysis: null }; run.current = r;
    completedSongs.current = []; setPhase('starting'); setMessage(''); setArtist('');
    try {
      const input = createLiveMusicCapture(); r.capture = input; setCapture(input);
      const preparing = input.prepare(new AbortController().signal); void preparing.catch(() => {});
      // A fresh owned run shares original Session expiry and cumulative limits.
      const ready = (snap.reference || snap.analysis || snap.panel || !snap.session || (snap.chats && !snap.chats.current) ? controller.newChat() : Promise.resolve(true))
        .then(created => { if (!created) input.cancel(); return created; });
      const [created] = await Promise.all([ready, preparing]);
      if (!created || run.current !== r || !mounted.current) { input.cancel(); if (run.current === r) fail(r, 'Couldn’t start listening. Try again.'); return; }
      const v = controller.getView(); r.context = v.snapshot?.session?.context ?? null; r.wipe = v.wipe; r.navigation = v.navigationEpoch;
      if (!r.context || !active(r)) { input.cancel(); run.current = null; setCapture(null); setPhase('idle'); return; }
      setPhase('listening');
      const sent = controller.submitLive(input, null);
      if (!sent.accepted) return fail(r, 'Couldn’t start listening. Try again.');
      await sent.done;
      if (!active(r)) return;
      setCapture(null); r.capture = null;
      const result = controller.getView().snapshot;
      if (result?.code === 'unsupported_source' || result?.analysis?.audioAccess === 'refused') return fail(r, 'This music can’t be used. Try another song.');
      if (!result?.reference || !isStreamedReference(result.reference) || !result.analysis || result.analysis.synthetic || result.analysis.audioAccess !== 'accessed' || !result.analysis.relationships.length || result.stage === 'failed' || result.stage === 'cancelled') return fail(r, 'Couldn’t hear that clearly. Try again.');
      r.analysis = result.analysis.handle;
      if (!result.analysis.proposedArtist) { setPhase('artist'); setMessage('Choose a starting artist.'); return; }
      await match(r, result.analysis.proposedArtist);
    } catch { const starting = !r.context && run.current === r; fail(r, 'Couldn’t finish that match. Try again.'); if (starting) void controller.stop(); }
  };
  const startLink = async () => {
    if (run.current || blocked || view.pending || view.saving || view.stopping || view.chatAction || snap?.mode !== 'live') return;
    const parsed = parseYouTubeReference(link);
    if (!parsed.ok || parsed.timestamp.kind === 'invalid') { setMessage('Paste a valid YouTube song link.'); setPhase('error'); return; }
    const r: Run = { source: 'youtube', capture: null, context: null, wipe: view.wipe, navigation: view.navigationEpoch, analysis: null }; run.current = r;
    completedSongs.current = []; setPhase('starting'); setMessage(''); setArtist('');
    try {
      const created = snap.reference || snap.analysis || snap.panel || !snap.session || (snap.chats && !snap.chats.current) ? await controller.newChat() : true;
      if (!created || run.current !== r || !mounted.current) return fail(r, 'Couldn’t start that song. Try again.');
      const v = controller.getView(); r.context = v.snapshot?.session?.context ?? null; r.wipe = v.wipe; r.navigation = v.navigationEpoch;
      if (!r.context || !active(r)) return fail(r, 'Couldn’t start that song. Try again.');
      const start = parsed.timestamp.kind === 'valid' ? parsed.timestamp.start : 0, focus = { start, end: start + 45 };
      const sent = controller.submitReference({ url: parsed.canonicalUrl, focus, cue: null, display: { videoId: parsed.videoId, canonicalUrl: parsed.canonicalUrl, focus, cue: null } });
      if (!sent.accepted) return fail(r, 'Couldn’t start that song. Try again.');
      setLink(''); await sent.done; if (!active(r)) return;
      const result = controller.getView().snapshot;
      if (result?.code === 'unsupported_source' || result?.analysis?.audioAccess === 'refused') return fail(r, 'This music can’t be used. Try another song.');
      if (!result?.analysis || result.analysis.synthetic || result.analysis.audioAccess !== 'accessed' || !result.analysis.relationships.length || result.stage === 'failed' || result.stage === 'cancelled') return fail(r, 'Couldn’t analyse that song. Try another link.');
      r.analysis = result.analysis.handle;
      if (!result.analysis.proposedArtist) { setPhase('artist'); setMessage('Choose a starting artist.'); return; }
      await match(r, result.analysis.proposedArtist);
    } catch { fail(r, 'Couldn’t finish that song. Try again.'); }
  };
  const stop = () => { const old = run.current; run.current = null; old?.capture?.cancel(); returnFocus.current = true; setCapture(null); setPhase('idle'); setMessage(''); setArtist(''); void controller.stop(); };
  const canContinue = (s: SafeSnapshot | null) => s?.mode === 'live' && !!s.liveListening && !!s.session && !!s.reference && isStreamedReference(s.reference) && !!s.analysis &&
    !s.analysis.synthetic && s.analysis.audioAccess === 'accessed' && s.analysis.relationships.length > 0 && !s.panel && !s.attempt?.active &&
    (s.brief ? s.discovery === 'available' : s.stage === 'awaiting_preference');
  const resume = async () => {
    const v = controller.getView(), s = v.snapshot;
    if (run.current || v.pending || v.saving || v.stopping || v.chatAction || v.clearing || v.redacted || v.recovery || v.expiry || controller.barrierActive() || !canContinue(s)) return;
    const r: Run = { capture: null, context: s!.session!.context, wipe: v.wipe, navigation: v.navigationEpoch, analysis: s!.analysis!.handle };
    run.current = r; setMessage(''); setArtist('');
    try {
      if (!s!.brief) {
        if (s!.analysis!.proposedArtist) await match(r, s!.analysis!.proposedArtist);
        else { setPhase('artist'); setMessage('Choose a starting artist.'); }
      } else if (s!.identity?.awaiting && s!.identity.slots.some(slot => slot.status === 'ambiguous' && !slot.chosen)) {
        setPhase('artist'); setMessage('Choose a starting artist.');
      } else await finishDiscovery(r);
    } catch { fail(r, 'Couldn’t finish that match. Try again.'); }
  };
  const selectTab = (next: MobileTab) => {
    if (next === tab) return;
    scrollPositions.current[tab] = document.scrollingElement?.scrollTop ?? window.scrollY;
    // Leaving the capture screen releases a live/preparing microphone. Once
    // input is released, the same finite owned search can finish in Library.
    const input = run.current?.capture;
    if (input && !['finishing', 'analysing', 'error'].includes(input.getSnapshot().phase)) stop();
    setTab(next);
  };
  const scope = () => { const v = controller.getView(); return v.redacted || v.clearing || v.recovery || v.expiry || !v.snapshot?.session ? null : `${v.snapshot.session.context}:${v.wipe}`; };
  const listening = captured.phase === 'listening';
  const resumable = !run.current && !blocked && !view.pending && !view.saving && !view.stopping && !view.chatAction && canContinue(snap);
  const restoredMessage = !run.current && !blocked && phase === 'idle' ? snap?.code === 'unsupported_source' || snap?.analysis?.audioAccess === 'refused'
    ? 'This music can’t be used. Try another song.' : snap?.stage === 'failed' ? 'Couldn’t finish that search. Listen again.' : '' : '';
  const resultMessage = message || restoredMessage;
  const title = phase === 'artist' ? 'Choose a starting artist' : busy ? listening ? 'Listening for music' : captured.phase === 'permission' ? 'Allow your microphone' : captured.phase === 'connecting' || phase === 'starting' ? 'Getting ready' : 'Finding your next song' : 'Tap to Find Your Next Jam';
  const ambiguous = phase === 'artist' && run.current?.analysis === snap?.analysis?.handle ? snap?.identity?.slots.filter(s => s.status === 'ambiguous' && !s.chosen) : [];
  return <div className="app mobile-app live-only-app" data-tab={tab} data-page-visible={pageVisible || undefined}>
    <header className={`header mobile-header ${tab === 'home' ? 'home-entry-header' : 'mobile-page-header'}`}><div className="mobile-page-title"><h1 ref={heading} tabIndex={-1} className={tab === 'home' ? 'visually-hidden' : undefined}>{tab === 'home' ? 'Wintr' : tab === 'library' ? 'Library' : 'Concerts'}</h1>{tab === 'library' && <p>{libraryView.songs.length} {libraryView.songs.length === 1 ? 'song' : 'songs'}</p>}</div>{tab === 'library' && <LibrarySearchButton expanded={search} onClick={() => setSearch(v => !v)} />}</header>
    {tab !== 'home' && (busy || externalBusy || phase === 'artist' || resultMessage || resumable) && <aside className="live-route-status" aria-label="Current search"><p role="status">{busy || externalBusy ? 'Finding songs…' : phase === 'artist' ? 'Choose an artist to continue.' : resultMessage || 'Your search is ready to continue.'}</p>{(busy || externalBusy) && <button className="secondary" onClick={stop}>Stop</button>}{phase === 'artist' && <button className="primary" onClick={() => selectTab('home')}>Choose artist</button>}{resumable && <button className="primary" onClick={() => void resume()}>Continue search</button>}</aside>}
    <main className="mobile-page live-only-home" hidden={tab !== 'home'} data-has-songs={libraryView.songs.length > 0 || undefined}>
      <section className="live-only-hero" aria-label="Music discovery" data-active={busy || undefined} data-listening={listening || undefined} data-artist={phase === 'artist' || undefined}>
        {run.current && <button ref={closeButton} className="live-close icon-button" aria-label="Stop listening and discovery" onClick={stop}>×</button>}
        {!busy && <h2 className="home-invitation">{title}</h2>}
        <div className="listen-stage"><div className="listening-ripples" aria-hidden="true">{[0, 1, 2, 3].map(i => <span key={i} style={{ '--ripple-index': i } as CSSProperties} />)}</div><button ref={listenButton} className="listen-trigger" aria-label={busy ? 'Listening in progress' : 'Listen live'} disabled={busy || phase === 'artist' || blocked || !snap?.liveListening || snap.mode !== 'live' || view.pending || snap?.attempt?.active === true || !!view.saving || view.stopping} onClick={() => void start()}><Emblem out={{ steps: 0, busy: listening, found: false, halted: false }} listeningMs={capture ? captured.durationMs : 0} /></button></div>
        {busy && <div className="listening-copy" role="status">{!listening && <span className="listening-dots" aria-hidden="true"><i /><i /><i /></span>}<h2>{title}</h2><p>{listening ? 'Let the music play.' : phase === 'matching' ? 'Finding songs with a similar feel.' : 'Just a moment.'}</p></div>}
        {listening && <button className="primary live-finish" disabled={captured.durationMs < 5000} onClick={() => capture?.finish()}>Finish</button>}
        {!busy && resultMessage && <p role="status" className="live-result-message">{resultMessage}</p>}
        {tab === 'home' && resumable && <button className="primary" onClick={() => void resume()}>Continue search</button>}
        {phase === 'artist' && <section className="live-artist-choice" aria-label="Confirm artist">{!!ambiguous?.length ? ambiguous.map(slot => <div key={slot.proposal}><h2>{slot.proposal}</h2>{slot.options.map(option => <button key={option.handle} className="secondary" onClick={async () => { const r = run.current, identity = snap?.identity; if (!r || !identity || !active(r)) return; setPhase('matching'); const ok = await controller.chooseArtist({ checkpoint: identity.handle, slot: snap!.identity!.slots.indexOf(slot), choice: option.handle }); if (active(r) && ok) await finishDiscovery(r); else if (active(r)) fail(r, 'Couldn’t confirm that artist. Try again.'); }}>{option.name}{option.disambiguation && <small>{option.disambiguation}</small>}</button>)}</div>) : <form onSubmit={e => { e.preventDefault(); const r = run.current; if (r) void match(r, artist); }}><label htmlFor="seed-artist">Artist name</label><input id="seed-artist" maxLength={128} value={artist} onChange={e => setArtist(e.target.value)} /><button className="primary" disabled={!artist.trim()}>Find songs</button></form>}</section>}
        {(blocked || externalBusy) && <div role="status"><p>{view.recovery ? 'Finish clearing to listen again.' : externalBusy ? 'A search is in progress.' : 'Listening is unavailable right now.'}</p>{externalBusy && <button className="secondary" onClick={stop}>Stop</button>}{view.recovery && <button className="secondary" onClick={() => void controller.clear()}>Retry Clear</button>}</div>}
      </section>
      <RecentSongs songs={libraryView.songs} />{libraryView.notice && <p className="support" role="status">{libraryView.notice}</p>}
    </main>
    <main className="mobile-page mobile-library" hidden={tab !== 'library'}><LibraryScreen view={libraryView} searchOpen={search} onCloseSearch={() => setSearch(false)} onRemove={song => library.remove(song)} onClear={() => library.clear(Math.max(Date.now(), snap?.session?.checkedAt ?? 0))} /><button className="text-action privacy-link" onClick={() => setPrivacy(true)}>Privacy</button></main>
    <main className="mobile-page mobile-concerts" hidden={tab !== 'concerts'}><ConcertsScreen songs={libraryView.songs} active={tab === 'concerts'} revoked={blocked} scopeKey={scope()} getScope={scope} ensureSession={async () => !!controller.getView().snapshot?.session || controller.newChat()} /></main>
    {tab === 'home' && !busy && !externalBusy && phase !== 'artist' && <form className="youtube-fallback" aria-label="YouTube song" onSubmit={event => { event.preventDefault(); void startLink(); }}><input type="url" aria-label="YouTube song link" placeholder="Paste a YouTube link" maxLength={2048} value={link} disabled={busy || blocked || view.pending || !!view.saving || view.stopping} onChange={event => setLink(event.target.value)} /><button type="submit" aria-label="Find songs from YouTube" disabled={!link.trim() || busy || blocked || view.pending || !!view.saving || view.stopping}><span aria-hidden="true">↑</span></button></form>}
    <MobileNavigation tab={tab} busy={busy} onSelect={selectTab} />
    <dialog ref={dialog} aria-labelledby="privacy-title" className="live-privacy-dialog" onCancel={() => setPrivacy(false)} onClose={() => setPrivacy(false)}>
      <h2 id="privacy-title" tabIndex={-1}>Privacy</h2>
      <p>Listen sends microphone audio and music details to Google Gemini. Wintr doesn’t save raw audio; <a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noopener noreferrer">Google may retain it under its own terms</a>.</p>
      <p>Artist names go to <a href="https://www.qloo.com/legal/privacy" target="_blank" rel="noopener noreferrer">Qloo</a> and <a href="https://www.apple.com/legal/privacy/en-ww/" target="_blank" rel="noopener noreferrer">Apple</a> for song discovery, and <a href="https://privacy.ticketmaster.co.uk/en/privacy-policy" target="_blank" rel="noopener noreferrer">Ticketmaster</a> for concerts. Location and date filters stay on this device.</p>
      <p>Session access ends within one hour, or when cleared. Saved song details stay in Library until removed.</p>
      <details><summary>More about your data</summary><p>Session results use Google Cloud storage. Deletion can take longer; basic usage and safety records remain.</p><p>A session cookie keeps access tied to this browser. Clearing a session keeps your Library.</p><p>Artwork loads directly from Apple and Ticketmaster, which receive your IP address.</p></details>
      <details><summary>Licences and credits</summary><p>Apple and Apple Music are trademarks of Apple Inc., registered in the U.S. and other countries. iTunes Store is a service mark of Apple Inc.</p><p><a href="/licenses/Inter-OFL.txt" target="_blank" rel="noopener noreferrer">Inter licence</a> · <a href="/licenses/Software-NOTICES.txt" target="_blank" rel="noopener noreferrer">Software notices</a> · <a href="/licenses/Asset-NOTICES.txt" target="_blank" rel="noopener noreferrer">Artwork credits</a> · <a href="/licenses/GeoNames.txt" target="_blank" rel="noopener noreferrer">City data</a></p></details>
      <button className="secondary" onClick={() => { stop(); void controller.clear(); }}>Clear session</button><button className="primary" onClick={() => setPrivacy(false)}>Done</button>
    </dialog>
  </div>;
}
