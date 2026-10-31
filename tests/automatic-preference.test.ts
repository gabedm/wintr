import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createApiHandler } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { MemoryStore } from '../src/server/store.js';
import { isSafeSnapshot } from '../src/client/snapshot-validation.js';
import type { Handle, ReferenceAnalysis } from '../src/shared/records.js';
const h=(x:string)=>x.padEnd(24,'x') as Handle;
async function fixture(streamed=true){
 const now=Date.now(),config=loadConfig([],{WINTR_MODE:'synthetic'}),store=new MemoryStore(config),created=await store.createSession(now);
 if(!created||typeof created==='string')throw Error('fixture session');
 const session=created.session,bucket=(await store.read(session.id,session.epoch,now))!;
 const analysis={id:h('analysis'),sessionId:session.id,epoch:session.epoch,createdAt:now,reference:streamed?{kind:'streamed',receipt:h('receipt')}:{canonicalUrl:'https://www.youtube.com/watch?v=invRefAAA01',videoId:'invRefAAA01',focus:{start:0,end:20}},relationships:['Invented rhythm','Invented vocal']} as unknown as ReferenceAnalysis;
 vi.spyOn(store,'read').mockResolvedValue({...bucket,analysis});
 const save=vi.spyOn(store,'saveBrief').mockResolvedValue({kind:'rejected',code:'no_session'});
 const handler=createApiHandler({config,store,referenceAdapter:null,now:()=>now});
 const post=async(extra:Record<string,unknown>)=>{
  const body={analysis:analysis.id,actionKey:crypto.randomUUID(),expectedBrief:null,relationship:{choice:0},artists:['Invented Artist'],...extra};
  const req=Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;req.method='POST';req.url='/api/preference';req.headers={host:config.hostHeader,origin:config.origin,'content-type':'application/json',cookie:`wintr_sid=${created.secret}`};
  let text='';const response=Object.assign(new EventEmitter(),{statusCode:200,headersSent:false,setHeader(){},end(raw:string){text=raw;response.headersSent=true;}});
  await handler(req,response as unknown as ServerResponse);return{status:response.statusCode,text};
 };
 return{post,save};
}
it('marks the automatic first streamed relationship separately from a listener choice',async()=>{const s=await fixture();await s.post({automatic:true});expect(s.save).toHaveBeenCalledOnce();expect(s.save.mock.calls[0]![1]).toMatchObject({relationship:'Invented rhythm',relationshipSource:'automatic_match'});});
it.each([{automatic:false},{automatic:'true'},{automatic:true,relationship:{choice:1}},{automatic:true,relationship:{text:'Invented correction'}}])('rejects malformed or expanded automatic selection %j',async body=>{const s=await fixture();expect((await s.post(body)).status).toBe(400);expect(s.save).not.toHaveBeenCalled();});
it('does not apply the automatic path to a YouTube analysis',async()=>{const s=await fixture(false);expect((await s.post({automatic:true})).status).toBe(400);expect(s.save).not.toHaveBeenCalled();});
it('validates automatic provenance on the safe client snapshot',()=>{const base={mode:'live',session:null,stage:'idle',revision:0,status:null,attempt:null,reference:null,listenerCue:null,analysis:null,brief:{handle:h('brief'),version:1,relationship:'Invented rhythm',source:'automatic_match',artists:['Invented Artist']},identity:null,connection:null,panel:null,history:[],refinement:null,code:null};expect(isSafeSnapshot(base)).toBe(true);expect(isSafeSnapshot({...base,brief:{...base.brief,source:'automatic_override'}})).toBe(false);});
