import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import type { SafeSnapshot } from '../shared/records.js';
import { isAudioReference, isRecordedReference, isStreamedReference } from '../shared/records.js';
import { EXAMPLE_SOURCE } from '../shared/example-source.js';
import { canonicalVideoUrl, formatClock, parseTimestamp, parseYouTubeReference, validateFocus } from '../shared/youtube.js';
import { api } from './api.js';
import { browserClearIntents } from './clear-intent.js';
import { browserChatIntents } from './chat-intent.js';
import { ChatSidebar, type ChatSidebarProps } from './ChatSidebar.js';
import { useChatComposer, useChatPageMotion } from './chat-navigation.js';
import { chatFromLocation, writeChatLocation } from './chat-history.js';
import { CHAT_REQUIRED, SessionController } from './controller.js';
import { actionDecision, CONTROL } from './control.js';
import { useControlPress, useToggle } from './control-hooks.js';
import { Appear, appearOffset, IntroCard, layoutRect, PendingStatus, useIntro, WelcomeGhost, type Rect } from './conversation-motion.js';
import { DECOR, FreshTracker, ghostDecision } from './decor.js';
import { acceptSend, currentComposer, editDraft, EMPTY_DRAFT, initialComposer, isEmptyDraft, loadSource, settleSend, setSourceOpen, sourceNote, type ComposerState, type Draft } from './draft.js';
import { AnalysisView, ChoicesPanel, ConnectionPanel, discoveryOutcome, KeepingContext, PreferencePanel, referenceFailure, RefinePanel, workingText } from './discovery.js';
import { Emblem, useEmblem } from './emblem-view.js';
import { ExampleAttribution, ExampleOffer } from './example.js';
import { InputSheet, MicButton } from './InputSheet.js';
import { useLocalRecording } from './recording-hooks.js';
import type { MusicCaptureSnapshot } from './music-capture.js';
import { createLiveMusicCapture, IDLE_LIVE_CAPTURE, type LiveMusicCapture } from './live-music-capture.js';
import { browserFocusStranded, FocusHandoff } from './handoff.js';
import { isSubmitKey, shouldDismissKeyboard } from './keys.js';
import { STANDARD_EASING } from './motion.js';
import { openOverlay, overlayWants, resolveWhy, whyIdentity, type Overlay } from './overlay.js';
import { useModalAuthority } from './overlay-hooks.js';
import { WhySheet } from './WhySheet.js';
import { resultAnnouncement } from './announce.js';
import { ResultTracker } from './reading-anchor.js';
import { analysisBlockedReason, focusDisclosure, MODE_COPY } from './readiness.js';
import { prefersReducedMotion, useComposerHeight, useDockClearance, useDrawerPresence, useShellMotion, type ShellMotion } from './viewport-hooks.js';
import { SongLibrary } from './song-library.js';
import { songsFromPanel } from '../shared/saved-song.js';
import { LibraryScreen, LibrarySearchButton, MobileNavigation, RecentSongs, type MobileTab } from './mobile-views.js';
import { ConcertsScreen } from './ConcertsScreen.js';

function scroller(): Element {
  return document.scrollingElement ?? document.documentElement;
}

function findResult(key: string): HTMLElement | null {
  return /^[\w-]+$/.test(key) ? document.querySelector<HTMLElement>(`[data-result="${key}"]`) : null;
}

/** Scroll position at which a result's top sits just below the top edge (null if it is not rendered). */
function resultTop(key: string): number | null {
  const el = findResult(key);
  // The entrance's own translation is decoration: the target is where the result rests.
  return el ? el.getBoundingClientRect().top - appearOffset(el) + scroller().scrollTop - 16 : null;
}


function focusFromUrl(url: string): Pick<Draft, 'start' | 'end'> {
  const parsed = parseYouTubeReference(url);
  if (!parsed.ok || parsed.timestamp.kind === 'invalid') return { start: '', end: '' };
  const start = parsed.timestamp.kind === 'valid' ? parsed.timestamp.start : 0;
  return { start: formatClock(start), end: formatClock(start + 45) };
}

/**
 * Source/focus/note controls. Compact by default (a one-line summary with an
 * explicit Edit affordance) as soon as a valid link is present, before and after
 * submission; forced open whenever something needs attention so validation
 * recovery is never hidden.
 */
export function SourceDetails({
  compact,
  summary,
  attention,
  open = false,
  onToggle,
  children,
}: {
  compact: boolean;
  summary: string;
  attention: boolean;
  /** Controlled disclosure: the page decides when the form is open (a note was chosen, a source is being edited) and when it collapses (a send). */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}) {
  if (!compact) return <div className="draft-details">{children}</div>;
  return (
    <details className="draft-details compact" open={attention || open || undefined} onToggle={onToggle && !attention ? (e) => onToggle(e.currentTarget.open) : undefined}>
      <summary>
        <span className="summary-text">{summary}</span>
        <span className="summary-action">
          Edit<span className="visually-hidden"> focus and note</span>
        </span>
      </summary>
      {/* Editing a forced-open form must keep it open when its validation reason changes. */}
      <div className="draft-details-body" onFocusCapture={() => onToggle?.(true)}>{children}</div>
    </details>
  );
}

/** Short one-line description of the focus and note for the compact disclosure (the full note stays in its field). */
export function sourceSummary(focus: string, cue: string): string {
  const note = cue.trim();
  return note === '' ? focus : `${focus} · “${note.length > 48 ? `${note.slice(0, 48)}…` : note}”`;
}

/**
 * The background is made inert (not just aria-hidden) for exactly as long as the
 * drawer is wanted; the drawer sits outside it and decides itself how long an
 * exiting picture stays visible (it is inert and non-blocking by then).
 */
export function ShellLayout({ menuOpen, empty = false, tab, children, sheet }: { menuOpen: boolean; empty?: boolean; tab?: MobileTab; children: ReactNode; sheet: ReactNode }) {
  return (
    <>
      <div className={`app${tab ? ' mobile-app' : ''}${empty ? ' app-empty' : ''}`} data-tab={tab} inert={menuOpen}>
        {children}
      </div>
      {sheet}
    </>
  );
}

export function App() {
  const [controller] = useState(() => new SessionController(api, { intents: browserClearIntents(), chatIntents: browserChatIntents(), initialChat: chatFromLocation() }));
  const view = useSyncExternalStore(controller.subscribe, controller.getView);
  const [tab, setTab] = useState<MobileTab>('home');
  const [librarySearch, setLibrarySearch] = useState(false);
  const [library] = useState(() => new SongLibrary());
  const libraryView = useSyncExternalStore(library.subscribe, library.getSnapshot);
  useEffect(() => { library.activate(); return () => library.dispose(); }, [library]);
  // A device library keeps public recording metadata only. Session revocation
  // still removes every private panel, source, note and handle immediately.
  const libraryAuthority = useRef(view); libraryAuthority.current = view;
  const savedPanels = useRef(new Set<string>());
  useEffect(() => {
    const { snapshot, clearing, redacted, recovery } = view;
    if (!snapshot?.session || snapshot.mode !== 'live' || clearing || redacted || recovery || libraryView.state === 'loading') return;
    const panels = [...snapshot.history, ...(snapshot.panel ? [snapshot.panel] : [])].filter(p => !savedPanels.current.has(p.handle));
    if (!panels.length) return;
    const context = snapshot.session.context; let current = true;
    const authorized = () => { const latest = libraryAuthority.current; return current && latest.snapshot?.session?.context === context && !latest.clearing && !latest.redacted && latest.recovery === null; };
    const songs = panels.flatMap(p => songsFromPanel(p, Date.now()));
    if (songs.length) void library.add(songs, authorized).then(ok => { if (ok && authorized()) for (const p of panels) savedPanels.current.add(p.handle); });
    return () => { current = false; };
  }, [view.snapshot, view.clearing, view.redacted, view.recovery, library, libraryView.state]);
  // The unsaved draft belongs to one wipe epoch: any local wipe (Clear here, or a Clear intent from another tab or an
  // earlier load) drops it in that same render, before any effect runs.
  const wipeRef = useRef(view.wipe);
  wipeRef.current = view.wipe;
  const hidingChat = view.chatAction === 'switch' || view.chatAction === 'create' || view.chatAction === 'delete' || view.chatAction === 'reconcile';
  const [composer, setComposer] = useChatComposer(view.snapshot, view.wipe, hidingChat || view.redacted || view.clearing || view.recovery !== null, view.deleteRecovery.map(intent => intent.chat));
  const current = currentComposer(composer, view.wipe);
  const draft = current.draft;
  const setDraft = (next: Draft | ((d: Draft) => Draft)) => setComposer((c) => editDraft(c, wipeRef.current, next));
  // One modal overlay at a time: the session menu or the Why sheet (see overlay.ts).
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const inputAdoption = useRef<{ overlay: Overlay; context: string } | null>(null);
  const [preparedClip, setPreparedClip] = useState<{ snapshot: MusicCaptureSnapshot; scope: string; receipt: NonNullable<SafeSnapshot['captureReceipt']> } | null>(null);
  const [preparingClip, setPreparingClip] = useState(false);
  const [recordingPreparationFailed, setRecordingPreparationFailed] = useState(false);
  const preparationRun = useRef<object | null>(null);
  const registrationKey = useRef<{ snapshot: MusicCaptureSnapshot; key: string } | null>(null);
  const [liveCapture, setLiveCapture] = useState<LiveMusicCapture | null>(null);
  const liveCaptureSnapshot = useSyncExternalStore(liveCapture?.subscribe ?? (() => () => {}), liveCapture?.getSnapshot ?? (() => IDLE_LIVE_CAPTURE));

  useEffect(() => {
    controller.activate();
    void controller.refresh();
    const onPageShow = (e: PageTransitionEvent) => controller.onReturn(e.persisted);
    const onVisible = () => document.visibilityState === 'visible' && controller.onReturn(false);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisible);
      controller.dispose();
    };
  }, [controller]);

  const { snapshot, pending, stopping, clearing, redacted, submitted, notice, saving } = view;
  // A free save awaiting its acknowledgement holds every action built on the basis it is about to change (see controller.freeMutation).
  const holding = saving !== null || view.chatAction !== null;
  const mode = snapshot?.mode ?? null;
  // Overlay authority is derived from the current accepted state on every render: a revoked state removes the Why sheet at once.
  const authority = { snapshot, clearing, redacted, wipe: view.wipe, recovery: view.recovery !== null };
  const effectiveOverlay = overlay?.kind === 'input' && inputAdoption.current?.overlay === overlay && snapshot?.session?.context === inputAdoption.current.context
    ? { ...overlay, context: inputAdoption.current.context } : overlay;
  const wants = overlayWants(effectiveOverlay, authority);
  const modalOpen = wants.menu || wants.why || wants.input;
  const closeOverlay = () => { cancelRecording(); setOverlay(null); };
  useEffect(() => {
    if ((overlay?.kind === 'why' && !wants.why) || (overlay?.kind === 'input' && !wants.input)) setOverlay(null);
  }, [overlay, wants.why, wants.input]);
  const parsed = draft.url.trim() === '' ? null : parseYouTubeReference(draft.url);
  const startSec = parseTimestamp(draft.start.trim());
  const endSec = parseTimestamp(draft.end.trim());
  const focusCheck = startSec === null || endSec === null ? null : validateFocus({ start: startSec, end: endSec });
  const timestampIssue = parsed?.ok && parsed.timestamp.kind === 'invalid' && !draft.focusEdited;
  const serverActive = snapshot?.attempt?.active === true;
  const working = pending || stopping || serverActive;
  const recordingAllowed = wants.input && !working && !clearing && !redacted && (!holding || saving?.kind === 'capture') && view.recovery === null &&
    mode !== null && mode !== 'disabled' && typeof api.registerCapture === 'function' && typeof api.recordingReference === 'function';
  const recordingScope = `${view.wipe}:${view.navigationEpoch}:${snapshot?.session?.context ?? 'entry'}:${snapshot?.chats?.current ?? 'entry'}`;
  const recording = useLocalRecording(recordingScope, recordingAllowed);
  const recordingSelfService = snapshot?.recordingSelfService === true;
  const preparedRecording = preparedClip?.snapshot === recording.snapshot && preparedClip.scope === recordingScope ? preparedClip.receipt : null;
  const cancelRecording = () => {
    preparationRun.current = null; setPreparingClip(false); setRecordingPreparationFailed(false); setPreparedClip(null); registrationKey.current = null;
    controller.cancelRecordingPreparation(); recording.cancel();
  };
  const startRecording = () => { cancelRecording(); recording.start(); };
  const prepareRecording = async () => {
    if (!recordingAllowed || recording.snapshot.phase !== 'ready' || preparingClip || preparationRun.current !== null) return null;
    const ready = recording.snapshot, run = {};
    preparationRun.current = run; setPreparingClip(true); setRecordingPreparationFailed(false);
    const active = () => preparationRun.current === run && recording.matchesReady(ready);
    try {
      const metadata = await recording.readyMetadata();
      if (!metadata || !active()) { if (!metadata && active()) setRecordingPreparationFailed(true); return null; }
      if (registrationKey.current?.snapshot !== ready) registrationKey.current = { snapshot: ready, key: crypto.randomUUID() };
      const receipt = await controller.prepareRecording({ ...metadata, actionKey: registrationKey.current.key }, next => {
        if (!active() || overlay?.kind !== 'input' || overlay.context !== null || !next.session) return false;
        const current = controller.getView();
        const nextScope = `${current.wipe}:${current.navigationEpoch}:${next.session.context}:${next.chats?.current ?? 'entry'}`;
        if (!recording.adoptScope(recordingScope, nextScope, ready)) return false;
        inputAdoption.current = { overlay, context: next.session.context };
        return true;
      });
      if (receipt && active()) {
        const current = controller.getView();
        const scope = `${current.wipe}:${current.navigationEpoch}:${current.snapshot?.session?.context ?? 'entry'}:${current.snapshot?.chats?.current ?? 'entry'}`;
        const prepared = { snapshot: ready, scope, receipt };
        setPreparedClip(prepared);
        return prepared;
      }
      if (active() && !controller.getView().notice) setRecordingPreparationFailed(true);
      return null;
    } catch {
      if (active()) setRecordingPreparationFailed(true);
      return null;
    } finally { if (preparationRun.current === run) { preparationRun.current = null; setPreparingClip(false); } }
  };
  const needsChat = !!snapshot?.session && snapshot.chats?.current === null;
  const blockedReason = needsChat ? CHAT_REQUIRED : analysisBlockedReason(mode);
  const canAnalyse = blockedReason === null && parsed?.ok === true && focusCheck?.ok === true && !working && !clearing && !redacted && !holding;
  const unavailableReason = blockedReason ?? (holding ? 'Saving your last change…' : null);
  const disclosure = parsed?.ok === true ? focusDisclosure(mode) : null;
  const exampleDraft = mode === 'synthetic' && parsed?.ok === true && parsed.videoId === EXAMPLE_SOURCE.videoId;
  // The S00 example fills an empty draft before a reference exists. Do not repeat
  // the onboarding offer below an already accepted reference or result panel.
  // The server capability is still required; using the offer never sends anything.
  const offerExample = mode === 'synthetic' && snapshot?.exampleSource === true && snapshot.reference === null && submitted === null && draft.url.trim() === '' && !working && !clearing && !redacted && view.recovery === null && !holding;
  // The relationship stays visible, read-only, while its own Discover / Continue / refinement runs; never for a reference step
  // (a new reference has no saved relationship yet) and never through Clear, redaction, recovery or expiry (snapshot.session is then gone).
  const workKind = view.action?.kind ?? (serverActive ? snapshot?.attempt?.kind : null);
  const keeping =
    working && !clearing && !redacted && view.recovery === null && snapshot?.session && snapshot.analysis && (workKind === 'discover' || workKind === 'refine') ? snapshot.brief : null;
  // Earlier panels keep their own intent. A newer admitted attempt belongs after them, including failed/stopped refinements.
  const tailIntent = snapshot?.panel?.intent && !clearing && !redacted && view.recovery === null
    ? (snapshot.brief?.handle !== snapshot.panel.intent.handle ? snapshot.brief : null)
    : null;

  // The header emblem draws only existing facts (snapshot stage/attempt/panel and the local action awaiting admission).
  // Clear, a failed Clear, a recovery barrier and expiry remove its progress in this very render; a run is also bound to the
  // opaque session context, the controller's wipe counter and the identity of the local action object (view.action).
  const emblem = useEmblem({
    captureActive: recording.snapshot.phase === 'recording' || liveCaptureSnapshot.phase === 'listening',
    snapshot,
    action: view.action,
    working,
    stopping,
    revoked: clearing || redacted || view.recovery !== null || snapshot?.code === 'session_expired',
    wipe: view.wipe,
  }, tab === 'home');

  // Reading anchor: a result is a new panel (or, before one exists, the reference analysis).
  const shell = useShellMotion();
  const { anchor } = shell;
  const conversation = useRef<HTMLElement | null>(null);
  const chatKey = snapshot?.session && snapshot.chats?.current ? `${snapshot.session.context}:${snapshot.chats.current}` : null;
  const chatPage = useChatPageMotion(conversation, chatKey,
    clearing || redacted || view.recovery !== null || view.chatAction === 'delete' || view.chatAction === 'reconcile', view.wipe);
  const onPopChat = useRef<() => void>(() => {});
  onPopChat.current = () => {
    setTab('home');
    const target = chatFromLocation() ?? snapshot?.chats?.items[0]?.handle;
    if (!target) return;
    chatPage.begin(true); closeOverlay();
    void controller.switchChat(target, true).then(ok => { if (!ok) writeChatLocation(controller.getView().snapshot?.chats?.current ?? null, true); });
  };
  useEffect(() => { const pop = () => onPopChat.current(); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); }, []);
  useLayoutEffect(() => { if (clearing || redacted || view.recovery !== null) writeChatLocation(null, true); }, [clearing, redacted, view.recovery, view.wipe]);
  const wasLocalExpiry = useRef(false);
  useLayoutEffect(() => {
    if (view.expiry !== null) wasLocalExpiry.current = true;
    else if (wasLocalExpiry.current) {
      wasLocalExpiry.current = false;
      if (!redacted && snapshot?.session && snapshot.chats?.current) writeChatLocation(snapshot.chats.current, true);
    }
  }, [view.expiry, redacted, snapshot]);
  const composerContext = useRef<HTMLDivElement | null>(null);
  const composerWrap = useRef<HTMLDivElement | null>(null);
  useDockClearance(composerContext, composerWrap, shell.viewport, shell.anchor);
  const results = useRef(new ResultTracker());
  const [announcement, setAnnouncement] = useState('');
  const resultKey = snapshot?.panel?.handle ?? snapshot?.analysis?.handle ?? null;
  const sessionKey = snapshot?.session ? (snapshot.chats ? `${snapshot.session.context}:${snapshot.chats.current ?? 'none'}:${view.navigationEpoch}` : snapshot.session.context) : null;
  const resultLabel = resultAnnouncement(snapshot?.panel ?? null, snapshot?.analysis ?? null);

  useLayoutEffect(() => {
    if (!snapshot) return;
    const seen = results.current.observe(sessionKey, resultKey);
    if (seen === 'baseline' || seen === 'cleared') {
      // Page load, restore, new session or removed content: nothing may follow, announce or be offered.
      anchor.reset();
      setAnnouncement('');
    } else if (seen === 'result' && resultKey && !clearing && !redacted) {
      // A background music result must not move the Library or Concerts page.
      if (tab === 'home') anchor.onResult(resultKey, () => resultTop(resultKey));
      setAnnouncement(resultLabel);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, sessionKey, resultKey, clearing, redacted, anchor, tab]);

  // The result and composer commit together. Later wrapping/font/viewport layout
  // keeps that result start, never the unread Sources/refinement footer. These
  // observers retain no content or old result key; reset revokes the target.
  useLayoutEffect(() => {
    let active = true;
    const changed = () => { if (active) anchor.layoutChanged(); };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(changed) : null;
    if (conversation.current) observer?.observe(conversation.current);
    if (composerContext.current) observer?.observe(composerContext.current);
    if (composerWrap.current) observer?.observe(composerWrap.current);
    document.fonts?.addEventListener?.('loadingdone', changed);
    return () => {
      active = false;
      observer?.disconnect();
      document.fonts?.removeEventListener?.('loadingdone', changed);
    };
  }, [anchor]);

  // A wipe also drops what was derived from the old content: reading position intent, result tracking and announcements.
  useLayoutEffect(() => {
    if (view.wipe === 0) return;
    // The render guard hides the old draft, retry copy and disclosure immediately; also drop their state before paint.
    setComposer((c) => currentComposer(c, view.wipe));
    anchor.reset();
    results.current.reset();
    setAnnouncement('');
  }, [view.wipe, anchor]);

  // The reader's position at the moment work starts decides whether the result is followed.
  useLayoutEffect(() => {
    if (working) anchor.measure();
  }, [working, anchor]);

  const showNewAnswer = shell.pending !== null && shell.pending === resultKey && !clearing && !redacted;
  const revealNewAnswer = () => {
    if (!resultKey) return;
    findResult(resultKey)?.focus({ preventScroll: true });
    anchor.reveal(() => resultTop(resultKey));
  };
  // An explicit paid start (Discover, Continue, Follow, Find fresh recordings) removes or disables the button that held focus:
  // focus then goes to the one stable Stop button, only if nothing else the listener chose holds it. Nothing else arms this.
  const [toStop] = useState(() => new FocusHandoff());
  const stopButton = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (working && toStop.pending && toStop.take(browserFocusStranded())) stopButton.current?.focus({ preventScroll: true });
  });
  const startPaid = (run: () => Promise<void>) => {
    anchor.userAction();
    toStop.arm();
    void run().finally(() => toStop.cancel());
  };
  const discover = (brief: Parameters<typeof controller.discover>[0]) => startPaid(() => controller.discover(brief));
  const previousLivePhase = useRef(liveCaptureSnapshot.phase);
  useLayoutEffect(() => {
    if (previousLivePhase.current === 'listening' && liveCaptureSnapshot.phase !== 'listening' && working && browserFocusStranded()) stopButton.current?.focus({ preventScroll: true });
    previousLivePhase.current = liveCaptureSnapshot.phase;
  });
  const listenLive = () => {
    if (working || holding || clearing || redacted || view.recovery || !snapshot?.liveListening || mode !== 'live') return;
    cancelRecording();
    const capture = createLiveMusicCapture();
    anchor.userAction(); toStop.arm();
    const sent = controller.submitLive(capture, draft.cue.trim() || null);
    if (sent.accepted) { setLiveCapture(capture); setOverlay(null); }
    void sent.done.finally(() => { toStop.cancel(); setLiveCapture(current => current === capture ? null : current); });
  };
  const stop = () => {
    cancelRecording();
    void controller.stop();
    anchor.reset();
  };

  const analyse = () => {
    if (!canAnalyse || !parsed?.ok || !focusCheck?.ok) return;
    const cue = draft.cue.trim() === '' ? null : draft.cue.trim();
    anchor.userAction();
    const sent = controller.submitReference({
      url: draft.url.trim(),
      focus: focusCheck.focus,
      cue,
      display: { videoId: parsed.videoId, canonicalUrl: parsed.canonicalUrl, focus: focusCheck.focus, cue },
    });
    // M03.send composer reset: only an ACCEPTED send takes the draft out of the composer (the height then settles over
    // the existing measured 160 ms path). A refused or no-op Analyse leaves everything as it was.
    if (sent.accepted) {
      const ref = { canonicalUrl: parsed.canonicalUrl, focus: focusCheck.focus };
      setComposer((c) => acceptSend(c, wipeRef.current, { ref, context: snapshot?.session?.context ?? null }));
    }
  };

  const clear = async () => {
    cancelRecording();
    anchor.reset();
    results.current.reset();
    setAnnouncement('');
    setComposer(initialComposer(wipeRef.current));
    // Clear revokes first (controller.clear is synchronous in effect); the overlay state follows.
    if (await controller.clear()) setOverlay((o) => (o?.kind === 'menu' ? null : o));
  };
  const analyseRecording = () => {
    if (!recordingAllowed || recording.snapshot.phase !== 'ready' || preparingClip || preparationRun.current !== null) return;
    const ready = recording.snapshot;
    const submit = (prepared: { snapshot: MusicCaptureSnapshot; scope: string; receipt: NonNullable<SafeSnapshot['captureReceipt']> } | null) => {
      if (!prepared?.receipt.approved || prepared.snapshot !== ready || !recording.matchesReady(ready)) return;
      const audio = recording.takePreparedBytes(ready, prepared.scope);
      if (!audio) return;
      const sent = controller.submitRecording(audio, null, prepared.receipt);
      if (sent.accepted) { closeOverlay(); startPaid(() => sent.done); }
    };
    if (preparedClip && preparedRecording) submit(preparedClip);
    else if (recordingSelfService) void prepareRecording().then(submit);
  };
  const openWhy = () => {
    const identity = whyIdentity(snapshot);
    if (identity !== null) setOverlay((o) => openOverlay(o, { kind: 'why', identity }));
  };

  const setUrl = (url: string) => setDraft((d) => (d.focusEdited ? { ...d, url } : { ...d, url, ...focusFromUrl(url) }));

  const reference = submitted ?? (snapshot?.reference ? { ...snapshot.reference, cue: snapshot.listenerCue } : null);

  // ---- Conversation decoration (M01 intro, M03 send, M04 pending/result). ----
  // Everything below is drawn from the state above and never gates it: send, Stop, Clear, expiry, results and
  // their attribution are decided first, and every decoration finishes or disappears at once when interrupted.
  const showIntro = reference === null;
  const intro = useIntro({
    resolved: snapshot !== null || notice !== null || view.recovery !== null,
    empty: showIntro,
    interrupted: draft !== EMPTY_DRAFT,
    wipe: view.wipe,
  });
  // M03.send: the welcome leaves layout in the render the send commits; a still copy fades out at its previous rectangle.
  const introRect = useRef<Rect | null>(null);
  const wasIntro = useRef(showIntro);
  const [ghost, setGhost] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    const el = intro.element();
    if (showIntro && el) introRect.current = layoutRect(el);
    if (ghostDecision({ wasWelcome: wasIntro.current, welcome: showIntro, sentHere: submitted !== null && liveCapture === null, hasRect: introRect.current !== null, reducedMotion: prefersReducedMotion() })) setGhost(introRect.current);
    wasIntro.current = showIntro;
  });
  useEffect(() => {
    const measure = () => {
      const el = intro.element();
      if (el) introRect.current = layoutRect(el);
    };
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [intro]);
  useLayoutEffect(() => setGhost(null), [view.wipe]);

  // M04.result: only a panel that first appears while this page is awaiting or watching work plays its entrance.
  const [fresh] = useState(() => new FreshTracker());
  // The first known state is the baseline (a restore may already hold a panel and an active refinement); only an unseen
  // result after it can enter. The wipe reset runs before the commit so a post-wipe state is baselined at once.
  const panelFresh = !clearing && !redacted && fresh.isFresh(snapshot?.panel?.handle ?? null, working);
  useLayoutEffect(() => fresh.reset(), [view.wipe, fresh]);
  useLayoutEffect(() => {
    fresh.commit([...(snapshot?.panel ? [snapshot.panel.handle] : []), ...(snapshot?.history.map((h) => h.handle) ?? [])], working, snapshot !== null);
  });

  // M03.cancel / M08.recovery: only a settled state that arrives while this page was working plays its 160 ms entrance. A restored,
  // returned or already-seen state is simply there; Clear/expiry/redaction never animate and forget everything.
  const [settledTracker] = useState(() => new FreshTracker());
  const settledKey = !working && snapshot?.attempt && (snapshot.stage === 'cancelled' || snapshot.stage === 'failed') ? `${snapshot.attempt.handle}:${snapshot.stage}:${snapshot.code ?? ''}` : null;
  const noticeKey = notice ? `notice:${notice}` : null;
  const settledPlay = (key: string | null) => !clearing && !redacted && view.recovery === null && settledTracker.isFresh(key, working);
  useLayoutEffect(() => settledTracker.reset(), [view.wipe, settledTracker]);
  useLayoutEffect(() => {
    settledTracker.commit([...(settledKey ? [settledKey] : []), ...(noticeKey ? [noticeKey] : [])], working);
  });

  // M03.control: one delegated press binding for every existing control (pointer only; keyboard activation is untouched).
  useControlPress();

  // Explicit source edits reveal and focus their existing controlled editor.
  const focusTarget = useRef<'source-cue' | 'source-url' | null>(null);
  const openInput = () => setOverlay((o) => openOverlay(o, { kind: 'input', context: snapshot?.session?.context ?? null, wipe: view.wipe }));
  useLayoutEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    focusTarget.current = null;
    const el = document.getElementById(target);
    // An explicit edit/selection may target the normal-flow editor at short
    // heights or large zoom. Let native focus reveal it in the root scrollport.
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.focus();
  });

  // M03.send retry/recovery: once work has ended, the retry copy is dropped (the server owns this source, a wipe, barrier,
  // expiry or another session applies, or the listener started something new) or put back ONCE into an untouched, empty
  // composer. Pure decision (draft.ts); this effect never sends anything and never touches a non-empty composer.
  // The owned intent includes its note (listenerCue): a note-only correction that was not admitted must not look owned.
  const ownedSource = snapshot?.reference && !isAudioReference(snapshot.reference) ? { canonicalUrl: snapshot.reference.canonicalUrl, focus: snapshot.reference.focus, cue: snapshot.listenerCue } : null;
  useLayoutEffect(() => {
    if (current.accepted === null) return;
    const blocked = clearing || redacted || view.recovery !== null || controller.barrierActive();
    const facts = { working, blocked, expired: snapshot?.code === 'session_expired', context: snapshot?.session?.context ?? null, owned: ownedSource };
    setComposer((c) => {
      const settled = settleSend(c, wipeRef.current, facts);
      return settled.state === c ? c : settled.state;
    });
  });

  // Edit source: loads the OWNED source, focus and note into the (empty) composer. It dispatches nothing; only Analyse sends.
  const editSource = () => {
    if (!snapshot?.reference || isAudioReference(snapshot.reference)) return;
    const owned = { canonicalUrl: snapshot.reference.canonicalUrl, focus: snapshot.reference.focus, cue: snapshot.listenerCue };
    focusTarget.current = 'source-url';
    setComposer((c) => loadSource(c, wipeRef.current, owned).state);
  };
  // Draft fill only: the example's link and focus go into the (editable) composer; a typed note is kept and nothing is sent.
  const useExample = () => {
    focusTarget.current = 'source-url';
    const { start, end } = EXAMPLE_SOURCE.focus;
    setDraft((d) => ({ ...d, url: EXAMPLE_SOURCE.url, start: formatClock(start), end: formatClock(end), focusEdited: false }));
  };
  const recoveryNote = sourceNote(current.note, ownedSource !== null, isEmptyDraft(draft));
  const recoveryReference = snapshot?.reference ?? submitted;
  const liveRecovery = recoveryReference !== null && recoveryReference !== undefined && isStreamedReference(recoveryReference);
  const recordedRecovery = recoveryReference !== null && recoveryReference !== undefined && isRecordedReference(recoveryReference);
  const referenceRecoveryNote = liveRecovery ? '' : recordedRecovery ? 'Record another excerpt to try again.' : recoveryNote || 'Paste a link to try again.';
  const canListenAgain = liveRecovery && !working && !holding && !clearing && !redacted && !view.recovery &&
    mode === 'live' && snapshot?.session !== null && !!snapshot?.liveListening && snapshot.code !== 'session_expired';
  const canEditSource = ownedSource !== null && !working && !clearing && !redacted && view.recovery === null && isEmptyDraft(draft);
  const navigationBlocked = working || clearing || redacted || view.recovery !== null || saving !== null || (view.chatAction !== null && view.chatAction !== 'switch');
  const newChat = () => {
    if (navigationBlocked || view.chatAction !== null) return;
    setTab('home'); chatPage.begin(); closeOverlay();
    void controller.newChat(!snapshot?.session && !isEmptyDraft(draft)).then(ok => { if (ok) writeChatLocation(controller.getView().snapshot?.chats?.current ?? null); });
  };
  const sidebar: ChatSidebarProps = {
    privacyKey: `${snapshot?.session?.context ?? 'entry'}:${view.wipe}`,
    directory: clearing || redacted || view.recovery !== null ? null : snapshot?.chats ?? null,
    busy: holding || clearing || redacted || view.recovery !== null,
    navigationBlocked,
    expired: view.expiry !== null || snapshot?.code === 'session_expired',
    onNew: newChat,
    onSelect: chat => { if (navigationBlocked) return; setTab('home'); if (chat !== snapshot?.chats?.current) chatPage.begin(); closeOverlay(); void controller.switchChat(chat).then(ok => { if (ok) writeChatLocation(controller.getView().snapshot?.chats?.current ?? null); }); },
    onRename: (chat, title, revision) => controller.renameChat(chat, title, revision),
    onDelete: (chat, revision) => { closeOverlay(); void controller.deleteChat(chat, revision).then(ok => { if (ok) writeChatLocation(controller.getView().snapshot?.chats?.current ?? null, true); }); },
  };

  const tabScroll = useRef<Record<MobileTab, number>>({ home: 0, library: 0, concerts: 0 });
  const switchedTab = useRef(false);
  const selectTab = (next: MobileTab) => {
    if (next === tab) return;
    // Leaving a capture screen ends capture now, never after its exit animation.
    if (liveCapture || recording.snapshot.phase === 'recording') stop();
    closeOverlay(); intro.reveal(); anchor.reset();
    tabScroll.current[tab] = scroller().scrollTop;
    switchedTab.current = true; setTab(next);
  };
  useLayoutEffect(() => {
    if (!switchedTab.current) return;
    switchedTab.current = false;
    document.querySelector<HTMLElement>(`[data-page-heading="${tab}"]`)?.focus({ preventScroll: true });
    window.scrollTo({ top: tabScroll.current[tab], behavior: 'instant' });
  }, [tab]);
  const liveHero = liveCapture !== null && pending && !clearing && !redacted && !stopping;
  const concertScope = () => {
    const current = controller.getView();
    return current.clearing || current.redacted || current.recovery !== null || current.expiry !== null || current.snapshot?.code === 'session_expired' || !current.snapshot?.session
      ? null : `${current.snapshot.session.context}:${current.wipe}`;
  };
  const canStartListening = !working && !holding && !clearing && !redacted && !view.recovery && snapshot?.liveListening && mode === 'live';
  return (
    <ShellLayout
      menuOpen={modalOpen}
      empty={showIntro}
      tab={tab}
      sheet={
        <>
          <SessionDrawer open={wants.menu} mode={mode} onClose={closeOverlay} onClear={clear} working={working} stopping={stopping} onStop={stop} chats={sidebar} notice={notice} />
          <WhySheet
            open={wants.why}
            identity={overlay?.kind === 'why' ? overlay.identity : null}
            resolve={(identity) => resolveWhy(identity, authority)}
            working={working}
            stopping={stopping}
            notice={notice}
            onClose={closeOverlay}
            onStop={stop}
            onClear={clear}
          />
          <InputSheet open={wants.input} scope={recordingScope} onClose={closeOverlay} working={working} stopping={stopping} onStop={stop} onClear={clear} notice={notice}
            onListen={wants.input && !working && !holding && snapshot?.liveListening && mode === 'live' ? listenLive : undefined}
            recording={recordingAllowed && mode ? { mode, selfService: recordingSelfService, preparationFailed: recordingPreparationFailed, snapshot: recording.snapshot, preparing: preparingClip, prepared: preparedRecording !== null, approved: preparedRecording?.approved === true,
              onPrepare: () => { void prepareRecording(); }, onStart: startRecording, onStop: recording.stop, onDiscard: cancelRecording, onAnalyse: analyseRecording } : undefined}
            revoked={clearing || redacted || view.recovery !== null || (overlay?.kind === 'input' && !wants.input) ||
              (!wants.input && pending && submitted !== null && 'kind' in submitted && submitted.kind === 'recorded')} />
        </>
      }
    >
      <header className={`header mobile-header${tab !== 'home' ? ' mobile-page-header' : showIntro || liveHero ? ' home-entry-header' : ''}`}>
        {tab === 'home' ? <>
          {!showIntro && !liveHero && <button type="button" className="header-new-chat" onClick={newChat} disabled={navigationBlocked || view.chatAction !== null} aria-label="New chat"><span aria-hidden="true">+</span><span>New chat</span></button>}
          {showIntro || liveHero ? <h1 className="visually-hidden" tabIndex={-1} data-page-heading="home">Wintr</h1> : <div tabIndex={-1} data-page-heading="home"><Emblem out={emblem.out} attach={emblem.attach} /></div>}
        </> : <div className="mobile-page-title"><h1 tabIndex={-1} data-page-heading={tab}>{tab === 'library' ? 'Library' : 'Concerts'}</h1>{tab === 'library' && <p>{libraryView.songs.length} {libraryView.songs.length === 1 ? 'song' : 'songs'}</p>}</div>}
        {tab === 'library' && <LibrarySearchButton expanded={librarySearch} onClick={() => setLibrarySearch(!librarySearch)} />}
        {tab === 'home' && !showIntro && !liveHero && <button type="button" id={MENU_TRIGGER_ID} className="header-chat-link" aria-label="Open chats and privacy" onClick={() => setOverlay((o) => openOverlay(o, { kind: 'menu' }))}>Your chats</button>}
      </header>

      <main ref={conversation} className="conversation" hidden={tab !== 'home'}>
        <h1 className="visually-hidden" tabIndex={-1} data-chat-heading>{snapshot?.chats?.items.find(c => c.handle === snapshot.chats?.current)?.title ?? 'Wintr chat'}</h1>
        {view.chatAction && <p className="assistant status" role="status">{view.chatAction === 'delete' ? 'Deleting chat…' : view.chatAction === 'rename' ? 'Saving chat name…' : 'Opening chat…'}</p>}
        {view.deleteRecovery.map(intent => <div className="assistant action-row" key={intent.chat}><p>One chat is hidden until Delete is confirmed.</p><button type="button" className="secondary" disabled={holding || clearing} onClick={() => void controller.deleteChat(intent.chat, intent.revision)}>Retry Delete</button></div>)}
        <p className="visually-hidden" role="status">
          {announcement}
        </p>
        {/* The introduction belongs to the empty state; once a reference is submitted the conversation takes the space. */}
        {showIntro && !liveHero && <IntroCard attach={intro.attach} onReveal={intro.reveal}><div className="home-listen-content"><h2 className="home-invitation">Press to find your jam</h2><button type="button" className="listen-trigger" aria-label="Listen live" disabled={!canStartListening} onClick={listenLive}><Emblem out={emblem.out} attach={emblem.attach} /></button><p className="listen-privacy support">{mode === 'live' && snapshot?.liveListening ? 'Music goes to Gemini · up to 20s' : mode === null ? 'Connecting…' : 'Live listening is unavailable'}</p></div></IntroCard>}
        {liveHero && <div className="listening-hero" aria-label="Live listening readiness"><Emblem out={emblem.out} attach={emblem.attach} listeningMs={liveCaptureSnapshot.durationMs} /><p className="support">{liveCaptureSnapshot.phase === 'listening' && liveCaptureSnapshot.durationMs >= 5000 ? 'Ready when you are.' : liveCaptureSnapshot.phase === 'listening' ? 'Keep the music playing.' : liveCaptureSnapshot.phase === 'analysing' ? 'Listening finished.' : ''}</p></div>}
        {needsChat && notice !== CHAT_REQUIRED && !working && !clearing && !redacted && !holding && view.recovery === null && <p className="assistant" role="status">{CHAT_REQUIRED}</p>}
        {ghost && <WelcomeGhost rect={ghost} onGone={() => setGhost(null)}><Emblem out={{ steps: 0, busy: false, found: false, halted: true }} /></WelcomeGhost>}

        {reference && (
          <Appear className="user-bubble" play={submitted !== null} enterMs={DECOR.userBubble.enterMs} y={DECOR.userBubble.y}>
            {isStreamedReference(reference) ? <span>Live music</span> : isRecordedReference(reference) ? <><span>Recorded music</span><span className="support">{Math.round(reference.durationMs / 1000)} seconds</span></> : <>
              <span className="bubble-url">{reference.canonicalUrl}</span>
              <span className="support">Focus {formatClock(reference.focus.start)}–{formatClock(reference.focus.end)}</span>
            </>}
            {reference.cue && <span>{reference.cue}</span>}
          </Appear>
        )}
        {mode === 'synthetic' && reference && !isAudioReference(reference) && reference.canonicalUrl === canonicalVideoUrl(EXAMPLE_SOURCE.videoId) && !clearing && !redacted && <ExampleAttribution />}
        {reference && canEditSource && <EditSourceAction onEdit={editSource} />}

        {clearing && (
          <p className="assistant status" role="status">
            Clearing this session…
          </p>
        )}
        {liveCapture && pending && !clearing && !redacted && <section className="assistant recording-controls" aria-label="Listen live">
          <p role="status">{liveCaptureSnapshot.error ?? (liveCaptureSnapshot.phase === 'permission' ? 'Allow microphone access to listen.' : liveCaptureSnapshot.phase === 'connecting' || liveCaptureSnapshot.phase === 'idle' ? 'Connecting…' : liveCaptureSnapshot.phase === 'listening' ? 'Listening…' : liveCaptureSnapshot.phase === 'finishing' ? 'Finishing…' : 'Finding what makes it work…')}</p>
          {liveCaptureSnapshot.phase === 'listening' && <><p className="recording-time" aria-label={`${(liveCaptureSnapshot.durationMs / 1000).toFixed(1)} seconds heard`}>{(liveCaptureSnapshot.durationMs / 1000).toFixed(1)}s <span className="support">/ 20s</span></p>
            <button type="button" className="primary" disabled={liveCaptureSnapshot.durationMs < 5000} onClick={() => liveCapture.finish()}>Finish listening</button></>}
        </section>}
        {snapshot?.analysis && <AnalysisView analysis={snapshot.analysis} saved={snapshot.brief !== null} />}

        {keeping && snapshot?.panel?.intent === undefined && <KeepingContext brief={keeping} />}

        {snapshot?.analysis && !working && !clearing && (
          <PreferencePanel
            snapshot={snapshot}
            disabled={working || clearing || redacted}
            busy={holding}
            onSave={(input) => controller.savePreference(input)}
            onDiscover={discover}
            onChooseArtist={(input) => void controller.chooseArtist(input)}
          />
        )}

        {snapshot?.connection && <ConnectionPanel connection={snapshot.connection} onWhy={openWhy} />}

        {/* One keyed list keeps a complete unit mounted when current becomes
            history. Native answer/source disclosures, frame and focus survive;
            source/session/wipe changes discard that presentation identity. */}
        {[...(snapshot?.history ?? []), ...(snapshot?.panel ? [snapshot.panel] : [])].map((p) => (
          <Appear key={`${view.wipe}:${sessionKey}:${reference ? isAudioReference(reference) ? reference.receipt : `${reference.canonicalUrl}:${reference.focus.start}:${reference.focus.end}` : ''}:${snapshot?.analysis?.handle}:${p.handle}`}
            play={p.handle === snapshot?.panel?.handle && panelFresh} enterMs={DECOR.result.enterMs} y={DECOR.result.y}>
            <ChoicesPanel panel={p} disabled={working || clearing || redacted} saving={saving} onFeedback={(input) => void controller.saveFeedback(input)} />
          </Appear>
        ))}

        {tailIntent && <KeepingContext brief={tailIntent} />}

        {snapshot?.panel && !clearing && !redacted && (
          <div hidden={working} key={`${view.wipe}:${sessionKey}:${snapshot.panel.handle}`}>
          <RefinePanel
            snapshot={snapshot}
            disabled={working || clearing || redacted}
            busy={holding}
            onRefine={(input) => startPaid(() => controller.refine(input))}
          />
          </div>
        )}

        <PendingStatus
          label={stopping ? 'Stopping…' : workingText(snapshot, view.action)}
          wanted={tab === 'home' && working && !clearing}
          active={tab === 'home' && working && !stopping && !clearing}
          revoked={tab !== 'home' || clearing || redacted || view.recovery !== null || snapshot?.code === 'session_expired'}
        />

        {/* M03.cancel / M08.recovery: the settled state replaces the pending row in flow (160 ms); the latest state wins (keyed), and
            Clear/expiry never reach here with private content. Cancellation, revocation and every request are decided before this draws. */}
        {!working && snapshot && discoveryOutcome(snapshot) && (
          <SettledState stateKey={settledKey!} play={settledPlay(settledKey)}>
            <p className="assistant">{discoveryOutcome(snapshot)}</p>
          </SettledState>
        )}

        {!working && snapshot?.stage === 'cancelled' && snapshot.attempt?.kind === 'reference' && (
          <SettledState stateKey={settledKey!} play={settledPlay(settledKey)}>
            <p className="assistant">{liveRecovery ? 'Listening stopped.' : 'Stopped. Nothing from that request will be added.'} {referenceRecoveryNote}</p>
            {canListenAgain && <div className="action-row"><button type="button" className="primary" onClick={listenLive}>Listen again</button></div>}
          </SettledState>
        )}
        {!working && snapshot?.stage === 'failed' && snapshot.attempt?.kind === 'reference' && (
          <SettledState stateKey={settledKey!} play={settledPlay(settledKey)}>
            <p className="assistant">
              {referenceFailure(snapshot.code, recoveryReference)}{' '}
              {referenceRecoveryNote}
            </p>
            {canListenAgain && <div className="action-row"><button type="button" className="primary" onClick={listenLive}>Listen again</button></div>}
          </SettledState>
        )}
        {snapshot?.code === 'session_expired' && !notice && (
          <p className="assistant">Your session ended and app access to its data was removed. Start again when you are ready.</p>
        )}
        {notice && !modalOpen && (
          <SettledState stateKey={noticeKey!} play={settledPlay(noticeKey)}>
            <p className="assistant notice" role="alert">
              {notice}
            </p>
          </SettledState>
        )}
        <RecoveryActions
          recovery={view.recovery}
          failedClear={redacted && !clearing && view.expiry === null}
          onRetryClear={() => void clear()}
          onContinue={() => controller.continueWithoutIntentCheck()}
        />
        {view.expiry !== null && !clearing && view.recovery === null && <div className="assistant action-row" aria-label="Session access recovery">
          <button type="button" className="secondary" disabled={view.expiry === 'checking'} onClick={() => void controller.refresh()}>{view.expiry === 'checking' ? 'Checking session…' : 'Check session'}</button>
          <button type="button" className="secondary" onClick={() => void clear()}>Clear session</button>
        </div>}
      </main>

      {/* Optional contexts stay in document flow: a short viewport can scroll
          them above the smaller anchored editor without covering the intro. */}
      <div ref={composerContext} className="composer-context" hidden={tab !== 'home'}>
        {draft.url === '' && draft.cue !== '' && !reference && <p className="draft-cue support" role="status">Keeping “{draft.cue}” · Add a song link</p>}
        {offerExample && <details className="example-entry"><summary>Try a song</summary><ExampleOffer onUse={useExample} /></details>}
        {exampleDraft && !reference && <ExampleAttribution />}

        {parsed && !parsed.ok && (
          <p className="field-error" id="url-error" role="alert">
            {parsed.message}
          </p>
        )}
        {parsed?.ok && (
          <SourceDetails
            compact
            summary={sourceSummary(focusCheck?.ok ? `Focus ${formatClock(focusCheck.focus.start)}–${formatClock(focusCheck.focus.end)}` : 'Set the focus', draft.cue)}
            attention={timestampIssue === true || (focusCheck !== null && !focusCheck.ok)}
            open={current.sourceOpen}
            onToggle={(open) => setComposer((c) => setSourceOpen(c, wipeRef.current, open))}
          >
            <>
                <div className="focus-row">
                  <label className="field">
                    <span className="field-label">Start</span>
                    <input
                      inputMode="numeric"
                      value={draft.start}
                      placeholder="00:00"
                      aria-describedby="focus-help"
                      onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value, focusEdited: true }))}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">End</span>
                    <input
                      inputMode="numeric"
                      value={draft.end}
                      placeholder="00:45"
                      aria-describedby="focus-help"
                      onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value, focusEdited: true }))}
                    />
                  </label>
                </div>
                <p id="focus-help" className={focusCheck && !focusCheck.ok ? 'field-error' : 'support'}>
                  {timestampIssue
                    ? 'The time in this link is unclear. Set the start and end.'
                    : focusCheck === null
                      ? 'Use times like 1:12 or 72.'
                      : focusCheck.ok
                        ? 'Up to 60 seconds. This focus is a request, not proof the clip was analysed.'
                        : focusCheck.message}
                </p>
                <label className="field">
                  <span className="field-label">What do you love about it? (optional)</span>
                  <input id="source-cue" value={draft.cue} maxLength={1000} onChange={(e) => setDraft((d) => ({ ...d, cue: e.target.value }))} />
                </label>
            </>
          </SourceDetails>
        )}

      </div>

      <div ref={composerWrap} className="composer-wrap" hidden={tab !== 'home'}>
        {showNewAnswer && (
          <div className="new-answer-row">
            <button type="button" className="new-answer" onClick={revealNewAnswer}>
              New answer
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 3v9M4 8.5 8 12.5l4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        )}
        <Composer
          url={draft.url}
          onUrl={setUrl}
          working={working}
          stopping={stopping}
          canAnalyse={canAnalyse}
          disabledReason={unavailableReason}
          onAnalyse={analyse}
          onStop={stop}
          onFocusChange={focused => { if (focused) intro.reveal(); }}
          actionRef={stopButton}
          onMic={openInput}
          motion={shell}
          invalid={parsed !== null && !parsed.ok}
          describedBy={disclosure ? 'focus-disclosure' : undefined}
        />
        {disclosure && (
          <p className="support" id="focus-disclosure">
            {disclosure}
          </p>
        )}
      </div>
      {tab === 'home' && showIntro && !liveHero && <RecentSongs songs={libraryView.songs} />}
      <main className="mobile-page mobile-library" hidden={tab !== 'library'}><LibraryScreen view={libraryView} searchOpen={librarySearch} onCloseSearch={() => setLibrarySearch(false)} onRemove={song => library.remove(song)} onClear={() => library.clear(Math.max(Date.now(), snapshot?.session?.checkedAt ?? 0))} /><div className="library-chat-access"><button type="button" id={tab === 'home' && !showIntro && !liveHero ? undefined : MENU_TRIGGER_ID} aria-label="Open chats and privacy" onClick={() => setOverlay((o) => openOverlay(o, { kind: 'menu' }))}>Your chats</button></div></main>
      <main className="mobile-page mobile-concerts" hidden={tab !== 'concerts'}><ConcertsScreen songs={libraryView.songs} active={tab === 'concerts'} revoked={clearing || redacted || view.recovery !== null || view.expiry !== null || snapshot?.code === 'session_expired'} scopeKey={concertScope()} getScope={concertScope} ensureSession={async () => !!controller.getView().snapshot?.session || controller.newChat()} /></main>
      {tab !== 'home' && working && <div className="mobile-background-work" role="status"><span>Wintr is working on your music.</span><button type="button" className="secondary" onClick={() => selectTab('home')}>View</button><button type="button" className="secondary" disabled={stopping} onClick={stop}>{stopping ? 'Stopping…' : 'Stop'}</button></div>}
      {tab !== 'home' && (redacted || view.expiry !== null || view.recovery !== null) && <div className="mobile-session-notice"><p>This chat session has ended. Your Library is still here.</p><button type="button" className="secondary" onClick={() => selectTab('home')}>Return to Home</button></div>}
      <MobileNavigation tab={tab} onSelect={selectTab} busy={working} />
    </ShellLayout>
  );
}

interface ComposerProps {
  url: string;
  onUrl: (v: string) => void;
  working: boolean;
  stopping: boolean;
  canAnalyse: boolean;
  disabledReason: string | null;
  invalid: boolean;
  /** Always-visible text the link field is described by when it is valid (the focus disclosure). */
  describedBy?: string;
  onAnalyse: () => void;
  onStop: () => void;
  onFocusChange: (focused: boolean) => void;
  /** The stable Send/Stop element, for a focus hand-off from a removed paid-start control. */
  actionRef?: RefObject<HTMLButtonElement | null>;
  /** Opens the voice-input chooser. It never captures, requests a permission or contacts anything. */
  onMic: () => void;
  motion: ShellMotion;
}

function Composer(p: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const ime = useComposerHeight(ref, p.url, p.motion);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const n = e.nativeEvent;
    if (!isSubmitKey({ key: e.key, shiftKey: e.shiftKey, isComposing: n.isComposing, keyCode: n.keyCode })) return;
    e.preventDefault();
    send('enter', undefined);
  };
  /** Sends if accepted; a touch Send then dismisses the on-screen keyboard (desktop and IME flows keep focus). */
  const send = (via: 'button' | 'enter', pointerType: string | undefined) => {
    const sent = p.canAnalyse;
    if (sent) p.onAnalyse();
    const coarsePrimary = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
    if (shouldDismissKeyboard({ sent, composing: ime.composing(), via, pointerType, coarsePrimary })) ref.current?.blur();
    // The note field is disabled while work runs; keyboard focus moves to the one stable action button (Stop) instead of being stranded.
    else if (sent && !ime.composing()) actionRef.current?.focus({ preventScroll: true });
  };
  // One stable action button for the whole life of the composer: Send and Stop are two states of the same element, so a
  // state change can never strand keyboard focus. What it does comes only from the real state (control.ts actionDecision).
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const iconToggle = useToggle(p.working, CONTROL.iconCrossfadeMs);
  const attachAction = useCallback(
    (node: HTMLButtonElement | null) => {
      actionRef.current = node;
      if (p.actionRef) p.actionRef.current = node;
      iconToggle(node);
    },
    [iconToggle, p.actionRef],
  );
  const action = actionDecision({ working: p.working, stopping: p.stopping, canAnalyse: p.canAnalyse });
  const onAction = (e: MouseEvent<HTMLButtonElement>) => {
    if (action === 'stop') p.onStop();
    else if (action === 'send') send('button', (e.nativeEvent as Partial<PointerEvent>).pointerType);
  };
  return (
    <div className="composer-row">
      <div className="composer">
      <label className="visually-hidden" htmlFor="source-url">
        YouTube link
      </label>
      <textarea
        id="source-url"
        ref={ref}
        rows={1}
        value={p.url}
        maxLength={2048}
        placeholder="Paste a YouTube link"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={p.invalid}
        aria-describedby={p.invalid ? 'url-error' : p.describedBy}
        disabled={p.working}
        onChange={(e) => p.onUrl(e.target.value)}
        onFocus={() => p.onFocusChange(true)}
        onBlur={() => p.onFocusChange(false)}
        onKeyDown={onKey}
        onCompositionStart={ime.onCompositionStart}
        onCompositionEnd={ime.onCompositionEnd}
      />
      <MicButton onOpen={p.onMic} />
      <ActionButton refCallback={attachAction} working={p.working} unavailable={action === 'none'} title={p.working ? undefined : (p.disabledReason ?? undefined)} onClick={onAction} />
      </div>
    </div>
  );
}

/**
 * The settled cancellation / recovery state in normal flow: it enters over 160 ms (opacity only) when it arrived while this page was
 * working. Keyed by the state, so the latest wins and an old one never lingers; it holds only generic, non-private text.
 */
export function SettledState({ stateKey, play, children }: { stateKey: string; play: boolean; children: ReactNode }) {
  return (
    <Appear key={stateKey} play={play} enterMs={DECOR.settled.enterMs} y={0} easing={STANDARD_EASING}>
      {children}
    </Appear>
  );
}

/**
 * The single Send/Stop action. Its accessible name follows the real operation state at once; "unavailable" is
 * aria-disabled, not `disabled`, so the focused element stays focusable and a request still cannot start (the
 * handler decides from state). Both glyphs live in one cell and crossfade; the button never changes width.
 */
export function ActionButton({
  working,
  unavailable,
  title,
  onClick,
  refCallback,
}: {
  working: boolean;
  unavailable: boolean;
  title?: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  refCallback?: (node: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={refCallback}
      type="button"
      className="send"
      data-working={working || undefined}
      aria-label={working ? 'Stop' : 'Analyse reference'}
      aria-disabled={unavailable || undefined}
      title={title}
      onClick={onClick}
    >
      <svg className="icon-send" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path d="M9 14V4M4.5 8.5 9 4l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg className="icon-stop" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <rect x="4" y="4" width="10" height="10" rx="2" fill="currentColor" />
      </svg>
    </button>
  );
}

/**
 * The owned source stays editable context. This one small explicit action loads the source, focus and note back
 * into the composer for deliberate correction; it sends nothing (only Analyse does). 44 px target.
 */
export function EditSourceAction({ onEdit }: { onEdit: () => void }) {
  return (
    <div className="source-actions">
      <button type="button" className="icon-button new-reference" onClick={onEdit} aria-label="Edit source link, focus and note" title="Change reference">
        <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}

/**
 * Explicit recovery after an unconfirmed Clear (here, in another tab or before a reload), or when storage cannot be
 * checked. Nothing is retried automatically; the listener chooses.
 */
export function RecoveryActions({
  recovery,
  failedClear,
  onRetryClear,
  onContinue,
}: {
  recovery: 'clear_pending' | 'storage_unavailable' | null;
  failedClear: boolean;
  onRetryClear: () => void;
  onContinue: () => void;
}) {
  if (!recovery && !failedClear) return null;
  return (
    <div className="assistant action-row" aria-label="Clear recovery">
      <button type="button" className="primary" onClick={onRetryClear}>
        Retry Clear
      </button>
      {recovery === 'storage_unavailable' && (
        <button type="button" className="secondary" onClick={onContinue}>
          Show this session
        </button>
      )}
    </div>
  );
}

export const MENU_TRIGGER_ID = 'menu-trigger';

/**
 * The session drawer (motion M07.drawer): the existing menu/privacy/licence/Clear
 * controls. Whether it is open is `open`, applied immediately: the page behind
 * is inert while wanted, Escape, Close and the scrim all work at once, scrolling
 * behind is locked, and on close focus goes straight back to the trigger. Only
 * the exiting picture is animated; it is inert, hidden from assistive
 * technology and ignores the pointer, so it can never hold focus or block the
 * page. Clear is never routed through the animation.
 */
export function SessionDrawer({ open, mode, onClose, onClear, working, stopping, onStop, chats, notice }: { open: boolean; mode: SafeSnapshot['mode'] | null; onClose: () => void; onClear: () => void; working?: boolean; stopping?: boolean; onStop?: () => void; chats?: ChatSidebarProps; notice?: string | null }) {
  const { mounted, exiting, attach } = useDrawerPresence(open);
  useModalAuthority(open, onClose, MENU_TRIGGER_ID);

  if (!mounted) return null;
  return <DrawerLayer attach={attach} exiting={exiting} mode={mode} onClose={onClose} onClear={onClear} working={working} stopping={stopping} onStop={onStop} chats={chats} notice={notice} />;
}

/** The drawer picture: scrim plus panel. While `exiting` it ignores the pointer and its panel is inert and hidden from assistive technology. */
export function DrawerLayer(p: {
  attach?: (el: HTMLElement | null) => void;
  exiting: boolean;
  mode: SafeSnapshot['mode'] | null;
  onClose: () => void;
  onClear: () => void;
  working?: boolean;
  stopping?: boolean;
  onStop?: () => void;
  chats?: ChatSidebarProps;
  notice?: string | null;
}) {
  return (
    <div className="drawer-layer" ref={p.attach} data-exiting={p.exiting || undefined}>
      <div className="drawer-scrim" onClick={p.onClose} aria-hidden="true" />
      <MenuSheet mode={p.mode} onClose={p.onClose} onClear={p.onClear} exiting={p.exiting} working={p.working} stopping={p.stopping} onStop={p.onStop} chats={p.chats} notice={p.notice} />
    </div>
  );
}

/** The drawer panel (dialog) itself; `exiting` makes it inert and hidden from assistive technology at once. */
export function MenuSheet({ mode, onClose, onClear, exiting = false, working = false, stopping = false, onStop, chats, notice }: { mode: SafeSnapshot['mode'] | null; onClose: () => void; onClear: () => void; exiting?: boolean; working?: boolean; stopping?: boolean; onStop?: () => void; chats?: ChatSidebarProps; notice?: string | null }) {
  const sheet = useRef<HTMLDivElement>(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  // Meaningful initial focus: the dialog itself, which announces its title; the first Tab reaches the first control.
  useEffect(() => {
    if (!exiting) (chats ? sheet.current?.querySelector<HTMLElement>('[data-new-chat]:not(:disabled)') ?? sheet.current : sheet.current)?.focus({ preventScroll: true });
  }, [exiting]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !sheet.current) return;
    const items = [...sheet.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')];
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === sheet.current)) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first?.focus();
    }
  };
  return (
    <div
      ref={sheet}
      className="drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sheet-title"
      tabIndex={-1}
      inert={exiting}
      aria-hidden={exiting || undefined}
      onKeyDown={onKey}
    >
      <div className="drawer-heading"><h2 id="sheet-title" className="sheet-title">
        {chats ? 'Your chats' : 'This session'}
      </h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></button></div>
      <div className="drawer-content">
      {notice && <p className="support" role="alert">{notice}</p>}
      {chats && <ChatSidebar key={chats.privacyKey} {...chats} />}
      <button type="button" className="privacy-toggle" aria-expanded={privacyOpen} aria-controls={privacyOpen ? 'session-privacy' : undefined} onClick={() => setPrivacyOpen(value => !value)}>Privacy &amp; sources<span aria-hidden="true">{privacyOpen ? '−' : '+'}</span></button>
      {privacyOpen && <div id="session-privacy" className="privacy-content">
      <p>
        Chats last up to one hour, using a short-lived session cookie. New chats share that expiry. No Wintr account or permanent chat history.
        {' '}Unsent recordings stay on this device for up to five minutes, or until you close the recorder. Raw audio isn’t saved in your chats.
      </p>
      <p>
        Clear removes access immediately; server deletion follows. Expired records are removed during cleanup. External services have their own retention rules.
      </p>
      <p>Listen live streams up to 20 seconds of music to Google Gemini. Stop ends the stream. Raw audio isn’t saved in your chats.</p>
      <p>Your Library keeps up to 1,000 discovered songs on this device: titles, artists, listening links and dates. Clear session leaves it intact. Remove songs or use Clear Library to delete them.</p>
      <p>Album covers load from Apple’s image service, which receives your IP address. Their public links are saved with the song.</p>
      <p>Concerts sends discovered artist names to Ticketmaster. Location and date filters stay on this device. Searching never buys tickets.</p>
      {mode !== null && <p className="support">{MODE_COPY[mode].menu}</p>}
      <p className="support">
        Inter is self-hosted under the SIL Open Font License (
        <a href="/licenses/Inter-OFL.txt" target="_blank" rel="noopener noreferrer">
          Inter licence
        </a>
        ).
      </p>
      <p className="support">Apple Music and iTunes Store are trademarks of Apple Inc., registered in the U.S. and other countries.</p>
      <p className="support">
        <a href="/licenses/Software-NOTICES.txt" target="_blank" rel="noopener noreferrer">Software notices</a>
        {' · '}<a href="/licenses/Asset-NOTICES.txt" target="_blank" rel="noopener noreferrer">Artwork credits</a>
      </p>
      </div>}
      </div>
      <div className="action-row drawer-footer">
        {working && <button type="button" className="secondary" onClick={() => { sheet.current?.focus({ preventScroll: true }); onStop?.(); }} disabled={stopping}>{stopping ? 'Stopping…' : 'Stop'}</button>}
        <button type="button" className="secondary" onClick={onClear}>
          Clear session
        </button>
      </div>
    </div>
  );
}
