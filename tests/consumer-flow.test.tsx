// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';
import { App } from '../src/client/App.js';
import { ApiError } from '../src/client/api.js';

// Real App/controller/React event wiring over an explicitly fake API. This is
// DOM and lifecycle evidence, not rendered layout, physical audio or provider evidence.
const port = vi.hoisted(() => ({ state: vi.fn(), createSession: vi.fn(), reference: vi.fn(), selectChat: vi.fn(), readChat: vi.fn(), changeChat: vi.fn(),
  preference: vi.fn(), artistChoice: vi.fn(), discover: vi.fn(), feedback: vi.fn(),
  refine: vi.fn(), stop: vi.fn(), clear: vi.fn() }));
vi.mock('../src/client/api.js', async (original) => ({ ...await original<typeof import('../src/client/api.js')>(), api: port }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = (value: string) => value.padEnd(24, '0') as Handle;
const blank = (extra: Partial<SafeSnapshot> = {}): SafeSnapshot => ({
  mode: 'synthetic', exampleSource: false, session: null, stage: 'idle', revision: 0,
  status: null, attempt: null, reference: null, listenerCue: null, analysis: null,
  brief: null, identity: null, connection: null, panel: null, history: [], refinement: null, code: null, ...extra,
});
const ready = (withPanel = true): SafeSnapshot => blank({
  session: { context: 'invented-dom-session', expiresAt: Date.now() + 3_600_000 },
  stage: withPanel ? 'complete' : 'awaiting_preference', revision: 3,
  reference: { videoId: 'aaaaaaaaaaa', canonicalUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', focus: { start: 12, end: 57 } },
  analysis: { handle: h('analysis'), synthetic: true, audioAccess: 'synthetic_not_accessed',
    observations: ['An invented observation.'], relationships: ['A low line and a soft lead'], proposedArtist: 'Invented Seed' },
  brief: { handle: h('brief'), version: 1, relationship: 'A low line and a soft lead', source: 'intake_cue', artists: ['Invented Seed'] },
  panel: withPanel ? { handle: h('panel'), synthetic: true, role: 'initial', mode: null, basis: [], outcome: 'choices',
    choices: [{ handle: h('choice'), title: 'Invented Recording', credits: ['Invented Neighbour'], anchor: 'Invented Neighbour',
      unverifiedCredits: 0, service: 'youtube', playUrl: null, fitHypothesis: 'An invented hypothesis.', sources: [],
      feedback: { fit: null, familiarity: null, revision: 0 } }],
    answer: { text: '', marks: [] }, citations: [], suggestionsUrl: null, gaps: [] } : null,
  refinement: { used: false },
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  port.clear.mockResolvedValue(blank());
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function boot(state: SafeSnapshot) {
  port.state.mockResolvedValue(state);
  await act(async () => { root.render(<App />); await flush(); });
}
function button(text: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text || b.getAttribute('aria-label') === text);
  if (!found) throw new Error('Missing expected synthetic-test control: ' + text);
  return found;
}
const click = async (text: string) => act(async () => { button(text).click(); await flush(); });
function typeLink(value: string) {
  const field = host.querySelector<HTMLTextAreaElement>('#source-url')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
const paidCalls = () => port.reference.mock.calls.length + port.discover.mock.calls.length + port.refine.mock.calls.length;

describe('session chat sidebar', () => {
  const A = h('chat-a'), B = h('chat-b');
  const items = [{ handle: A, title: 'Invented first chat', createdAt: 1000, revision: 0 }, { handle: B, title: 'Invented second chat', createdAt: 1000, revision: 0 }];
  const first = (): SafeSnapshot => ({ ...ready(false), chats: { current: A, revision: 0, items: items.slice(0, 1) } });
  const second = (): SafeSnapshot => blank({ session: first().session, chats: { current: B, revision: 1, items } });
  it('creates a chat and restores each unsaved local draft when switching, with no paid action', async () => {
    port.changeChat.mockResolvedValue(second());
    port.readChat.mockImplementation(async chat => chat === A ? { ...first(), chats: { current: A, revision: 1, items } } : second());
    await boot(first());
    await act(async () => { typeLink('Invented unsent first draft'); await flush(); });
    await click('New chat');
    expect(port.changeChat).toHaveBeenCalledWith(expect.objectContaining({ kind: 'create' }));
    expect(host.querySelector<HTMLTextAreaElement>('#source-url')!.value).toBe('');
    await act(async () => { typeLink('Invented unsent second draft'); await flush(); });
    await click('Open chats and privacy');
    expect(document.activeElement).toBe(host.querySelector('[data-new-chat]'));
    await click('Invented first chat');
    expect(host.querySelector<HTMLTextAreaElement>('#source-url')!.value).toBe('Invented unsent first draft');
    await click('Open chats and privacy'); await click('Invented second chat');
    expect(host.querySelector<HTMLTextAreaElement>('#source-url')!.value).toBe('Invented unsent second draft');
    expect(paidCalls()).toBe(0);
  });

  it('renames inline and restores focus to the current options button after Save', async () => {
    await boot(first()); await click('Open chats and privacy');
    await click('Options for Invented first chat'); await click('Rename');
    const field = host.querySelector<HTMLInputElement>('#chat-rename')!;
    expect(document.activeElement).toBe(field);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Invented new name'); field.dispatchEvent(new Event('input', { bubbles: true })); await flush(); });
    port.changeChat.mockResolvedValue({ ...first(), chats: { current: A, revision: 1, items: items.map(c => c.handle === A ? { ...c, title: 'Invented new name', revision: 1 } : c) } });
    await act(async () => { field.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush(); });
    expect(port.changeChat).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rename', chat: A, title: 'Invented new name', expectedRevision: 0 }));
    expect(document.activeElement).toBe(button('Options for Invented new name'));
    expect(paidCalls()).toBe(0);
  });

  it('keeps a new link unsent and gives chat recovery when the selected chat has been deleted', async () => {
    await boot(blank({ session: first().session, chats: { current: null, revision: 1, items: items.slice(1) } }));
    await act(async () => { typeLink('https://www.youtube.com/watch?v=bbbbbbbbbbb'); await flush(); });
    expect(host.textContent).toContain('Choose a chat from the sidebar, or start a new chat.');
    expect(button('Analyse reference').getAttribute('aria-disabled')).toBe('true');
    await click('Analyse reference');
    expect(host.querySelector<HTMLTextAreaElement>('#source-url')!.value).toBe('https://www.youtube.com/watch?v=bbbbbbbbbbb');
    expect(paidCalls()).toBe(0);
    expect(port.createSession).not.toHaveBeenCalled();
    expect(port.changeChat).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('Choose or skip each artist');
  });

  it('restores the accepted entry link when Session acquisition recovers no selected chat', async () => {
    const acquisition = deferred<SafeSnapshot>(); port.createSession.mockReturnValue(acquisition.promise);
    await boot(blank());
    await act(async () => { typeLink('https://www.youtube.com/watch?v=bbbbbbbbbbb&t=17s'); await flush(); });
    await click('Analyse reference');
    expect(host.querySelector<HTMLTextAreaElement>('#source-url')!.value).toBe('');
    await act(async () => {
      acquisition.resolve(blank({ session: first().session, chats: { current: null, revision: 1, items: items.slice(1) } }));
      await flush();
    });
    expect(host.querySelector<HTMLTextAreaElement>('#source-url')!.value).toBe('https://www.youtube.com/watch?v=bbbbbbbbbbb&t=17s');
    expect(host.textContent?.match(/Choose a chat from the sidebar, or start a new chat\./g)).toHaveLength(1);
    expect(paidCalls()).toBe(0);
    expect(port.createSession).toHaveBeenCalledTimes(1);
    expect(port.changeChat).not.toHaveBeenCalled();
  });

  it('announces a failed rename inside the active dialog while preserving the draft and stable focus', async () => {
    const work = deferred<SafeSnapshot>(); port.changeChat.mockReturnValue(work.promise);
    await boot(first()); await click('Open chats and privacy');
    await click('Options for Invented first chat'); await click('Rename');
    const field = host.querySelector<HTMLInputElement>('#chat-rename')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Invented unsaved name'); field.dispatchEvent(new Event('input', { bubbles: true })); await flush(); });
    await act(async () => { field.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush(); });
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.activeElement).toBe(dialog);
    expect(field.disabled).toBe(true);
    await act(async () => { work.reject(new Error('invented rename failure')); await flush(); });
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Something went wrong.');
    expect(dialog.closest('[inert]')).toBeNull();
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(field.value).toBe('Invented unsaved name');
    expect(field.disabled).toBe(false);
    expect(button('Save name').disabled).toBe(false);
    expect(button('Cancel').disabled).toBe(false);
    expect(document.activeElement).toBe(dialog);
    expect(port.changeChat).toHaveBeenCalledTimes(1);
    expect(paidCalls()).toBe(0);
    await click('Clear session');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toContain('Invented unsaved name');
  });

  it('Clear removes sidebar titles and all per-chat drafts before its acknowledgement', async () => {
    await boot(first());
    await act(async () => { typeLink('Invented private draft'); await flush(); });
    const clear = deferred<SafeSnapshot>(); port.clear.mockReturnValue(clear.promise);
    await click('Open chats and privacy'); await click('Clear session');
    expect(host.textContent).not.toContain('Invented first chat');
    expect(host.querySelector<HTMLTextAreaElement>('#source-url')!.value).toBe('');
    await act(async () => { clear.resolve(blank()); await flush(); });
    expect(paidCalls()).toBe(0);
  });

  it('a global Clear removes failed chat deletion recovery before acknowledgement and keeps it gone after confirmation', async () => {
    port.changeChat.mockRejectedValue(new Error('invented lost deletion reply'));
    await boot(first()); await click('Open chats and privacy');
    await click('Options for Invented first chat'); await click('Delete chat');
    expect(host.textContent).toContain('One chat is hidden');
    expect(button('Retry Delete').disabled).toBe(false);
    const clear = deferred<SafeSnapshot>(); port.clear.mockReturnValue(clear.promise);
    await click('Open chats and privacy'); await click('Clear session');
    expect(host.textContent).not.toContain('One chat is hidden');
    expect(host.textContent).not.toContain('Retry Delete');
    await act(async () => { clear.resolve(blank()); await flush(); });
    expect(host.textContent).toContain('Session cleared.');
    expect(host.textContent).not.toContain('Retry Delete');
    expect(host.textContent).not.toContain('Invented first chat');
    expect(paidCalls()).toBe(0);
  });

  it('hides idle private results and unsent drafts at the local session boundary before a fresh expiry read', async () => {
    const initial = first(), expiry = Date.now() + 150;
    await boot({ ...initial, session: { ...initial.session!, expiresAt: expiry } });
    await act(async () => { typeLink('Invented private idle draft'); await flush(); });
    port.state.mockResolvedValue(blank({ code: 'session_expired' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); await flush(); });
    expect(host.querySelector('[data-result]')).toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>('#source-url')!.value).toBe('');
    expect(port.state.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(paidCalls()).toBe(0);
  });
});

describe('server-derived discovery retry availability', () => {
  it('shows the owned pending identity choices in a legacy preference-stage snapshot without offering premature Discover', async () => {
    await boot({ ...ready(false), stage: 'awaiting_preference', discovery: 'available',
      attempt: { handle: h('attempt'), kind: 'discover', active: false, outcome: 'succeeded' },
      identity: { handle: h('checkpoint'), revision: 0, awaiting: true, slots: [{ proposal: 'Invented Seed', status: 'ambiguous', chosen: null,
        options: [{ handle: h('artist'), name: 'Invented Seed', disambiguation: 'Invented band' }] }] } });
    expect(host.querySelector('[aria-label="Which artist did you mean?"]')).not.toBeNull();
    expect(button('Continue discovery').disabled).toBe(true);
    expect(host.querySelector('button.primary')!.textContent).toBe('Continue discovery');
    expect(paidCalls()).toBe(0);
  });

  it('offers separate public identity context without selecting an artist or dispatching work', async () => {
    const profile = { service: 'spotify' as const, url: 'https://open.spotify.com/artist/' + '1'.repeat(22) };
    await boot({ ...ready(false), stage: 'awaiting_artist', discovery: 'available',
      identity: { handle: h('checkpoint'), revision: 0, awaiting: true, slots: [{ proposal: 'Invented Seed', status: 'ambiguous', chosen: null,
        options: [{ handle: h('artist'), name: 'Invented Seed', disambiguation: 'Invented band', context: profile }] }] } });
    const link = host.querySelector<HTMLAnchorElement>('a[href="' + profile.url + '"]');
    expect(link).not.toBeNull();
    expect(link!.closest('button')).toBeNull();
    expect(link!.target).toBe('_blank');
    expect(link!.rel.split(' ')).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    host.addEventListener('click', event => event.preventDefault(), { once: true });
    await act(async () => { link!.click(); await flush(); });
    expect(port.artistChoice).not.toHaveBeenCalled();
    expect(paidCalls()).toBe(0);
    expect(button('Continue discovery').disabled).toBe(true);
  });

  it('also blocks stopped checkpoint Continue while leaving its free artist choices available', async () => {
    await boot({ ...ready(false), stage: 'awaiting_artist', discovery: 'unavailable',
      attempt: { handle: h('attempt'), kind: 'discover', active: false, outcome: 'cancelled' },
      identity: { handle: h('checkpoint'), revision: 1, awaiting: true, slots: [{ proposal: 'Invented Seed', status: 'ambiguous', chosen: h('artist'),
        options: [{ handle: h('artist'), name: 'Invented Seed', disambiguation: 'Invented band' }] }] } });
    expect(button('Continue discovery').disabled).toBe(true);
    await click('Continue discovery');
    expect(port.discover).not.toHaveBeenCalled();
    expect(button('Invented Seed, Invented band').disabled).toBe(false);
    expect(button('Edit starting artists').disabled).toBe(false);
    expect(host.textContent).toContain('This discovery cannot be sent again');
  });

  it.each(['unavailable', 'edit_artists', undefined] as const)('refuses a known invalid resend for %s while keeping free Edit reachable', async discovery => {
    await boot({ ...ready(false), stage: 'failed', code: 'qloo_failed', discovery,
      attempt: { handle: h('attempt'), kind: 'discover', active: false, outcome: 'failed' } });
    expect(button('Discover connections').disabled).toBe(true);
    await click('Discover connections');
    expect(port.discover).not.toHaveBeenCalled();
    expect(button('Edit').disabled).toBe(false);
    expect(host.textContent).toContain(discovery === 'edit_artists' ? 'Change the starting artists' : 'This discovery cannot be sent again');
  });

  it('permits exactly the deliberately offered action after a corrected server snapshot, without sending on boot', async () => {
    const state = { ...ready(false), discovery: 'available' as const };
    port.discover.mockResolvedValue(state);
    await boot(state);
    expect(button('Discover connections').disabled).toBe(false);
    expect(port.discover).not.toHaveBeenCalled();
    await click('Discover connections');
    expect(port.discover).toHaveBeenCalledTimes(1);
  });
});

describe('approved example and pre-send disclosure', () => {
  it('keeps automatic timestamp recovery open while both focus fields are corrected, without sending', async () => {
    await boot(blank());
    await act(async () => { typeLink('https://youtu.be/aaaaaaaaaaa?t=12'); await flush(); });
    const details = host.querySelector<HTMLDetailsElement>('details.draft-details')!;
    await act(async () => { details.querySelector<HTMLElement>('summary')!.focus(); await flush(); });
    expect(details.open).toBe(false); // Focusing a closed summary does not activate it.
    await act(async () => { typeLink('https://youtu.be/aaaaaaaaaaa?t=72&start=12'); await flush(); });
    expect(details.open).toBe(true);
    const [start, end] = [...details.querySelectorAll<HTMLInputElement>('.focus-row input')];
    const edit = async (field: HTMLInputElement, value: string) => act(async () => {
      field.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true })); await flush();
    });
    await edit(start!, '00:12');
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(start);
    await edit(end!, '00:57');
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(end);
    expect(button('Analyse reference').getAttribute('aria-disabled')).not.toBe('true');
    expect(port.createSession).not.toHaveBeenCalled();
    expect(paidCalls()).toBe(0);
    await act(async () => { details.querySelector<HTMLElement>('summary')!.click(); await new Promise(resolve => setTimeout(resolve, 0)); await flush(); });
    expect(details.open).toBe(false); // A deliberate close still works once the focus is valid.
  });

  it('fills an editable attributed example without a session, save or provider-triggering request', async () => {
    await boot(blank({ exampleSource: true }));
    expect(host.textContent).toContain('Kevin MacLeod');
    expect(host.textContent).toContain('CC BY 4.0');
    await click('Use this example');
    const field = host.querySelector<HTMLTextAreaElement>('#source-url')!;
    expect(field.value).toBe('https://www.youtube.com/watch?v=sMcWOaJFuw0&t=12s');
    expect(field.disabled).toBe(false);
    expect([...host.querySelectorAll<HTMLInputElement>('input')].map(el => el.value)).toEqual(expect.arrayContaining(['00:12', '00:57']));
    await act(async () => { typeLink('https://youtu.be/bbbbbbbbbbb?t=20'); await flush(); });
    expect(field.value).toContain('bbbbbbbbbbb');
    expect(port.state).toHaveBeenCalledTimes(1);
    expect(port.createSession).not.toHaveBeenCalled();
    expect(port.preference).not.toHaveBeenCalled();
    expect(paidCalls()).toBe(0);
  });

  it.each(['disabled', 'synthetic', 'live'] as const)('does not offer an example without the server capability in %s mode', async mode => {
    await boot(blank({ mode, exampleSource: false }));
    expect(host.textContent).not.toContain('Use this example');
    expect(paidCalls()).toBe(0);
  });

  it('does not repeat the S00 offer under an existing reference/result when its composer becomes empty', async () => {
    await boot({ ...ready(), exampleSource: true });
    expect(host.querySelector<HTMLTextAreaElement>('#source-url')!.value).toBe('');
    expect(host.textContent).not.toContain('Use this example');
    expect(paidCalls()).toBe(0);
  });

  it('shows the actual live processing limit before Analyse, outside optional closed details and associated with the link', async () => {
    await boot(blank({ mode: 'live', exampleSource: true }));
    expect(host.textContent).not.toContain('Use this example');
    await act(async () => { typeLink('https://youtu.be/invRefAAA01?t=12'); await flush(); });
    const notice = host.querySelector<HTMLElement>('#focus-disclosure')!;
    expect(notice.textContent).toMatch(/Gemini may analyse beyond your chosen moment/i);
    expect(notice.closest('details')).toBeNull();
    expect(host.querySelector('#source-url')?.getAttribute('aria-describedby')).toBe('focus-disclosure');
    expect(button('Analyse reference').getAttribute('aria-disabled')).toBeNull();
    expect(paidCalls()).toBe(0);
  });

  it('the composer and example keep focus and editable source context without inventing a note or sending', async () => {
    await boot(blank({ exampleSource: true }));
    const link = host.querySelector<HTMLTextAreaElement>('#source-url')!;
    await act(async () => { link.focus(); await flush(); });
    expect(document.activeElement).toBe(link);
    expect(host.textContent).not.toContain('Keeping “');
    await click('Use this example');
    expect(document.activeElement).toBe(link);
    const details = host.querySelector<HTMLDetailsElement>('details.draft-details')!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); await flush(); });
    const cue = host.querySelector<HTMLInputElement>('#source-cue')!;
    expect(cue.value).toBe('');
    expect(cue.disabled).toBe(false);
    await act(async () => {
      cue.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(cue, 'Keep the invented contrast');
      cue.dispatchEvent(new Event('input', { bubbles: true })); await flush();
    });
    expect(cue.value).toBe('Keep the invented contrast');
    expect(document.activeElement).toBe(cue);
    expect(link.value).toContain('sMcWOaJFuw0');
    expect(port.preference).not.toHaveBeenCalled();
    expect(port.createSession).not.toHaveBeenCalled();
    expect(paidCalls()).toBe(0);
  });
});

describe('feedback acknowledgement in the actual App', () => {
  it('holds rapid clicks visibly, preserves focus and saves the second axis only on the acknowledged basis', async () => {
    const state = ready(), first = deferred<SafeSnapshot>(), second = deferred<SafeSnapshot>();
    port.feedback.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await boot(state);
    const like = button('Like it'); like.focus();
    // Two events in one React batch exercise the controller guard before the new busy props have rendered.
    act(() => { like.click(); button('New to me').click(); });
    expect(port.feedback).toHaveBeenCalledTimes(1);
    expect(host.textContent).toMatch(/still being saved.*not sent/i);
    expect(button('Like it').getAttribute('aria-pressed')).toBe('false');
    expect(button('New to me').getAttribute('aria-disabled')).toBe('true');
    expect(button('Find fresh recordings').disabled).toBe(true);
    expect(document.activeElement).toBe(like);
    const liked = { ...state, revision: 4, panel: { ...state.panel!, choices: [{ ...state.panel!.choices[0]!, feedback: { fit: 'like' as const, familiarity: null, revision: 1 } }] } };
    await act(async () => { first.resolve(liked); await flush(); });
    expect(button('Like it').getAttribute('aria-pressed')).toBe('true');
    expect(button('New to me').getAttribute('aria-disabled')).toBeNull();
    await click('New to me');
    expect(port.feedback.mock.calls[1]![0]).toMatchObject({ fit: 'like', familiarity: 'new', expectedRevision: 1 });
    const both = { ...liked, revision: 5, panel: { ...liked.panel, choices: [{ ...liked.panel.choices[0]!, feedback: { fit: 'like' as const, familiarity: 'new' as const, revision: 2 } }] } };
    await act(async () => { second.resolve(both); await flush(); });
    expect(button('Like it').getAttribute('aria-pressed')).toBe('true');
    expect(button('New to me').getAttribute('aria-pressed')).toBe('true');
    expect(paidCalls()).toBe(0);
  });

  it('a failed save leaves feedback unselected, shows recovery and restores the controls without retry', async () => {
    const save = deferred<SafeSnapshot>(); port.feedback.mockReturnValue(save.promise);
    await boot(ready()); await click('Like it');
    expect(host.textContent).toContain('Saving…');
    await act(async () => { save.reject(new ApiError(0, 'timeout', null)); await flush(); });
    expect(button('Like it').getAttribute('aria-pressed')).toBe('false');
    expect(button('New to me').getAttribute('aria-disabled')).toBeNull();
    expect(host.textContent).toMatch(/did not get an answer in time/i);
    expect(port.feedback).toHaveBeenCalledTimes(1);
  });

  it('Clear removes a pending save and private recording immediately; a late feedback reply cannot restore either', async () => {
    const state = ready(), save = deferred<SafeSnapshot>(), clear = deferred<SafeSnapshot>();
    port.feedback.mockReturnValue(save.promise); port.clear.mockReturnValue(clear.promise);
    await boot(state); await click('Like it');
    await act(async () => { host.querySelector<HTMLButtonElement>('#menu-trigger')!.click(); await flush(); });
    await click('Clear session');
    expect(host.textContent).not.toContain('Invented Recording');
    expect(host.textContent).not.toContain('Saving…');
    await act(async () => { clear.resolve(blank()); save.resolve({ ...state, revision: 99 }); await flush(); });
    expect(host.textContent).not.toContain('Invented Recording');
    expect(host.textContent).not.toContain('A low line and a soft lead');
    expect(paidCalls()).toBe(0);
  });

  it('a known-expired save removes the recording and unsent draft while reconciliation is still waiting', async () => {
    const state = ready(), save = deferred<SafeSnapshot>(), read = deferred<SafeSnapshot>();
    port.feedback.mockReturnValue(save.promise);
    await boot(state);
    port.state.mockReturnValue(read.promise);
    await act(async () => { typeLink('https://youtu.be/bbbbbbbbbbb'); await flush(); });
    await click('Like it');
    await act(async () => { save.reject(new ApiError(410, 'session_expired', null)); await flush(); });
    expect(host.textContent).not.toContain('Invented Recording');
    expect(host.textContent).not.toContain('A low line and a soft lead');
    expect(host.querySelector<HTMLTextAreaElement>('#source-url')!.value).toBe('');
    expect(host.textContent).not.toContain('Saving…');
    await act(async () => { read.resolve({ ...state, revision: 99 }); await flush(); });
    expect(host.textContent).not.toContain('Invented Recording');
    expect(port.feedback).toHaveBeenCalledTimes(1);
    expect(paidCalls()).toBe(0);
  });

  it('an expired-session read wipes the unsent source and note on return', async () => {
    await boot(ready());
    await act(async () => { typeLink('https://youtu.be/bbbbbbbbbbb'); await flush(); });
    await act(async () => {
      const cue = host.querySelector<HTMLInputElement>('#source-cue')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(cue, 'An unsent invented cue');
      cue.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });
    expect(host.querySelector<HTMLInputElement>('#source-cue')!.value).toBe('An unsent invented cue');
    port.state.mockResolvedValue(blank({ code: 'session_expired' }));
    await act(async () => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); await flush(); });
    expect(host.querySelector<HTMLTextAreaElement>('#source-url')!.value).toBe('');
    expect(host.textContent).not.toContain('Invented Recording');
    expect(host.textContent).not.toContain('A low line and a soft lead');
    expect(host.textContent).not.toContain('An unsent invented cue');
    expect(paidCalls()).toBe(0);
  });
});

describe('saved relationship stays with its own work', () => {
  it.each(['discover', 'continue', 'refine'] as const)('keeps one readonly relationship during %s and removes it on Clear', async action => {
    const kind = action === 'refine' ? 'refine' : 'discover';
    const state = ready(kind === 'refine'), work = deferred<SafeSnapshot>();
    if (action === 'continue') Object.assign(state, { stage: 'awaiting_artist', identity: { handle: h('identity'), revision: 1, awaiting: true, slots: [] } });
    port[kind].mockReturnValue(work.promise);
    await boot(state);
    await click(action === 'continue' ? 'Continue discovery' : kind === 'discover' ? 'Discover connections' : 'Find fresh recordings');
    const contexts = host.querySelectorAll<HTMLElement>('[aria-label="Your choice"]');
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.textContent).toContain('A low line and a soft lead');
    expect(contexts[0]?.querySelector('button,input,textarea')).toBeNull();
    expect(button('Stop')).toBeTruthy();
    await act(async () => { host.querySelector<HTMLButtonElement>('#menu-trigger')!.click(); await flush(); });
    expect([...host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].some(b => b.textContent?.trim() === 'Stop' && !b.disabled)).toBe(true);
    await click('Clear session');
    await act(async () => { work.resolve({ ...state, revision: 20 }); await flush(); });
    expect(host.querySelector('[aria-label="Your choice"]')).toBeNull();
    expect(host.textContent).not.toContain('A low line and a soft lead');
    expect(port[kind]).toHaveBeenCalledTimes(1);
  });

  it('never carries the earlier relationship into analysis of a new reference', async () => {
    const work = deferred<SafeSnapshot>(); port.reference.mockReturnValue(work.promise);
    await boot(ready());
    await act(async () => { typeLink('https://youtu.be/bbbbbbbbbbb'); await flush(); });
    await click('Analyse reference');
    expect(port.reference).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[aria-label="Your choice"]')).toBeNull();
    await act(async () => { work.resolve(blank()); await flush(); });
  });
});

describe('a later result appends without replacing the unit being read', () => {
  it('does not infer an unknown original intent from the current correction', async () => {
    const base = ready();
    await boot({ ...base, brief: { ...base.brief!, handle: h('new-brief'), relationship: 'A different current cue' },
      panel: { ...base.panel!, intent: null } });
    expect(host.querySelector('[aria-label="Your choice"]')).toBeNull();
    expect(host.textContent).not.toContain('A different current cue');
    expect(paidCalls()).toBe(0);
  });

  it.each(['failed', 'cancelled'] as const)('keeps a newer admitted intent after old results on %s refinement, without a pre-admission duplicate', async stage => {
    const base = ready(), work = deferred<SafeSnapshot>();
    const state = { ...base, panel: { ...base.panel!, intent: base.brief } };
    port.refine.mockReturnValue(work.promise);
    await boot(state); await click('Find fresh recordings');
    expect(host.querySelectorAll('[aria-label="Your choice"]')).toHaveLength(1);
    const corrected = { ...base.brief!, handle: h('new-brief'), version: 2, relationship: 'A newer attempted cue' };
    await act(async () => { work.resolve({ ...state, revision: 5, stage, brief: corrected, refinement: { used: true }, code: stage === 'failed' ? 'catalogue_failed' : 'cancelled',
      attempt: { handle: h('refine-attempt'), kind: 'refine', active: false, outcome: stage === 'failed' ? 'failed' : 'cancelled' } }); await flush(); });
    const old = host.querySelector('[aria-label="Recording choices"]')!;
    expect(old.textContent).toContain(base.brief!.relationship);
    expect(old.textContent).not.toContain(corrected.relationship);
    const contexts = host.querySelectorAll('[aria-label="Your choice"]');
    expect(contexts).toHaveLength(2);
    expect(contexts[1]!.textContent).toContain(corrected.relationship);
    expect(old.compareDocumentPosition(contexts[1]!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(port.refine).toHaveBeenCalledTimes(1);
  });

  it('keeps each panel’s original musical intent instead of relabelling earlier results with the correction', async () => {
    const original = ready(), corrected = { ...original.brief!, handle: h('corrected-brief'), version: 2, relationship: 'A dry pulse under a hazy lead' };
    const first = { ...original.panel!, intent: original.brief };
    const second = { ...first, handle: h('corrected-panel'), intent: corrected, role: 'refinement' as const, mode: 'correct_direction' as const };
    await boot({ ...original, brief: corrected, panel: second, history: [first], refinement: { used: true } });
    const earlier = host.querySelector('[aria-label="Recording choices"]')!, later = host.querySelector('[aria-label="Refined recording choices"]')!;
    expect(earlier.textContent).toContain('A low line and a soft lead');
    expect(earlier.textContent).not.toContain(corrected.relationship);
    expect(later.textContent).toContain(corrected.relationship);
    expect(host.querySelectorAll('[aria-label="Your choice"]')).toHaveLength(2);
    expect(paidCalls()).toBe(0);
  });

  it('retains the old recording, open answer, source focus and Suggestions DOM across refinement', async () => {
    const base = ready(), work = deferred<SafeSnapshot>();
    const state = { ...base, panel: { ...base.panel!, answer: { text: 'Invented complete old answer.', marks: [] },
      citations: [{ title: 'Invented old source', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/invented', domain: 'invented.invalid' }],
      suggestionsUrl: `/api/suggestions/${base.panel!.handle}` } };
    port.refine.mockReturnValue(work.promise);
    await boot(state);
    const old = host.querySelector<HTMLElement>(`[data-result="${state.panel!.handle}"]`)!;
    const answer = old.querySelector<HTMLDetailsElement>('.panel-evidence')!;
    answer.open = true;
    const source = answer.querySelector<HTMLAnchorElement>('a')!;
    const frame = old.querySelector('iframe');
    await click('Find fresh recordings');
    act(() => source.focus());
    const next = { ...state.panel!, handle: h('refined-panel'), role: 'refinement' as const,
      choices: [{ ...state.panel!.choices[0]!, handle: h('refined-choice'), title: 'Invented Refined Recording' }] };
    await act(async () => { work.resolve({ ...state, revision: 4, panel: next, history: [state.panel!], refinement: { used: true } }); await flush(); });
    expect(host.querySelector(`[data-result="${state.panel!.handle}"]`)).toBe(old);
    expect(answer.open).toBe(true);
    expect(old.querySelector('iframe')).toBe(frame);
    expect(old.closest('details:not([open])')).toBeNull();
    expect(document.activeElement).toBe(source);
    expect(host.textContent).toContain('Invented Refined Recording');
    expect(port.refine).toHaveBeenCalledTimes(1);
  });

  it('Clear removes both retained units and their private disclosures before a late reply can act', async () => {
    const base = ready(), old = { ...base.panel!, handle: h('earlier-panel'), answer: { text: 'Invented earlier private answer.', marks: [] } };
    const state = { ...base, history: [old] };
    await boot(state);
    const retained = host.querySelector<HTMLDetailsElement>(`[data-result="${old.handle}"] details`)!;
    retained.open = true;
    await act(async () => { host.querySelector<HTMLButtonElement>('#menu-trigger')!.click(); await flush(); });
    await click('Clear session');
    expect(retained.isConnected).toBe(false);
    expect(host.querySelector('[data-result]')).toBeNull();
    expect(host.textContent).not.toContain('Invented earlier private answer');
  });

  it('a different owned session with reused handles receives fresh disclosure state', async () => {
    const state = ready(); await boot(state);
    const old = host.querySelector<HTMLElement>(`[data-result="${state.panel!.handle}"]`)!;
    old.querySelector<HTMLDetailsElement>('details')!.open = true;
    port.state.mockResolvedValue({ ...state, session: { ...state.session!, context: 'different-invented-session' } });
    await act(async () => { window.dispatchEvent(new Event('pageshow')); await flush(); });
    const current = host.querySelector<HTMLElement>(`[data-result="${state.panel!.handle}"]`)!;
    expect(current).not.toBe(old); expect(old.isConnected).toBe(false);
    expect(current.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
  });

  it('a retained unit obeys a later source-unavailable projection instead of keeping old source DOM', async () => {
    const state = ready(), work = deferred<SafeSnapshot>();
    port.refine.mockReturnValue(work.promise); await boot(state);
    const old = host.querySelector<HTMLElement>(`[data-result="${state.panel!.handle}"]`)!;
    old.querySelector<HTMLDetailsElement>('details')!.open = true;
    await click('Find fresh recordings');
    const hidden = { ...state.panel!, outcome: 'source_unavailable' as const, choices: [], answer: { text: '', marks: [] }, citations: [], suggestionsUrl: null, gaps: [] };
    const next = { ...state.panel!, handle: h('next-panel'), choices: [{ ...state.panel!.choices[0]!, title: 'Invented New Recording' }] };
    await act(async () => { work.resolve({ ...state, revision: 8, history: [hidden], panel: next, refinement: { used: true } }); await flush(); });
    expect(old.isConnected).toBe(true);
    expect(old.querySelector('article,details,iframe,a')).toBeNull();
    expect(old.textContent).toContain('hidden because');
    expect(host.textContent).not.toContain('Invented Recording');
  });
});

function candidateReady(): SafeSnapshot {
  const state = ready();
  return { ...state, panel: { ...state.panel!, intent: state.brief, catalogueMode: 'first_party_candidates',
    choices: [{ ...state.panel!.choices[0]!, service: 'apple_music',
      playUrl: 'https://music.apple.com/us/song/9000000001', identityEvidence: 'first_party_catalogue',
      fitHypothesis: 'An invented <strong>possibility</strong>, not heard.' }],
    answer: { text: 'An invented catalogue summary, not a Google answer.', marks: [] },
  } };
}

describe('candidate catalogue through the actual App', () => {
  it.each(['Open chats and privacy', 'Add music', 'Why this connection'])('keeps a failed Stop notice inside %s without moving focus or retrying', async opener => {
    const work = deferred<SafeSnapshot>(), stopped = deferred<SafeSnapshot>();
    port.refine.mockReturnValue(work.promise); port.stop.mockReturnValue(stopped.promise);
    await boot({ ...candidateReady(), connection: { synthetic: true, seeds: ['Invented Seed'], artists: ['Invented Neighbour'],
      anchors: [{ handle: h('anchor'), name: 'Invented Neighbour' }], tags: [], capability: 'artists_only', attribution: 'seed_mix', why: ['An invented connection.'] } });
    await click('Find fresh recordings'); await click(opener);
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const stop = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === 'Stop')!;
    await act(async () => { stop.click(); await flush(); });
    expect(document.activeElement).toBe(dialog);
    await act(async () => { stopped.reject(new Error('invented Stop failure')); await flush(); });
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Something went wrong.');
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(document.activeElement).toBe(dialog);
    expect(port.stop).toHaveBeenCalledTimes(1);
    expect(port.refine).toHaveBeenCalledTimes(1);
    if (opener !== 'Open chats and privacy') { await click('Close'); await click('Open chats and privacy'); }
    await click('Clear session');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { work.resolve(candidateReady()); await flush(); });
    expect(host.textContent).not.toContain('Invented Recording');
  });

  it('shows the exact destination and catalogue evidence without native Google source UI or interpreted markup', async () => {
    await boot(candidateReady());
    const panel = host.querySelector<HTMLElement>('[aria-label="Recording choices"]')!;
    const article = panel.querySelector('article')!;
    const destination = article.querySelector<HTMLAnchorElement>('a')!;
    expect(destination.href).toBe('https://music.apple.com/us/song/9000000001');
    expect(destination.target).toBe('_blank');
    expect(destination.rel).toMatch(/noopener/);
    expect(destination.rel).toMatch(/noreferrer/);
    expect(panel.textContent).toContain('Synthetic recordings from a local fixture');
    expect(panel.textContent).toContain('Identity checked against Apple’s catalogue search and exact song lookup.');
    expect(panel.querySelector('.panel-evidence > summary')!.textContent).toBe('How these were selected');
    expect(panel.textContent).toContain('this is not a Google Search answer');
    expect(panel.querySelector('.panel-evidence')!.textContent).toContain('An invented catalogue summary, not a Google answer.');
    expect(panel.textContent).not.toContain('Full answer and sources');
    expect(panel.querySelector('.sources,iframe')).toBeNull();
    expect(article.textContent).toContain('<strong>possibility</strong>');
    expect(article.querySelector('strong')).toBeNull();
    expect(paidCalls()).toBe(0);
  });

  it('appends a refined candidate unit without replacing the open initial summary or its original intent', async () => {
    const state = candidateReady(), work = deferred<SafeSnapshot>();
    port.refine.mockReturnValue(work.promise); await boot(state);
    const earlier = host.querySelector<HTMLElement>('[aria-label="Recording choices"]')!;
    const summary = earlier.querySelector<HTMLDetailsElement>('.panel-evidence')!;
    summary.open = true;
    const recordingDetails = earlier.querySelector<HTMLDetailsElement>('.choice-details')!;
    recordingDetails.open = true;
    const corrected = { ...state.brief!, handle: h('candidate-brief2'), version: 2, source: 'listener_text' as const,
      relationship: 'A dry pulse beneath an airy lead' };
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('[aria-label="Refined search"] input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, corrected.relationship);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });
    await click('Try this direction');
    expect(port.refine.mock.calls[0]![0]).toMatchObject({ mode: 'correct_direction', panel: state.panel!.handle,
      brief: state.brief!.handle, relationship: { text: corrected.relationship } });
    const next = { ...state.panel!, handle: h('candidate-panel2'), intent: corrected, role: 'refinement' as const,
      mode: 'correct_direction' as const, choices: [{ ...state.panel!.choices[0]!, handle: h('candidate-choice2'),
        title: 'Invented Refined Candidate', playUrl: 'https://music.apple.com/us/song/9000000002' }] };
    await act(async () => { work.resolve({ ...state, revision: 4, brief: corrected, panel: next,
      history: [state.panel!], refinement: { used: true } }); await flush(); });
    expect(host.querySelector('[aria-label="Recording choices"]')).toBe(earlier);
    expect(earlier.querySelector('.panel-evidence')).toBe(summary);
    expect(summary.isConnected).toBe(true);
    expect(summary.open).toBe(true);
    expect(summary.textContent).toContain(state.panel!.answer.text);
    expect(earlier.querySelector('.choice-details')).toBe(recordingDetails);
    expect(recordingDetails.open).toBe(true);
    expect(recordingDetails.textContent).toContain('Identity checked against Apple’s catalogue search and exact song lookup.');
    expect(earlier.textContent).toContain(state.brief!.relationship);
    expect(earlier.textContent).not.toContain(corrected.relationship);
    const later = host.querySelector<HTMLElement>('[aria-label="Refined recording choices"]')!;
    expect(later.textContent).toContain(corrected.relationship);
    expect(later.querySelector('a')!.getAttribute('href')).toBe('https://music.apple.com/us/song/9000000002');
    expect(host.querySelectorAll('.sources,iframe')).toHaveLength(0);
    expect(host.textContent).toContain('Refinement used.');
    expect(port.refine).toHaveBeenCalledTimes(1);
  });

  it('retains a correction draft after an unadmitted network failure and wipes it on Clear', async () => {
    const state = candidateReady(), work = deferred<SafeSnapshot>();
    port.refine.mockReturnValue(work.promise); await boot(state);
    const correction = 'Keep the airy lead over a dry pulse';
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('[aria-label="Refined search"] input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, correction);
      input.dispatchEvent(new Event('input', { bubbles: true })); await flush();
    });
    await click('Try this direction');
    await act(async () => { work.reject(new Error('invented network failure')); await flush(); });
    expect(host.querySelector<HTMLInputElement>('[aria-label="Refined search"] input')?.value).toBe(correction);
    await act(async () => { host.querySelector<HTMLButtonElement>('#menu-trigger')!.click(); await flush(); });
    await click('Clear session');
    expect(host.querySelector('[aria-label="Refined search"]')).toBeNull();
  });

  it.each(['Stop', 'Clear session'] as const)('keeps modal %s actionable during candidate work and rejects its late completion', async control => {
    const state = candidateReady(), work = deferred<SafeSnapshot>();
    port.refine.mockReturnValue(work.promise);
    port.stop.mockResolvedValue({ ...state, stage: 'cancelled', revision: 4, code: 'cancelled',
      attempt: { handle: h('candidate-attempt'), kind: 'refine', active: false, outcome: 'cancelled' } });
    await boot(state); await click('Find fresh recordings');
    await click('Add music');
    const sheet = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const action = [...sheet.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === control)!;
    expect(action).toBeTruthy();
    expect(action.disabled).toBe(false);
    expect(host.querySelector('.app')!.hasAttribute('inert')).toBe(true);
    await act(async () => { action.click(); await flush(); });
    if (control === 'Stop') expect(port.stop).toHaveBeenCalledTimes(1);
    else {
      expect(port.clear).toHaveBeenCalledTimes(1);
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      expect(host.textContent).not.toContain('Invented Recording');
    }
    const late = { ...state.panel!, handle: h('late-candidate-panel'), role: 'refinement' as const,
      choices: [{ ...state.panel!.choices[0]!, handle: h('late-candidate-choice'), title: 'Invented Late Candidate' }] };
    await act(async () => { work.resolve({ ...state, revision: 99, panel: late, history: [state.panel!],
      refinement: { used: true } }); await flush(); });
    expect(host.textContent).not.toContain('Invented Late Candidate');
    if (control === 'Stop') expect(host.textContent).toContain('Invented Recording');
    expect(port.refine).toHaveBeenCalledTimes(1);
  });
});

describe('actual App result targeting over controlled geometry', () => {
  // jsdom does not lay out text. These boxes stand for a long response, not a
  // claim that the first recording is visible on a real phone or at 200% zoom.
  function geometry() {
    const scroller = document.documentElement;
    const previous = ['clientHeight', 'scrollHeight'].map(key => [key, Object.getOwnPropertyDescriptor(scroller, key)] as const);
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 852 });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 3252 });
    scroller.scrollTop = 100;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.hasAttribute('data-result') ? 700 - scroller.scrollTop + 16 : 0;
      return { top, bottom: top + 1200, left: 0, right: 378, width: 378, height: 1200, x: 0, y: top, toJSON() {} };
    });
    return { scroller, restore: () => {
      rect.mockRestore(); scroller.scrollTop = 0;
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(scroller, key, descriptor);
        else Reflect.deleteProperty(scroller, key);
      }
    } };
  }

  it.each(['choices', 'no_match', 'source_unavailable'] as const)('an eligible %s result opens at its actual start, above a long footer', async outcome => {
    const g = geometry();
    try {
      const state = ready(false), work = deferred<SafeSnapshot>();
      port.discover.mockReturnValue(work.promise); await boot(state);
      await click('Discover connections');
      g.scroller.scrollTop = 1762;
      const panel = ready().panel!;
      await act(async () => { work.resolve({ ...state, stage: 'complete', revision: 7,
        panel: { ...panel, outcome, ...(outcome === 'choices' ? {} : { choices: [], answer: { text: '', marks: [] }, citations: [], suggestionsUrl: null }) } }); await flush(); });
      expect(g.scroller.scrollTop).toBe(700);
      expect(host.querySelector(`[data-result="${panel.handle}"]`)).not.toBeNull();
      expect(host.textContent).not.toContain('New answer');
      expect(port.discover).toHaveBeenCalledTimes(1);
    } finally { g.restore(); }
  });

  it('restoring a complete panel never follows it or pins an unmeasured reader to its footer', async () => {
    const g = geometry();
    try {
      await boot(ready());
      expect(g.scroller.scrollTop).toBe(100);
      expect(host.textContent).not.toContain('New answer');
    } finally { g.restore(); }
  });

  it('switching back to an already-read chat preserves its saved reading position after all result effects', async () => {
    const g = geometry(), A = h('reading-chat-a'), B = h('reading-chat-b');
    const scrollTop = Object.getOwnPropertyDescriptor(g.scroller, 'scrollTop');
    let y = 100;
    const max = () => host.querySelector('[data-result]') ? 2400 : 0;
    Object.defineProperty(g.scroller, 'scrollHeight', { configurable: true, get: () => max() + 852 });
    Object.defineProperty(g.scroller, 'scrollTop', { configurable: true, get: () => { y = Math.min(y, max()); return y; }, set: value => { y = Math.max(0, Math.min(value, max())); } });
    const owner = ready().session;
    const items = [A, B].map((handle, i) => ({ handle, title: `Invented reading chat ${i}`, createdAt: 1000, revision: 0 }));
    const state = (chat: Handle): SafeSnapshot => ({ ...ready(), session: owner, chats: { current: chat, revision: 0, items }, panel: { ...ready().panel!, handle: chat, choices: ready().panel!.choices.map(c => ({ ...c, title: `Invented recording ${chat}` })) } });
    const reads: { chat: Handle; reply: ReturnType<typeof deferred<SafeSnapshot>> }[] = [];
    port.readChat.mockImplementation(chat => { const reply = deferred<SafeSnapshot>(); reads.push({ chat, reply }); return reply.promise; });
    const switchTo = async (index: number) => {
      await click('Open chats and privacy'); await click(`Invented reading chat ${index}`);
      const pending = reads.at(-1)!;
      await act(async () => { pending.reply.resolve(state(pending.chat)); await flush(); });
    };
    try {
      await boot(state(A));
      await switchTo(1);
      act(() => { g.scroller.scrollTop = 600; window.dispatchEvent(new Event('scroll')); });
      await switchTo(0);
      await switchTo(1);
      expect(g.scroller.scrollTop).toBe(600); expect(paidCalls()).toBe(0);
    } finally { if (scrollTop) Object.defineProperty(g.scroller, 'scrollTop', scrollTop); else Reflect.deleteProperty(g.scroller, 'scrollTop'); g.restore(); }
  });

  it('a wheel/scroll away during work keeps the reader in place until New answer is chosen', async () => {
    const g = geometry();
    try {
      const state = ready(false), work = deferred<SafeSnapshot>();
      port.discover.mockReturnValue(work.promise); await boot(state); await click('Discover connections');
      act(() => { window.dispatchEvent(new Event('wheel')); g.scroller.scrollTop = 200; window.dispatchEvent(new Event('scroll')); });
      await act(async () => { work.resolve({ ...state, stage: 'complete', revision: 7, panel: ready().panel }); await flush(); });
      expect(g.scroller.scrollTop).toBe(200);
      expect(button('New answer')).toBeTruthy();
      await click('New answer'); expect(g.scroller.scrollTop).toBe(700);
    } finally { g.restore(); }
  });
});
