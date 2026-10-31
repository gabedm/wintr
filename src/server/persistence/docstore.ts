// Shared transactional document persistence (W05 foundation, F1).
//
// - DocStore/DocTx is the narrow, testable transaction interface every shared
//   authority (ledger now; ownership/admission Store in F2) uses. All
//   authoritative reads, checks and writes for one decision happen inside one
//   `transact` callback.
// - Transaction callbacks may be re-run by the database on contention. They
//   must only read/write through `tx` and compute with pure functions: no SDK
//   calls outside `tx`, no provider/network I/O and no logging. The only
//   permitted ambient input is the injected clock, re-read on every attempt so
//   a delayed or retried transaction is judged at its own time (it can only
//   tighten expiry/deadline decisions, never extend them).
// - Records are individual, bounded documents in allowlisted collections. There
//   is no session snapshot document holding all results.
// - createFirestoreDocStore adapts the official server SDK (@google-cloud/firestore)
//   through the structural FirestoreLike surface; firestore-sdk-check.ts proves
//   at compile time that the SDK's Firestore class satisfies it. Constructing a
//   real client (project/database/runtime identity) is a controller binding
//   step and is NOT done here, at import or in tests.

/** Service accounting and service-wide limits: no TTL field, never deleted by Clear/expiry. */
export const LEDGER_COLLECTIONS = ['wintr_ledger_service', 'wintr_ledger_scopes', 'wintr_ledger_reservations', 'wintr_service_limits'] as const;
/**
 * Listener-owned records: carry the `expireAt` TTL field and are deleted on
 * Clear. `wintr_owned_content` holds complete large provider output (reference
 * final text, panel answer/citations/Suggestions) beside its small record.
 */
export const OWNED_COLLECTIONS = ['wintr_owned', 'wintr_owned_content'] as const;

export type CollectionName = (typeof LEDGER_COLLECTIONS)[number] | (typeof OWNED_COLLECTIONS)[number];

export interface DocPath {
  readonly collection: CollectionName;
  readonly id: string;
}

export type DocValue = null | boolean | number | string | Date | readonly DocValue[] | DocData;
export interface DocData {
  readonly [field: string]: DocValue;
}

/** Bound for ordinary records (Firestore storage-size estimate). */
export const MAX_DOC_BYTES = 64 * 1024;
/**
 * Bound for complete provider output documents, below Firestore's 1 MiB
 * (1,048,576 byte) document limit. Holds a 512 KiB final text, or a 512 KiB
 * answer plus a 64 KiB Suggestions unit and its citations, whole.
 */
export const MAX_CONTENT_DOC_BYTES = 1_000_000;
const MAX_DEPTH = 8;

const docBound = (collection?: CollectionName) => (collection === 'wintr_owned_content' ? MAX_CONTENT_DOC_BYTES : MAX_DOC_BYTES);

/**
 * Firestore's documented storage-size calculation
 * (https://firebase.google.com/docs/firestore/storage-size): strings and field
 * names are UTF-8 bytes + 1; numbers and timestamps 8; booleans and null 1; an
 * array is the sum of its values; a map is sized like a document body (field
 * names + values + 32 bytes), at every nesting level. Used for bounds instead
 * of JSON length.
 */
export function firestoreValueSize(v: unknown): number {
  if (v === null || typeof v === 'boolean') return 1;
  if (typeof v === 'number' || v instanceof Date) return 8;
  if (typeof v === 'string') return Buffer.byteLength(v) + 1;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + firestoreValueSize(x), 0);
  if (typeof v === 'object' && v !== null) return Object.entries(v).reduce((n, [k, x]) => n + Buffer.byteLength(k) + 1 + firestoreValueSize(x), 32);
  return 0;
}
/** Document name size: each collection ID and document ID as a string, plus 16 bytes. */
export const firestoreNameSize = (path: { collection: string; id: string }) => Buffer.byteLength(path.collection) + 1 + Buffer.byteLength(path.id) + 1 + 16;
/** Document size: name + field names + field values + 32 bytes (the top-level map's overhead). */
export const firestoreDocSize = (path: { collection: string; id: string }, data: DocData) => firestoreNameSize(path) + firestoreValueSize(data);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const COLLECTIONS = new Set<string>([...LEDGER_COLLECTIONS, ...OWNED_COLLECTIONS]);

export class DocStoreError extends Error {
  constructor(
    readonly code: 'invalid_path' | 'invalid_data' | 'too_large' | 'read_after_write' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

export function assertPath(p: DocPath): void {
  if (!COLLECTIONS.has(p.collection) || !ID.test(p.id)) throw new DocStoreError('invalid_path', 'invalid document path');
}

/**
 * Accepts only plain JSON-like data plus Date (for the TTL field): finite
 * numbers, bounded depth, simple field names, no undefined/functions/classes.
 */
export function assertDocData(data: unknown, where?: CollectionName | DocPath): asserts data is DocData {
  const walk = (v: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) throw new DocStoreError('invalid_data', 'document too deep');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new DocStoreError('invalid_data', 'non-finite number');
      return;
    }
    if (v instanceof Date) {
      if (!Number.isFinite(v.getTime())) throw new DocStoreError('invalid_data', 'invalid date');
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      for (const [k, x] of Object.entries(v)) {
        if (!FIELD.test(k)) throw new DocStoreError('invalid_data', 'invalid field name');
        walk(x, depth + 1);
      }
      return;
    }
    throw new DocStoreError('invalid_data', 'unsupported value');
  };
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new DocStoreError('invalid_data', 'document must be an object');
  walk(data, 0);
  // Exact when the path is known; otherwise the longest collection name and the longest permitted id.
  const path = typeof where === 'object' ? where : { collection: where ?? 'wintr_ledger_reservations', id: 'x'.repeat(128) };
  if (firestoreDocSize(path, data as DocData) > docBound(path.collection)) throw new DocStoreError('too_large', 'document too large');
}

export interface DocTx {
  /** All reads must precede all writes (as in Firestore server transactions). */
  getAll(paths: readonly DocPath[]): Promise<(DocData | null)[]>;
  /** Fails the commit if the document exists. */
  create(path: DocPath, data: DocData): void;
  set(path: DocPath, data: DocData): void;
  delete(path: DocPath): void;
}

export interface QueryFilter {
  readonly field: string;
  readonly op: '==' | 'in';
  readonly value: string | readonly string[];
}

export interface DocStore {
  transact<T>(fn: (tx: DocTx) => Promise<T>): Promise<T>;
  /** Non-transactional read (reconciliation/ops views only; never an admission decision). */
  get(path: DocPath): Promise<DocData | null>;
  /**
   * Bounded query for reconciliation/ops views only: one or two filters (at most
   * one `in`), all applied by the database before the limit.
   */
  query(collection: CollectionName, filters: readonly QueryFilter[], limit: number): Promise<{ id: string; data: DocData }[]>;
}

// ---------------------------------------------------------------------------
// Structural surface of the official server SDK used by the adapter.

/** Firestore field map as the SDK types it. */
export type FirestoreFields = { [field: string]: any };
export interface FirestoreDocRef {
  readonly id: string;
  readonly path: string;
}
export interface FirestoreDocSnapshot {
  readonly exists: boolean;
  readonly id: string;
  data(): FirestoreFields | undefined;
}
/** `R` is the client's own document-reference type; the adapter only passes refs it got from `doc()`. */
export interface FirestoreTransaction<R extends FirestoreDocRef> {
  getAll(...refs: R[]): Promise<FirestoreDocSnapshot[]>;
  create(ref: R, data: FirestoreFields): unknown;
  set(ref: R, data: FirestoreFields): unknown;
  delete(ref: R): unknown;
}
export interface FirestoreQuery {
  where(field: string, op: '==' | 'in', value: unknown): FirestoreQuery;
  limit(n: number): FirestoreQuery;
  get(): Promise<{ readonly docs: readonly FirestoreDocSnapshot[] }>;
}
export interface FirestoreCollection<R extends FirestoreDocRef> extends FirestoreQuery {
  doc(id: string): R & { get(): Promise<FirestoreDocSnapshot> };
}
export interface FirestoreLike<R extends FirestoreDocRef = FirestoreDocRef> {
  collection(path: string): FirestoreCollection<R>;
  runTransaction<T>(fn: (tx: FirestoreTransaction<R>) => Promise<T>, opts?: { maxAttempts?: number }): Promise<T>;
}

/** SDK Timestamp values come back as objects with toDate(); normalise to Date. */
function fromFirestore(v: unknown): DocValue {
  if (v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number') return v;
  if (v instanceof Date) return v;
  if (typeof v === 'object' && v !== null && typeof (v as { toDate?: unknown }).toDate === 'function') return (v as { toDate(): Date }).toDate();
  if (Array.isArray(v)) return v.map(fromFirestore);
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromFirestore(x)]));
  throw new DocStoreError('invalid_data', 'unsupported stored value');
}

const snapshotData = (s: FirestoreDocSnapshot): DocData | null => {
  if (!s.exists) return null;
  const d = s.data();
  return d ? (fromFirestore(d) as DocData) : null;
};

/** Default bound on database-driven callback re-runs (the SDK default is also 5). */
export const DEFAULT_TRANSACTION_ATTEMPTS = 5;

/** Borrowed SDK adapter: its owner must keep the client open for every operation.
 * Use createOwnedFirestoreDocStore for controlled drain/close; raw SDK use after
 * terminate is not a supported outage simulation or lifecycle guarantee. */
export function createFirestoreDocStore<R extends FirestoreDocRef>(db: FirestoreLike<R>, opts: { maxAttempts?: number } = {}): DocStore {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_TRANSACTION_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new RangeError('maxAttempts must be 1..10');
  const ref = (p: DocPath) => {
    assertPath(p);
    return db.collection(p.collection).doc(p.id);
  };
  return {
    async transact(fn) {
      return db.runTransaction(async (sdkTx) => {
        let wrote = false;
        const tx: DocTx = {
          async getAll(paths) {
            if (wrote) throw new DocStoreError('read_after_write', 'reads must precede writes in a transaction');
            if (paths.length === 0) return [];
            const snaps = await sdkTx.getAll(...paths.map(ref));
            return snaps.map(snapshotData);
          },
          create(path, data) {
            assertDocData(data, path);
            wrote = true;
            sdkTx.create(ref(path), data);
          },
          set(path, data) {
            assertDocData(data, path);
            wrote = true;
            sdkTx.set(ref(path), data);
          },
          delete(path) {
            wrote = true;
            sdkTx.delete(ref(path));
          },
        };
        return fn(tx);
      }, { maxAttempts });
    },
    async get(path) {
      return snapshotData(await ref(path).get());
    },
    async query(collection, filters, limit) {
      const valid =
        COLLECTIONS.has(collection) &&
        Number.isInteger(limit) &&
        limit >= 1 &&
        limit <= 500 &&
        filters.length >= 1 &&
        filters.length <= 2 &&
        filters.filter((f) => f.op === 'in').length <= 1 &&
        new Set(filters.map((f) => f.field)).size === filters.length &&
        filters.every(
          (f) =>
            FIELD.test(f.field) &&
            (f.op === '=='
              ? typeof f.value === 'string'
              : f.op === 'in' && Array.isArray(f.value) && f.value.length >= 1 && f.value.length <= 30 && f.value.every((v) => typeof v === 'string')),
        );
      if (!valid) throw new DocStoreError('invalid_path', 'invalid query');
      let q: FirestoreQuery = db.collection(collection);
      for (const f of filters) q = q.where(f.field, f.op, f.op === 'in' ? [...f.value] : f.value);
      const snap = await q.limit(limit).get();
      return snap.docs.flatMap((d) => {
        const data = snapshotData(d);
        return data ? [{ id: d.id, data }] : [];
      });
    },
  };
}
