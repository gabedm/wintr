// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LibraryScreen, MobileNavigation, RecentSongs } from '../src/client/mobile-views.js';
import { ConcertsScreen, type ConcertClient } from '../src/client/ConcertsScreen.js';
import type { ConcertReply } from '../src/shared/concerts.js';
import type { SavedSong } from '../src/shared/saved-song.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const song: SavedSong = { url:'https://music.apple.com/us/song/12345',service:'apple_music',title:'Invented song',artists:['Invented artist'],foundAt:Date.now() };
const other: SavedSong = { ...song,url:'https://music.apple.com/us/song/23456',title:'Another recording',artists:['Other artist'] };
let host: HTMLDivElement, root: Root;
const flush = async () => { await act(async () => { for(let i=0;i<15;i++) await Promise.resolve(); }); };
const click = async (name: string) => { const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.getAttribute('aria-label')===name||b.textContent===name)!; expect(button).toBeTruthy(); await act(async()=>button.click()); await flush(); };
const input = async (field: HTMLInputElement, text: string) => { await act(async()=>{ Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,text); field.dispatchEvent(new Event('input',{bubbles:true})); }); };
beforeEach(()=>{host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.restoreAllMocks();});
it('keeps exactly three labelled, current navigation controls and no search tab',()=>{const select=vi.fn(); act(()=>root.render(<MobileNavigation tab="library" onSelect={select}/>)); expect([...host.querySelectorAll('button')].map(b=>b.textContent)).toEqual(['Home','Library','Concerts']); expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('Library'); act(()=>host.querySelectorAll<HTMLButtonElement>('button')[2]!.click()); expect(select).toHaveBeenCalledWith('concerts');});
it('never leaves a hidden Library search filtering the song list',async()=>{
  const draw=(searchOpen:boolean)=>act(()=>root.render(<LibraryScreen view={{songs:[song,other],state:'ready',notice:null}} searchOpen={searchOpen} onCloseSearch={()=>{}} onRemove={async()=>true} onClear={async()=>true}/>));
  draw(true); await flush(); const field=host.querySelector('input')!; expect(document.activeElement).toBe(field); await input(field,'Other'); expect(host.querySelectorAll('.saved-song')).toHaveLength(1);
  draw(false); await flush(); expect(host.querySelector('input')).toBeNull(); expect(host.querySelectorAll('.saved-song')).toHaveLength(2);
});
it('requires the explicit row action before removing a saved song',async()=>{const remove=vi.fn(async()=>true);act(()=>root.render(<LibraryScreen view={{songs:[song],state:'ready',notice:null}} searchOpen={false} onCloseSearch={()=>{}} onRemove={remove} onClear={async()=>true}/>));await click(`Options for ${song.title}`);expect(remove).not.toHaveBeenCalled();await click('Remove from Library');expect(remove).toHaveBeenCalledExactlyOnceWith(song);});
it('keeps covers and the Apple Music link with a stable one-way artwork fallback and no store badge',async()=>{
 const artwork={url:'https://is1-ssl.mzstatic.com/image/thumb/Music001/v4/invented/100x100bb.jpg',storeUrl:song.url};
 act(()=>root.render(<LibraryScreen view={{songs:[{...song,artwork}],state:'ready',notice:null}} searchOpen={false} onCloseSearch={()=>{}} onRemove={async()=>true} onClear={async()=>true}/>));
 expect(host.querySelector('a a')).toBeNull();expect(host.querySelector('.store-badge')).toBeNull();expect(host.querySelector('.apple-music-link')?.getAttribute('href')).toBe(song.url);
 const image=host.querySelector('.song-artwork img')!;expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
 await act(async()=>image.dispatchEvent(new Event('error')));expect(host.querySelector('.song-artwork img')).toBeNull();expect(host.querySelector('.song-artwork svg')).not.toBeNull();expect(host.querySelector('.apple-music-link img')).not.toBeNull();
});
it('links both Apple Music icons to the verified recording without iTunes labels or links to the cover metadata store URL',async()=>{
 const storeUrl='https://music.apple.com/us/album/invented-release/11111?i=12345';
 const saved={...song,artwork:{url:'https://is1-ssl.mzstatic.com/image/thumb/Music001/v4/invented/100x100bb.jpg',storeUrl}};
 act(()=>root.render(<><RecentSongs songs={[saved]}/><LibraryScreen view={{songs:[saved],state:'ready',notice:null}} searchOpen={false} onCloseSearch={()=>{}} onRemove={async()=>true} onClear={async()=>true}/></>));
 const links=[...host.querySelectorAll<HTMLAnchorElement>('.apple-music-link')];expect(links).toHaveLength(2);
 for(const link of links){expect(link.getAttribute('href')).toBe(song.url);expect(link.getAttribute('aria-label')).toBe('Open Invented song by Invented artist on Apple Music');expect(link.getAttribute('rel')).toBe('noopener noreferrer');expect(link.querySelector('img')?.getAttribute('alt')).toBe('');}
 expect(host.querySelector('.store-badge')).toBeNull();expect([...host.querySelectorAll('a')].some(a=>a.getAttribute('href')===storeUrl)).toBe(false);expect(host.innerHTML).not.toContain('iTunes Store');expect(host.querySelector('a a')).toBeNull();
 await act(async()=>host.querySelector('.song-artwork img')!.dispatchEvent(new Event('error')));expect(host.querySelectorAll('.apple-music-link')).toHaveLength(2);expect(host.querySelector('.store-badge')).toBeNull();
});
it('keeps Apple Music available without a cover and preserves legacy YouTube destinations without inventing Apple matches',()=>{
 const youtube:SavedSong={...other,service:'youtube',url:'https://www.youtube.com/watch?v=abcdefghijk'};
 act(()=>root.render(<LibraryScreen view={{songs:[song,youtube],state:'ready',notice:null}} searchOpen={false} onCloseSearch={()=>{}} onRemove={async()=>true} onClear={async()=>true}/>));
 expect(host.querySelectorAll('.apple-music-link')).toHaveLength(1);expect(host.querySelector('.apple-music-link')?.getAttribute('href')).toBe(song.url);expect(host.querySelector('.store-badge')).toBeNull();expect([...host.querySelectorAll('a')].some(a=>a.getAttribute('href')===youtube.url)).toBe(true);expect(host.innerHTML).not.toContain('spotify');
});
it('keeps unconfigured concerts distinct from empty coverage and sends no search',async()=>{const client:ConcertClient={capability:vi.fn(async()=>false),search:vi.fn()};act(()=>root.render(<ConcertsScreen scopeKey="invented-scope" getScope={() => "invented-scope"} songs={[song]} active revoked={false} ensureSession={async()=>true} client={client}/>));await flush();expect(host.textContent).toContain('Concert listings aren’t connected yet.');expect(host.textContent).not.toContain('No upcoming shows');expect(client.search).not.toHaveBeenCalled();});
it('does not describe incomplete concert checks as a successful empty search',async()=>{
 const client:ConcertClient={capability:async()=>true,search:async()=>({events:[],incomplete:true,checkedAt:Date.now()})};act(()=>root.render(<ConcertsScreen scopeKey="invented-scope" getScope={() => "invented-scope"} songs={[song]} active revoked={false} ensureSession={async()=>true} client={client}/>));await flush();expect(host.textContent).toContain('This list may be incomplete.');expect(host.textContent).not.toContain('No upcoming shows');
});
it('closes city editing without letting Enter reactivate its toggle, and returns Done focus',async()=>{
 const client:ConcertClient={capability:async()=>true,search:vi.fn()};act(()=>root.render(<ConcertsScreen scopeKey="invented" getScope={()=>'invented'} songs={[song]} active revoked={false} ensureSession={async()=>true} client={client}/>));await flush();await click('Location⌄');
 const city=host.querySelector<HTMLInputElement>('input')!,enter=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});await act(async()=>city.dispatchEvent(enter));await flush();expect(enter.defaultPrevented).toBe(true);expect(host.querySelector('input')).toBeNull();expect(document.activeElement).toBe(host.querySelector('.concert-filters button'));
 await click('Dates⌄');await click('Apply');expect(host.querySelector('input')).toBeNull();expect(document.activeElement).toBe(host.querySelectorAll('.concert-filters button')[1]);
});
it('searches concerts once on deliberate entry and rejects a late result after leaving',async()=>{
  let finish!:(result:ConcertReply)=>void;const client:ConcertClient={capability:vi.fn(async()=>true),search:vi.fn(()=>new Promise<ConcertReply>(yes=>{finish=yes;}))},ensure=vi.fn(async()=>true);
  const draw=(active:boolean)=>act(()=>root.render(<ConcertsScreen scopeKey="invented-scope" getScope={() => "invented-scope"} songs={[song]} active={active} revoked={false} ensureSession={ensure} client={client}/>));
  draw(false);await flush();expect(client.search).not.toHaveBeenCalled();draw(true);await flush();expect(client.search).toHaveBeenCalledOnce();const signal=(client.search as any).mock.calls[0][1] as AbortSignal;
  draw(false);await flush();expect(signal.aborted).toBe(true);finish({events:[],incomplete:false,checkedAt:Date.now()});await flush();expect(host.textContent).not.toContain('No upcoming shows');
});
it('cancels an in-flight concert request on session revocation and does not silently retry',async()=>{
 const client:ConcertClient={capability:vi.fn(async()=>true),search:vi.fn(()=>new Promise<ConcertReply>(()=>{}))};const draw=(revoked:boolean)=>act(()=>root.render(<ConcertsScreen scopeKey="invented-scope" getScope={() => "invented-scope"} songs={[song]} active revoked={revoked} ensureSession={async()=>true} client={client}/>));draw(false);await flush();const signal=(client.search as any).mock.calls[0][1] as AbortSignal;draw(true);await flush();expect(signal.aborted).toBe(true);expect(client.search).toHaveBeenCalledOnce();
});
it('filters the same pending unfiltered lookup without cancelling or dispatching another',async()=>{
 let finish!:(value:ConcertReply)=>void;const client:ConcertClient={capability:async()=>true,search:vi.fn(()=>new Promise<ConcertReply>(yes=>{finish=yes;}))};
 act(()=>root.render(<ConcertsScreen scopeKey="invented" getScope={()=>'invented'} songs={[song]} active revoked={false} ensureSession={async()=>true} client={client}/>));await flush();expect(client.search).toHaveBeenCalledOnce();
 const firstSignal=vi.mocked(client.search).mock.calls[0]![1];await click('Location⌄');expect(firstSignal.aborted).toBe(false);await input(host.querySelector('input')!,'London');await click('Done');expect(client.search).toHaveBeenCalledOnce();expect(vi.mocked(client.search).mock.calls[0]![0].city).toBeNull();
 finish({events:[],incomplete:false,checkedAt:Date.now()});await flush();expect(host.textContent).toContain('No shows match these filters.');
});
it('drops old concert coverage when Library deletion removes the artists',async()=>{
 const client:ConcertClient={capability:async()=>true,search:vi.fn(async()=>({events:[],incomplete:false,checkedAt:Date.now()}))};const draw=(songs:SavedSong[])=>act(()=>root.render(<ConcertsScreen scopeKey="invented" getScope={()=>'invented'} songs={songs} active revoked={false} ensureSession={async()=>true} client={client}/>));
 draw([song]);await flush();expect(host.textContent).toContain('No upcoming shows');draw([]);await flush();expect(host.textContent).not.toContain('No upcoming shows');expect(client.search).toHaveBeenCalledOnce();
});
it('preserves an unfinished location draft when capability starts the unfiltered list',async()=>{
 let ready!:(available:boolean)=>void;const client:ConcertClient={capability:()=>new Promise<boolean>(yes=>{ready=yes;}),search:vi.fn(async()=>({events:[],incomplete:false,checkedAt:Date.now()}))};
 act(()=>root.render(<ConcertsScreen scopeKey="invented" getScope={()=>'invented'} songs={[song]} active revoked={false} ensureSession={async()=>true} client={client}/>));await flush();await click('Location⌄');
 await input(host.querySelector('input')!,'Half typed city');expect(host.querySelector<HTMLButtonElement>('.concert-filter-editor .primary')?.disabled).toBe(false);
 const enter=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});await act(async()=>host.querySelector('input')!.dispatchEvent(enter));expect(enter.defaultPrevented).toBe(true);expect(host.querySelector('input')).toBeNull();await click('Half typed city⌄');await input(host.querySelector('input')!,'Half typed city');
 await act(async()=>ready(true));await flush();
 expect(client.search).toHaveBeenCalledOnce();expect(host.querySelector<HTMLInputElement>('input')?.value).toBe('Half typed city');
 await click('Done');expect(client.search).toHaveBeenCalledExactlyOnceWith({artists:song.artists,city:null,from:expect.any(String),to:null},expect.any(AbortSignal));expect(host.querySelector('input')).toBeNull();
});
it('restores focus and consumes Escape when Library options and clear confirmation close',async()=>{
 const remove=vi.fn(async()=>true),clear=vi.fn(async()=>true);act(()=>root.render(<LibraryScreen view={{songs:[song],state:'ready',notice:null}} searchOpen={false} onCloseSearch={()=>{}} onRemove={remove} onClear={clear}/>));
 const options=()=>host.querySelector<HTMLButtonElement>('.song-options')!;await click(`Options for ${song.title}`);host.querySelector<HTMLButtonElement>('.song-options-row button:last-child')!.focus();await click('Cancel');expect(document.activeElement).toBe(options());
 await click(`Options for ${song.title}`);const escape=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});await act(async()=>host.querySelector('.song-options-row button')!.dispatchEvent(escape));await flush();expect(escape.defaultPrevented).toBe(true);expect(host.querySelector('.song-options-row')).toBeNull();expect(document.activeElement).toBe(options());expect(remove).not.toHaveBeenCalled();
 await click('Clear Library');host.querySelector<HTMLButtonElement>('.library-footer .secondary')!.focus();await click('Keep them');expect(document.activeElement).toBe(host.querySelector('.library-footer .text-action'));
 await click('Clear Library');await act(async()=>host.querySelector<HTMLButtonElement>('.library-footer .primary')!.click());await flush();expect(clear).toHaveBeenCalledOnce();expect(document.activeElement).toBe(host.querySelector('h2'));
});
it('removes concert loading immediately on Stop and ignores that response after an explicit retry',async()=>{
 const resolve:((v:ConcertReply)=>void)[]=[];const client:ConcertClient={capability:async()=>true,search:vi.fn(()=>new Promise<ConcertReply>(yes=>resolve.push(yes)))};
 act(()=>root.render(<ConcertsScreen scopeKey="invented-stop" getScope={()=>'invented-stop'} songs={[song]} active revoked={false} ensureSession={async()=>true} client={client}/>));await flush();await click('Stop');expect(vi.mocked(client.search).mock.calls[0]![1].aborted).toBe(true);expect(host.textContent).not.toContain('Finding concerts');expect(document.activeElement?.textContent).toBe('Load concerts');
 await click('Load concerts');expect(client.search).toHaveBeenCalledTimes(2);await act(async()=>resolve[0]!({events:[],incomplete:false,checkedAt:Date.now()}));await flush();expect(host.textContent).toContain('Finding concerts');expect(host.textContent).not.toContain('No upcoming shows');
 await act(async()=>resolve[1]!({events:[],incomplete:false,checkedAt:Date.now()}));await flush();expect(host.textContent).toContain('No upcoming shows');
});
it('rechecks a failed concert connection only after the explicit retry action',async()=>{
 const client:ConcertClient={capability:vi.fn().mockRejectedValueOnce(new Error('Invented offline')).mockResolvedValue(true),search:vi.fn(async()=>({events:[],incomplete:false,checkedAt:Date.now()}))};
 act(()=>root.render(<ConcertsScreen scopeKey="invented-retry" getScope={()=>'invented-retry'} songs={[song]} active revoked={false} ensureSession={async()=>true} client={client}/>));await flush();expect(client.capability).toHaveBeenCalledOnce();expect(client.search).not.toHaveBeenCalled();await flush();expect(client.capability).toHaveBeenCalledOnce();await click('Try again');expect(client.capability).toHaveBeenCalledTimes(2);expect(client.search).toHaveBeenCalledOnce();
});
it('keeps Clear confirmation focused and admits only one pending Library mutation',async()=>{
 let finish!:(ok:boolean)=>void;const clear=vi.fn(()=>new Promise<boolean>(yes=>{finish=yes;}));act(()=>root.render(<LibraryScreen view={{songs:[song],state:'ready',notice:null}} searchOpen={false} onCloseSearch={()=>{}} onRemove={async()=>true} onClear={clear}/>));await click('Clear Library');expect(document.activeElement?.textContent).toBe('Keep them');const confirm=host.querySelector<HTMLButtonElement>('.library-footer .primary')!;await act(async()=>{confirm.click();confirm.click();});expect(clear).toHaveBeenCalledOnce();await act(async()=>finish(false));await flush();expect(document.activeElement?.textContent).toBe('Keep them');
});
it('releases concert loading at the deadline even if the adapter never settles',async()=>{
 vi.useFakeTimers();try{const client:ConcertClient={capability:async()=>true,search:vi.fn(()=>new Promise<ConcertReply>(()=>{}))};act(()=>root.render(<ConcertsScreen scopeKey="invented-timeout" getScope={()=>'invented-timeout'} songs={[song]} active revoked={false} ensureSession={async()=>true} client={client}/>));await flush();await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});await flush();expect(vi.mocked(client.search).mock.calls[0]![1].aborted).toBe(true);expect(host.textContent).not.toContain('Finding concerts');expect(host.textContent).toContain('Couldn’t load concerts');expect([...host.querySelectorAll('button')].some(b=>b.textContent==='Try again')).toBe(true);expect(vi.getTimerCount()).toBe(0);}finally{vi.useRealTimers();}
});
