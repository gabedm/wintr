import { afterEach, expect, it, vi } from 'vitest';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';
import { ApiError, type ApiPort, type ChatRequest } from '../src/client/api.js';
import { SessionController } from '../src/client/controller.js';
import { memoryChatIntents, type ChatDeleteIntent, type ChatIntentPort } from '../src/client/chat-intent.js';

const h = (s: string) => s.padEnd(24, '0') as Handle;
const A = h('chat-a'), B = h('chat-b'), C = h('chat-c');
const context = 'invented-chat-context-0001';
const items = [A, B, C].map((handle, i) => ({ handle, title: `Invented chat ${i}`, revision: 0, createdAt: 1000 }));
const snap = (current: Handle | null = A, extra: Partial<SafeSnapshot> = {}): SafeSnapshot => ({
  mode: 'synthetic', session: { context, expiresAt: 3_601_000 }, chats: { current, revision: 0, items },
  stage: 'awaiting_preference', revision: current === A ? 20 : 1, status: 'reference_ready', attempt: null,
  reference: { videoId: '00000000001', canonicalUrl: 'https://www.youtube.com/watch?v=00000000001', focus: { start: 0, end: 30 } },
  listenerCue: `Private invented cue ${current}`, analysis: { handle: h('analysis'), synthetic: true, audioAccess: 'synthetic_not_accessed', observations: ['Invented observation'], relationships: ['Invented relationship'], proposedArtist: null },
  brief: null, identity: null, connection: null, panel: null, history: [], refinement: null, code: null, ...extra,
});
const empty = (): SafeSnapshot => ({ ...snap(), session: null, chats: undefined, stage: 'idle', revision: 0, status: null, reference: null, listenerCue: null, analysis: null });
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
function held<T>() {
  let resolve!: (v: T) => void, reject!: (reason: unknown) => void, settled = false;
  const promise = new Promise<T>((yes, no) => { resolve = v => { settled = true; yes(v); }; reject = err => { settled = true; no(err); }; });
  cleanup.push(async () => { if (!settled) reject(new Error('invented teardown')); await promise.catch(() => {}); });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function fixture(port: ChatIntentPort = memoryChatIntents()) {
  const reads: { chat: Handle | null; d: ReturnType<typeof held<SafeSnapshot>> }[] = [];
  const changes: { input: ChatRequest; d: ReturnType<typeof held<SafeSnapshot>> }[] = [];
  const states: ReturnType<typeof held<SafeSnapshot>>[] = [], creates: ReturnType<typeof held<SafeSnapshot>>[] = [];
  const forbidden = vi.fn(async () => { throw new Error('unexpected provider action'); });
  const api: ApiPort = {
    state: () => { const d = held<SafeSnapshot>(); states.push(d); return d.promise; },
    createSession: () => { const d = held<SafeSnapshot>(); creates.push(d); return d.promise; },
    readChat: chat => { const d = held<SafeSnapshot>(); reads.push({ chat, d }); return d.promise; },
    changeChat: input => { const d = held<SafeSnapshot>(); changes.push({ input, d }); return d.promise; },
    selectChat: vi.fn(), reference: forbidden, discover: forbidden, refine: forbidden, preference: forbidden, artistChoice: forbidden, feedback: forbidden, stop: forbidden,
    clear: vi.fn(async () => empty()),
  };
  let n = 0;
  const controller = new SessionController(api, { chatIntents: port, clock: () => 1000, newKey: () => h(`key-${++n}`), newIntentId: () => (++n).toString(16).padStart(16, '0') });
  cleanup.push(() => controller.dispose()); controller.activate();
  const refresh = controller.refresh(); states[0]!.resolve(snap()); await refresh;
  return { controller, api, reads, changes, states, creates, forbidden };
}

it('switches between lower per-chat revisions without paid calls or stale cross-chat resurrection', async () => {
  const f = await fixture();
  const first = f.controller.switchChat(B), second = f.controller.switchChat(C);
  expect(f.reads.map(r => r.chat)).toEqual([B, C]);
  expect(f.controller.getView().snapshot!.analysis).toBeNull();
  f.reads[1]!.d.resolve(snap(C)); expect(await second).toBe(true);
  f.reads[0]!.d.resolve(snap(B, { revision: 200 })); expect(await first).toBe(false);
  expect(f.controller.getView().snapshot!.chats!.current).toBe(C);
  expect(f.controller.getView().snapshot!.listenerCue).toContain(C);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('renaming another chat retains the current chat through a fresh owned read', async () => {
  const f = await fixture();
  const rename = f.controller.renameChat(B, 'Invented renamed chat', 0);
  f.changes[0]!.d.resolve(snap(B, { chats: { current: B, revision: 1, items: items.map(c => c.handle === B ? { ...c, title: 'Invented renamed chat', revision: 1 } : c) } }));
  await flush(); expect(f.reads[0]!.chat).toBe(A);
  expect(f.controller.getView().snapshot!.listenerCue).toContain(A);
  f.reads[0]!.d.resolve(snap(A, { chats: { current: A, revision: 1, items } }));
  expect(await rename).toBe(true); expect(f.forbidden).not.toHaveBeenCalled();
});

it('keeps a failed local Delete redacted across persisted return when storage refused its marker', async () => {
  const port = memoryChatIntents(); port.add = () => { throw new Error('invented storage refusal'); };
  const f = await fixture(port), deleting = f.controller.deleteChat(A, 0);
  expect(f.controller.getView().snapshot!.listenerCue).toBeNull();
  f.changes[0]!.d.reject(new ApiError(0, 'network', null)); expect(await deleting).toBe(false);
  expect(f.controller.getView().deleteRecovery).toHaveLength(1);
  f.controller.onReturn(true); f.states[1]!.resolve(snap()); await flush();
  expect(f.controller.getView().snapshot!.analysis).toBeNull();
  expect(f.controller.getView().snapshot!.chats!.items.some(c => c.handle === A)).toBe(false);
  expect(f.controller.submitReference({ url: 'https://youtu.be/00000000001', focus: { start: 0, end: 30 }, cue: null, display: { videoId: '00000000001', canonicalUrl: 'https://www.youtube.com/watch?v=00000000001', focus: { start: 0, end: 30 }, cue: null } }).accepted).toBe(false);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('a fresh load with an unfinished deletion reminder hides the target and offers explicit retry', async () => {
  const port = memoryChatIntents(); port.add({ id: '0000000000000001', context, chat: A, revision: 0 });
  const f = await fixture(port);
  expect(f.controller.getView().snapshot!.reference).toBeNull();
  expect(f.controller.getView().deleteRecovery[0]!.chat).toBe(A);
  expect(f.changes).toHaveLength(0); expect(f.forbidden).not.toHaveBeenCalled();
  const retry = f.controller.deleteChat(A, 0);
  f.changes[0]!.d.resolve(snap(B, { chats: { current: B, revision: 1, items: items.filter(c => c.handle !== A) } }));
  expect(await retry).toBe(true); expect(port.list()).toHaveLength(0);
});

it('a completed cross-tab Delete queued across an in-flight switch wins over its buffered response', async () => {
  const port = memoryChatIntents(); let notify = () => {};
  port.subscribe = fn => { notify = fn; return () => {}; };
  const f = await fixture(port), switching = f.controller.switchChat(B);
  // Both storage events can arrive after the marker was already removed.
  notify(); notify();
  f.reads[0]!.d.resolve(snap(B)); expect(await switching).toBe(false);
  await flush(); expect(f.reads[1]!.chat).toBeNull();
  f.reads[1]!.d.resolve(snap(A, { chats: { current: A, revision: 1, items: items.filter(c => c.handle !== B) } }));
  await flush();
  expect(f.controller.getView().snapshot!.chats!.current).toBe(A);
  expect(f.controller.getView().snapshot!.listenerCue).not.toContain(B);
  expect(f.changes).toHaveLength(0); expect(f.forbidden).not.toHaveBeenCalled();
});

it('Clear during New chat creation prevents any later additional-chat write', async () => {
  const f = await fixture();
  const reset = f.controller.refresh(); f.states[1]!.resolve(empty()); await flush(); f.reads[0]!.d.resolve(empty()); await reset;
  const creating = f.controller.newChat(true);
  expect(f.creates).toHaveLength(1);
  const clearing = f.controller.clear();
  expect(f.api.clear).not.toHaveBeenCalled();
  f.creates[0]!.resolve(snap());
  await creating; await clearing;
  expect(f.changes).toHaveLength(0); expect(f.controller.getView().snapshot!.session).toBeNull();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('does not send a reference against a deleted primary when the owned directory has no selected chat', async () => {
  const f = await fixture();
  const read = f.controller.refresh();
  f.states[1]!.resolve({ ...empty(), session: snap().session, chats: { current: null, revision: 1, items: items.filter(c => c.handle !== A) } });
  await read;
  const send = f.controller.submitReference({ url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', focus: { start: 0, end: 30 }, cue: null,
    display: { videoId: 'bbbbbbbbbbb', canonicalUrl: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', focus: { start: 0, end: 30 }, cue: null } });
  expect(send.accepted).toBe(false);
  await send.done;
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.creates).toHaveLength(0);
  expect(f.changes).toHaveLength(0);
  expect(f.controller.getView().snapshot!.chats!.current).toBeNull();
});

it('checks recovered Session selection after held acquisition before sending a reference', async () => {
  const f = await fixture();
  const reset = f.controller.refresh(); f.states[1]!.resolve(empty()); await flush(); f.reads[0]!.d.resolve(empty()); await reset;
  const send = f.controller.submitReference({ url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', focus: { start: 0, end: 30 }, cue: null,
    display: { videoId: 'bbbbbbbbbbb', canonicalUrl: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', focus: { start: 0, end: 30 }, cue: null } });
  expect(send.accepted).toBe(true);
  f.creates[0]!.resolve({ ...empty(), session: snap().session, chats: { current: null, revision: 1, items: items.filter(c => c.handle !== A) } });
  await send.done;
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.creates).toHaveLength(1);
  expect(f.changes).toHaveLength(0);
  expect(f.controller.getView().snapshot!.session!.expiresAt).toBe(snap().session!.expiresAt);
  expect(f.controller.getView().notice).toBe('Choose a chat from the sidebar, or start a new chat.');
});

it('New chat stays new when a missing local view recovers an already-existing nonempty Session', async () => {
  const f = await fixture();
  const reset = f.controller.refresh(); f.states[1]!.resolve(empty()); await flush(); f.reads[0]!.d.resolve(empty()); await reset;
  const creating = f.controller.newChat();
  f.creates[0]!.resolve(snap()); await flush();
  expect(f.changes).toHaveLength(1); expect(f.changes[0]!.input.kind).toBe('create');
  f.changes[0]!.d.resolve(snap(B, { stage: 'idle', revision: 0, status: null, reference: null, listenerCue: null, analysis: null }));
  expect(await creating).toBe(true); expect(f.controller.getView().snapshot!.chats!.current).toBe(B);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('does not accept a Delete response that still includes the target in its roster', async () => {
  const f = await fixture(), deleting = f.controller.deleteChat(A, 0);
  f.changes[0]!.d.resolve(snap());
  expect(await deleting).toBe(false);
  expect(f.controller.getView().snapshot!.analysis).toBeNull();
  expect(f.controller.getView().deleteRecovery).toHaveLength(1);
});

it('a second failed Delete cannot treat its already-filtered local roster as confirmation', async () => {
  const f = await fixture();
  const first = f.controller.deleteChat(B, 0);
  f.changes[0]!.d.reject(new ApiError(0, 'network', null)); await first;
  const retry = f.controller.deleteChat(B, 0);
  f.changes[1]!.d.reject(new ApiError(0, 'network', null)); await retry;
  const read = f.controller.refresh(); f.states[1]!.resolve(snap()); await read;
  expect(f.controller.getView().snapshot!.chats!.items.some(c => c.handle === B)).toBe(false);
  expect(f.controller.getView().deleteRecovery).toHaveLength(1);
});

it('rereads the original chat after a failed switch instead of treating its blank placeholder as loaded', async () => {
  const f = await fixture(), switching = f.controller.switchChat(B);
  f.reads[0]!.d.reject(new ApiError(0, 'network', null)); expect(await switching).toBe(false);
  const returning = f.controller.switchChat(A);
  expect(f.reads).toHaveLength(2); expect(f.reads[1]!.chat).toBe(A);
  f.reads[1]!.d.resolve(snap()); expect(await returning).toBe(true);
  expect(f.controller.getView().snapshot!.listenerCue).toContain(A);
});

it('History forces a fresh owned GET even when its selector resolves to the same current chat', async () => {
  const f = await fixture(), history = f.controller.switchChat(A, true);
  expect(f.reads).toHaveLength(1); expect(f.reads[0]!.chat).toBe(A);
  f.reads[0]!.d.resolve(snap()); expect(await history).toBe(true);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('a disposed controller cannot retarget the shared API after its held switch returns', async () => {
  const f = await fixture(), switching = f.controller.switchChat(B);
  const before = vi.mocked(f.api.selectChat!).mock.calls.length;
  f.controller.dispose();
  f.reads[0]!.d.resolve(snap(B)); expect(await switching).toBe(false);
  expect(vi.mocked(f.api.selectChat!).mock.calls).toHaveLength(before);
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('reactivation queues one fresh GET after a disposed held read, with no paid continuation', async () => {
  const f = await fixture();
  const old = f.controller.refresh();
  f.controller.dispose(); f.controller.activate(); await f.controller.refresh();
  f.states[1]!.resolve(snap(B)); await old; await flush();
  expect(f.states).toHaveLength(3);
  expect(f.controller.getView().snapshot!.listenerCue).not.toContain(B);
  f.states[2]!.resolve(snap()); await flush();
  expect(f.controller.getView().snapshot!.listenerCue).toContain(A);
  expect(f.forbidden).not.toHaveBeenCalled();
});
