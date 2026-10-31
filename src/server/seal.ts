import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ServerSecret } from './providers/secret.js';

// HMAC seal over a canonical JSON form. It proves a durable record was written
// by this server with this exact content and owner binding, so serialised
// records (e.g. a later Firestore document) can be rehydrated without trusting
// their bytes. The key is injected server-only configuration.

export interface RecordSealer {
  seal(value: unknown): string;
  verify(value: unknown, seal: unknown): boolean;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createRecordSealer(key: ServerSecret): RecordSealer {
  const mac = (value: unknown) => createHmac('sha256', key.reveal()).update(canonicalJson(value)).digest('base64url');
  return {
    seal: mac,
    verify(value, seal) {
      if (typeof seal !== 'string' || seal.length !== 43) return false;
      const expected = Buffer.from(mac(value));
      const given = Buffer.from(seal);
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
  };
}

/** Process-local key for disabled/synthetic local runs only. Live use requires an injected durable key. */
export const createEphemeralSealer = () => createRecordSealer(new ServerSecret(randomBytes(32).toString('base64url')));
