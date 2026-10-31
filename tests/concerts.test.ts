import { describe, expect, it, vi } from 'vitest';
import { filterConcerts, isConcertImage, isConcertQuery, isConcertReply, isConcertUrl, validConcertDate, type ConcertReply } from '../src/shared/concerts.js';
import { createTicketmasterSearch } from '../src/server/concerts.js';
import type { HttpTransport, ProviderResponse } from '../src/server/providers/http.js';
import type { TicketmasterAdmission } from '../src/server/ticketmaster-rate.js';
const NOW = Date.UTC(2026, 9, 30, 18), query = { artists: ['Invented Artist'], city: 'London', from: '2026-10-30', to: '2026-11-30' };
const attraction = { id: 'invented-attraction', name: 'Invented Artist' };
const event = () => ({ id: 'invented-event', name: 'Invented Artist live', url: 'https://www.ticketmaster.co.uk/event/invented-event', images: [{ url: 'https://s1.ticketm.net/dam/a/invented.jpg' }], dates: { start: { localDate: '2026-11-12', localTime: '19:30:00' }, status: { code: 'onsale' } }, _embedded: { attractions: [attraction], venues: [{ name: 'Invented Venue', city: { name: 'London' } }] } });
const response = (data: unknown): ProviderResponse => ({ status: 200, contentType: 'application/json; charset=utf-8', body: new TextEncoder().encode(JSON.stringify(data)) });
function setup(change: { attractions?: unknown[]; event?: unknown; reply?: ProviderResponse; authorize?: () => Promise<boolean>; admit?: () => Promise<TicketmasterAdmission> } = {}) {
  const transport = vi.fn<HttpTransport>(async req => req.url.pathname.endsWith('attractions.json') ? response({ _embedded: { attractions: change.attractions ?? [attraction] } }) : change.reply ?? response({ _embedded: { events: [change.event ?? event()] } }));
  const admit = vi.fn(change.admit ?? (async () => ({ allowed: true as const, dispatchBy: NOW + 1000 }))), authorize = vi.fn(change.authorize ?? (async () => true));
  const abort = new AbortController();
  const service = createTicketmasterSearch({ transport, access: () => ({ apiKey: 'invented_ticketmaster_key_not_real', validUntil: NOW + 3600000 }), admit, now: () => NOW, pause: async () => {} });
  return { service, transport, admit, authorize, abort, search: () => service.search(query, { signal: abort.signal, authorize, isCurrent: () => true }) };
}
describe('concert data boundaries', () => {
  it('orders received shows by date then known local time and retains verified venue country',async()=>{
    const s=setup(),make=(id:string,time:string)=>({...event(),id,name:id,dates:{...event().dates,start:{localDate:'2026-11-12',localTime:time}},_embedded:{...event()._embedded,venues:[{...event()._embedded.venues[0],country:{countryCode:'GB'}}]}});
    s.transport.mockResolvedValueOnce(response({_embedded:{attractions:[attraction]}})).mockResolvedValueOnce(response({_embedded:{events:[make('late','21:00:00'),make('earlier','18:00:00')]}}));
    const r=await s.search();expect(r.events.map(e=>e.id)).toEqual(['earlier','late']);expect(r.events.every(e=>e.countryCode==='GB')).toBe(true);
    expect(filterConcerts(r.events,{city:' london ',countryCode:'GB',from:'2026-11-12',to:'2026-11-12'})).toHaveLength(2);
    expect(filterConcerts(r.events,{city:'London',countryCode:'CA',from:'2026-11-12',to:null})).toEqual([]);
  });
  it('accepts only bounded own country data while retaining older replies without a country',async()=>{
    const r=await setup().search(),e=r.events[0]!;expect(e.countryCode).toBeNull();const {countryCode,...legacy}=e;
    expect(isConcertReply({...r,events:[legacy]})).toBe(true);expect(filterConcerts([legacy],{city:'London',countryCode:'GB',from:query.from,to:null})).toEqual([]);
    for(const countryCode of ['gb','GB&city=Other',undefined,12])expect(isConcertReply({...r,events:[{...e,countryCode}]})).toBe(false);
    expect(isConcertReply({...r,events:[{...e,countryCode:'GB'}]})).toBe(true);
    let reads=0;const accessor=Object.defineProperty({...legacy},'countryCode',{enumerable:true,get(){reads++;return 'GB';}});expect(isConcertReply({...r,events:[accessor]})).toBe(false);expect(reads).toBe(0);
  });
  it('marks the combined list incomplete when the global event cap trims otherwise complete artist pages',async()=>{
    const names=new Map<string,string>(),artists=Array.from({length:7},(_,i)=>'Invented '+i),s=setup();
    s.transport.mockImplementation(async req=>{
      if(req.url.pathname.endsWith('attractions.json')){const name=req.url.searchParams.get('keyword')!,id=name.replaceAll(' ','_');names.set(id,name);return response({_embedded:{attractions:[{id,name}]}});}
      const id=req.url.searchParams.get('attractionId')!,name=names.get(id)!;return response({_embedded:{events:Array.from({length:10},(_,i)=>({...event(),id:id+'_'+i,_embedded:{...event()._embedded,attractions:[{id,name}]}}))}});
    });
    const r=await s.service.search({...query,artists},{signal:s.abort.signal,authorize:s.authorize,isCurrent:()=>true});expect(r.events).toHaveLength(60);expect(r.incomplete).toBe(true);expect(s.transport).toHaveBeenCalledTimes(14);
  });
  it('uses only the fixed attraction and event routes, verified attraction ID and requested city/dates', async () => {
    const s = setup(), result = await s.search(); expect(isConcertReply(result)).toBe(true); expect(result.events).toHaveLength(1); expect(result.events[0]!.artists).toEqual(query.artists);
    expect(s.admit).toHaveBeenCalledTimes(2); expect(s.transport).toHaveBeenCalledTimes(2);
    const requests = s.transport.mock.calls.map(c => c[0]); expect(requests.every(r => r.url.origin === 'https://app.ticketmaster.com' && r.method === 'GET' && !r.body)).toBe(true);
    expect(requests[1]!.url.searchParams.get('attractionId')).toBe(attraction.id); expect(requests[1]!.url.searchParams.get('city')).toBe('London'); expect(requests[1]!.url.searchParams.has('keyword')).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/apikey|invented_ticketmaster_key/);
  });
  it('does not silently choose one of two namesakes', async () => { const s = setup({ attractions: [attraction, { ...attraction, id: 'other-id' }] }); const result = await s.search(); expect(result.events).toEqual([]); expect(result.incomplete).toBe(true); expect(s.transport).toHaveBeenCalledOnce(); });
  it('forwards the selected country, snapshots it before awaiting and refuses wrong-country listings', async () => {
    const e = { ...event(), _embedded: { ...event()._embedded, venues: [{ ...event()._embedded.venues[0], country: { countryCode: 'GB' } }] } }, s = setup({ event: e });
    const selected = { ...query, countryCode: 'GB' }; const result = s.service.search(selected, { signal: s.abort.signal, authorize: s.authorize, isCurrent: () => true }); selected.countryCode = 'CA'; expect((await result).events).toHaveLength(1); expect(s.transport.mock.calls[1]![0].url.searchParams.get('countryCode')).toBe('GB');
    const wrong = setup({ event: { ...e, _embedded: { ...e._embedded, venues: [{ ...e._embedded.venues[0], country: { countryCode: 'CA' } }] } } }); expect(await wrong.service.search({ ...query, countryCode: 'GB' }, { signal: wrong.abort.signal, authorize: wrong.authorize, isCurrent: () => true })).toMatchObject({ events: [], incomplete: true });
    expect(isConcertQuery({ ...query, countryCode: 'GB' })).toBe(true); for (const countryCode of ['gb', 'GB&city=Other', undefined, 12]) expect(isConcertQuery({ ...query, countryCode })).toBe(false); expect(isConcertQuery({ ...query, city: null, countryCode: 'GB' })).toBe(false);
  });
  it('does not use a loosely similar name as the discovered artist', async () => { const s = setup({ attractions: [{ ...attraction, name: 'Tribute to Invented Artist' }] }); expect((await s.search()).events).toEqual([]); expect(s.transport).toHaveBeenCalledOnce(); });
  it('rejects an event belonging to a different attraction despite matching prose', async () => { const e = event(); e._embedded.attractions[0] = { ...attraction, id: 'different-id' }; expect((await setup({ event: e }).search()).events).toEqual([]); });
  it.each(['https://evil.test/event/invented', 'https://www.ticketmaster.com.evil.test/event/invented', 'http://www.ticketmaster.com/event/invented', 'https://user:secret@www.ticketmaster.com/event/invented'])('never exposes a foreign or credential-bearing ticket destination %s', async url => { expect(isConcertUrl(url)).toBe(false); expect((await setup({ event: { ...event(), url } }).search()).events).toEqual([]); });
  it('drops unsafe imagery while retaining a valid event', async () => { const result = await setup({ event: { ...event(), images: [{ url: 'https://tracking.test/pixel?private=query' }] } }).search(); expect(result.events[0]!.image).toBeNull(); expect(isConcertImage('https://s1.ticketm.net.evil.test/dam/a/image.jpg')).toBe(false); });
  it('enforces local event dates after its timezone-safe wider provider query', async () => { const e = event(); e.dates.start.localDate = '2026-12-01'; expect((await setup({ event: e }).search()).events).toEqual([]); });
  it('stops immediately on a provider limit without automatic retry', async () => { const s = setup({ reply: { status: 429, contentType: 'application/json', body: new Uint8Array() } }); await expect(s.search()).rejects.toThrow('limited'); expect(s.transport).toHaveBeenCalledTimes(2); expect(s.admit).toHaveBeenCalledTimes(2); });
  it('keeps an unreadable response distinct from successful empty coverage', async () => { const s = setup({ reply: { status: 200, contentType: 'application/json', body: new TextEncoder().encode('{"_embedded":{},"\\u005fembedded":{"events":[]}}') } }); await expect(s.search()).rejects.toThrow('unavailable'); expect(s.transport).toHaveBeenCalledTimes(2); });
  it.each(['attractions','events'] as const)('refuses malformed %s envelopes rather than claiming empty coverage', async route => {
    for (const data of [{_embedded:'malformed'},{_embedded:null},{_embedded:[]},{},{_embedded:{}}]) {
      const s=setup();if(route==='attractions')s.transport.mockResolvedValueOnce(response(data));else s.transport.mockResolvedValueOnce(response({_embedded:{attractions:[attraction]}})).mockResolvedValueOnce(response(data));
      await expect(s.search()).rejects.toThrow('unavailable');expect(s.transport).toHaveBeenCalledTimes(route==='attractions'?1:2);
    }
  });
  it('accepts an explicit provider zero-result page without _embedded',async()=>{const s=setup();s.transport.mockResolvedValueOnce(response({page:{totalElements:0}}));expect(await s.search()).toMatchObject({events:[],incomplete:false});expect(s.transport).toHaveBeenCalledOnce();});
  it('marks bounded provider pages as incomplete when more listings exist',async()=>{const s=setup();s.transport.mockResolvedValueOnce(response({_embedded:{attractions:[attraction]},page:{totalElements:7}}));expect((await s.search()).incomplete).toBe(true);});
  it('does not dispatch after revocation before or during durable admission', async () => {
    const first = setup({ authorize: async () => false }); await expect(first.search()).rejects.toThrow(); expect(first.transport).not.toHaveBeenCalled(); expect(first.admit).not.toHaveBeenCalled();
    let current = true; const second = setup({ authorize: async () => current, admit: async () => { current = false; return { allowed: true, dispatchBy: NOW + 1000 }; } }); const r = await second.search().catch(() => null); expect(second.transport).not.toHaveBeenCalled(); expect(second.admit).toHaveBeenCalledOnce(); expect(r).toBeNull();
  });
  it('does not dispatch after expiry in the extra continuation following shared authorization',async()=>{
    let clock=1_000_000,reads=0;const expiry=clock+1,transport=vi.fn<HttpTransport>(async()=>response({page:{totalElements:0}})),admit=vi.fn(async()=>({allowed:true as const,dispatchBy:1_001_000}));
    const service=createTicketmasterSearch({transport,admit,now:()=>clock,access:()=>({apiKey:'invented_ticketmaster_key_not_real',validUntil:1_010_000})});
    await expect(service.search(query,{signal:new AbortController().signal,isCurrent:()=>clock<expiry,authorize:async()=>{if(++reads===3)queueMicrotask(()=>queueMicrotask(()=>{clock=expiry;}));return clock<expiry;}})).rejects.toThrow('unavailable');
    expect(reads).toBe(3);expect(admit).toHaveBeenCalledOnce();expect(transport).not.toHaveBeenCalled();
  });
  it('paces intended requests before admission so a multi-artist search fits the shared short-window limit',async()=>{
    let clock=NOW;const times:number[]=[],names=new Map<string,string>(),artists=['Invented One','Invented Two','Invented Three'];
    const transport:HttpTransport=async req=>{times.push(clock);if(req.url.pathname.endsWith('attractions.json')){const name=req.url.searchParams.get('keyword')!,id=name.replaceAll(' ','_');names.set(id,name);return response({_embedded:{attractions:[{id,name}]}});}const id=req.url.searchParams.get('attractionId')!,name=names.get(id)!;return response({_embedded:{events:[{...event(),id:`event_${id}`,_embedded:{...event()._embedded,attractions:[{id,name}]}}]}});};
    const admit=vi.fn(async()=>({allowed:true as const,dispatchBy:clock+1000})),pause=vi.fn(async(ms:number)=>{clock+=ms;});
    const service=createTicketmasterSearch({transport,admit,pause,now:()=>clock,access:()=>({apiKey:'invented_ticketmaster_key_not_real',validUntil:NOW+3600000})});
    const result=await service.search({...query,artists},{signal:new AbortController().signal,authorize:async()=>true,isCurrent:()=>true});expect(result.events).toHaveLength(3);expect(times).toHaveLength(6);expect(times.slice(1).every((at,i)=>at-times[i]!>=550)).toBe(true);expect(admit).toHaveBeenCalledTimes(6);expect(pause).toHaveBeenCalledTimes(5);
  });
  it('does not call any adapter for malformed queries or missing access', async () => { const s = setup(); await expect(s.service.search({ ...query, artists: Array(13).fill('Artist') }, { signal: s.abort.signal, authorize: s.authorize, isCurrent: () => true })).rejects.toThrow(); expect(s.transport).not.toHaveBeenCalled(); const missing = createTicketmasterSearch({ transport: s.transport, access: () => null, admit: s.admit, now: () => NOW }); expect(missing.available()).toBe(false); await expect(missing.search(query, { signal: s.abort.signal, authorize: s.authorize, isCurrent: () => true })).rejects.toThrow(); expect(s.transport).not.toHaveBeenCalled(); });
  it('cancels before a subsequent artist request', async () => { const s = setup(); s.transport.mockImplementationOnce(async () => { s.abort.abort(); return response({ _embedded: { attractions: [attraction] } }); }); await expect(s.search()).rejects.toThrow(); expect(s.transport).toHaveBeenCalledOnce(); });
  it('validates real calendar dates, ordered ranges, bounds and own fields', () => {
    expect(validConcertDate('2027-02-29')).toBe(false); expect(validConcertDate('2028-02-29')).toBe(true); expect(isConcertQuery(query)).toBe(true);
    for (const q of [{ ...query, to: '2026-01-01' }, { ...query, city: 'x\nsecret' }, { ...query, token: 'secret' }, { ...query, artists: [] }, { ...query, to: '2028-01-01' }]) expect(isConcertQuery(q)).toBe(false);
  });
});
