import { createHash } from 'node:crypto';
import type { DocPath, DocStore, DocTx } from './persistence/docstore.js';

export type TicketmasterAdmission = { readonly allowed: true; readonly dispatchBy: number } | { readonly allowed: false; readonly reason: 'limited' | 'unavailable' };
export type TicketmasterAuthorization = (work: (tx: DocTx) => Promise<TicketmasterAdmission>) => Promise<TicketmasterAdmission | null>;
export interface TicketmasterRateOptions { readonly docs: DocStore; readonly serviceId: string; readonly dailyLimit: number; readonly expiresAt: number; readonly now?: () => number }
const DAY = 86400000, LAG = 1000;
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** Separate content-free rolling Ticketmaster admission. No TTL, listener names, refund or music-ledger reset. */
export function createTicketmasterRateGate(options: TicketmasterRateOptions): (signal: AbortSignal, authorize?: TicketmasterAuthorization) => Promise<TicketmasterAdmission> {
  const { docs, serviceId, dailyLimit, expiresAt } = options, now = options.now ?? Date.now;
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(serviceId) || !Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 5000 || !time(expiresAt)) throw new Error('invalid_ticketmaster_binding');
  const scope = createHash('sha256').update(`${serviceId}|ticketmaster|scope`).digest('hex').slice(0, 32);
  const path: DocPath = { collection: 'wintr_service_limits', id: `tm_${createHash('sha256').update(`${serviceId}|ticketmaster|admission`).digest('hex').slice(0, 48)}` };
  const unavailable = (): TicketmasterAdmission => ({ allowed: false, reason: 'unavailable' });
  return async (signal, authorize) => {
    const started = now(); if (signal.aborted || !time(started) || started >= expiresAt) return unavailable();
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<TicketmasterAdmission>(yes => { onAbort = () => yes(unavailable()); signal.addEventListener('abort', onAbort, { once: true }); });
    const plan = async (tx: DocTx): Promise<TicketmasterAdmission> => {
      const [row] = await tx.getAll([path]), at = now();
      if (signal.aborted || !time(at) || at < started || at >= expiresAt) return unavailable();
      let stamps: number[] = [], lastSeen = 0;
      if (row !== null && row !== undefined) {
        if (Object.keys(row).sort().join(',') !== 'lastSeen,schema,scope,stamps' || row.schema !== 1 || row.scope !== scope || !time(row.lastSeen) || !Array.isArray(row.stamps) || row.stamps.length > 5000) return unavailable();
        lastSeen = row.lastSeen;
        if (lastSeen > at || row.stamps.some((t, i, all) => !time(t) || t > lastSeen || (i > 0 && t < all[i - 1]))) return unavailable();
        stamps = row.stamps as number[];
      }
      const retained = stamps.filter(t => at - t < DAY + LAG);
      if (retained.length >= dailyLimit || retained.filter(t => at - t < 1000 + LAG).length >= 4) return { allowed: false, reason: 'limited' };
      tx.set(path, { schema: 1, scope, stamps: [...retained, at], lastSeen: at });
      return { allowed: true, dispatchBy: Math.min(at + LAG, expiresAt) };
    };
    // The production POST supplies the owned-session transaction capability.
    // Standalone gate tests retain the ordinary counter-only transaction.
    let planned: TicketmasterAdmission | null = null;
    const runPlan = async (tx: DocTx) => (planned = await plan(tx));
    const pending = (authorize ? authorize(runPlan) : docs.transact(runPlan))
      .then(result => result !== null && result === planned ? result : unavailable()).catch(unavailable);
    try {
      const result = await Promise.race([pending, cancelled]), after = now();
      return signal.aborted || !time(after) || after < started || after >= expiresAt || (result.allowed && after >= result.dispatchBy) ? unavailable() : result;
    } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
  };
}
