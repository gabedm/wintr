import { assertDocData, type CollectionName, type DocData, type DocPath } from './docstore.js';

// Listener-owned record envelope for the shared store. One bounded document
// per record, never a session snapshot. `expiresAt` (ms, finite safe integer)
// is the authoritative access boundary checked on every read against the
// current server clock; `expireAt` is the Firestore TTL field for later
// physical cleanup only. Service accounting lives in separate collections with
// no TTL.
//
// Stored data is never trusted because it was validated on write: Firestore
// can carry NaN/Infinity, wrong types or extra fields, so every decode
// re-validates the exact schema, ownership, epoch and clock.

export const OWNED_KINDS = [
  'session',
  'secret',
  'journey',
  'analysis',
  'brief',
  'attempt',
  'search',
  'checkpoint',
  'pool',
  'plan',
  'panel',
  'feedback',
  'capture',
  'binding',
  'freebinding',
] as const;
/** Large complete provider output kept beside its record (bounded by Firestore's document limit, not truncated). */
export const CONTENT_KINDS = ['analysistext', 'panelcontent'] as const;
export type OwnedKind = (typeof OWNED_KINDS)[number] | (typeof CONTENT_KINDS)[number];

export interface OwnedOwner {
  readonly sessionId: string;
  readonly epoch: number;
}

const HANDLE = /^[A-Za-z0-9_-]{16,64}$/;
const ENVELOPE_KEYS = ['body', 'epoch', 'expireAt', 'expiresAt', 'kind', 'sessionId'];

const isKind = (k: unknown): k is OwnedKind => (OWNED_KINDS as readonly unknown[]).includes(k) || (CONTENT_KINDS as readonly unknown[]).includes(k);
const collectionFor = (kind: OwnedKind): CollectionName => ((CONTENT_KINDS as readonly string[]).includes(kind) ? 'wintr_owned_content' : 'wintr_owned');
export const isSafeTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isEpoch = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const isPlainObject = (v: unknown): v is DocData =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && Object.getPrototypeOf(v) === Object.prototype;

export function ownedPath(kind: OwnedKind, handle: string): DocPath {
  if (!isKind(kind) || !HANDLE.test(handle)) throw new RangeError('invalid owned record path');
  return { collection: collectionFor(kind), id: `${kind}_${handle}` };
}

export function encodeOwned(kind: OwnedKind, owner: OwnedOwner, expiresAt: number, body: DocData): DocData {
  if (!isKind(kind) || !HANDLE.test(owner.sessionId) || !isEpoch(owner.epoch) || !isSafeTime(expiresAt) || !isPlainObject(body)) {
    throw new RangeError('invalid owned record envelope');
  }
  const doc: DocData = { kind, sessionId: owner.sessionId, epoch: owner.epoch, expiresAt, expireAt: new Date(expiresAt), body };
  assertDocData(doc, collectionFor(kind));
  return doc;
}

interface Envelope {
  readonly kind: OwnedKind;
  readonly sessionId: string;
  readonly epoch: number;
  readonly expiresAt: number;
  readonly body: DocData;
}

/** Strict structural validation of a stored envelope (no ownership decision). */
function envelope(data: DocData | null): Envelope | null {
  if (!isPlainObject(data)) return null;
  const keys = Object.keys(data).sort();
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((k, i) => k !== ENVELOPE_KEYS[i])) return null;
  const { kind, sessionId, epoch, expiresAt, expireAt, body } = data;
  if (!isKind(kind) || typeof sessionId !== 'string' || !HANDLE.test(sessionId) || !isEpoch(epoch) || !isSafeTime(expiresAt)) return null;
  if (!(expireAt instanceof Date) || expireAt.getTime() !== expiresAt || !isPlainObject(body)) return null;
  return { kind, sessionId, epoch, expiresAt, body };
}

/**
 * The body only when the envelope is well-formed and kind, session, epoch and
 * the current server time (finite safe integer, before expiry) all match;
 * otherwise null (no existence leak).
 */
export function decodeOwned(data: DocData | null, kind: OwnedKind, owner: OwnedOwner, now: number): DocData | null {
  if (!isSafeTime(now)) return null;
  const e = envelope(data);
  if (!e || e.kind !== kind || e.sessionId !== owner.sessionId || e.epoch !== owner.epoch) return null;
  return now < e.expiresAt ? e.body : null;
}

/**
 * Session root lookup when only the session handle is known: strict envelope,
 * kind and handle checks; returns the current epoch and expiry for the caller
 * to enforce (revocation and expiry are decided by the store, not hidden here).
 */
export function decodeSessionRoot(data: DocData | null, sessionId: string): { epoch: number; expiresAt: number; body: DocData } | null {
  const e = envelope(data);
  if (!e || e.kind !== 'session' || e.sessionId !== sessionId) return null;
  return { epoch: e.epoch, expiresAt: e.expiresAt, body: e.body };
}

/** Strict envelope of a lookup document (e.g. the secret-hash index) whose owning session is not yet known. */
export function decodeLookup(data: DocData | null, kind: OwnedKind): { sessionId: string; epoch: number; expiresAt: number; body: DocData } | null {
  const e = envelope(data);
  return e && e.kind === kind ? { sessionId: e.sessionId, epoch: e.epoch, expiresAt: e.expiresAt, body: e.body } : null;
}
