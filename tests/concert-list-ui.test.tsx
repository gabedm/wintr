// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConcertsScreen, type ConcertClient } from '../src/client/ConcertsScreen.js';
import type { Concert, ConcertReply } from '../src/shared/concerts.js';
import type { SavedSong } from '../src/shared/saved-song.js';
vi.mock('../src/client/city-index.js', async original => ({...await original<typeof import('../src/client/city-index.js')>(),loadCityIndex:async()=>({search:(q:string)=>q.toLowerCase().startsWith('lon')?[{id:1,city:'London',countryCode:'GB',country:'UK',region:'England',label:'London, UK'}]:[]})}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const song:SavedSong={url:'https://music.apple.com/gb/song/123456',service:'apple_music',title:'Invented song',artists:['Invented artist'],foundAt:1};
const event=(id:string,date:string,time:string|null,city='London',countryCode:string|null='GB'):Concert=>({id,title:id,artists:song.artists,date,time,city,countryCode,venue:'Invented Hall',url:'https://www.ticketmaster.co.uk/event/'+id,image:null,status:'onsale'});
const events=[event('late','2030-11-03','21:00'),event('earlier','2030-11-02','20:00'),event('canada','2030-11-03','18:00','London','CA'),event('morning','2030-11-03','10:00'),event('unknown','2030-11-03',null,'London',null),event('other','2030-11-04','20:00','Manchester')];
let host:HTMLDivElement,root:Root;
const flush=async()=>{await act(async()=>{for(let i=0;i<25;i++)await Promise.resolve();});};
const click=async(name:string)=>{const b=[...host.querySelectorAll<HTMLButtonElement>('button')].find(e=>e.getAttribute('aria-label')===name||e.textContent===name);expect(b).toBeTruthy();await act(async()=>b!.click());await flush();};
const input=async(text:string)=>{await act(async()=>{const field=host.querySelector('input')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,text);field.dispatchEvent(new Event('input',{bubbles:true}));});await flush();};
const titles=()=>[...host.querySelectorAll('.concert-card > p:first-of-type')].map(e=>e.textContent);
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(2030,10,1,12));host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.useRealTimers();vi.restoreAllMocks();});
function fixture(){
 let scope:string|null='invented-A',revoked=false,active=true,songs=[song];const client:ConcertClient={capability:vi.fn(async()=>true),search:vi.fn(async()=>({events,incomplete:false,checkedAt:Date.now()}))};
 const draw=()=>act(()=>root.render(<ConcertsScreen songs={songs} scopeKey={scope} getScope={()=>scope} active={active} revoked={revoked} ensureSession={async()=>true} client={client}/>));
 return {client,draw,setScope:(s:string|null)=>{scope=s;},setRevoked:(r:boolean)=>{revoked=r;},setActive:(a:boolean)=>{active=a;},setSongs:(s:SavedSong[])=>{songs=s;}};
}
it('loads unrestricted upcoming shows once and orders equal dates by known time before unknown time',async()=>{
 const f=fixture();f.draw();await flush();expect(f.client.search).toHaveBeenCalledExactlyOnceWith({artists:song.artists,city:null,from:'2030-11-01',to:null},expect.any(AbortSignal));expect(titles()).toEqual(['earlier','morning','canada','late','unknown','other']);
});
it('returns to the owned loaded list without a connection check or provider search',async()=>{
 const f=fixture();f.draw();await flush();f.setActive(false);f.draw();await flush();f.setActive(true);f.draw();await flush();expect(f.client.search).toHaveBeenCalledOnce();expect(f.client.capability).toHaveBeenCalledOnce();expect(titles()).toHaveLength(6);expect(host.textContent).not.toContain('Finding concerts');
});
it('filters city and exact selected country locally, keeping unknown-country namesakes out',async()=>{
 const f=fixture();f.draw();await flush();await click('Location⌄');await input('lon');await click('London, UKEngland');await click('Done');expect(titles()).toEqual(['earlier','morning','late']);expect(f.client.search).toHaveBeenCalledOnce();
 await click('London, UK⌄');await click('Clear location');await click('Done');expect(titles()).toHaveLength(6);expect(f.client.search).toHaveBeenCalledOnce();
});
it('combines local city and inclusive date range, then restores all received shows without a request',async()=>{
 const f=fixture();f.draw();await flush();await click('Location⌄');await input('London');await click('Done');await click('Dates⌄');await click('3 November 2030');await click('3 November 2030');await click('Apply');expect(titles()).toEqual(['morning','canada','late','unknown']);expect(f.client.search).toHaveBeenCalledOnce();
 await click(host.querySelectorAll('.concert-filters button')[1]!.textContent!);await click('Clear');await click('Apply');expect(titles()).toHaveLength(5);expect(f.client.search).toHaveBeenCalledOnce();
});
it('offers a local reset when filters have no matches and restores focus',async()=>{
 const f=fixture();f.draw();await flush();await click('Location⌄');await input('Invented empty city');await click('Done');expect(titles()).toEqual([]);expect(host.textContent).toContain('No shows match these filters.');await click('Clear filters');expect(titles()).toHaveLength(6);expect(document.activeElement).toBe(host.querySelector('.concert-filters button'));expect(f.client.search).toHaveBeenCalledOnce();
});
it('does not cache a late reply from a cancelled visit',async()=>{
 const f=fixture();let finish!:(v:ConcertReply)=>void;vi.mocked(f.client.search).mockImplementationOnce(()=>new Promise(yes=>{finish=yes;}));f.draw();await flush();f.setActive(false);f.draw();await flush();finish({events,incomplete:false,checkedAt:Date.now()});await flush();expect(titles()).toEqual([]);f.setActive(true);f.draw();await flush();expect(f.client.search).toHaveBeenCalledTimes(2);expect(titles()).toHaveLength(6);
});
it('invalidates a completed list on Session replacement before it can be reused',async()=>{
 const f=fixture();f.draw();await flush();f.setScope('invented-B');f.draw();expect(titles()).toEqual([]);await flush();f.setActive(false);f.draw();await flush();f.setActive(true);f.draw();await flush();expect(f.client.search).toHaveBeenCalledTimes(2);
});
it('revokes completed coverage immediately and never auto-renews it',async()=>{
 const f=fixture();f.draw();await flush();f.setRevoked(true);f.draw();expect(titles()).toEqual([]);await flush();expect(f.client.search).toHaveBeenCalledOnce();expect(host.textContent).not.toContain('View on Ticketmaster');
});
it('invalidates completed coverage after a discovered artist changes, requiring a new deliberate visit',async()=>{
 const f=fixture();f.draw();await flush();f.setSongs([{...song,artists:['Other discovered artist']}]);f.draw();expect(titles()).toEqual([]);await flush();expect(f.client.search).toHaveBeenCalledOnce();f.setActive(false);f.draw();await flush();f.setActive(true);f.draw();await flush();expect(f.client.search).toHaveBeenCalledTimes(2);expect(vi.mocked(f.client.search).mock.calls[1]![0].artists).toEqual(['Other discovered artist']);
});
it('preserves an incomplete result as incomplete when a filter has no matches',async()=>{
 const f=fixture();vi.mocked(f.client.search).mockResolvedValue({events,incomplete:true,checkedAt:Date.now()});f.draw();await flush();await click('Location⌄');await input('Invented empty city');await click('Done');expect(host.textContent).toContain('This list may be incomplete.');expect(host.textContent).toContain('No shows match these filters.');expect(f.client.search).toHaveBeenCalledOnce();
});

