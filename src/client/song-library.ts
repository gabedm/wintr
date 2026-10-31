import { isSavedSong, LIBRARY_LIMIT, type SavedSong } from '../shared/saved-song.js';

const DB = 'wintr-song-library', CHANNEL = 'wintr-library-changed';
interface Meta { key: 'state'; ignoreThrough: number; revision: number }
export interface LibraryView { readonly songs: readonly SavedSong[]; readonly state: 'loading' | 'ready' | 'unavailable'; readonly notice: string | null }
const INITIAL: LibraryView = Object.freeze({ songs: [], state: 'loading', notice: null });
const validMeta = (v: unknown): v is Meta => !!v && typeof v === 'object' && Object.keys(v).sort().join(',') === 'ignoreThrough,key,revision' &&
  (v as Meta).key === 'state' && Number.isSafeInteger((v as Meta).ignoreThrough) && (v as Meta).ignoreThrough >= 0 && Number.isSafeInteger((v as Meta).revision) && (v as Meta).revision >= 0;
const sorted = (songs: readonly SavedSong[]) => [...songs].sort((a, b) => b.foundAt - a.foundAt || a.url.localeCompare(b.url)).slice(0, LIBRARY_LIMIT);

/** IndexedDB transactions serialize changes across tabs. Notifications contain no song or session data. */
export class SongLibrary {
  private view: LibraryView = INITIAL;
  private readonly watchers = new Set<() => void>();
  private db: Promise<IDBDatabase> | null = null;
  private channel: BroadcastChannel | null = null;
  private active = false;
  private readEpoch = 0;
  readonly getSnapshot = () => this.view;
  readonly subscribe = (f: () => void) => { this.watchers.add(f); return () => { this.watchers.delete(f); }; };
  private set(view: LibraryView) { this.view = Object.freeze(view); this.watchers.forEach(f => f()); }
  private open(): Promise<IDBDatabase> {
    if (!this.db) this.db = new Promise((yes, no) => {
      if (!globalThis.indexedDB) { no(new Error('unavailable')); return; }
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('songs', { keyPath: 'url' }); r.result.createObjectStore('meta', { keyPath: 'key' }); };
      r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); this.db = null; }; yes(r.result); };
      r.onerror = r.onblocked = () => no(new Error('unavailable'));
    });
    return this.db;
  }
  activate() {
    if (this.active) return;
    this.active = true;
    if (typeof BroadcastChannel === 'function') {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = () => { if (this.active) void this.refresh(); };
    }
    window.addEventListener('focus', this.onFocus);
    void this.refresh();
  }
  dispose() { this.active = false; this.readEpoch++; this.channel?.close(); this.channel = null; window.removeEventListener('focus', this.onFocus); }
  private readonly onFocus = () => { void this.refresh(); };
  private async refresh() {
    const epoch = ++this.readEpoch;
    try {
      const db = await this.open();
      const songs = await new Promise<unknown[]>((yes, no) => { const t = db.transaction('songs', 'readonly'), r = t.objectStore('songs').getAll(); t.oncomplete = () => yes(r.result); t.onerror = t.onabort = () => no(new Error('read')); });
      if (!this.active || epoch !== this.readEpoch) return;
      const valid = songs.filter(isSavedSong);
      this.set({ songs: sorted(valid), state: 'ready', notice: valid.length === songs.length ? null : 'Some saved songs couldn’t be read.' });
    } catch { if (this.active && epoch === this.readEpoch) this.set({ ...this.view, state: 'unavailable', notice: 'Songs can’t be saved on this browser.' }); }
  }
  private async edit(run: (songs: IDBObjectStore, meta: Meta, saveMeta: () => void) => void): Promise<boolean> {
    try {
      const db = await this.open();
      await new Promise<void>((yes, no) => {
        const t = db.transaction(['songs', 'meta'], 'readwrite'), songs = t.objectStore('songs'), metadata = t.objectStore('meta');
        const r = metadata.get('state');
        r.onsuccess = () => {
          const meta: Meta = r.result === undefined ? { key: 'state', ignoreThrough: 0, revision: 0 } : r.result;
          if (!validMeta(meta)) { t.abort(); return; }
          try { run(songs, meta, () => { meta.revision++; metadata.put(meta); }); } catch { t.abort(); }
        };
        t.oncomplete = () => yes(); t.onabort = t.onerror = () => no(new Error('write'));
      });
      this.channel?.postMessage('changed'); await this.refresh(); return true;
    } catch { this.set({ ...this.view, state: 'unavailable', notice: 'Couldn’t save that change. Try again.' }); return false; }
  }
  async add(songs: readonly SavedSong[], current: () => boolean): Promise<boolean> {
    if (!songs.length || !songs.every(isSavedSong) || !current()) return false;
    return this.edit((store, meta, save) => {
      if (!current()) return;
      const r = store.getAll(); r.onsuccess = () => {
        if (!current()) return;
        const existing = (r.result as unknown[]).filter(isSavedSong), byUrl = new Map(existing.map(s => [s.url, s]));
        const changed = new Set<string>();
        for (const s of songs) if (s.foundAt > meta.ignoreThrough) {
          const previous = byUrl.get(s.url);
          if (!previous) { byUrl.set(s.url, s); changed.add(s.url); }
          // A fresh verified discovery moves the song to the front without
          // duplicating it. The durable cutoff still rejects every old panel.
          else if (s.foundAt > previous.foundAt) { byUrl.set(s.url, { ...s, ...(s.artwork ? {} : previous.artwork ? { artwork: previous.artwork } : {}) }); changed.add(s.url); }
          else if (!previous.artwork && s.artwork) { byUrl.set(s.url, { ...previous, artwork: s.artwork }); changed.add(s.url); }
        }
        const retained = sorted([...byUrl.values()]);
        for (const s of existing) if (!retained.some(v => v.url === s.url)) store.delete(s.url);
        for (const s of retained) if (changed.has(s.url)) store.put(s);
        save();
      };
    });
  }
  remove(song: SavedSong) { return this.edit((store, meta, save) => { store.delete(song.url); meta.ignoreThrough = Math.max(meta.ignoreThrough, song.foundAt); save(); }); }
  clear(cutoff: number) {
    if (!Number.isSafeInteger(cutoff) || cutoff < 0) return Promise.resolve(false);
    return this.edit((store, meta, save) => {
      const r = store.getAll(); r.onsuccess = () => { meta.ignoreThrough = Math.max(meta.ignoreThrough, cutoff, ...r.result.filter(isSavedSong).map((s: SavedSong) => s.foundAt)); store.clear(); save(); };
    });
  }
}
