// Clear intents: privacy recovery markers, not storage tokens or a saved profile.
//
// When the listener asks to Clear, the page hides everything at once and then
// asks the server to revoke the session. If that request never gets a valid
// answer (network loss, a hung body, a restart), the session may still exist on
// the server and a reload would show it again. So before the request is sent,
// the page records one marker in same-origin storage. While ANY marker exists,
// every tab and every fresh load refuses private reads, rendering and new work
// until a Clear is acknowledged by the server.
//
// Protocol (no shared key, so no read-then-delete race between renderers):
// - Each Clear operation writes its OWN key, `wintr.clear-intent.<16 hex nonce>`,
//   with the fixed value "v1". Nobody else ever writes that key.
// - Pending = at least one key with the prefix exists (whatever its suffix or
//   value: a corrupt entry is still pending, i.e. fail closed).
// - An acknowledged Clear removes, by exact key, only its own marker and the
//   markers that already existed when it started (that confirmed revocation
//   happened after them, so they are covered). A marker written after it
//   started is never removed by it. Removing a key another renderer already
//   removed is harmless, and no key is ever rewritten.
// Markers hold no credential, session context, record handle, reference,
// focus, note, result, source or identity, and nothing is restored from them.
// Storage events only prompt a re-check; the stored keys are the authority.

export const CLEAR_INTENT_PREFIX = 'wintr.clear-intent.';
const MARKER_VALUE = 'v1';
const NONCE = /^[0-9a-f]{16}$/;
/** Bound on how many markers are examined or cleaned in one pass. More than this is still "pending". */
export const MAX_INTENTS = 32;

export type IntentState = 'none' | 'pending' | 'unavailable';

/** Storage port: injectable for tests; the browser binding is same-origin localStorage. */
export interface ClearIntentPort {
  /** Suffixes of every marker key present (at most MAX_INTENTS + 1). Throws when storage cannot be read. */
  list(): string[];
  /** Writes this operation's own marker. Throws when storage cannot be written. */
  add(id: string): void;
  /** Removes exactly this marker key (a no-op when already gone). Throws when storage cannot be written. */
  remove(id: string): void;
  /** Prompts a re-check when another renderer changes markers. Delivery may be late or missing. */
  subscribe(listener: () => void): () => void;
}

export function newIntentId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return [...random(8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const isIntentId = (v: string): boolean => NONCE.test(v);

/** Current state. Any present marker (well-formed or not) is pending; unreadable storage is 'unavailable'. */
export function readIntents(port: ClearIntentPort): { state: IntentState; ids: string[] } {
  try {
    const ids = port.list();
    return { state: ids.length === 0 ? 'none' : 'pending', ids };
  } catch {
    return { state: 'unavailable', ids: [] };
  }
}

/** Same-origin localStorage binding with cross-tab prompts through the storage event. */
export function browserClearIntents(): ClearIntentPort {
  const storage = () => {
    const s = globalThis.localStorage;
    if (!s) throw new Error('storage unavailable');
    return s;
  };
  return {
    list: () => {
      const s = storage();
      const ids: string[] = [];
      for (let i = 0; i < s.length && ids.length <= MAX_INTENTS; i += 1) {
        const key = s.key(i);
        if (key !== null && key.startsWith(CLEAR_INTENT_PREFIX)) ids.push(key.slice(CLEAR_INTENT_PREFIX.length));
      }
      return ids;
    },
    add: (id) => storage().setItem(CLEAR_INTENT_PREFIX + id, MARKER_VALUE),
    remove: (id) => storage().removeItem(CLEAR_INTENT_PREFIX + id),
    subscribe: (listener) => {
      // key === null means another tab cleared all of this origin's storage.
      const onStorage = (e: StorageEvent) => {
        if (e.key === null || e.key.startsWith(CLEAR_INTENT_PREFIX)) listener();
      };
      globalThis.addEventListener?.('storage', onStorage);
      return () => globalThis.removeEventListener?.('storage', onStorage);
    },
  };
}

/**
 * Test model of one origin's storage shared by several renderers. Like real
 * storage events, notifications to other renderers are asynchronous: with
 * `deliver: 'manual'` they wait for `flush()`, so a write can be visible to a
 * reader before (or without) its event. Hooks allow interleaving another
 * renderer's write between any two storage operations.
 */
export interface MemoryIntentCell {
  readonly entries: Map<string, string>;
  failRead: boolean;
  failWrite: boolean;
  deliver: 'sync' | 'manual';
  /** Runs before each operation of any port on this cell (to inject interleavings). */
  beforeOp: ((op: 'list' | 'add' | 'remove', id?: string) => void) | null;
  readonly listeners: Set<{ owner: object; listener: () => void }>;
  readonly queue: { owner: object; listener: () => void }[];
  notify(from: object): void;
  flush(): void;
}

export function createIntentCell(initial: Record<string, string> = {}): MemoryIntentCell {
  const cell: MemoryIntentCell = {
    entries: new Map(Object.entries(initial)),
    failRead: false,
    failWrite: false,
    deliver: 'sync',
    beforeOp: null,
    listeners: new Set(),
    queue: [],
    notify(from) {
      const targets = [...cell.listeners].filter((l) => l.owner !== from);
      if (cell.deliver === 'manual') cell.queue.push(...targets);
      else for (const t of targets) t.listener();
    },
    flush() {
      for (const t of cell.queue.splice(0)) if (cell.listeners.has(t)) t.listener();
    },
  };
  return cell;
}

export function memoryClearIntents(cell: MemoryIntentCell = createIntentCell()): ClearIntentPort {
  const self = {};
  const hook = (op: 'list' | 'add' | 'remove', id?: string) => {
    const h = cell.beforeOp;
    if (h) {
      cell.beforeOp = null;
      h(op, id);
    }
  };
  return {
    list: () => {
      hook('list');
      if (cell.failRead) throw new Error('storage unavailable');
      return [...cell.entries.keys()].filter((k) => k.startsWith(CLEAR_INTENT_PREFIX)).map((k) => k.slice(CLEAR_INTENT_PREFIX.length));
    },
    add: (id) => {
      hook('add', id);
      if (cell.failWrite) throw new Error('storage unavailable');
      cell.entries.set(CLEAR_INTENT_PREFIX + id, MARKER_VALUE);
      cell.notify(self);
    },
    remove: (id) => {
      hook('remove', id);
      if (cell.failWrite) throw new Error('storage unavailable');
      if (cell.entries.delete(CLEAR_INTENT_PREFIX + id)) cell.notify(self);
    },
    subscribe: (listener) => {
      const entry = { owner: self, listener };
      cell.listeners.add(entry);
      return () => void cell.listeners.delete(entry);
    },
  };
}
