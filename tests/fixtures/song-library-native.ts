import { SongLibrary, type LibraryView } from '../../src/client/song-library.js';
import type { SavedSong } from '../../src/shared/saved-song.js';

/** Browser-only regression. Invoke solely on an explicitly disposable origin;
 * it clears that origin's Wintr Library and uses invented public metadata. */
export async function runNativeLibraryCases(): Promise<readonly string[]> {
  if (!document.querySelector('[data-disposable-library-fixture]')) throw new Error('disposable browser fixture required');
  const passed:string[]=[], instances:SongLibrary[]=[], messages:unknown[]=[];
  const channel=new BroadcastChannel('wintr-library-changed');channel.onmessage=e=>messages.push(e.data);
  const check=(ok:unknown,name:string)=>{if(!ok)throw new Error(name);passed.push(name);};
  const wait=(library:SongLibrary,predicate:(view:LibraryView)=>boolean)=>new Promise<void>((yes,no)=>{
    let unsubscribe=()=>{};const done=()=>{if(predicate(library.getSnapshot())){clearTimeout(timer);unsubscribe();yes();}};
    const timer=setTimeout(()=>{unsubscribe();no(new Error('native storage state timeout'));},3000);unsubscribe=library.subscribe(done);done();
  });
  const create=async()=>{const x=new SongLibrary();instances.push(x);x.activate();await wait(x,v=>v.state==='ready');return x;};
  const base=Date.now()+1000, song=(id:number):SavedSong=>({url:`https://music.apple.com/us/song/${100000+id}`,service:'apple_music',title:`Invented storage recording ${id}`,artists:['Invented storage artist'],foundAt:base+id});
  let raw:IDBDatabase|undefined;
  try{
    const a=await create(),b=await create();check(await a.clear(Date.now()),'initial disposable clear committed');
    check(await a.add([song(1)],()=>true),'native add transaction committed');await wait(b,v=>v.songs.some(s=>s.url===song(1).url));check(true,'second instance receives committed change');
    check(await b.remove(song(1)),'explicit removal committed');await wait(a,v=>!v.songs.some(s=>s.url===song(1).url));
    await a.add([song(1)],()=>true);check(!a.getSnapshot().songs.length,'removed metadata cannot return from an old panel');
    await Promise.all([a.add([song(2)],()=>true),b.remove(song(2))]);await a.add([song(2)],()=>true);check(!a.getSnapshot().songs.some(s=>s.url===song(2).url),'queued add and remove serialize without resurrection');
    await Promise.all([b.clear(base+10),a.add([song(3)],()=>true)]);check(!a.getSnapshot().songs.length,'Clear cutoff rejects a queued old discovery');
    let current=true;const late=a.add([song(20)],()=>current);current=false;await late;check(!a.getSnapshot().songs.length,'revocation before transaction work prevents stale storage');
    raw=await new Promise<IDBDatabase>((yes,no)=>{const r=indexedDB.open('wintr-song-library',1);r.onsuccess=()=>yes(r.result);r.onerror=()=>no(new Error('native open'));});
    await new Promise<void>((yes,no)=>{const t=raw!.transaction('songs','readwrite');t.objectStore('songs').put({...song(21),foundAt:Number.MAX_SAFE_INTEGER});t.oncomplete=()=>yes();t.onabort=()=>no(new Error('corruption fixture write'));});
    const c=await create();check(c.getSnapshot().songs.length===0&&c.getSnapshot().notice!==null,'unrenderable persisted date is dropped with a notice');
    const originalPut=IDBObjectStore.prototype.put;
    try{
      IDBObjectStore.prototype.put=function(){throw new DOMException('Invented quota failure','QuotaExceededError');};
      check(await a.add([song(30)],()=>true)===false,'aborted native write reports failure');check(a.getSnapshot().state==='unavailable'&&a.getSnapshot().notice!==null,'write failure stays visible');
    }finally{IDBObjectStore.prototype.put=originalPut;}
    check(await a.add([song(40)],()=>true),'storage can recover through a new deliberate write');
    const artwork={url:'https://is1-ssl.mzstatic.com/image/thumb/Music001/v4/invented/100x100bb.jpg',storeUrl:song(40).url};
    await a.add([{...song(40),title:'Changed rediscovery title',foundAt:base+50,artwork}],()=>true);
    const enriched=a.getSnapshot().songs.find(s=>s.url===song(40).url);
    check(enriched?.artwork?.url===artwork.url&&enriched.foundAt===base+50&&enriched.title==='Changed rediscovery title','fresh verified rediscovery updates recency without duplicating the song');
    check(a.getSnapshot().songs.filter(s=>s.url===song(40).url).length===1,'rediscovery is deduplicated by canonical destination');
    await a.add([song(60)],()=>true);check(a.getSnapshot().songs[0]?.url===song(60).url,'second distinct discovery appears first');
    await a.add([{...song(40),foundAt:base+70}],()=>true);check(a.getSnapshot().songs[0]?.url===song(40).url,'rediscovered recording returns to the front');
    const d=await create();check(d.getSnapshot().songs.some(s=>s.url===song(40).url),'new instance reads committed persisted metadata');
    await wait(b,v=>v.songs.some(s=>s.url===song(40).url));check(messages.length>0&&messages.every(x=>x==='changed'),'broadcasts contain only a change signal');
    await a.remove(a.getSnapshot().songs.find(s=>s.url===song(40).url)!);await a.add([{...song(40),artwork}],()=>true);check(!a.getSnapshot().songs.some(s=>s.url===song(40).url),'old cover enrichment cannot restore a deleted song');
    return passed;
  }finally{raw?.close();channel.close();instances.forEach(x=>x.dispose());}
}
