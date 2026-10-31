import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GEMINI_LIVE_PROFILE } from './providers/gemini-live-reference.js';
import { ownData, parsePersonalProfile, personalBindings, personalFingerprint, PersonalSetupError, type PersonalProfile } from './personal-profile.js';
import { parsePrivateJson, readPrivateFile } from './windows-secrets.js';
import { approvedSetup } from './personal-setup.js';

export const PERSONAL_LIVE_FILE = 'live-listening-approved.json';
export interface PersonalLivePermission {
  readonly schema: 1;
  readonly kind: 'wintr-personal-live-v1';
  readonly authority: 'until_revoked';
  readonly profileFingerprint: string;
  readonly approvalId: string;
  readonly profile: typeof GEMINI_LIVE_PROFILE;
}
/** Pure controller preparation. It never changes the independent base approval. */
export function createPersonalLivePermission(base: PersonalProfile, approvalId: string, now = Date.now()): PersonalLivePermission {
  return parsePersonalLivePermission({ schema: 1, kind: 'wintr-personal-live-v1', authority: 'until_revoked',
    profileFingerprint: personalFingerprint(base), approvalId, profile: { ...GEMINI_LIVE_PROFILE } }, base, now);
}
export function parsePersonalLivePermission(raw: unknown, base: PersonalProfile, now: number): PersonalLivePermission {
  const p = ownData(raw, ['schema', 'kind', 'authority', 'profileFingerprint', 'approvalId', 'profile']);
  const profile = ownData(p.profile, Object.keys(GEMINI_LIVE_PROFILE));
  if (p.schema !== 1 || p.kind !== 'wintr-personal-live-v1' || p.authority !== 'until_revoked' || p.profileFingerprint !== personalFingerprint(base) ||
    typeof p.approvalId !== 'string' || !/^call_[A-Za-z0-9_-]{8,100}$/.test(p.approvalId) ||
    Object.entries(GEMINI_LIVE_PROFILE).some(([k, v]) => profile[k] !== v)) throw new PersonalSetupError('setup_changed');
  // Includes source denials and every existing monetary/count bound; no digest override.
  personalBindings(base, now, p.approvalId);
  return Object.freeze({ schema: 1, kind: 'wintr-personal-live-v1', authority: 'until_revoked', profileFingerprint: p.profileFingerprint as string,
    approvalId: p.approvalId, profile: GEMINI_LIVE_PROFILE });
}
/** Optional, readonly extension. Revoking the original profile always wins independently. */
export function capturePersonalLivePermission(directory: string, base: PersonalProfile, now = Date.now()) {
  const file = join(directory, PERSONAL_LIVE_FILE);
  if (!existsSync(file)) return null;
  const baseFingerprint = personalFingerprint(base);
  const checkBase = () => {
    // approvedSetup also supports first-time onboarding before profile.json
    // exists. A Live extension must independently require the existing profile.
    const current = parsePersonalProfile(parsePrivateJson(readPrivateFile(join(directory, 'profile.json'), 65536)), Date.now());
    if (personalFingerprint(current) !== baseFingerprint || personalFingerprint(approvedSetup(directory)) !== baseFingerprint) throw new PersonalSetupError('setup_changed');
  };
  checkBase();
  const bytes = readPrivateFile(file, 16 * 1024), permission = parsePersonalLivePermission(parsePrivateJson(bytes), base, now);
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  return Object.freeze({ approvalId: permission.approvalId,
    checkAuthority() {
      checkBase();
      const current = readPrivateFile(file, 16 * 1024);
      if (createHash('sha256').update(current).digest('hex') !== fingerprint) throw new PersonalSetupError('setup_changed');
    },
  });
}
