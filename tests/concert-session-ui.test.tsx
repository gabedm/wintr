// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/client/App.js';
import type { SafeSnapshot, Handle } from '../src/shared/records.js';
import type { ConcertReply } from '../src/shared/concerts.js';
const fake = vi.hoisted(() => ({ state:vi.fn(),createSession:vi.fn(),changeChat:vi.fn(),search:vi.fn() }));
vi.mock('../src/client/api.js',async original=>({...await original<typeof import('../src/client/api.js')>(),api:fake}));
vi.mock('../src/client/song-library.js',()=>{
 const view={state:'ready',notice:null,songs:[{url:'https://music.apple.com/us/song/12345',service:'apple_music',title:'Invented song',artists:['Invented artist'],foundAt:Date.now()}]};
 return{SongLibrary:class{activate(){} dispose(){} subscribe=()=>()=>{};getSnapshot=()=>view;add=async()=>true;}};
});
vi.mock('../src/client/ConcertsScreen.js',async original=>{
 const module=await original<typeof import('../src/client/ConcertsScreen.js')>();
 const client={capability:async()=>true,search:fake.search};
 return{...module,ConcertsScreen:(props:ComponentProps<typeof module.ConcertsScreen>)=><module.ConcertsScreen {...props} client={client}/>};
});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const chat='C'.repeat(24) as Handle;
const snapshot=(context:string|null):SafeSnapshot=>({mode:'live',session:context?{context,expiresAt:Date.now()+3600000}:null,stage:'idle',revision:0,status:null,attempt:null,reference:null,listenerCue:null,analysis:null,brief:null,identity:null,connection:null,panel:null,history:[],refinement:null,code:null,chats:{current:context?chat:null,revision:0,items:context?[{handle:chat,title:'New chat',createdAt:Date.now(),revision:0}]:[]}});
let current:SafeSnapshot,host:HTMLDivElement,root:Root,finish:(value:ConcertReply)=>void,signal:AbortSignal;
const flush=async()=>{await act(async()=>{for(let i=0;i<30;i++)await Promise.resolve();});};
const click=async(name:string)=>{const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===name||b.getAttribute('aria-label')===name);expect(button).toBeTruthy();await act(async()=>button!.click());await flush();};
beforeEach(()=>{
 localStorage.clear();window.history.replaceState(null,'','/');vi.spyOn(window,'scrollTo').mockImplementation(()=>{});vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener(){},removeEventListener(){}}));
 current=snapshot('invented-session-A');fake.state.mockImplementation(async()=>current);fake.createSession.mockImplementation(async()=>current=snapshot('invented-session-B'));fake.changeChat.mockImplementation(async()=>current);
 fake.search.mockImplementation((_query,s:AbortSignal)=>{signal=s;return new Promise<ConcertReply>(yes=>{finish=yes;});});host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.clearAllMocks();vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();window.history.replaceState(null,'','/');});
const boot=async()=>{act(()=>root.render(<App/>));await flush();await click('Concerts');};
it.each(['expired','replaced'] as const)('the real App cancels concerts when its Session is %s and refuses a late reply',async ending=>{
 await boot();expect(fake.search).toHaveBeenCalledOnce();
 current=ending==='expired'?{...snapshot(null),code:'session_expired'}:snapshot('invented-session-C');await act(async()=>window.dispatchEvent(new Event('pageshow')));await flush();
 expect(signal.aborted).toBe(true);finish({events:[],incomplete:false,checkedAt:Date.now()});await flush();expect(host.textContent).not.toContain('No upcoming shows in these listings.');
});
it('creates a fresh owned Session only after Concerts is opened from a persistent Library without a chat',async()=>{
 current=snapshot(null);act(()=>root.render(<App/>));await flush();expect(fake.createSession).not.toHaveBeenCalled();expect(fake.search).not.toHaveBeenCalled();await click('Concerts');expect(fake.createSession).toHaveBeenCalledOnce();expect(fake.search).toHaveBeenCalledOnce();expect(signal.aborted).toBe(false);
 finish({events:[],incomplete:false,checkedAt:Date.now()});await flush();expect(host.textContent).toContain('No upcoming shows in these listings.');
});
