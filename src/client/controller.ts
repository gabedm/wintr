import type { YouTubeReference, SafeReference, Focus, Handle, RuntimeMode, SafeSnapshot } from '../shared/records.js';
import {
  ApiError,
  describeError,
  type ApiPort,
  type ArtistChoiceInput,
  type FeedbackInput,
  type PreferenceInput,
  type RefineInput,
  type StopTarget,
} from './api.js';
import { isRevokedSessionAck, snapshotRemainingMs } from './api.js';
import { LIMITS } from '../shared/records.js';
import { inspectPcmWav } from '../shared/recording.js';
import { memoryClearIntents, newIntentId, readIntents, type ClearIntentPort, type IntentState } from './clear-intent.js';
import { memoryChatIntents, type ChatDeleteIntent, type ChatIntentPort } from './chat-intent.js';

// Client operation controller.
// - Each Analyse is one local operation token. Stop/Clear invalidate it
//   synchronously and abort its transport; every await rechecks the exact token
//   before any further mutation or rendering.
// - Clear is a barrier: while it runs, no new mutation starts and no read is
//   issued or applied. If Clear fails, the old session's private content stays
//   redacted until a Clear succeeds or a different/no session is observed.
// - Snapshots carry an opaque server session context. Revisions are compared
//   only within one context; across contexts, a response issued earlier than the
//   one currently displayed is dropped, so replaced content cannot reappear.
// - Server-side Stop (by action key) and Clear revoke admitted work
//   independently of the browser. Background reads are GET-only and bounded.
// - Clear writes a non-private recovery marker (see clear-intent.ts) before it
//   is sent and removes only its own marker after the server acknowledges.
//   While any marker is present (this tab, another tab, a previous load) the
//   page is behind a recovery barrier: nothing private is read, applied or
//   rendered, the unsaved draft is dropped, and only an explicit Retry Clear
//   leaves it. Free control and read waits are bounded, so a hung request or
//   body ends in an honest, retryable failure; nothing is retried automatically.

export type Submitted = SafeReference & { readonly cue: string | null };

/**
 * The one provider-triggering action this page is awaiting (local, pre-admission knowledge only). Every started action is a
 * fresh object that stays the same object across renders until it ends, so decoration can tell a repeated render of one action
 * from a later action of the same kind by identity alone.
 */
export interface PendingAction {
  readonly kind: 'reference' | 'discover' | 'refine';
  /** Which refinement, so progress text is honest about reused connections. */
  readonly refineMode?: RefineInput['mode'];
}

/** The one free save this page is awaiting an acknowledgement for (local knowledge only; nothing is saved until the server says so). */
export interface FreeSaving {
  readonly kind: 'preference' | 'artist' | 'feedback' | 'capture';
  /** The exact owned choice a feedback save is for; null otherwise. */
  readonly target: Handle | null;
}

export interface ViewState {
  readonly expiry: 'checking' | 'unconfirmed' | null;
  readonly navigationEpoch: number;
  readonly chatAction: 'create' | 'switch' | 'rename' | 'delete' | 'reconcile' | null;
  readonly deleteRecovery: readonly ChatDeleteIntent[];
  readonly snapshot: SafeSnapshot | null;
  readonly pending: boolean;
  /** The action behind pending; null when nothing is awaited. */
  readonly action: PendingAction | null;
  readonly stopping: boolean;
  /** A free save awaits its acknowledgement. Dropped in the same render as Clear, Stop, a barrier, expiry or a new session. */
  readonly saving: FreeSaving | null;
  readonly clearing: boolean;
  /** True after a failed Clear: private content of that session is hidden. */
  readonly redacted: boolean;
  readonly submitted: Submitted | null;
  readonly notice: string | null;
  /**
   * Recovery barrier: an unacknowledged Clear exists (this tab, another tab or a
   * previous load), or storage cannot be checked. Nothing private is read or shown.
   */
  readonly recovery: 'clear_pending' | 'storage_unavailable' | null;
  /** Increments whenever local private state is wiped; the page drops its unsaved draft for every new value. */
  readonly wipe: number;
}

export interface AnalyseInput {
  readonly url: string;
  readonly focus: Focus;
  readonly cue: string | null;
  readonly display: YouTubeReference & { readonly cue: string | null };
}

export interface ControllerOptions {
  readonly initialChat?: Handle | null;
  readonly chatIntents?: ChatIntentPort;
  readonly newKey?: () => string;
  readonly watchIntervalMs?: number;
  readonly maxWatchReads?: number;
  readonly returnMinIntervalMs?: number;
  readonly clock?: () => number;
  /** Clear-intent marker storage (default: in-memory, this controller only). The page binds same-origin localStorage. */
  readonly intents?: ClearIntentPort;
  /** Unique id for each Clear operation's own marker (default: 64 random bits). */
  readonly newIntentId?: () => string;
  /** Upper bound on waiting for any free control/read request, independent of the transport's own deadline. */
  readonly controlTimeoutMs?: number;
}

interface Operation {
  readonly actionKey: string;
  readonly transport: AbortController;
  phase: 'session' | 'submitted';
}

const emptySnapshot = (mode: RuntimeMode, session: SafeSnapshot['session'] = null, exampleSource?: boolean): SafeSnapshot => ({
  mode,
  ...(exampleSource === undefined ? {} : { exampleSource }),
  session,
  stage: 'idle',
  revision: 0,
  status: null,
  attempt: null,
  reference: null,
  listenerCue: null,
  analysis: null,
  brief: null,
  identity: null,
  connection: null,
  panel: null,
  history: [],
  refinement: null,
  code: null,
});

const CLEAR_FAILED = 'Clear did not complete on the server, so this session is hidden but may still exist. Try Clear again.';
const CLEAR_PENDING =
  'An earlier Clear was not confirmed by the server, so this session is hidden and may still exist. Nothing from it will be shown until Clear is confirmed. Retry Clear.';
const STORAGE_UNAVAILABLE =
  'This browser is blocking site storage, so Wintr cannot check whether an earlier Clear finished. Your session is hidden. Retry Clear, or continue to show it.';
const MARKER_UNSAVED =
  'This browser did not let Wintr remember the unfinished Clear, so reloading could show this session again. Keep this tab open and use Retry Clear.';
const CLEARED = 'Session cleared.';
export const CHAT_REQUIRED = 'Choose a chat from the sidebar, or start a new chat.';
const STILL_SAVING = 'Your last change is still being saved, so this one was not sent. Try again once it is confirmed.';
const CLEARED_ELSEWHERE = 'Session cleared from another Wintr tab.';
const CONFIRMED_BUT_PENDING =
  'The server confirmed this Clear, but another Clear is still waiting for confirmation (or this browser could not update its reminder), so the session stays hidden. Retry Clear.';

export class SessionController {
  private view: ViewState = {
    expiry: null,
    navigationEpoch: 0,
    chatAction: null,
    deleteRecovery: [],
    snapshot: null,
    pending: false,
    action: null,
    stopping: false,
    saving: null,
    clearing: false,
    redacted: false,
    submitted: null,
    notice: null,
    recovery: null,
    wipe: 0,
  };
  private readonly listeners = new Set<() => void>();
  private readonly chatIntents: ChatIntentPort;
  private readonly localChatDeletes = new Map<string, ChatDeleteIntent>();
  private unsubscribeChats: (() => void) | null = null;
  private selectedChat: Handle | null = null;
  /** An accepted read, separate from a directory kept in a loading/error placeholder. */
  private loadedChat: Handle | null = null;
  private chatOperation: object | null = null;
  private reconcileAfterChat = false;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryReceipt: { context: string; expiresAt: number; checkedAt: number | null; deadline: number } | null = null;
  private expiryHidden = false;
  private op: Operation | null = null;
  /** One free save/choice at a time, so a double click cannot race its own basis. Compared by identity: a revoked save is no longer this one. */
  private free: { abort?: () => void } | null = null;
  private readonly preparedCaptures = new WeakMap<NonNullable<SafeSnapshot['captureReceipt']>, { context: string; chat: Handle | null; generation: number }>();
  private generation = 0;
  private seq = 0;
  private appliedSeq = 0;
  private clearing: Promise<boolean> | null = null;
  /** Context whose private content must stay hidden ('unknown' if Clear failed before any context was seen). */
  private redactContext: string | null = null;
  /** This page's Clear/revocation guard, independent of a temporary storage-event barrier. */
  private localRedactContext: string | null = null;
  private pendingCreate: Promise<SafeSnapshot> | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private watchReads = 0;
  /** Read-only progress refresh while this page's own execute is pending (same interval and ceiling as the watcher). */
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private progressReads = 0;
  private reading = false;
  private readAfterInvalidation = false;
  private lastReturnRead = Number.NEGATIVE_INFINITY;
  private disposed = false;
  /** The listener explicitly chose to continue although storage could not be checked. */
  private storageOverride = false;
  private unsubscribeIntents: (() => void) | null = null;
  private readonly newKey: () => string;
  private readonly watchIntervalMs: number;
  private readonly maxWatchReads: number;
  private readonly returnMinIntervalMs: number;
  private readonly clock: () => number;
  private readonly intents: ClearIntentPort;
  private readonly newIntentId: () => string;
  private readonly controlTimeoutMs: number;

  constructor(
    private readonly api: ApiPort,
    opts: ControllerOptions = {},
  ) {
    this.newKey = opts.newKey ?? (() => crypto.randomUUID());
    this.watchIntervalMs = opts.watchIntervalMs ?? 1000;
    this.maxWatchReads = opts.maxWatchReads ?? 150;
    this.returnMinIntervalMs = opts.returnMinIntervalMs ?? 2000;
    this.clock = opts.clock ?? Date.now;
    this.intents = opts.intents ?? memoryClearIntents();
    this.chatIntents = opts.chatIntents ?? memoryChatIntents();
    this.selectedChat = opts.initialChat ?? null;
    this.api.selectChat?.(this.selectedChat);
    this.newIntentId = opts.newIntentId ?? (() => newIntentId());
    this.controlTimeoutMs = opts.controlTimeoutMs ?? 20_000;
  }

  /** Ends the wait for a free control/read request after the control deadline, whether or not the request ever settles. */
  private bounded<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new ApiError(0, 'timeout', null)), this.controlTimeoutMs);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }

  private intentState(): IntentState {
    const { state } = readIntents(this.intents);
    return state === 'unavailable' && this.storageOverride ? 'none' : state;
  }

  /**
   * The barrier check every private read, render and new action passes first.
   * True when blocked; the barrier is then shown (unless this page's own Clear
   * is in flight, which has already wiped everything).
   */
  private blocked(): boolean {
    const s = this.intentState();
    if (s === 'none') {
      try { this.chatIntents.list(); } catch {
        if (!this.storageOverride) { if (!this.clearing) this.enterBarrier('storage_unavailable'); return true; }
      }
      return false;
    }
    if (!this.clearing) this.enterBarrier(s === 'pending' ? 'clear_pending' : 'storage_unavailable');
    return true;
  }

  /** Immediately wipe everything private and stop every read; nothing is sent. */
  private enterBarrier(kind: NonNullable<ViewState['recovery']>) {
    if (this.view.recovery === kind) return;
    this.generation += 1;
    this.loadedChat = null;
    this.stopExpiryTimer();
    const op = this.op;
    this.op = null;
    op?.transport.abort();
    this.stopWatch();
    this.stopProgress();
    this.free?.abort?.();
    this.free = null;
    this.watchReads = 0;
    const prev = this.view.snapshot;
    this.redactContext = prev?.session?.context ?? this.redactContext ?? 'unknown';
    this.set({
      snapshot: prev ? emptySnapshot(prev.mode, null, prev.exampleSource) : null,
      pending: false,
      action: null,
      stopping: false,
      saving: null,
      submitted: null,
      redacted: true,
      recovery: kind,
      wipe: this.view.wipe + 1,
      notice: kind === 'clear_pending' ? CLEAR_PENDING : STORAGE_UNAVAILABLE,
    });
  }

  /** Another tab changed the marker. Its value is re-read here; the event itself carries no authority. */
  private onIntentChange = () => {
    if (this.disposed) return;
    const s = this.intentState();
    if (s !== 'none') {
      if (!this.clearing) this.enterBarrier(s === 'pending' ? 'clear_pending' : 'storage_unavailable');
      return;
    }
    // Add/remove events can both arrive after acknowledgement removed the key.
    // Their absence must not preserve the old tab's content or continuation.
    if (!this.clearing) this.invalidateAndRead(CLEARED_ELSEWHERE);
  };

  private invalidateAndRead(notice: string | null) {
    // A return/storage event may invalidate a snapshot, but cannot confirm a
    // prior failed Clear. Keep that local guard until apply sees no/different
    // session, Clear is acknowledged, or the listener explicitly continues.
    const redactContext = this.localRedactContext;
    const redactedNotice = this.view.notice;
    this.enterBarrier('clear_pending');
    this.redactContext = redactContext;
    this.set({ recovery: null, redacted: redactContext !== null, notice: redactContext !== null ? redactedNotice : notice });
    if (this.reading) this.readAfterInvalidation = true;
    else void this.refresh();
  }

  /**
   * Explicit choice when storage cannot be checked: show this session anyway.
   * Only for 'storage_unavailable'; a pending Clear can only be resolved by Clear.
   */
  continueWithoutIntentCheck(): void {
    if (this.view.recovery !== 'storage_unavailable') return;
    this.storageOverride = true;
    this.redactContext = null;
    this.localRedactContext = null;
    this.set({ recovery: null, redacted: false, notice: null });
    void this.refresh();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getView = () => this.view;

  /** Mount/unmount hooks; reversible so React StrictMode's remount works. */
  activate() {
    this.disposed = false;
    if (this.reading) this.readAfterInvalidation = true;
    this.unsubscribeIntents?.();
    this.unsubscribeIntents = this.intents.subscribe(this.onIntentChange);
    this.unsubscribeChats?.();
    this.unsubscribeChats = this.chatIntents.subscribe(() => { void this.reconcileChats(); });
    if (this.blocked()) return;
    this.syncWatch();
  }

  dispose() {
    this.disposed = true;
    this.endLocalWork();
    this.stopExpiryTimer();
    this.chatOperation = null;
    this.loadedChat = null;
    this.set({ pending: false, action: null, stopping: false, saving: null, chatAction: null, submitted: null });
    this.unsubscribeIntents?.();
    this.unsubscribeIntents = null;
    this.unsubscribeChats?.();
    this.unsubscribeChats = null;
    this.stopWatch();
    this.stopProgress();
  }

  /** Read-only snapshot fetch. Never dispatches or resumes work; skipped while Clear is revoking or a Clear is unconfirmed. */
  async refresh(): Promise<void> {
    if (this.reading || this.disposed || this.clearing || this.blocked()) return;
    if (this.expiryHidden) this.set({ expiry: 'checking', notice: 'Checking session access…' });
    this.reading = true;
    const gen = this.generation;
    const seq = ++this.seq;
    try {
      let raw = await this.bounded(this.api.state());
      // A selected chat may have been deleted in another tab. An owned root
      // read recovers the remaining directory; it never recreates that chat.
      if (!raw.session && this.selectedChat && this.api.readChat && gen === this.generation) raw = await this.bounded(this.api.readChat(null));
      // A marker written while the read was in flight wins over its result.
      if (this.blocked()) return;
      this.apply(gen, seq, raw);
    } catch (err) {
      if (gen === this.generation && !this.clearing && !this.view.recovery && !this.revokeFromError(err)) this.set({ notice: describeError(err) });
    } finally {
      this.reading = false;
      if (this.expiryHidden && !this.disposed && !this.clearing && !this.view.recovery) this.set({ expiry: 'unconfirmed', notice: 'This session is hidden until its access can be checked.' });
      if (this.readAfterInvalidation) {
        this.readAfterInvalidation = false;
        void this.refresh();
      }
    }
  }

  /** Page return (pageshow/visibility). Checks the Clear barrier first, then one rate-limited read; never a model request. */
  onReturn(persisted: boolean) {
    if (this.disposed || this.blocked()) return;
    // A frozen document can miss the complete Clear lifecycle. It cannot show
    // its old private snapshot until shared server ownership is read again.
    if (persisted && !this.clearing) { this.invalidateAndRead(null); return; }
    if (this.op || this.clearing || (!persisted && !this.view.snapshot?.session && !this.redactContext)) return;
    const now = this.clock();
    if (now - this.lastReturnRead < this.returnMinIntervalMs) return;
    this.lastReturnRead = now;
    void this.refresh();
  }

  analyse(input: AnalyseInput): Promise<void> {
    return this.submitReference(input).done;
  }

  /**
   * The deliberate reference send. `accepted` is known synchronously: only an accepted
   * send may be treated by the page as having left the composer; a refused or no-op
   * call (an operation already running, a Clear or recovery barrier) changes nothing.
   * The request itself is sent at most once and never retried.
   */
  submitReference(input: AnalyseInput): { accepted: boolean; done: Promise<void> } {
    // A deleted primary is not replaced by an omitted selector. The listener
    // must deliberately choose or create a chat; no request or draft send occurs.
    if (this.view.snapshot?.session && this.view.snapshot.chats?.current === null) return { accepted: false, done: Promise.resolve() };
    return this.beginOperation(input.display, { kind: 'reference' }, true, (actionKey, signal) => {
      // Session acquisition may recover an existing directory with its primary
      // deleted. Recheck after that await, before issuing the reference request.
      if (this.view.snapshot?.session && this.view.snapshot.chats?.current === null) throw new ApiError(409, 'not_ready', CHAT_REQUIRED);
      return this.api.reference({ url: input.url, focus: input.focus, cue: input.cue, actionKey }, signal);
    });
  }

  /** Explicit free metadata preparation. No raw audio and no provider dispatch. */
  async prepareRecording(input: { actionKey: string; sha256: string; frames: number }, adoptEntry: (next: SafeSnapshot) => boolean): Promise<NonNullable<SafeSnapshot['captureReceipt']> | null> {
    if (this.disposed || !this.api.registerCapture || this.expiryHidden || this.chatOperation || this.op || this.free || this.clearing || this.redactContext || this.view.recovery || this.view.stopping || this.view.snapshot?.attempt?.active || this.blocked()) return null;
    const transport = new AbortController(), mine = { abort: () => transport.abort() }, gen = this.generation;
    this.free = mine;
    const live = () => this.free === mine && gen === this.generation && !transport.signal.aborted && !this.blocked();
    this.set({ saving: { kind: 'capture', target: null }, notice: null });
    try {
      if (!this.view.snapshot?.session) {
        const create = this.pendingCreate ?? this.api.createSession(), seq = ++this.seq;
        this.pendingCreate = create;
        let next;
        try { next = await this.bounded(create); }
        finally { if (this.pendingCreate === create) this.pendingCreate = null; }
        if (!live() || !next.session || next.stage !== 'idle' || next.reference !== null || next.attempt !== null || next.history.length !== 0 || !adoptEntry(next)) return null;
        this.apply(gen, seq, next);
      }
      if (!live()) return null;
      const context = this.view.snapshot?.session?.context, chat = this.view.snapshot?.chats?.current ?? null;
      if (!context) return null;
      const next = await this.bounded(this.api.registerCapture(input, transport.signal));
      if (!live() || this.view.snapshot?.session?.context !== context || (this.view.snapshot?.chats?.current ?? null) !== chat) return null;
      const receipt = next.captureReceipt;
      if (!receipt || next.session?.context !== context || (next.chats?.current ?? null) !== chat || receipt.durationMs !== input.frames * 1000 / 24000) throw new ApiError(200, 'network', null);
      this.preparedCaptures.set(receipt, { context, chat, generation: gen });
      return receipt;
    } catch (error) {
      if (live()) { if (this.revokeFromError(error)) void this.refresh(); else this.set({ notice: describeError(error) }); }
      return null;
    } finally { if (this.free === mine) { this.free = null; this.set({ saving: null }); } }
  }

  cancelRecordingPreparation(): void { if (this.view.saving?.kind === 'capture') this.dropFree(); }

  /** One explicit approved transfer. Raw audio is never a draft, snapshot or automatic retry. */
  submitRecording(audio: Uint8Array, cue: string | null, receipt: NonNullable<SafeSnapshot['captureReceipt']>): { accepted: boolean; done: Promise<void> } {
    let info;
    try { info = inspectPcmWav(audio); } catch { audio.fill(0); return { accepted: false, done: Promise.resolve() }; }
    const prepared = this.preparedCaptures.get(receipt);
    if (!this.api.recordingReference || !prepared || !receipt.approved || receipt.durationMs !== info.durationMs || prepared.generation !== this.generation ||
      prepared.context !== this.view.snapshot?.session?.context || prepared.chat !== (this.view.snapshot?.chats?.current ?? null)) { audio.fill(0); return { accepted: false, done: Promise.resolve() }; }
    const sent = this.beginOperation({ kind: 'recorded', receipt: receipt.receipt, durationMs: receipt.durationMs, cue }, { kind: 'reference' }, false, async (actionKey, signal) => {
      const context = this.view.snapshot?.session?.context;
      const chat = this.view.snapshot?.chats?.current ?? null;
      const current = () => !signal.aborted && !this.blocked() && context !== undefined &&
        this.view.snapshot?.session?.context === context && (this.view.snapshot?.chats?.current ?? null) === chat;
      const abort = () => audio.fill(0);
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (!current()) throw new ApiError(0, 'aborted', null);
        let binary = '';
        for (let offset = 0; offset < audio.length; offset += 0x8000) binary += String.fromCharCode(...audio.subarray(offset, offset + 0x8000));
        const payload = btoa(binary);
        return await this.api.recordingReference!({ actionKey, receipt: receipt.receipt, cue, audio: payload }, signal);
      } finally { signal.removeEventListener('abort', abort); audio.fill(0); }
    }, () => audio.fill(0));
    if (sent.accepted) this.preparedCaptures.delete(receipt);
    if (!sent.accepted) audio.fill(0);
    // Session setup may be interrupted before the send callback ever runs.
    return { accepted: sent.accepted, done: sent.done.finally(() => audio.fill(0)) };
  }

  /** One explicit live stream uses the same operation/generation and Stop namespace as every paid action. */
  submitLive(capture: import('./live-music-capture.js').LiveMusicCapture, cue: string | null): { accepted: boolean; done: Promise<void> } {
    if (!this.api.liveReference || !this.view.snapshot?.liveListening || this.view.snapshot.mode !== 'live') { capture.cancel(); return { accepted: false, done: Promise.resolve() }; }
    const sent = this.beginOperation(null, { kind: 'reference' }, true, (actionKey, signal) => this.api.liveReference!({ actionKey, cue }, capture, signal), () => capture.cancel());
    if (!sent.accepted) capture.cancel();
    return { accepted: sent.accepted, done: sent.done.finally(() => capture.cancel()) };
  }

  /** Re-reads storage: true while a Clear is unconfirmed anywhere (entering the barrier if so). For recovery decisions. */
  barrierActive(): boolean {
    return this.blocked();
  }

  private chatMarkers(): ChatDeleteIntent[] {
    try { return [...this.chatIntents.list(), ...this.localChatDeletes.values()]; }
    catch { return [...this.localChatDeletes.values()]; }
  }

  /** Redact pending deletions before any private response is applied. */
  private filterChatDeletes(raw: SafeSnapshot, authoritative = false): SafeSnapshot {
    if (!raw.session) { this.set({ deleteRecovery: [] }); return raw; }
    const context = raw.session.context;
    const markers = this.chatMarkers().filter(m => m.context === context);
    if (!raw.chats) { this.set({ deleteRecovery: [...new Map(markers.map(m => [m.chat, m])).values()] }); return raw; }
    const hidden = new Set<Handle>(), recovery = new Map<Handle, ChatDeleteIntent>();
    for (const marker of markers) {
      const item = raw.chats.items.find(c => c.handle === marker.chat);
      if (!item && authoritative) {
        // A complete freshly authorised roster also proves this handle is no
        // longer accessible. Removal never reveals cached content.
        this.localChatDeletes.delete(marker.id);
        try { this.chatIntents.remove(marker.id); } catch { /* Still no content exists to reveal. */ }
      } else {
        hidden.add(marker.chat);
        recovery.set(marker.chat, { ...marker, revision: item?.revision ?? marker.revision });
      }
    }
    this.set({ deleteRecovery: [...recovery.values()] });
    if (!hidden.size) return raw;
    const chats = { ...raw.chats, items: raw.chats.items.filter(c => !hidden.has(c.handle)) };
    if (raw.chats.current && hidden.has(raw.chats.current)) return { ...emptySnapshot(raw.mode, raw.session, raw.exampleSource), chats: { ...chats, current: null } };
    return { ...raw, chats };
  }

  private chatReady(allowActive = false, replaceNavigation = false): boolean {
    if (this.disposed || this.expiryHidden || (this.chatOperation && !(replaceNavigation && this.view.chatAction === 'switch')) || this.free || this.clearing || this.redactContext || this.view.recovery || this.blocked()) return false;
    if (!allowActive && (this.op || this.view.stopping || this.view.snapshot?.attempt?.active)) {
      this.set({ notice: 'Wait for this chat to finish, or Stop it before changing chats.' }); return false;
    }
    return true;
  }

  /** Free navigation always re-authorises content. No cached response is replayed. */
  async switchChat(chat: Handle, forceRead = false): Promise<boolean> {
    if (!this.api.readChat || !this.chatReady(false, true) || !this.view.snapshot?.chats?.items.some(c => c.handle === chat)) return false;
    if (!forceRead && this.view.snapshot.chats.current === chat && this.loadedChat === chat) return true;
    return this.chatTransition('switch', () => this.api.readChat!(chat), true);
  }

  async newChat(preserveEntryDraft = false): Promise<boolean> {
    if (!this.api.changeChat || !this.chatReady()) return false;
    return this.chatTransition('create', async live => {
      if (!this.view.snapshot?.session) {
        const creating = this.pendingCreate ?? this.api.createSession();
        this.pendingCreate = creating;
        let initial: SafeSnapshot;
        try { initial = await this.bounded(creating); }
        finally { if (this.pendingCreate === creating) this.pendingCreate = null; }
        if (!live()) return initial;
        if (initial.attempt?.active) { this.set({ notice: 'Wait for this chat to finish, or Stop it before changing chats.' }); return initial; }
        const initialEmpty = initial.stage === 'idle' && ['attempt','reference','listenerCue','analysis','brief','identity','connection','panel','refinement'].every(key => initial[key as keyof SafeSnapshot] === null) && initial.history.length === 0;
        if (initial.chats?.current && !preserveEntryDraft && initialEmpty) return initial;
        if (!initial.session) return initial;
      }
      return this.api.changeChat!({ kind: 'create', actionKey: this.newKey() });
    }, true);
  }

  async renameChat(chat: Handle, title: string, expectedRevision: number): Promise<boolean> {
    if (!this.api.changeChat || !this.chatReady()) return false;
    const selected = this.selectedChat;
    return this.chatTransition('rename', async live => {
      const reply = await this.api.changeChat!({ kind: 'rename', chat, title, expectedRevision, actionKey: this.newKey() });
      return live() && selected && selected !== chat && this.api.readChat ? this.api.readChat(selected) : reply;
    }, false);
  }

  async deleteChat(chat: Handle, expectedRevision: number): Promise<boolean> {
    if (!this.api.changeChat || !this.chatReady(true)) return false;
    const snapshot = this.view.snapshot, context = snapshot?.session?.context;
    if (!context) return false;
    const marker: ChatDeleteIntent = { id: this.newIntentId(), context, chat, revision: expectedRevision };
    // The local guard survives refused storage, failed writes and return events.
    for (const [id, old] of this.localChatDeletes) if (old.context === context && old.chat === chat) this.localChatDeletes.delete(id);
    this.localChatDeletes.set(marker.id, marker);
    try { this.chatIntents.add(marker); } catch { /* This page remains redacted and reports failure below. */ }
    const earlier = this.chatMarkers().filter(m => m.context === context && m.chat === chat);
    this.endLocalWork();
    this.set({ snapshot: snapshot ? this.filterChatDeletes(snapshot) : null });
    return this.chatTransition('delete', async live => {
      const reply = await this.api.changeChat!({ kind: 'delete', chat, expectedRevision, actionKey: this.newKey() });
      if (!live()) return reply;
      // The exact acknowledgement was DTO-validated. Its complete roster must
      // omit this chat; a session-bearing response alone does not confirm it.
      if (reply.session?.context !== context || !reply.chats || reply.chats.items.some(c => c.handle === chat)) throw new ApiError(200, 'unconfirmed', null);
      for (const intent of earlier) {
        this.localChatDeletes.delete(intent.id);
        try { this.chatIntents.remove(intent.id); } catch { /* Authorised absence still fences it. */ }
      }
      const selected = snapshot?.chats?.current;
      return selected && selected !== chat && this.api.readChat ? this.api.readChat(selected) : reply;
    }, snapshot?.chats?.current === chat);
  }

  /** A completed or missed cross-tab delete cannot restore an old picture. */
  private async reconcileChats(): Promise<void> {
    if (!this.api.readChat || this.disposed || this.clearing || this.blocked()) return;
    if (this.chatOperation) {
      this.reconcileAfterChat = true;
      const previous = this.view.snapshot;
      this.set({ snapshot: previous ? emptySnapshot(previous.mode, previous.session, previous.exampleSource) : null });
      return;
    }
    const selected = this.selectedChat;
    await this.chatTransition('reconcile', async live => {
      const root = await this.api.readChat!(null);
      if (live() && selected && root.chats?.current !== selected && root.chats?.items.some(c => c.handle === selected)) return this.api.readChat!(selected);
      return root;
    }, true);
  }

  private async chatTransition(kind: NonNullable<ViewState['chatAction']>, send: (live: () => boolean) => Promise<SafeSnapshot>, hide: boolean): Promise<boolean> {
    this.endLocalWork();
    if (hide) this.loadedChat = null;
    const mine = {}, gen = this.generation, seq = ++this.seq;
    this.chatOperation = mine;
    const before = this.view.snapshot;
    this.set({ chatAction: kind, navigationEpoch: this.view.navigationEpoch + (hide ? 1 : 0), pending: false, action: null, stopping: false, saving: null, submitted: null, notice: null,
      ...(hide ? { snapshot: before ? { ...emptySnapshot(before.mode, before.session, before.exampleSource), ...((kind === 'switch' || kind === 'create') && before.chats ? { chats: before.chats } : {}) } : null } : {}) });
    try {
      const live = () => !this.disposed && this.chatOperation === mine && gen === this.generation && !this.clearing && !this.view.recovery && !this.blocked();
      const reply = await this.bounded(send(live));
      if (this.disposed || this.chatOperation !== mine || gen !== this.generation || this.blocked()) return false;
      if (this.reconcileAfterChat) return false;
      this.apply(gen, seq, reply);
      if (!live() || this.expiryHidden) return false;
      if (kind !== 'switch' && kind !== 'reconcile') try { this.chatIntents.changed(); } catch { /* Confirmed server state is retained. */ }
      return true;
    } catch (err) {
      if (this.chatOperation === mine && gen === this.generation) {
        if (!this.revokeFromError(err)) this.set({ notice: kind === 'delete' ? `Delete was not confirmed. That chat stays hidden. ${describeError(err)}` : describeError(err) });
      }
      return false;
    } finally {
      if (this.chatOperation === mine) {
        this.chatOperation = null; this.set({ chatAction: null });
        if (this.reconcileAfterChat) { this.reconcileAfterChat = false; void this.reconcileChats(); }
      }
    }
  }

  /** Explicit provider-triggering Discover / Continue for the confirmed brief version. */
  discover(brief: Handle): Promise<void> {
    if (!this.view.snapshot?.session) return Promise.resolve();
    return this.runOperation(null, { kind: 'discover' }, false, (actionKey, signal) => this.api.discover({ brief, actionKey }, signal));
  }

  /**
   * Free save of the chosen relationship / correction and proposed artists. Each
   * deliberate save gets its own action key and is guarded by the confirmed version
   * it was based on. Never dispatches provider work.
   */
  savePreference(input: PreferenceInput): Promise<boolean> {
    return this.freeMutation({ kind: 'preference', target: null }, (snap) =>
      this.api.preference({ ...input, actionKey: this.newKey(), expectedBrief: snap.brief?.handle ?? null }),
    );
  }

  /** Free identity choice / skip / change, guarded by the checkpoint revision it was based on. */
  chooseArtist(input: ArtistChoiceInput): Promise<boolean> {
    return this.freeMutation({ kind: 'artist', target: null }, (snap) =>
      this.api.artistChoice({ ...input, actionKey: this.newKey(), expectedRevision: snap.identity?.revision ?? 0 }),
    );
  }

  /**
   * Free, deliberate fit/familiarity save for one exact displayed choice, guarded by
   * the feedback revision it was based on. Never dispatches; Play clicks and page
   * return never call this.
   */
  saveFeedback(input: FeedbackInput): Promise<boolean> {
    return this.freeMutation({ kind: 'feedback', target: input.choice }, (snap) => {
      const panel = [snap.panel, ...snap.history].find((p) => p?.handle === input.panel);
      const choice = panel?.choices.find((c) => c.handle === input.choice);
      return this.api.feedback({ ...input, actionKey: this.newKey(), expectedRevision: choice?.feedback.revision ?? 0 });
    });
  }

  /** The one explicit, counted refinement (shared allowance). */
  refine(input: RefineInput): Promise<void> {
    if (!this.view.snapshot?.session) return Promise.resolve();
    return this.runOperation(null, { kind: 'refine', refineMode: input.mode }, false, (actionKey, signal) => this.api.refine({ ...input, actionKey }, signal));
  }

  /**
   * One free save at a time. While it awaits its acknowledgement `view.saving` says so (the page shows it and holds the
   * actions that would otherwise be dropped); a second request is refused with a visible notice, never silently. The
   * save is revoked, in the same render, by Clear, Stop, a barrier or a change of session: a late reply is then ignored.
   */
  private async freeMutation(saving: FreeSaving, send: (basis: SafeSnapshot) => Promise<SafeSnapshot>): Promise<boolean> {
    if (this.chatOperation || this.expiryHidden) return false;
    const snap = this.view.snapshot;
    if (this.op || this.clearing || this.redactContext || this.view.recovery || this.view.stopping || !snap?.session) return false;
    if (snap.attempt?.active || this.blocked()) return false;
    if (this.free) {
      this.set({ notice: STILL_SAVING });
      return false;
    }
    const mine = {};
    this.free = mine;
    const gen = this.generation;
    const seq = ++this.seq;
    this.set({ notice: null, saving });
    const live = () => this.free === mine && gen === this.generation && !this.clearing;
    try {
      const next = await this.bounded(send(snap));
      // Storage is re-read here: another renderer's marker wins even if its event has not been delivered.
      if (!live() || this.blocked()) return false;
      this.apply(gen, seq, next);
      return live();
    } catch (err) {
      if (live()) {
        if (this.revokeFromError(err)) {
          void this.refresh();
        } else {
          this.set({ notice: describeError(err) });
          // An out-of-date basis means someone else changed intent: re-read the owned state.
          if (err instanceof ApiError && (err.code === 'stale_version' || err.code === 'stale_operation')) void this.refresh();
        }
      }
      return false;
    } finally {
      if (this.free === mine) {
        this.free = null;
        this.set({ saving: null });
      }
    }
  }

  /** The awaited save no longer applies (another tab changed things, the session ended): its pending cue ends at once. */
  private dropFree() {
    this.free?.abort?.();
    if (!this.free) return;
    this.free = null;
    this.set({ saving: null });
  }

  /** Invalidate every local continuation when its server session ends; no transport or animation may restore it. */
  private endLocalWork() {
    this.generation += 1;
    const op = this.op;
    this.op = null;
    op?.transport.abort();
    this.free?.abort?.();
    this.free = null;
    this.stopWatch();
    this.stopProgress();
    this.watchReads = 0;
  }

  /** A server revocation is authoritative now, even if the reconciliation read hangs or fails. */
  private revokeFromError(err: unknown): boolean {
    if (!(err instanceof ApiError) || (err.code !== 'session_expired' && err.code !== 'no_session')) return false;
    const previous = this.view.snapshot;
    this.endLocalWork();
    this.redactContext = previous?.session?.context ?? this.redactContext ?? 'unknown';
    this.localRedactContext = this.redactContext;
    this.set({ snapshot: previous ? emptySnapshot(previous.mode, null, previous.exampleSource) : null,
      pending: false, action: null, stopping: false, saving: null, submitted: null,
      redacted: true, notice: describeError(err), wipe: this.view.wipe + 1 });
    return true;
  }

  private runOperation(
    submitted: Submitted | null,
    action: PendingAction,
    mayCreateSession: boolean,
    send: (actionKey: string, signal: AbortSignal) => Promise<SafeSnapshot>,
  ): Promise<void> {
    return this.beginOperation(submitted, action, mayCreateSession, send).done;
  }

  /**
   * Starts one operation if (and only if) nothing forbids it, and says so
   * synchronously: `accepted` is true exactly when this call took ownership of the
   * single operation slot. The caller can therefore treat a draft as sent only for
   * an accepted call; a refused one changed nothing.
   */
  private beginOperation(
    submitted: Submitted | null,
    action: PendingAction,
    mayCreateSession: boolean,
    send: (actionKey: string, signal: AbortSignal) => Promise<SafeSnapshot>,
    onAbort?: () => void,
  ): { accepted: boolean; done: Promise<void> } {
    const refused = { accepted: false, done: Promise.resolve() };
    if (this.disposed || this.expiryHidden || this.chatOperation || this.chatMarkers().some(m => m.context === this.view.snapshot?.session?.context && m.chat === this.selectedChat) || this.op || this.free || this.clearing || this.redactContext || this.view.recovery || this.view.stopping || this.view.snapshot?.attempt?.active) return refused;
    if (this.blocked()) return refused;
    const op: Operation = { actionKey: this.newKey(), transport: new AbortController(), phase: 'session' };
    if (onAbort) op.transport.signal.addEventListener('abort', onAbort, { once: true });
    this.op = op;
    this.stopWatch();
    this.stopProgress();
    this.progressReads = 0;
    const gen = this.generation;
    this.set({ pending: true, action, notice: null, submitted });
    return { accepted: true, done: this.drive(op, gen, mayCreateSession, send).finally(() => {
      if (onAbort) op.transport.signal.removeEventListener('abort', onAbort);
    }) };
  }

  private async drive(op: Operation, gen: number, mayCreateSession: boolean, send: (actionKey: string, signal: AbortSignal) => Promise<SafeSnapshot>): Promise<void> {
    const current = () => this.op === op && gen === this.generation;
    try {
      if (mayCreateSession && !this.view.snapshot?.session) {
        // Reuse an in-flight creation (e.g. after Stop then Analyse) instead of minting a second session.
        const create = this.pendingCreate ?? this.api.createSession();
        const seq = ++this.seq;
        this.pendingCreate = create;
        let created: SafeSnapshot;
        try {
          created = await this.bounded(create);
        } finally {
          if (this.pendingCreate === create) this.pendingCreate = null;
        }
        // Re-read storage after the await: a marker written by another renderer meanwhile wins, delivered or not.
        if (!current() || this.blocked()) return;
        this.apply(gen, seq, created);
      }
      // The last check before anything paid is sent.
      if (!current() || this.blocked()) return;
      op.phase = 'submitted';
      const seq = ++this.seq;
      const request = send(op.actionKey, op.transport.signal);
      // Read-only refreshes now surface the stage the server actually reports; the execute itself is sent once and never retried.
      this.scheduleProgress(op, gen);
      const result = await request;
      if (!current() || this.blocked()) return;
      this.apply(gen, seq, result);
    } catch (err) {
      if (!current()) return;
      if (this.revokeFromError(err)) void this.refresh();
      else this.set({ notice: describeError(err) });
    } finally {
      if (this.op === op) {
        this.op = null;
        this.stopProgress();
        this.set({ pending: false, action: null, submitted: null });
        this.syncWatch();
      }
    }
  }

  async stop(): Promise<void> {
    if (this.clearing) return;
    const gen = this.generation;
    const op = this.op;
    const attempt = this.view.snapshot?.attempt;
    if (op || attempt?.active) this.dropFree();
    if (op) {
      this.op = null;
      this.stopProgress();
      op.transport.abort();
      if (op.phase === 'session') {
        this.set({ pending: false, action: null, submitted: null, notice: 'Stopped before anything was sent.' });
        return;
      }
      return this.stopOnServer(gen, { actionKey: op.actionKey });
    }
    if (attempt?.active) return this.stopOnServer(gen, { attempt: attempt.handle });
  }

  /**
   * Clears local state immediately (0 ms), records the non-private Clear intent,
   * then revokes on the server. Concurrent calls share one revocation. Resolves
   * false if the server did not confirm; the intent then stays and every tab and
   * reload stays behind the recovery barrier until a Clear is confirmed. This is
   * also "Retry Clear".
   */
  clear(): Promise<boolean> {
    if (this.clearing) return this.clearing;
    this.stopExpiryTimer(); this.expiryReceipt = null; this.expiryHidden = false;
    this.set({ expiry: null });
    this.generation += 1;
    const gen = this.generation;
    const op = this.op;
    this.op = null;
    op?.transport.abort();
    this.stopWatch();
    this.stopProgress();
    this.free?.abort?.();
    this.free = null;
    this.watchReads = 0;
    const prev = this.view.snapshot;
    const context = prev?.session?.context ?? this.redactContext ?? 'unknown';
    const chatCovered = this.chatMarkers().filter(marker => context === 'unknown' || marker.context === context);
    this.localRedactContext = context;
    this.set({
      snapshot: prev ? emptySnapshot(prev.mode, null, prev.exampleSource) : null,
      pending: false,
      action: null,
      stopping: false,
      saving: null,
      clearing: true,
      submitted: null,
      // Global revocation supersedes the per-chat recovery UI; its exact markers are retained until acknowledged.
      deleteRecovery: [],
      notice: null,
      recovery: null,
      wipe: this.view.wipe + 1,
    });
    // This operation's own marker is written before anything is sent. The markers already present are recorded:
    // only they and our own may be removed by our acknowledgement. If storage refuses, Clear still proceeds and says so.
    const own = this.newIntentId();
    const earlier = readIntents(this.intents).ids;
    let saved = false;
    try {
      this.intents.add(own);
      saved = this.intents.list().includes(own);
    } catch {
      saved = false;
    }
    this.clearing = this.revoke(gen, context, own, earlier, saved, chatCovered);
    return this.clearing;
  }

  private async revoke(gen: number, context: string, own: string, earlier: readonly string[], saved: boolean, chatCovered: readonly ChatDeleteIntent[]): Promise<boolean> {
    let ok = false;
    let next: SafeSnapshot | null = null;
    let failure: unknown = null;
    try {
      // A session creation already on the wire must land (or time out) before the revocation, or it could outlive Clear.
      const create = this.pendingCreate;
      if (create) await this.bounded(create).catch(() => undefined);
      const reply = await this.bounded(this.api.clear());
      // Only the server's exact revoked-session reply confirms. Anything else (partial, array, a live session) does not.
      if (!isRevokedSessionAck(reply)) throw new ApiError(200, 'unconfirmed', null);
      next = reply;
      ok = true;
    } catch (err) {
      failure = err;
    }
    // An acknowledgement removes, by exact key, its own marker and those that predate it. A marker written by anyone
    // after this Clear started is never touched, so a late acknowledgement cannot lift a newer intent.
    if (ok) {
      for (const marker of chatCovered) {
        this.localChatDeletes.delete(marker.id);
        try { this.chatIntents.remove(marker.id); } catch { /* Revoked access stays revoked. */ }
      }
      for (const id of [own, ...earlier]) {
        try {
          this.intents.remove(id);
        } catch {
          // Unremovable: the barrier stays and Retry Clear remains the way out.
        }
      }
    }
    this.clearing = null;
    if (gen !== this.generation) return ok;
    if (ok) this.localRedactContext = null;
    // Storage that cannot be read cannot hold a newer intent of another tab; this confirmed Clear has revoked the
    // session the cookie named, so the "cannot check an earlier Clear" barrier has nothing left to protect.
    if (ok && this.intentState() === 'unavailable') this.storageOverride = true;
    const intent = this.intentState();
    if (ok && next && intent === 'none') {
      this.redactContext = null;
      this.appliedSeq = ++this.seq;
      this.set({ snapshot: next, redacted: false, recovery: null, clearing: false, notice: CLEARED });
      return true;
    }
    this.redactContext = context;
    this.set({ clearing: false, redacted: true, recovery: null });
    if (intent !== 'none') {
      // Unconfirmed, or confirmed while a newer intent exists: stay behind the barrier.
      this.enterBarrier(intent === 'pending' ? 'clear_pending' : 'storage_unavailable');
      this.set({ notice: failure !== null ? `${CLEAR_FAILED} ${describeError(failure)}` : CONFIRMED_BUT_PENDING });
    } else {
      this.set({ notice: `${CLEAR_FAILED} ${describeError(failure)}${saved ? '' : ` ${MARKER_UNSAVED}`}` });
    }
    return ok;
  }

  private async stopOnServer(gen: number, target: StopTarget) {
    this.set({ pending: false, action: null, stopping: true });
    const seq = ++this.seq;
    try {
      const next = await this.bounded(this.api.stop(target));
      if (gen !== this.generation) return;
      this.apply(gen, seq, next);
      if (next.stage !== 'cancelled') this.set({ notice: 'Stopped. Nothing from that request will be added.' });
    } catch (err) {
      if (gen === this.generation) {
        if (this.revokeFromError(err)) void this.refresh();
        else this.set({ notice: describeError(err) });
      }
    } finally {
      if (gen === this.generation) this.set({ stopping: false, submitted: null });
    }
  }

  private stopExpiryTimer() {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  /** Local retention fence only. It never declares server revocation, refunds
   * exposure, refreshes Session expiry or authorises another paid action. */
  private hideForExpiry(reconcile: boolean) {
    this.stopExpiryTimer();
    if (!this.expiryHidden) {
      this.expiryHidden = true;
      this.endLocalWork(); this.chatOperation = null; this.loadedChat = null;
      const before = this.view.snapshot;
      this.set({ snapshot: before ? emptySnapshot(before.mode, before.session, before.exampleSource) : null,
        pending: false, action: null, stopping: false, saving: null, chatAction: null, submitted: null,
        redacted: true, expiry: reconcile ? 'checking' : 'unconfirmed', wipe: this.view.wipe + 1, notice: 'This session’s local time window ended. Checking access…' });
    }
    if (reconcile && !this.disposed && !this.clearing) {
      if (this.reading) this.readAfterInvalidation = true;
      else void this.refresh();
    }
  }

  private armExpiry(raw: SafeSnapshot): boolean {
    if (!raw.session) {
      this.stopExpiryTimer(); this.expiryReceipt = null; this.expiryHidden = false; return true;
    }
    // Historical non-chat DTOs have no trustworthy relative delivery clock.
    // Their server access remains bounded; every current chat response carries
    // checkedAt. Direct legacy test/port snapshots use a conservative wall
    // clock fallback only when the new chat directory is present.
    if (raw.session.checkedAt === undefined && !raw.chats) return true;
    const localNow = performance.now(), wallNow = this.clock(), previous = this.expiryReceipt?.context === raw.session.context ? this.expiryReceipt : null;
    const expiresAt = Math.min(raw.session.expiresAt, previous?.expiresAt ?? raw.session.expiresAt);
    const checkedAt = raw.session.checkedAt ?? null;
    const transported = snapshotRemainingMs(raw);
    let remaining = transported ?? Math.min(LIMITS.sessionLifetimeMs, expiresAt - wallNow, checkedAt === null ? LIMITS.sessionLifetimeMs : expiresAt - checkedAt);
    if (transported !== null) remaining -= raw.session.expiresAt - expiresAt;
    if (!Number.isFinite(localNow) || !Number.isFinite(remaining)) remaining = 0;
    let deadline = localNow + Math.max(0, Math.min(LIMITS.sessionLifetimeMs, remaining));
    // The same old projection/replay cannot gain time from another read.
    if (previous && (checkedAt === null || previous.checkedAt === null || checkedAt <= previous.checkedAt)) deadline = Math.min(deadline, previous.deadline);
    const receipt = { context: raw.session.context, expiresAt, checkedAt, deadline };
    this.expiryReceipt = receipt; this.stopExpiryTimer();
    if (deadline <= localNow || !Number.isFinite(deadline)) { this.hideForExpiry(!this.expiryHidden); return false; }
    this.expiryHidden = false;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      if (this.expiryReceipt === receipt && !this.disposed && !this.clearing) this.hideForExpiry(true);
    }, deadline - localNow);
    return true;
  }

  private apply(gen: number, seq: number, raw: SafeSnapshot) {
    // Every application re-reads storage: a pending marker wins before its event is delivered.
    if (this.disposed || gen !== this.generation || this.clearing || this.view.recovery || this.blocked()) return;
    const prev = this.view.snapshot;
    const sameOwner = !!prev?.session && !!raw.session && prev.session.context === raw.session.context;
    const sameContext = sameOwner && (prev?.chats?.current ?? null) === (raw.chats?.current ?? null);
    if (sameOwner && prev?.chats && raw.chats && raw.chats.revision < prev.chats.revision) return;
    if (sameContext ? raw.revision < prev!.revision : seq < this.appliedSeq) return;
    this.appliedSeq = Math.max(this.appliedSeq, seq);

    let next = this.filterChatDeletes(raw, true);
    if (this.redactContext) {
      if (!raw.session || (this.redactContext !== 'unknown' && raw.session.context !== this.redactContext)) {
        this.redactContext = null;
        this.localRedactContext = null;
        this.set({ redacted: false });
      } else {
        next = emptySnapshot(raw.mode, raw.session);
      }
    }
    const wasExpiryHidden = this.expiryHidden;
    if (!this.redactContext && !this.armExpiry(raw)) return;
    if (wasExpiryHidden && !this.expiryHidden && !this.redactContext) this.set({ redacted: false, expiry: null, notice: raw.code === 'session_expired' ? 'Your session ended and app access to its data was removed.' : null });
    // Ended/replaced sessions revoke all local continuations and drafts, including a paid response still on the wire.
    const ended = !!prev?.session && prev.session.context !== next.session?.context;
    if (ended) this.endLocalWork();
    if (!this.redactContext) {
      this.selectedChat = raw.chats?.current ?? null;
      this.loadedChat = this.selectedChat;
      this.api.selectChat?.(this.selectedChat);
    }
    this.set(ended ? { snapshot: next, pending: false, action: null, stopping: false, saving: null,
      submitted: null, wipe: this.view.wipe + 1 } : { snapshot: next });
    this.syncWatch();
  }

  /** Bounded GET refresh only while the server reports an active attempt this page is not already awaiting. */
  private syncWatch() {
    const s = this.view.snapshot;
    if (!s?.session || !s.attempt?.active) {
      this.stopWatch();
      this.watchReads = 0;
      return;
    }
    if (this.op || this.watchTimer || this.disposed || this.clearing) return;
    if (this.watchReads >= this.maxWatchReads) {
      this.set({ notice: 'Still working on the server. Reload later to check the result.' });
      return;
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      this.watchReads += 1;
      void this.refresh().then(() => this.syncWatch());
    }, this.watchIntervalMs);
  }

  private stopWatch() {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
  }

  /**
   * While this page's own execute is pending the watcher is deliberately idle, so
   * bounded read-only state refreshes (same interval and ceiling) show the stage
   * the server has actually admitted. They only call the state endpoint, never
   * dispatch or retry, apply only while this exact operation is still current,
   * and fail silently (a failed read changes nothing and the execute continues).
   */
  private scheduleProgress(op: Operation, gen: number) {
    if (this.progressTimer || this.disposed || this.op !== op || gen !== this.generation || op.phase !== 'submitted') return;
    if (this.progressReads >= this.maxWatchReads) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      if (this.disposed || this.op !== op || gen !== this.generation || this.clearing) return;
      this.progressReads += 1;
      void this.progressRead(op, gen).then(() => this.scheduleProgress(op, gen));
    }, this.watchIntervalMs);
  }

  private async progressRead(op: Operation, gen: number): Promise<void> {
    if (this.reading || this.blocked()) return;
    this.reading = true;
    const seq = ++this.seq;
    try {
      const raw = await this.bounded(this.api.state());
      // Revoked, stopped, replaced or finished while the read was in flight: nothing from it may render.
      if (this.op !== op || gen !== this.generation || this.disposed || this.clearing || this.blocked()) return;
      this.apply(gen, seq, raw);
    } catch (err) {
      // Ordinary read failure is best effort; an authoritative revocation still hides content immediately.
      if (this.op === op && gen === this.generation && !this.disposed && !this.clearing) this.revokeFromError(err);
    } finally {
      this.reading = false;
      if (this.readAfterInvalidation) {
        this.readAfterInvalidation = false;
        void this.refresh();
      }
    }
  }

  private stopProgress() {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = null;
  }

  private set(patch: Partial<ViewState>) {
    this.view = { ...this.view, ...patch };
    for (const l of this.listeners) l();
  }
}
