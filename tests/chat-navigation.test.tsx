// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useChatPageMotion } from '../src/client/chat-navigation.js';
import { chatFromLocation, writeChatLocation } from '../src/client/chat-history.js';
import type { Handle } from '../src/shared/records.js';
import { FakeFrames } from './fixtures/fake-frames.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });
function setup() {
  const frames = new FakeFrames();
  vi.spyOn(performance, 'now').mockImplementation(() => frames.now());
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.raf(() => cb(frames.now())));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.caf(id));
  const reduced = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', () => reduced);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const scroll = document.documentElement, oldScroll = scroll.scrollTop;
  let begin = (_back = false) => {};
  function Fixture({ page, revoked = false, wipe = 0 }: { page: string; revoked?: boolean; wipe?: number }) {
    const main = useRef<HTMLElement>(null);
    begin = useChatPageMotion(main, page, revoked, wipe).begin;
    return <main ref={main} id="invented-main"><h1 tabIndex={-1} data-chat-heading>{revoked ? 'Revoked' : `Invented page ${page}`}</h1><div id="invented-result" data-result="invented-private-result">Invented content</div><iframe title="Invented Suggestions" src="/api/suggestions/invented" /></main>;
  }
  const render = (page: string, revoked = false, wipe = 0) => act(() => root.render(<Fixture page={page} revoked={revoked} wipe={wipe} />));
  cleanups.push(() => { act(() => root.unmount()); host.remove(); scroll.scrollTop = oldScroll; expect(document.querySelector('.chat-page-ghost')).toBeNull(); expect(frames.queue.size).toBe(0); });
  render('A');
  return { frames, reduced, host, render, begin: (back = false) => act(() => begin(back)), scroll };
}

it('overlaps220ms outgoing/incoming without live controls, media reloads or duplicate anchors in the picture', () => {
  const f = setup(); f.scroll.scrollTop = 120; f.begin();
  const ghost = document.querySelector<HTMLElement>('.chat-page-ghost')!;
  expect(ghost).not.toBeNull(); expect(ghost.getAttribute('aria-hidden')).toBe('true'); expect(ghost.inert).toBe(true);
  expect(ghost.querySelector('[id], [data-result], iframe, img')).toBeNull();
  f.render('B'); expect(f.scroll.scrollTop).toBe(0);
  expect(document.activeElement).toBe(f.host.querySelector('h1'));
  expect(f.host.querySelector('main')!.style.transform).toBe('translateX(12px)');
  act(() => f.frames.step(110));
  expect(Number(ghost.style.opacity)).toBeGreaterThan(0); expect(Number(ghost.style.opacity)).toBeLessThan(1);
  act(() => f.frames.step(110));
  expect(document.querySelector('.chat-page-ghost')).toBeNull(); expect(f.host.querySelector('main')!.style.opacity).toBe('1');
  expect(f.frames.queue.size).toBe(0);
});

it('Back mirrors the12px direction and restores the authorised chat reading position', () => {
  const f = setup(); f.scroll.scrollTop = 180; f.begin(); f.render('B'); act(() => f.frames.step(220));
  f.scroll.scrollTop = 45; f.begin(true); f.render('A');
  expect(f.scroll.scrollTop).toBe(180); expect(f.host.querySelector('main')!.style.transform).toBe('translateX(-12px)');
  act(() => f.frames.step(220)); expect(f.frames.queue.size).toBe(0);
});

it.each(['revocation', 'wipe', 'hidden', 'reduced'] as const)('removes outgoing private picture immediately on %s', kind => {
  const f = setup(); f.begin(); expect(document.querySelector('.chat-page-ghost')).not.toBeNull();
  if (kind === 'revocation') f.render('A', true);
  else if (kind === 'wipe') f.render('A', false, 1);
  else if (kind === 'hidden') { vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); act(() => document.dispatchEvent(new Event('visibilitychange'))); }
  else { f.reduced.matches = true; for (const call of f.reduced.addEventListener.mock.calls as unknown[][]) if (typeof call[1] === 'function') act(() => (call[1] as () => void)()); }
  expect(document.querySelector('.chat-page-ghost')).toBeNull(); expect(f.frames.queue.size).toBe(0);
});

it('reduced navigation keeps focus and reading behavior without a frame or outgoing picture', () => {
  const f = setup(); f.reduced.matches = true; f.begin(); f.render('B');
  expect(document.querySelector('.chat-page-ghost')).toBeNull(); expect(f.frames.queue.size).toBe(0);
  expect(document.activeElement).toBe(f.host.querySelector('h1')); expect(f.host.querySelector('main')!.style.opacity).toBe('1');
});

it('history serialises only a canonical opaque selector and rejects ambiguous/malformed selectors', () => {
  const chat = 'a'.repeat(24) as Handle;
  writeChatLocation(chat); expect(chatFromLocation()).toBe(chat); expect(window.history.state).toBeNull();
  expect(window.location.search).toBe('?chat=' + chat);
  writeChatLocation(null, true); expect(chatFromLocation()).toBeNull();
  for (const value of ['?chat=bad', '?chat=' + chat + '&chat=' + chat, '?chat=%3Cscript%3E']) { window.history.replaceState(null, '', '/' + value); expect(chatFromLocation()).toBeNull(); }
});
