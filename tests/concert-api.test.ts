import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createApiHandler } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { MemoryStore, type Store } from '../src/server/store.js';
import type { ConcertReply } from '../src/shared/concerts.js';
import type { ConcertSearch } from '../src/server/concerts.js';
const T=Date.now(), base=loadConfig([],{WINTR_MODE:'synthetic'}),query={artists:['Invented Artist'],city:'London',from:'2026-10-30',to:null};
function setup(search: ConcertSearch['search']=vi.fn<ConcertSearch['search']>(async()=>({events:[],incomplete:false,checkedAt:T}))) {
 const clock={value:T},store=new MemoryStore(base),handler=createApiHandler({config:{...base,mode:'live'},store,referenceAdapter:null,concerts:{available:()=>true,search},now:()=>clock.value});
 const send=async(method:string,path:string,cookie?:string,body:unknown={},headers:Record<string,string|undefined>={})=>{
  const req=Readable.from(method==='GET'?[]:[Buffer.from(JSON.stringify(body))]) as IncomingMessage;req.method=method;req.url=path;req.headers={host:base.hostHeader,origin:base.origin,'content-type':'application/json',...(cookie?{cookie}:{}),...headers};
  const response=Object.assign(new EventEmitter(),{statusCode:200,headersSent:false,setHeader:(k:string,v:unknown)=>{outHeaders.set(k.toLowerCase(),v);},end:(raw:string)=>{text=raw;response.headersSent=true;}}),outHeaders=new Map<string,unknown>();let text='';
  await handler(req,response as unknown as ServerResponse);return{status:response.statusCode,json:JSON.parse(text),headers:outHeaders};
 };
 const session=async()=>{const r=await send('POST','/api/session');expect(r.status).toBe(201);return String(r.headers.get('set-cookie')).split(';')[0]!;};
 return{send,session,clock,search,store};
}
describe('concert HTTP ownership and emission',()=>{
 it('accepts the bounded optional country field and forwards it without weakening the old query schema',async()=>{
  const s=setup(),cookie=await s.session();expect((await s.send('POST','/api/concerts',cookie,{...query,countryCode:'GB'})).status).toBe(200);expect(s.search).toHaveBeenLastCalledWith({...query,countryCode:'GB'},expect.any(Object));
  expect((await s.send('POST','/api/concerts',cookie,{...query,countryCode:'gb'})).status).toBe(400);expect((await s.send('POST','/api/concerts',cookie,{...query,countryCode:'GB',extra:'unexpected'})).status).toBe(400);expect(s.search).toHaveBeenCalledOnce();
 });
 it('binds atomic POST admission to its owned Session and retires it when the response finishes',async()=>{
  let context!:Parameters<ConcertSearch['search']>[1];
  const grant={allowed:true as const,dispatchBy:T+1000};
  const search=vi.fn<ConcertSearch['search']>(async(_q,ctx)=>{context=ctx;expect(await ctx.authorizeAdmission!(async()=>grant)).toBe(grant);return{events:[],incomplete:false,checkedAt:T};});
  const s=setup(search),cookie=await s.session();
  const operation=vi.fn(async(_owner:unknown,_at:number,plan:(tx:any)=>Promise<unknown>)=>plan({}));
  (s.store as Store).withAuthorizedOperation=operation as Store['withAuthorizedOperation'];
  expect((await s.send('POST','/api/concerts',cookie,query)).status).toBe(200);
  expect(context.authorizeAdmission).toBeTypeOf('function');
  expect(operation.mock.calls[0]![0]).toMatchObject({epoch:1});
  const latePlan=vi.fn(async()=>grant);
  expect(context.signal.aborted).toBe(true);expect(await context.authorizeAdmission!(latePlan)).toBeNull();
  expect(latePlan).not.toHaveBeenCalled();expect(operation).toHaveBeenCalledOnce();
 });
 it('rejects local expiry after the atomic planner returns before allowing its commit',async()=>{
  let s!:ReturnType<typeof setup>;
  const search=vi.fn<ConcertSearch['search']>(async(_q,ctx)=>{
   await expect(ctx.authorizeAdmission!(async()=>{s.clock.value=T+3600000;return{allowed:true,dispatchBy:T+1000};})).rejects.toThrow();
   return{events:[],incomplete:false,checkedAt:T};
  });
  s=setup(search);const cookie=await s.session();
  (s.store as Store).withAuthorizedOperation=(async(_owner,_at,plan)=>plan({} as any)) as Store['withAuthorizedOperation'];
  expect((await s.send('POST','/api/concerts',cookie,query)).status).toBe(401);
 });
 it('requires the exact origin, host, owned session and bounded body before searching',async()=>{
  const s=setup(),cookie=await s.session();
  expect((await s.send('POST','/api/concerts',cookie,query,{origin:undefined})).status).toBe(403);
  expect((await s.send('POST','/api/concerts',cookie,query,{origin:'https://foreign.invalid'})).status).toBe(403);
  expect((await s.send('POST','/api/concerts',cookie,query,{host:'foreign.invalid'})).status).toBe(421);
  expect((await s.send('POST','/api/concerts',undefined,query)).status).toBe(401);
  expect((await s.send('POST','/api/concerts',cookie,{...query,apiKey:'invented'})).status).toBe(400);expect(s.search).not.toHaveBeenCalled();
  const valid=await s.send('POST','/api/concerts',cookie,query);expect(valid.status).toBe(200);expect(valid.json.events).toEqual([]);expect(valid.headers.get('cache-control')).toBe('no-store');expect(s.search).toHaveBeenCalledOnce();
 });
 it('aborts pending concert work on Clear and withholds even a provider that ignores abort',async()=>{
  let resolve!:(value:ConcertReply)=>void;const search=vi.fn<ConcertSearch['search']>(()=>new Promise<ConcertReply>(yes=>{resolve=yes;})),s=setup(search),cookie=await s.session();const pending=s.send('POST','/api/concerts',cookie,query);
  await vi.waitFor(()=>expect(search).toHaveBeenCalledOnce(),{interval:1,timeout:1000});const signal=search.mock.calls[0]![1].signal;await s.send('DELETE','/api/session',cookie);expect(signal.aborted).toBe(true);resolve({events:[],incomplete:false,checkedAt:T});const result=await pending;expect(result.status).toBe(401);expect(result.json).not.toHaveProperty('events');
 });
 it('refuses a concurrent search for the same session before reaching the service',async()=>{
  let resolve!:(value:ConcertReply)=>void;const search=vi.fn<ConcertSearch['search']>(()=>new Promise<ConcertReply>(yes=>{resolve=yes;})),s=setup(search),cookie=await s.session();const pending=s.send('POST','/api/concerts',cookie,query);await vi.waitFor(()=>expect(search).toHaveBeenCalledOnce(),{interval:1,timeout:1000});expect((await s.send('POST','/api/concerts',cookie,query)).status).toBe(409);expect(search).toHaveBeenCalledOnce();resolve({events:[],incomplete:false,checkedAt:T});expect((await pending).status).toBe(200);
 });
 it('withholds a late response after fixed session expiry',async()=>{
  let resolve!:(value:ConcertReply)=>void;const search=vi.fn<ConcertSearch['search']>(()=>new Promise<ConcertReply>(yes=>{resolve=yes;})),s=setup(search),cookie=await s.session();const pending=s.send('POST','/api/concerts',cookie,query);await vi.waitFor(()=>expect(search).toHaveBeenCalledOnce(),{interval:1,timeout:1000});s.clock.value=T+3600000;resolve({events:[],incomplete:false,checkedAt:T});expect((await pending).status).toBe(401);
 });
 it('rechecks expiry synchronously after the final durable authorization resolves',async()=>{
  const s=setup(),cookie=await s.session();let reads=0;
  vi.spyOn(s.store,'authorizeRead').mockImplementation(async()=>{if(++reads===2)queueMicrotask(()=>queueMicrotask(()=>{s.clock.value=T+3600000;}));return true;});
  const result=await s.send('POST','/api/concerts',cookie,query);expect(reads).toBe(2);expect(result.status).toBe(401);expect(result.json).not.toHaveProperty('events');
 });
 it('returns closed errors without exposing provider failure text or accepting an invalid response',async()=>{
  const leak=setup(vi.fn(async()=>{throw new Error('invented credential and query must not escape');})),cookie=await leak.session();const error=await leak.send('POST','/api/concerts',cookie,query);expect(error.status).toBe(503);expect(JSON.stringify(error.json)).not.toContain('invented');
  const bad=setup(vi.fn(async()=>({events:[{url:'javascript:alert(1)'}],incomplete:false,checkedAt:T}) as any)),other=await bad.session();expect((await bad.send('POST','/api/concerts',other,query)).status).toBe(503);
 });
});
