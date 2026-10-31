import type {
  FirestoreCollection,
  FirestoreDocRef,
  FirestoreDocSnapshot,
  FirestoreFields,
  FirestoreLike,
  FirestoreQuery,
  FirestoreTransaction,
} from '../../src/server/persistence/docstore.js';

// SDK-shaped, in-process fake of Firestore server transactions for tests only.
// One FakeFirestoreServer is the shared database; each FakeFirestore is a
// separate client "instance" (process). Faithful to the properties the adapter
// and ledger depend on:
// - a transaction callback may run several times; only the last successful
//   attempt's writes are applied, atomically;
// - a commit fails (and the callback is re-run) when any document it read,
//   including an absent one, changed since the read;
// - all reads must precede all writes; create() fails if the document exists;
// - Date values are stored as Timestamp-like objects and read back as such;
// - TTL is simulated by sweeping documents whose `expireAt` has passed.
// It is not hosted Firestore and proves nothing about latency, quotas or IAM.

export class FakeFirestoreError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Timestamp-like value as the SDK returns for stored dates. */
export class FakeTimestamp {
  constructor(readonly millis: number) {}
  toDate() {
    return new Date(this.millis);
  }
  toMillis() {
    return this.millis;
  }
}

const encode = (v: unknown): unknown => {
  if (v === undefined) throw new FakeFirestoreError(3, 'Cannot use "undefined" as a Firestore value');
  if (v instanceof Date) return new FakeTimestamp(v.getTime());
  if (v instanceof FakeTimestamp) return new FakeTimestamp(v.millis);
  if (Array.isArray(v)) return v.map(encode);
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  if (typeof v === 'function') throw new FakeFirestoreError(3, 'Cannot use a function as a Firestore value');
  return v;
};
const copy = (v: unknown): unknown => encode(v);

interface Write {
  readonly path: string;
  readonly op: 'create' | 'set' | 'delete';
  readonly data?: FirestoreFields;
}

export class FakeFirestoreServer {
  private readonly docs = new Map<string, FirestoreFields>();
  /** Per-path version, kept across deletes so an absent-then-created document is a change. */
  private readonly versions = new Map<string, number>();
  private seq = 0;
  callbackRuns = 0;
  commits = 0;
  conflicts = 0;
  readonly log: Write[] = [];
  /** Every executed query (collection, filters, limit), for asserting what the database itself was asked. */
  readonly queries: { collection: string; filters: { field: string; op: '==' | 'in'; value: unknown }[]; limit: number }[] = [];
  /** Awaited after a callback and before its commit: lets tests interleave instances. */
  beforeCommit: ((attempt: number) => Promise<void> | void) | null = null;
  /** Injected commit faults, consumed one per commit attempt. */
  readonly faults: ('unavailable' | 'ack_lost')[] = [];

  read(path: string): { data: FirestoreFields | null; version: number } {
    const d = this.docs.get(path);
    return { data: d ? (copy(d) as FirestoreFields) : null, version: this.versions.get(path) ?? 0 };
  }

  /** Atomic validate-and-apply; synchronous, so commits never interleave. */
  commit(reads: ReadonlyMap<string, number>, writes: readonly Write[]): 'ok' | 'conflict' | 'already_exists' {
    for (const [path, version] of reads) if ((this.versions.get(path) ?? 0) !== version) return 'conflict';
    for (const w of writes) if (w.op === 'create' && this.docs.has(w.path)) return 'already_exists';
    for (const w of writes) {
      if (w.op === 'delete') this.docs.delete(w.path);
      else this.docs.set(w.path, copy(w.data) as FirestoreFields);
      this.versions.set(w.path, ++this.seq);
      this.log.push(w);
    }
    this.commits += 1;
    return 'ok';
  }

  /** Direct server-side write (tests only: corruption/pre-seeding outside the app). */
  seed(path: string, data: FirestoreFields) {
    this.docs.set(path, encode(data) as FirestoreFields);
    this.versions.set(path, ++this.seq);
  }

  /** Simulated Firestore TTL policy on `field`: deletes documents whose timestamp has passed. */
  sweepTtl(nowMs: number, field = 'expireAt'): string[] {
    const gone: string[] = [];
    for (const [path, data] of this.docs) {
      const v = data[field];
      if (v instanceof FakeTimestamp && v.millis <= nowMs) gone.push(path);
    }
    for (const p of gone) {
      this.docs.delete(p);
      this.versions.set(p, ++this.seq);
    }
    return gone;
  }

  entries(prefix = ''): [string, FirestoreFields][] {
    return [...this.docs.entries()].filter(([p]) => p.startsWith(prefix)).map(([p, d]) => [p, copy(d) as FirestoreFields]);
  }
}

export interface FakeDocRef extends FirestoreDocRef {
  get(): Promise<FirestoreDocSnapshot>;
}

const snapshot = (path: string, data: FirestoreFields | null): FirestoreDocSnapshot => ({
  exists: data !== null,
  id: path.slice(path.lastIndexOf('/') + 1),
  data: () => (data === null ? undefined : (copy(data) as FirestoreFields)),
});

class FakeTransaction implements FirestoreTransaction<FakeDocRef> {
  readonly reads = new Map<string, number>();
  readonly writes: Write[] = [];
  constructor(private readonly server: FakeFirestoreServer) {}

  async getAll(...refs: FakeDocRef[]): Promise<FirestoreDocSnapshot[]> {
    if (this.writes.length > 0) throw new FakeFirestoreError(3, 'Firestore transactions require all reads to be executed before all writes.');
    await Promise.resolve();
    return refs.map((r) => {
      const { data, version } = this.server.read(r.path);
      if (!this.reads.has(r.path)) this.reads.set(r.path, version);
      return snapshot(r.path, data);
    });
  }
  create(ref: FakeDocRef, data: FirestoreFields) {
    this.writes.push({ path: ref.path, op: 'create', data: encode(data) as FirestoreFields });
    return this;
  }
  set(ref: FakeDocRef, data: FirestoreFields) {
    this.writes.push({ path: ref.path, op: 'set', data: encode(data) as FirestoreFields });
    return this;
  }
  delete(ref: FakeDocRef) {
    this.writes.push({ path: ref.path, op: 'delete' });
    return this;
  }
}

class FakeQuery implements FirestoreQuery {
  constructor(
    protected readonly server: FakeFirestoreServer,
    protected readonly collectionPath: string,
    private readonly filters: readonly { field: string; op: '==' | 'in'; value: unknown }[] = [],
    private readonly max = Infinity,
  ) {}
  where(field: string, op: '==' | 'in', value: unknown): FirestoreQuery {
    return new FakeQuery(this.server, this.collectionPath, [...this.filters, { field, op, value }], this.max);
  }
  limit(n: number): FirestoreQuery {
    return new FakeQuery(this.server, this.collectionPath, this.filters, n);
  }
  async get() {
    await Promise.resolve();
    this.server.queries.push({ collection: this.collectionPath, filters: this.filters.map((f) => ({ ...f })), limit: this.max });
    // Like Firestore: all filters first, then the limit.
    const docs = this.server
      .entries(`${this.collectionPath}/`)
      .filter(([, d]) => this.filters.every((f) => (f.op === '==' ? d[f.field] === f.value : Array.isArray(f.value) && f.value.includes(d[f.field]))))
      .slice(0, this.max)
      .map(([p, d]) => snapshot(p, d));
    return { docs };
  }
}

class FakeCollection extends FakeQuery implements FirestoreCollection<FakeDocRef> {
  doc(id: string): FakeDocRef {
    const path = `${this.collectionPath}/${id}`;
    const server = this.server;
    return { id, path, get: async () => snapshot(path, server.read(path).data) };
  }
}

/** One client instance over the shared fake server. */
export class FakeFirestore implements FirestoreLike<FakeDocRef> {
  constructor(readonly server: FakeFirestoreServer) {}

  collection(path: string): FirestoreCollection<FakeDocRef> {
    return new FakeCollection(this.server, path);
  }

  async runTransaction<T>(fn: (tx: FirestoreTransaction<FakeDocRef>) => Promise<T>, opts?: { maxAttempts?: number }): Promise<T> {
    const max = opts?.maxAttempts ?? 5;
    for (let attempt = 1; attempt <= max; attempt += 1) {
      const tx = new FakeTransaction(this.server);
      this.server.callbackRuns += 1;
      const result = await fn(tx); // A thrown callback error aborts without committing, as in the SDK.
      await this.server.beforeCommit?.(attempt);
      const fault = this.server.faults.shift();
      if (fault === 'unavailable') throw new FakeFirestoreError(14, 'UNAVAILABLE');
      const outcome = this.server.commit(tx.reads, tx.writes);
      if (outcome === 'conflict') {
        this.server.conflicts += 1;
        // Like the SDK: jittered exponential backoff before re-running the callback.
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 2 ** attempt)));
        continue;
      }
      if (outcome === 'already_exists') throw new FakeFirestoreError(6, 'ALREADY_EXISTS');
      if (fault === 'ack_lost') throw new FakeFirestoreError(4, 'DEADLINE_EXCEEDED (commit applied, response lost)');
      return result;
    }
    throw new FakeFirestoreError(10, 'ABORTED: too much contention');
  }
}
