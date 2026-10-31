// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ConcertCalendar, type ConcertDates } from '../src/client/ConcertCalendar.js';
import { ConcertsScreen, type ConcertClient } from '../src/client/ConcertsScreen.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const flush = async () => { await act(async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); }); };
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === name || b.textContent === name)!;
const click = async (name: string) => { expect(button(name)).toBeTruthy(); await act(async () => button(name).click()); await flush(); };
const day = async (date: string) => { const b = host.querySelector<HTMLButtonElement>(`[data-date="${date}"]`)!; expect(b).toBeTruthy(); expect(b.disabled).toBe(false); await act(async () => b.click()); await flush(); };
const key = async (key: string, shiftKey = false) => { const e = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }); await act(async () => document.activeElement!.dispatchEvent(e)); await flush(); return e; };
const draw = (value: ConcertDates = { from: '2026-10-31', to: null }, minDate = '2026-10-31') => { const apply = vi.fn(), cancel = vi.fn(); act(() => root.render(<ConcertCalendar value={value} minDate={minDate} disabled={false} onApply={apply} onCancel={cancel}/>)); return { apply, cancel }; };
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
it('applies one chosen day as an exact date rather than an open-ended search', async () => {
  const { apply } = draw(); expect(document.activeElement?.getAttribute('data-date')).toBe('2026-10-31'); expect(host.querySelector('input[type="date"]')).toBeNull(); expect(button('Previous month').disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('[data-date="2026-10-30"]')!.disabled).toBe(true); await click('Next month'); await day('2026-11-02'); expect(apply).not.toHaveBeenCalled();
  await click('Apply'); expect(apply).toHaveBeenCalledExactlyOnceWith({ from: '2026-11-02', to: '2026-11-02' });
});
it('selects an inclusive range across months with reversible endpoints', async () => {
  const { apply } = draw({ from: '2026-11-02', to: null }); await day('2026-11-02'); await click('Previous month'); await day('2026-10-31');
  expect(host.querySelector('[data-date="2026-10-31"]')?.closest('td')?.getAttribute('data-range')).toBe('start'); await click('Next month');
  expect(host.querySelector('[data-date="2026-11-01"]')?.closest('td')?.getAttribute('aria-selected')).toBe('true'); expect(host.querySelector('[data-date="2026-11-02"]')?.closest('td')?.getAttribute('data-range')).toBe('end');
  await click('Apply'); expect(apply).toHaveBeenCalledExactlyOnceWith({ from: '2026-10-31', to: '2026-11-02' });
});
it('starts fresh on the third tap and Clear restores upcoming dates', async () => {
  const { apply } = draw({ from: '2026-11-02', to: '2026-11-05' }); await day('2026-11-09'); await day('2026-11-12'); await day('2026-11-18'); expect(host.querySelectorAll('td[aria-selected="true"]')).toHaveLength(1);
  await click('Apply'); expect(apply).toHaveBeenLastCalledWith({ from: '2026-11-18', to: '2026-11-18' }); await click('Clear'); await click('Apply'); expect(apply).toHaveBeenLastCalledWith({ from: '2026-10-31', to: null });
});
it('keeps keyboard navigation local with one grid tab stop and Escape cancellation', async () => {
  const { apply, cancel } = draw(); expect(host.querySelectorAll('.calendar-day[tabindex="0"]')).toHaveLength(1); expect((await key('ArrowRight')).defaultPrevented).toBe(true); expect(document.activeElement?.getAttribute('data-date')).toBe('2026-11-01');
  await key('ArrowDown'); expect(document.activeElement?.getAttribute('data-date')).toBe('2026-11-08'); await key('End'); expect(document.activeElement?.getAttribute('data-date')).toBe('2026-11-14'); await key('Home'); expect(document.activeElement?.getAttribute('data-date')).toBe('2026-11-08');
  await key('Escape'); expect(cancel).toHaveBeenCalledOnce(); expect(apply).not.toHaveBeenCalled();
});
it('clamps month navigation to real dates including leap day and year rollover', async () => {
  draw({ from: '2028-01-31', to: null }, '2027-12-01'); await key('PageDown'); expect(document.activeElement?.getAttribute('data-date')).toBe('2028-02-29'); await key('PageDown', true); expect(document.activeElement?.getAttribute('data-date')).toBe('2029-02-28');
  await key('PageUp', true); expect(document.activeElement?.getAttribute('data-date')).toBe('2028-02-28'); await key('PageUp'); await key('PageUp'); expect(document.activeElement?.getAttribute('data-date')).toBe('2027-12-28');
});
it('rejects ranges over 366 days without losing the first date or sending a request', async () => {
  const { apply } = draw({ from: '2026-11-02', to: null }); await day('2026-11-02'); for (let i = 0; i < 13; i++) await click('Next month'); await day('2027-12-02'); expect(host.querySelector('[role="alert"]')?.textContent).toBe('Choose a range up to a year.'); expect(button('Apply').disabled).toBe(true); await click('Apply'); expect(apply).not.toHaveBeenCalled();
  await click('Previous month'); await day('2027-11-02'); await click('Apply'); expect(apply).toHaveBeenCalledExactlyOnceWith({ from: '2026-11-02', to: '2027-11-02' });
});
it('applies the latest range locally, returns focus, and cancels further drafts without another lookup', async () => {
  const client: ConcertClient = { capability: async () => true, search: vi.fn(async () => ({ events: [], incomplete: false, checkedAt: Date.now() })) };
  const song = { url: 'https://music.apple.com/us/song/12345', service: 'apple_music' as const, title: 'Invented', artists: ['Invented artist'], foundAt: Date.now() };
  act(() => root.render(<ConcertsScreen songs={[song]} active revoked={false} scopeKey="invented" getScope={() => 'invented'} ensureSession={async () => true} client={client}/>)); await flush(); expect(client.search).toHaveBeenCalledOnce(); await click('Dates⌄'); await click('Next month');
  const month = host.querySelector('.calendar-day')!.getAttribute('data-date')!.slice(0, 7); await day(`${month}-02`); await day(`${month}-05`); expect(client.search).toHaveBeenCalledOnce(); await click('Apply'); expect(client.search).toHaveBeenCalledOnce();
  expect(vi.mocked(client.search).mock.calls[0]![0]).toEqual({ artists: song.artists, city: null, from: expect.any(String), to: null }); expect(host.querySelector('.concert-calendar')).toBeNull(); expect(document.activeElement).toBe(host.querySelectorAll('.concert-filters button')[1]);
  await act(async () => host.querySelectorAll<HTMLButtonElement>('.concert-filters button')[1]!.click()); await flush(); await day(`${month}-10`); await key('Escape'); expect(client.search).toHaveBeenCalledOnce(); expect(host.querySelectorAll('.concert-filters button')[1]!.textContent).not.toContain('10');
});
it('does not let late capability submit an unfinished calendar draft', async () => {
  let ready!: (value: boolean) => void;
  const client: ConcertClient = { capability: () => new Promise<boolean>(resolve => { ready = resolve; }), search: vi.fn(async () => ({ events: [], incomplete: false, checkedAt: Date.now() })) };
  const song = { url: 'https://music.apple.com/us/song/12345', service: 'apple_music' as const, title: 'Invented', artists: ['Invented artist'], foundAt: Date.now() };
  act(() => root.render(<ConcertsScreen songs={[song]} active revoked={false} scopeKey="invented" getScope={() => 'invented'} ensureSession={async () => true} client={client}/>)); await flush(); await click('Dates⌄'); expect(button('Apply').disabled).toBe(false); await click('Next month');
  const month = host.querySelector('.calendar-day')!.getAttribute('data-date')!.slice(0, 7); await day(`${month}-05`); await act(async () => ready(true)); await flush(); expect(client.search).toHaveBeenCalledOnce(); expect(host.querySelector('.concert-calendar')).not.toBeNull();
  await click('Apply'); expect(client.search).toHaveBeenCalledExactlyOnceWith({ artists: song.artists, city: null, from: expect.any(String), to: null }, expect.any(AbortSignal));
});
