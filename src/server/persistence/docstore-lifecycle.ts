import { createFirestoreDocStore, DocStoreError, type DocStore, type FirestoreDocRef, type FirestoreLike } from './docstore.js';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ManagedDocStore extends DocStore {
  /** Synchronously refuses new work, drains admitted operations, then releases once. */
  close(accountingCleanup?: () => Promise<void>): Promise<void>;
}
const managed = new WeakSet<object>();
export const isManagedDocStore = (value: unknown): value is ManagedDocStore => typeof value === 'object' && value !== null && managed.has(value);

/** Owns the operation gate. The explicit release callback defines resource ownership. */
export function manageDocStore(inner: DocStore, release: () => Promise<void>): ManagedDocStore {
  let accepting = true;
  let active = 0;
  let drained: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const cleanupContext = new AsyncLocalStorage<boolean>();
  let cleanupActive = false;
  const check = () => { if (!accepting && !(cleanupActive && cleanupContext.getStore() === true)) throw new DocStoreError('unavailable', 'document store closed'); };
  const operation = async <T>(call: () => Promise<T>): Promise<T> => {
    check();
    active += 1;
    try { const result = await call(); check(); return result; }
    finally {
      active -= 1;
      if (active === 0) drained?.();
    }
  };
  const result: ManagedDocStore = {
    transact: (fn) => operation(() => inner.transact(async (tx) => {
      check();
      const result = await fn({
        getAll: async (paths) => { check(); const rows = await tx.getAll(paths); check(); return rows; },
        create: (path, data) => { check(); tx.create(path, data); },
        set: (path, data) => { check(); tx.set(path, data); },
        delete: (path) => { check(); tx.delete(path); },
      });
      check();
      return result;
    })),
    get: (path) => operation(() => inner.get(path)),
    query: (collection, filters, limit) => operation(() => inner.query(collection, filters, limit)),
    close(accountingCleanup) {
      if (closing) return closing;
      accepting = false; // Happens before the first await or resource release.
      const drain = active === 0 ? Promise.resolve() : new Promise<void>((resolve) => { drained = resolve; });
      // Only this trusted close callback can enter the drained store. Ordinary
      // callers remain synchronously refused, including while cleanup awaits.
      closing = drain.then(async () => {
        cleanupActive = true;
        try { if (accountingCleanup) await cleanupContext.run(true, accountingCleanup); }
        finally { cleanupActive = false; try { await release(); } finally { cleanupContext.disable(); } }
      });
      return closing;
    },
  };
  managed.add(result);
  return Object.freeze(result);
}

/** Transfers exclusive SDK lifecycle ownership. Never call db.terminate() outside this capability. */
export function createOwnedFirestoreDocStore<R extends FirestoreDocRef>(
  db: FirestoreLike<R> & { terminate(): Promise<void> }, opts: { maxAttempts?: number } = {},
): ManagedDocStore {
  return manageDocStore(createFirestoreDocStore(db, opts), () => db.terminate());
}
