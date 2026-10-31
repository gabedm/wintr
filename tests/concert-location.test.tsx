// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConcertLocationPicker } from '../src/client/ConcertLocationPicker.js';
import { createCityIndex, type CityIndex } from '../src/client/city-index.js';
import { ConcertsScreen, type ConcertClient } from '../src/client/ConcertsScreen.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const data = { version: 1, countries: { GB: 'UK', CA: 'Canada', US: 'United States', FR: 'France' }, regions: { 'GB.ENG': 'England', 'CA.08': 'Ontario', 'US.CA': 'California', 'FR.11': 'Île-de-France' }, cities: [[1, 'London', '', 'GB', 'ENG', 9000000], [2, 'London', '', 'CA', '08', 400000], [3, 'Long Beach', '', 'US', 'CA', 450000], [4, 'Paris', '', 'FR', '11', 2000000]] };
const index = createCityIndex(data), empty = { city: null, countryCode: null, label: '' };
let host: HTMLDivElement, root: Root;
const flush = async () => { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); };
const click = async (name: string) => { const b = [...host.querySelectorAll<HTMLButtonElement>('button')].find(e => e.getAttribute('aria-label') === name || e.textContent === name)!; expect(b).toBeTruthy(); await act(async () => b.click()); await flush(); };
const type = async (value: string) => { const f = host.querySelector('input')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(f, value); f.dispatchEvent(new Event('input', { bubbles: true })); }); await flush(); };
const key = async (key: string, isComposing = false) => { const event = new KeyboardEvent('keydown', { key, isComposing, bubbles: true, cancelable: true }); await act(async () => host.querySelector('input')!.dispatchEvent(event)); await flush(); return event; };
const choose = async (label: string) => { const option = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(e => e.querySelector('strong')?.textContent === label)!; expect(option).toBeTruthy(); await act(async () => option.click()); await flush(); };
const draw = async (load = vi.fn(async () => index)) => { const apply = vi.fn(), cancel = vi.fn(); act(() => root.render(<ConcertLocationPicker value={empty} disabled={false} onApply={apply} onCancel={cancel} load={load}/>)); await flush(); return { apply, cancel, load }; };
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('shows country-labelled suggestions while typing, and commits the canonical city/country only on Done', async () => {
  const { apply, load } = await draw(); await type('lon'); expect(host.querySelectorAll('[role="option"]')).toHaveLength(3); expect(host.textContent).toContain('London, UK'); expect(host.textContent).toContain('London, Canada'); expect(apply).not.toHaveBeenCalled();
  await choose('London, Canada'); expect(host.querySelector<HTMLInputElement>('input')!.value).toBe('London, Canada'); expect(host.querySelector('[role="listbox"]')).toBeNull(); expect(apply).not.toHaveBeenCalled(); await click('Done'); expect(apply).toHaveBeenCalledExactlyOnceWith({ city: 'London', countryCode: 'CA', label: 'London, Canada' }); expect(load).toHaveBeenCalledOnce();
});
it('uses arrows/Enter to choose without submitting; IME and first Escape never commit a suggestion', async () => {
  const { apply, cancel } = await draw(); await type('lon'); await key('Enter', true); expect(apply).not.toHaveBeenCalled(); expect(host.querySelector('input')!.value).toBe('lon');
  await key('ArrowDown'); expect(host.querySelector('input')!.getAttribute('aria-activedescendant')).toBe(host.querySelector('[aria-selected="true"]')?.id); await key('Enter'); expect(host.querySelector('input')!.value).toBe('London, UK'); expect(apply).not.toHaveBeenCalled();
  await type('par'); await key('Escape'); expect(cancel).not.toHaveBeenCalled(); expect(host.querySelector('[role="listbox"]')).toBeNull(); await key('Escape'); expect(cancel).toHaveBeenCalledOnce(); expect(apply).not.toHaveBeenCalled();
});
it('drops stale country metadata after editing a selection and can clear the location', async () => {
  const { apply } = await draw(); await type('london'); await choose('London, UK'); await type('Tiny Unlisted Village'); await click('Done'); expect(apply).toHaveBeenLastCalledWith({ city: 'Tiny Unlisted Village', countryCode: null, label: 'Tiny Unlisted Village' });
  await click('Clear location'); await click('Done'); expect(apply).toHaveBeenLastCalledWith(empty);
});
it('uses the latest draft after a slow index load and ignores a late load after unmount', async () => {
  let ready!: (index: CityIndex) => void; const load = vi.fn((_signal: AbortSignal) => new Promise<CityIndex>(yes => { ready = yes; })); const apply = vi.fn();
  act(() => root.render(<ConcertLocationPicker value={empty} disabled={false} onApply={apply} onCancel={() => {}} load={load}/>)); await type('lon'); await type('par'); await act(async () => ready(index)); await flush(); expect(host.textContent).toContain('Paris, France'); expect(host.textContent).not.toContain('London, UK'); expect(apply).not.toHaveBeenCalled();
  act(() => root.render(<div/>)); expect(load.mock.calls[0]![0].aborted).toBe(true);
});
it('allows manual city entry if the local index is unavailable, with no hidden provider lookup', async () => {
  const { apply, load } = await draw(vi.fn(async () => { throw Error('invented local asset failure'); })); await type('Unlisted city'); expect(host.textContent).toContain('City suggestions couldn’t load.'); await click('Done'); expect(apply).toHaveBeenCalledExactlyOnceWith({ city: 'Unlisted city', countryCode: null, label: 'Unlisted city' }); expect(load).toHaveBeenCalledOnce();
});
it('passes the newly selected city and country through the real Concerts screen exactly once and discards cancelled drafts', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(data) })));
  const client: ConcertClient = { capability: async () => true, search: vi.fn(async () => ({ events: [], incomplete: false, checkedAt: Date.now() })) };
  const song = { url: 'https://music.apple.com/us/song/12345', service: 'apple_music' as const, title: 'Invented song', artists: ['Invented artist'], foundAt: Date.now() };
  act(() => root.render(<ConcertsScreen songs={[song]} active revoked={false} scopeKey="invented" getScope={() => 'invented'} ensureSession={async () => true} client={client}/>)); await flush(); expect(client.search).toHaveBeenCalledOnce(); await click('Location⌄'); await type('lon'); await choose('London, UK'); expect(client.search).toHaveBeenCalledOnce(); await click('Done');
  expect(client.search).toHaveBeenCalledOnce(); expect(vi.mocked(client.search).mock.calls[0]![0]).toMatchObject({ city: null, to: null }); expect(vi.mocked(client.search).mock.calls[0]![0]).not.toHaveProperty('countryCode'); expect(document.activeElement).toBe(host.querySelector('.concert-filters button')); expect(host.querySelector('.concert-filters button')!.textContent).toBe('London, UK⌄');
  await click('London, UK⌄'); await type('par'); await key('Escape'); await key('Escape'); expect(client.search).toHaveBeenCalledOnce(); expect(host.querySelector('.concert-filters button')!.textContent).toBe('London, UK⌄');
});
it.each(['Done','Clear location'])('dismisses the location editor from the %s footer control on Escape without applying',async name=>{
 const {apply,cancel}=await draw();const target=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===name)!;target.focus();const event=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});await act(async()=>target.dispatchEvent(event));await flush();expect(event.defaultPrevented).toBe(true);expect(cancel).toHaveBeenCalledOnce();expect(apply).not.toHaveBeenCalled();
});
