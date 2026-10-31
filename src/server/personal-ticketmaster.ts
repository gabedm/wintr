import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ownData, PERSONAL_EXPIRY, type PersonalProfile } from './personal-profile.js';
import { parsePrivateJson, readPrivateFile, windowsProtection } from './windows-secrets.js';
import type { TicketmasterAccess } from './concerts.js';

export const PERSONAL_TICKETMASTER_LIMIT = 250;
export function parseTicketmasterPacket(raw: unknown, profileId: string, now: number): TicketmasterAccess {
  const p = ownData(raw, ['schema', 'kind', 'profileId', 'approved', 'authority', 'dailyLimit', 'createdAt', 'apiKey']);
  if (!Number.isSafeInteger(now) || now <= 0 || p.schema !== 1 || p.kind !== 'wintr-ticketmaster-v1' || p.profileId !== profileId || !/^[a-f0-9]{32}$/.test(profileId) || p.approved !== true || p.authority !== 'until_revoked' || p.dailyLimit !== PERSONAL_TICKETMASTER_LIMIT || !Number.isSafeInteger(p.createdAt) || (p.createdAt as number) <= 0 || (p.createdAt as number) > now || typeof p.apiKey !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(p.apiKey)) throw new Error('ticketmaster_setup_required');
  return Object.freeze({ apiKey: p.apiKey, validUntil: PERSONAL_EXPIRY });
}
/** Optional local key entry is independent of the original Google/Live approvals and files. */
export function captureWindowsTicketmaster(directory: string, profile: PersonalProfile, helper: string, check: () => void,
  decrypt: (bytes: Buffer) => Buffer = bytes => windowsProtection('unprotect', bytes, 'providers', helper)) {
  const file = join(directory, 'ticketmaster.dpapi');
  let cached: TicketmasterAccess | null = null, digest: string | null = null, revoked = false;
  return Object.freeze({ dailyLimit: PERSONAL_TICKETMASTER_LIMIT, access: (): TicketmasterAccess | null => {
    let plain: Buffer | undefined;
    try {
      check(); if (revoked) return null; if (!existsSync(file)) { if (digest !== null) revoked = true; return null; }
      const encrypted = readPrivateFile(file, 16384), current = createHash('sha256').update(encrypted).digest('hex');
      if (digest !== null) { if (current !== digest) { revoked = true; return null; } return cached; }
      plain = decrypt(encrypted);
      const value = parseTicketmasterPacket(parsePrivateJson(plain), profile.profileId, Date.now());
      check();
      // A replacement never inherits a running instance's authority. Missing at
      // boot is fine; an explicit local Connect action may enable it.
      cached = value; digest = current; return value;
    } catch { return null; }
    finally { plain?.fill(0); }
  } });
}
