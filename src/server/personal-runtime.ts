import { lookup } from 'node:dns/promises';
import { loadConfig } from './config.js';
import { composePreparedCandidateCatalogueRuntime, createPersonalFirestoreFactory, type FirestoreFactory, type LiveNetwork } from './live-runtime.js';
import { createCandidateCataloguePreparation, CANDIDATE_CATALOGUE_PROFILE } from './candidate-catalogue-profile.js';
import { parseSourcePolicy } from './source-policy.js';
import { createFetchTransport, type HttpTransport } from './providers/http.js';
import { createNodePinnedHttpClient } from './net/safe-fetch.js';
import { personalBindings, parsePersonalProfile, checkPersonalTotals, PersonalSetupError, type PersonalProfile } from './personal-profile.js';
import type { PersonalGoogleIdentity } from './personal-google.js';
import type { ServerSecret } from './providers/secret.js';
import type { ServiceTotals } from './ledger/ledger.js';
import type { ConcertSearch, TicketmasterAccess } from './concerts.js';

export interface PersonalRuntimeOptions {
  readonly profile: PersonalProfile;
  readonly checkAuthority: () => void;
  readonly google: PersonalGoogleIdentity;
  readonly secret: (ref: string) => Promise<ServerSecret>;
  readonly recordAccounting: (totals: ServiceTotals) => void;
  readonly firestore?: FirestoreFactory;
  readonly network?: Partial<LiveNetwork>;
  readonly clock?: () => number;
  readonly liveListening?: { readonly approvalId: string; readonly checkAuthority: () => void };
  readonly concerts?: ConcertSearch;
  readonly ticketmaster?: { readonly access: () => TicketmasterAccess | null; readonly dailyLimit: number };
}
/** The same application, graph, store and catalogue; only approved startup/auth differs. */
export async function composePersonalRuntime(options: PersonalRuntimeOptions) {
  const now = options.clock ?? Date.now, check = options.checkAuthority;
  const live = options.liveListening ? { approvalId: options.liveListening.approvalId, checkAuthority: options.liveListening.checkAuthority } : null;
  const checkLive = () => { check(); if (!live || typeof live.checkAuthority !== 'function') throw new PersonalSetupError('setup_changed'); live.checkAuthority(); };
  if (live) checkLive();
  const p = parsePersonalProfile(options.profile, now()), bindings = personalBindings(p, now(), live?.approvalId); check();
  const source = parseSourcePolicy(bindings.sourcePolicy); if (!source.ok) throw new PersonalSetupError('setup_required');
  const candidateBinding = { ...CANDIDATE_CATALOGUE_PROFILE, bindingVersion: bindings.bindingVersion, serviceId: p.serviceId, serviceIdentity: p.serviceIdentity,
    sourcePolicyVersion: source.policy.version, exposurePolicyVersion: bindings.exposurePolicy.version,
    projectId: p.projectId, quotaProjectId: p.quotaProjectId, identityRef: 'personal/google', storefront: 'us', expiresAt: bindings.expiresAt };
  const prepared = createCandidateCataloguePreparation(candidateBinding); if (!prepared.ok) throw new PersonalSetupError('setup_required');
  const guarded = (send: HttpTransport): HttpTransport => async request => { check(); const response = await send(request); check(); return response; };
  const supplied = options.network;
  const dns = supplied?.resolve ?? (async (hostname: string) => (await lookup(hostname, { all: true, verbatim: true })).map(x => x.address));
  const pinned = supplied?.pinned ?? createNodePinnedHttpClient();
  const runtime = await composePreparedCandidateCatalogueRuntime({
    config: loadConfig([], { WINTR_PORT: String(p.port) }), bindings, catalogueBinding: candidateBinding, cataloguePreparation: prepared.preparation, clock: now,
    ...(live ? { liveListeningAuthority: checkLive } : {}),
    ...(options.concerts ? { concerts: options.concerts } : {}),
    ...(options.ticketmaster ? { ticketmaster: options.ticketmaster } : {}),
    loaders: { secret: async ref => { check(); const secret = await options.secret(ref); check(); return secret; },
      googleAccessToken: async identity => { check(); if (identity !== 'personal/google') throw new PersonalSetupError('setup_required'); const token = await options.google.accessToken(); check(); return token; },
      firestore: options.firestore ?? createPersonalFirestoreFactory(options.google.client, check) },
    network: {
      ...(supplied?.liveSocket ? { liveSocket: supplied.liveSocket } : {}),
      reference: guarded(supplied?.reference ?? createFetchTransport(['https://generativelanguage.googleapis.com'])),
      catalogue: guarded(supplied?.catalogue ?? createFetchTransport(['https://aiplatform.googleapis.com'])),
      qloo: guarded(supplied?.qloo ?? createFetchTransport(['https://hackathon.api.qloo.com'])),
      resolve: async hostname => { check(); const result = await dns(hostname); check(); return result; },
      pinned: async request => { check(); const result = await pinned(request); check(); return result; },
    },
  });
  if (!runtime.ok) throw new PersonalSetupError('startup_failed');
  try {
    check();
    await runtime.store.recoverExpiredSubmissions(); check();
    const current = await runtime.store.reconciliation().totals();
    if (!current) throw new PersonalSetupError('accounting_unavailable');
    const totals = checkPersonalTotals(p, current);
    check(); options.recordAccounting(totals); check();
    return { runtime, profile: p, totals };
  } catch (error) { await runtime.close(); throw error; }
}
