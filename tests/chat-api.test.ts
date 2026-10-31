import { expect, it, vi } from 'vitest';
import { createApi, snapshotRemainingMs } from '../src/client/api.js';
import { isSafeSnapshot } from '../src/client/snapshot-validation.js';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';

const A = 'a'.repeat(24) as Handle, B = 'b'.repeat(24) as Handle;
const empty = (): SafeSnapshot => ({ mode: 'synthetic', session: null, stage: 'idle', revision: 0, status: null, attempt: null, reference: null, listenerCue: null, analysis: null, brief: null, identity: null, connection: null, panel: null, history: [], refinement: null, code: null });
const owned = (current = A): SafeSnapshot => ({ ...empty(), session: { context: 'invented-chat-context-0001', expiresAt: 3_601_000 }, chats: { current, revision: 0, items: [A, B].map(handle => ({ handle, title: 'Invented chat', createdAt: 1000, revision: 0 })) } });
const deps = (fetch: typeof globalThis.fetch) => ({ fetch, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>), controlTimeoutMs: 1000 });

it('captures the requested chat before awaits while root controls retain their Session scope', async () => {
  const requests: { path: string; body: unknown }[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const api = createApi(deps(async (path, init) => {
    const route = String(path); requests.push({ path: route, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (route.startsWith('/api/reference')) await gate;
    return new Response(JSON.stringify(init?.method === 'DELETE' ? empty() : owned(route.endsWith(B) ? B : A)), { status: 200 });
  }));
  api.selectChat!(A);
  const pending = api.reference({ url: 'https://youtu.be/00000000001', focus: { start: 0, end: 30 }, cue: null, actionKey: 'invented-action-key-0001' }, new AbortController().signal);
  try {
    api.selectChat!(B);
    await api.state(); await api.readChat!(null); await api.createSession();
    await api.changeChat!({ kind: 'create', actionKey: 'invented-action-key-0002' }); await api.clear();
  } finally { release(); }
  expect((await pending).chats!.current).toBe(A);
  expect(requests.map(r => r.path)).toEqual(['/api/reference?chat=' + A, '/api/state?chat=' + B, '/api/state', '/api/session', '/api/chats', '/api/session']);
  expect(requests.filter(r => r.path.startsWith('/api/reference'))).toHaveLength(1);
});

it('validates directory bounds, ownership-shaped fields and unique listed current chat', () => {
  expect(isSafeSnapshot(owned())).toBe(true);
  for (const mutate of [
    (s: any) => { s.chats.current = 'c'.repeat(24); },
    (s: any) => { s.chats.items.push(s.chats.items[0]); },
    (s: any) => { s.chats.items = Array.from({ length: 21 }, (_, i) => ({ handle: String(i).padEnd(24, '0'), title: 'Invented', createdAt: 1000, revision: 0 })); },
    (s: any) => { s.chats.items[0].title = 'x'.repeat(81); },
    (s: any) => { s.chats.items[0].createdAt = s.session.expiresAt; },
    (s: any) => { s.chats.items[0].revision = -1; },
    (s: any) => { s.chats.items[0].secret = 'invented-forbidden-field'; },
    (s: any) => { s.session = null; },
  ]) { const state = owned(); mutate(state); expect(isSafeSnapshot(state)).toBe(false); }
});

it('does not accept a native Suggestions selector for a different chat', () => {
  const state = owned();
  const panel = { handle: 'p'.repeat(24) as Handle, synthetic: true, role: 'initial' as const, mode: null, basis: [], outcome: 'no_match' as const, choices: [], answer: { text: '', marks: [] }, citations: [], suggestionsUrl: '/api/suggestions/' + 'p'.repeat(24) + '?chat=' + A, gaps: [] };
  expect(isSafeSnapshot({ ...state, panel })).toBe(true);
  expect(isSafeSnapshot({ ...state, panel: { ...panel, suggestionsUrl: '/api/suggestions/' + panel.handle + '?chat=' + B } })).toBe(false);
});

it('does not install private reference content when the new directory says no chat is selected', () => {
  const state = owned();
  expect(isSafeSnapshot({ ...state, chats: { ...state.chats!, current: null } })).toBe(true);
  expect(isSafeSnapshot({ ...state, chats: { ...state.chats!, current: null }, analysis: { handle: 'x'.repeat(24), synthetic: true, audioAccess: 'synthetic_not_accessed', observations: ['Invented prior-chat observation'], relationships: [], proposedArtist: null } })).toBe(false);
});

it('bounds projection timing and subtracts complete fetch/body time from local retention', async () => {
  const state = { ...owned(), session: { ...owned().session!, checkedAt: 1000, expiresAt: 2000 } };
  for (const checkedAt of [NaN, Infinity, -1, 2000, 2001]) expect(isSafeSnapshot({ ...state, session: { ...state.session, checkedAt } })).toBe(false);
  expect(isSafeSnapshot({ ...state, session: { ...state.session, expiresAt: 3_601_001 } })).toBe(false);
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    const api = createApi(deps(async () => { now = 200; const response = new Response(JSON.stringify(state), { status: 200 }); const text = response.text.bind(response); response.text = async () => { now = 400; return text(); }; return response; }));
    const snapshot = await api.state();
    expect(snapshotRemainingMs(snapshot)).toBe(600);
    now = 900; expect(snapshotRemainingMs(snapshot)).toBe(100);
    now = 1200; expect(snapshotRemainingMs(snapshot)).toBe(0);
  } finally { clock.mockRestore(); }
});
