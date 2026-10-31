import { appendFileSync, closeSync, existsSync, fsyncSync, openSync } from 'node:fs';
import { readPrivateFile } from './windows-secrets.js';
import { checkPersonalTotals, ownData, personalFingerprint, PersonalSetupError, type PersonalProfile } from './personal-profile.js';
import type { ServiceTotals } from './ledger/ledger.js';

/** Startup-only stable high-water receipt; the shared ledger remains authoritative. No reset/GET writes. */
export function recordPersonalAccounting(file: string, profile: PersonalProfile, totals: ServiceTotals, now: number): void {
  const fingerprint = personalFingerprint(profile);
  const hadJournal = existsSync(file);
  let previous = profile.baseline, previousTime = profile.approvedAt;
  if (hadJournal) {
    const bytes = readPrivateFile(file, 1024 * 1024); if (bytes.at(-1) !== 10) throw new PersonalSetupError('accounting_changed');
    let lines: string[]; try { lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd().split('\n'); } catch { throw new PersonalSetupError('accounting_changed'); }
    for (const line of lines) {
      let raw: unknown; try { raw = JSON.parse(line); } catch { throw new PersonalSetupError('accounting_changed'); }
      const r = ownData(raw, ['fingerprint', 'readAt', 'totals']);
      if (r.fingerprint !== fingerprint || !Number.isSafeInteger(r.readAt) || (r.readAt as number) < previousTime || (r.readAt as number) > now) throw new PersonalSetupError('accounting_changed');
      previous = checkPersonalTotals(profile, r.totals, previous); previousTime = r.readAt as number;
    }
  }
  if (!Number.isSafeInteger(now) || now < previousTime) throw new PersonalSetupError('accounting_changed');
  const current = checkPersonalTotals(profile, totals, previous);
  if (!hadJournal && (current.active !== 0 || current.counts.qloo !== profile.baseline.counts.qloo ||
      current.counts.gemini !== profile.baseline.counts.gemini || current.unitsHeld !== profile.baseline.unitsHeld ||
      current.unresolved !== profile.baseline.unresolved)) throw new PersonalSetupError('accounting_changed');
  // An in-flight reservation can still be withdrawn with proof that no intent
  // was recorded. Do not turn that provisional amount into a permanent local
  // floor. All current totals still satisfy the approved baseline/caps and the
  // last stable receipt; the shared ledger retains every active reservation.
  if (current.active !== 0) return;
  const fd = openSync(file, existsSync(file) ? 'a' : 'wx', 0o600);
  try { appendFileSync(fd, JSON.stringify({ fingerprint, readAt: now, totals: current }) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
}
