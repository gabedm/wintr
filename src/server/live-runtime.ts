import { promises as dnsPromises } from 'node:dns';
import type { Server } from 'node:http';
import type { AuthClient, GoogleAuthOptions } from 'google-auth-library';
import { createApiHandler, type ApiHandler } from './app.js';
import { createAppleCatalogueSearch } from './apple-catalogue-search.js';
import { createAppleMetadataRateGate } from './apple-metadata-rate.js';
import { captureTicketmasterPreparation, createTicketmasterSearch, type ConcertSearch, type TicketmasterAccess, type TicketmasterPreparation } from './concerts.js';
import { createTicketmasterRateGate } from './ticketmaster-rate.js';
import { createCandidateCatalogue } from './candidate-catalogue.js';
import { captureCandidateCataloguePreparation, candidateCatalogueBindingProblem, type CandidateCatalogueBinding } from './candidate-catalogue-profile.js';
import { loopbackBaseConfigProblem, type Config } from './config.js';
import { captureCloudReferencePreparation, cloudReferenceBindingProblem, CLOUD_REFERENCE_PROFILE, type CloudReferenceBinding } from './cloud-reference-profile.js';
import { FirestoreStore } from './firestore-store.js';
import { createWintrServer, listen } from './http-server.js';
import { validateLiveBindings, type LiveBindings } from './live-bindings.js';
import { createNativeCatalogue } from './native-catalogue.js';
import { createSourceResolver } from './source-resolver.js';
import { createNodePinnedHttpClient, type DnsResolver, type PinnedHttpClient } from './net/safe-fetch.js';
import { createFirestoreDocStore, type FirestoreLike } from './persistence/docstore.js';
import { createOwnedFirestoreDocStore, isManagedDocStore, manageDocStore, type ManagedDocStore } from './persistence/docstore-lifecycle.js';
import { sdkOwnedFirestoreSatisfiesAdapter } from './persistence/firestore-sdk-check.js';
import { createGeminiCatalogueAdapter, GEMINI_CATALOGUE_PROFILE } from './providers/gemini-catalogue.js';
import { createGeminiCandidateSelector } from './providers/gemini-candidate-selector.js';
import { createGeminiReferenceAdapter, GEMINI_REFERENCE_PROFILE } from './providers/gemini-reference.js';
import { createGeminiLiveReferenceAdapter, withLiveReference, type LiveSocketFactory } from './providers/gemini-live-reference.js';
import { createGeminiCloudReferenceAdapter, type CloudReferenceTokenLoader } from './providers/gemini-cloud-reference.js';
import { createFetchTransport, ProviderError, type HttpTransport, type ProviderName } from './providers/http.js';
import { createQlooClient } from './providers/qloo.js';
import { ServerSecret } from './providers/secret.js';
import type { ReferenceAdapter } from './reference.js';
import { isRecordedReference, isStreamedReference } from '../shared/records.js';
import { createRecordSealer } from './seal.js';
import type { SourcePolicy } from './source-policy.js';
import { hostedConfigProblem, hostedServingOf, sameHostedServing } from './serving-profile.js';
import type { Store } from './store.js';
import type { DesktopProbe } from './desktop-probe.js';
import { createAppleMusicVerifier, createYouTubeVerifier, type DestinationVerifier } from './verifier.js';

// Server-only live composition seam (O01/O04/O05, D07). The controller calls
// composeLiveRuntime with an explicit approved binding and its own secure
// loaders; this module never reads the environment, files, browser profiles or
// default credentials, and importing it has no side effect. Order:
//   1. a disabled loopback base, or the exact explicit HTTPS-profile constructor result;
//   2. strict binding validation and agreement with code (no loader called before);
//   3. credentials/identity through the controller's loaders (fail closed);
//   4. the shared FirestoreStore over an explicitly configured SDK client;
//   5. the genuine reference, Qloo, catalogue and recording-verifier adapters,
//      the durable sealer and the eligible-source policy, wired into the one
//      existing createApiHandler (no new route, no second harness).
// Network transports are constructed here but nothing is sent until a request
// arrives. Nothing in the repository calls this today: live remains inactive.

export interface FirestoreSettings {
  readonly projectId: string;
  /** '(default)' or a named database. */
  readonly databaseId: string;
}

/** Any client satisfying the adapter surface for its own document-reference type (the SDK uses DocumentReference). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFirestore = FirestoreLike<any>;

/** Official factories transfer managed ownership. Legacy raw factories lend an open client; its external owner retains termination responsibility. */
export type FirestoreFactory = (settings: FirestoreSettings) => AnyFirestore | ManagedDocStore | Promise<AnyFirestore | ManagedDocStore>;

/** Controller-supplied loaders. Values arrive only through these; failures fail the composition closed. */
export interface LiveLoaders {
  /** Resolves a credential reference (secret-manager name) to a server-only secret. */
  readonly secret: (ref: string) => Promise<ServerSecret>;
  /** Short-lived Google bearer token for the catalogue identity; called per catalogue request. */
  readonly googleAccessToken: (identityRef: string) => Promise<ServerSecret>;
  /** Builds the Firestore client with the explicit project/database (see createOfficialFirestoreFactory). */
  readonly firestore: FirestoreFactory;
}

/** Test seam: network clients (defaults are the real allowlisted fetch/DNS/pinned clients). */
export interface LiveNetwork {
  readonly liveSocket?: LiveSocketFactory;
  readonly reference: HttpTransport;
  readonly catalogue: HttpTransport;
  readonly qloo: HttpTransport;
  readonly resolve: DnsResolver;
  readonly pinned: PinnedHttpClient;
}

export interface LiveRuntimeOptions {
  /** Disabled loadConfig base, or exact createHostedBaseConfig result with a matching explicit binding.serving. */
  readonly config: Config;
  readonly bindings: unknown;
  readonly loaders: LiveLoaders;
  readonly network?: Partial<LiveNetwork>;
  readonly clock?: () => number;
  /** Re-read the controller-owned approval identity before every Live connection/message. */
  readonly liveListeningAuthority?: () => void;
  readonly concerts?: ConcertSearch;
  readonly ticketmaster?: { readonly access: () => TicketmasterAccess | null; readonly dailyLimit: number };
}

/** Separate controller-only preparation seam. No environment, client input or default binding selects it. */
export interface PreparedCloudReferenceRuntimeOptions extends LiveRuntimeOptions {
  readonly referencePreparation: unknown;
  readonly referenceBinding: unknown;
  /** Own explicit reference identity loader, never the catalogue loader or an API-key loader. */
  readonly referenceAccessToken: CloudReferenceTokenLoader;
}

/** Deliberate catalogue alternative, optionally combined with the separately prepared Cloud reference route. */
export interface PreparedCandidateCatalogueRuntimeOptions extends LiveRuntimeOptions {
  readonly cataloguePreparation: unknown;
  readonly catalogueBinding: unknown;
  readonly cloudReference?: {
    readonly preparation: unknown; readonly binding: unknown; readonly accessToken: CloudReferenceTokenLoader;
  };
}

export type LiveRuntime =
  | {
      readonly ok: true;
      readonly handler: ApiHandler;
      readonly store: FirestoreStore;
      readonly bindings: LiveBindings;
      /** Present only on the explicitly prepared Cloud-reference composition; never sent to the client. */
      readonly cloudReference?: CloudReferenceBinding;
      readonly candidateCatalogue?: CandidateCatalogueBinding;
      /** The composition's own immutable live config (snapshotted from the base config before any loader). */
      readonly config: Config;
      /** Earliest of binding, exposure-policy and source-policy expiry. */
      readonly validUntil: number;
      /** Invalidates before draining and releasing the owned SDK; borrowed clients remain their owner's responsibility. */
      readonly close: () => Promise<void>;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

const MIN_SEALING_KEY_CHARS = 32;
/** Stores produced by composeLiveRuntime; a kind string or a hand-built store never qualifies. */
const composedStores = new WeakSet<object>();

interface RuntimeAuthority {
  readonly config: Config;
  readonly handler: ApiHandler;
  readonly store: FirestoreStore;
  readonly validUntil: number;
  readonly clock: () => number;
  readonly lapsed: () => string | null;
  readonly close: () => Promise<void>;
}
/** Runtimes returned by composeLiveRuntime, keyed by the exact returned object; the start seam uses only this record. */
const composedRuntimes = new WeakMap<object, RuntimeAuthority>();
/** One listen attempt per exact authority; a duplicate must not dispose a healthy server. */
const startClaims = new WeakSet<RuntimeAuthority>();

/**
 * Why a store may not back live dispatch, or null. Only a FirestoreStore built
 * by composeLiveRuntime from a validated binding qualifies; MemoryStore, a
 * hand-built FirestoreStore or any object claiming a kind string is refused.
 */
export function liveStoreRefusal(store: Store): string | null {
  if (!(store instanceof FirestoreStore)) return 'only the shared transactional Firestore store may back live dispatch';
  if (!composedStores.has(store)) return 'the store was not composed from a validated controller binding';
  return null;
}

/** The live source check also binds the binding's own expiry. */
function boundSourcePolicy(policy: SourcePolicy, bindingExpiresAt: number): SourcePolicy {
  return Object.freeze({
    version: policy.version,
    expiresAt: Math.min(policy.expiresAt, bindingExpiresAt),
    size: policy.size,
    ...(policy.recordingSelfService === true ? { recordingSelfService: true } : {}),
    allows: (videoId: string, now: number) => now < bindingExpiresAt && policy.allows(videoId, now),
    allowsRecording: (digest: string, now: number) => now < bindingExpiresAt && policy.allowsRecording(digest, now),
    allowsLiveAudio: (now: number) => now < bindingExpiresAt && policy.allowsLiveAudio?.(now) === true,
  });
}

/** Defence in depth at dispatch: an unapproved/expired source never reaches the transport. */
function sourceGuarded(adapter: ReferenceAdapter, policy: SourcePolicy, clock: () => number): ReferenceAdapter {
  return {
    synthetic: false,
    ...(adapter.liveListening ? { liveListening: adapter.liveListening } : {}),
    ...(adapter.observationProfile ? { observationProfile: adapter.observationProfile } : {}),
    ...(adapter.observationProfileFor ? { observationProfileFor: adapter.observationProfileFor } : {}),
    analyse(input, signal, observer, execution) {
      const ref = structuredClone(input.reference);
      const check = () => {
        const allowed = isStreamedReference(ref) ? policy.allowsLiveAudio?.(clock()) === true : isRecordedReference(ref) ? policy.allowsRecording(ref.sha256, clock()) : policy.allows(ref.videoId, clock());
        if (!allowed || signal.aborted) throw new ProviderError('gemini', 'config', false);
      };
      try { check(); } catch (error) { return Promise.reject(error); }
      return adapter.analyse(input, signal, observer, execution ? { ...execution, dispatch: <T>(send: () => Promise<T>) => {
        const final = () => { check(); return send(); };
        return execution.dispatch ? execution.dispatch(final) : Promise.reject(new ProviderError('gemini', 'config', false));
      } } : execution);
    },
  };
}

const nodeResolver: DnsResolver = async (host) => (await dnsPromises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export async function composeLiveRuntime(opts: LiveRuntimeOptions): Promise<LiveRuntime> {
  return composeRuntime(opts);
}

/**
 * INACTIVE alternative preparation only. The ordinary H07 Interactions composition
 * remains unchanged. This constructor never activates itself, retries a failure,
 * discovers a credential or inherits catalogue reference authority.
 */
export async function composePreparedCloudReferenceRuntime(opts: PreparedCloudReferenceRuntimeOptions): Promise<LiveRuntime> {
  return composeRuntime(opts, { preparation: opts.referencePreparation, binding: opts.referenceBinding, accessToken: opts.referenceAccessToken });
}

export async function composePreparedCandidateCatalogueRuntime(opts: PreparedCandidateCatalogueRuntimeOptions): Promise<LiveRuntime> {
  return composeRuntime(opts, opts.cloudReference, { preparation: opts.cataloguePreparation, binding: opts.catalogueBinding });
}

async function composeRuntime(opts: LiveRuntimeOptions, cloudOptions?: {
  readonly preparation: unknown; readonly binding: unknown; readonly accessToken: CloudReferenceTokenLoader;
}, candidateOptions?: { readonly preparation: unknown; readonly binding: unknown }): Promise<LiveRuntime> {
  const clock = opts.clock ?? Date.now;
  const fail = (...problems: string[]): LiveRuntime => ({ ok: false, problems });
  const { loaders } = opts;
  let ticketmaster: TicketmasterPreparation | undefined;
  const preparedConcerts = opts.concerts;
  try {
    ticketmaster = opts.ticketmaster === undefined ? undefined : captureTicketmasterPreparation(opts.ticketmaster);
    if (ticketmaster && preparedConcerts) return fail('ticketmaster:conflicting_preparation');
  } catch { return fail('ticketmaster:shape'); }
  try {
    // This optional nested object belongs to the caller. Never reread it after a loader/store await.
    cloudOptions = cloudOptions ? Object.freeze({ preparation: cloudOptions.preparation, binding: cloudOptions.binding, accessToken: cloudOptions.accessToken }) : undefined;
  } catch { return fail('cloudReference:shape'); }

  // 1. Capture the exact constructor capability and base once, before any await.
  // A copied hosted config has no capability and must pass the unchanged local guard.
  const base = opts.config;
  const hosted = hostedServingOf(base);
  const config = snapshotConfig(base);
  if (!config) return fail('config:invalid');
  const configProblem = hosted ? hostedConfigProblem(config, hosted) : loopbackBaseConfigProblem(config);
  if (configProblem) return fail(configProblem);

  // 2. Binding validation, snapshot and agreement with the code, synchronously, before any await or loader.
  const v = validateLiveBindings(opts.bindings, clock());
  if (!v.ok) return fail(...v.problems);
  const b = v.bindings;
  if (b.liveListening) {
    if (cloudOptions || typeof opts.liveListeningAuthority !== 'function') return fail('liveListening:authority_required');
    try { opts.liveListeningAuthority(); } catch { return fail('liveListening:authority_refused'); }
  }
  if (hosted && !b.serving) return fail('serving:missing');
  if (!hosted && b.serving) return fail('serving:requires_hosted_config');
  if (hosted && b.serving && !sameHostedServing(hosted, b.serving)) return fail('serving:mismatch');
  if (b.exposurePolicy.expiresAt > b.expiresAt) return fail('exposurePolicy:outlives_binding');
  if (b.sourcePolicy.expiresAt > b.expiresAt) return fail('sourcePolicy:outlives_binding');
  let cloud: CloudReferenceBinding | null = null;
  if (cloudOptions) {
    const prepared = captureCloudReferencePreparation(cloudOptions.preparation, cloudOptions.binding, clock());
    if (!prepared.ok) return fail(...prepared.problems);
    const problem = cloudReferenceBindingProblem(prepared.binding, b);
    if (problem) return fail(problem);
    if (typeof cloudOptions.accessToken !== 'function') return fail('cloudReference:loader_missing');
    cloud = prepared.binding;
  }
  let candidate: CandidateCatalogueBinding | null = null;
  let candidateValidatedAt: number | null = null;
  if (candidateOptions) {
    const sampledAt = clock();
    const prepared = captureCandidateCataloguePreparation(candidateOptions.preparation, candidateOptions.binding, sampledAt);
    if (!prepared.ok) return fail(...prepared.problems);
    const problem = candidateCatalogueBindingProblem(prepared.binding, b);
    if (problem) return fail(problem);
    candidate = prepared.binding;
    candidateValidatedAt = sampledAt;
  }
  /** Authority is refreshed after every asynchronous step; it is never extended or renewed here. */
  let closed = false;
  const shutdown = new AbortController();
  let latestCandidateClock = candidateValidatedAt ?? 0;
  const lapsed = (): string | null => {
    if (closed) return 'runtime:closed';
    let t: number;
    try { t = clock(); } catch { return 'clock:invalid'; }
    if (!Number.isSafeInteger(t) || t < 0) return 'clock:invalid';
    if (candidate && t < latestCandidateClock) return 'clock:regressed';
    if (candidate) latestCandidateClock = t;
    if (t >= b.expiresAt) return 'expiresAt:expired';
    if (t >= b.exposurePolicy.expiresAt) return 'exposurePolicy:expired';
    if (t >= b.sourcePolicy.expiresAt) return 'sourcePolicy:expired';
    if (cloud && t >= cloud.expiresAt) return 'cloudReference.expiresAt:expired';
    if (candidate && t >= candidate.expiresAt) return 'candidateCatalogue.expiresAt:expired';
    return null;
  };

  // 3. Credentials and identity via the controller's loaders (never discovered here).
  const problems: string[] = [];
  const steps: [string, () => Promise<ServerSecret>][] = [
    ...(!cloud ? [['reference', () => loaders.secret(b.reference.credentialRef)] as [string, () => Promise<ServerSecret>]] : []),
    ['qloo', () => loaders.secret(b.qloo.credentialRef)],
    ['sealing', () => loaders.secret(b.sealing.keyRef)],
    ['catalogue_identity', () => loaders.googleAccessToken(b.catalogue.identityRef)],
  ];
  const beforeLoads = lapsed();
  if (beforeLoads) return fail(beforeLoads);
  const loaded = new Map<string, ServerSecret>();
  for (const [name, load] of steps) {
    try {
      const s = await load();
      if (s instanceof ServerSecret) loaded.set(name, s);
      else problems.push(`credential:${name}_unavailable`);
    } catch {
      // Safe code only; the loader's error may carry identifiers.
      problems.push(`credential:${name}_unavailable`);
    }
    const stop = lapsed();
    if (stop) return fail(stop);
  }
  const referenceKey = loaded.get('reference');
  const qlooKey = loaded.get('qloo');
  const sealingKey = loaded.get('sealing');
  if (sealingKey && sealingKey.reveal().length < MIN_SEALING_KEY_CHARS) problems.push('credential:sealing_too_short');
  if (problems.length > 0 || (!cloud && !referenceKey) || !qlooKey || !sealingKey || !loaded.has('catalogue_identity')) return fail(...problems);

  // 4. Shared store over the explicitly configured SDK client, given exactly the approved immutable policy snapshot.
  let db: AnyFirestore | ManagedDocStore;
  try {
    db = await loaders.firestore({ projectId: b.firestore.projectId, databaseId: b.firestore.databaseId });
  } catch {
    return fail('firestore:unavailable');
  }
  // Raw compatibility clients are borrowed; this gate closes their Store path
  // without terminating a resource the composition does not own.
  const docs = isManagedDocStore(db) ? db : manageDocStore(createFirestoreDocStore(db), async () => {});
  let localStore: FirestoreStore | undefined;
  const close = () => { closed = true; shutdown.abort('runtime_closed'); return docs.close(async () => { await localStore?.abandonLocalSubmissions(); }); };
  const afterStore = lapsed();
  if (afterStore) { await close(); return fail(afterStore); }
  try {
  const store = new FirestoreStore({
    docs,
    serviceId: b.serviceId,
    policy: b.exposurePolicySnapshot,
    clock,
    maxSessions: b.limits.maxSessions,
    maxJourneysPerSession: b.limits.maxJourneysPerSession,
    freeMutation: b.limits.freeMutation,
  });
  localStore = store;

  // 5. Genuine adapters. Every provider transport is gated at the moment it is
  // invoked (after any asynchronous credential preparation) by the effective
  // binding/financial-policy validity, and the reference transport also by the
  // source policy. Nothing is sent until a request arrives.
  const financialUntil = Math.min(b.expiresAt, b.exposurePolicy.expiresAt, candidate?.expiresAt ?? b.expiresAt);
  const runtimeTransport = (inner: HttpTransport, provider: ProviderName, until: number): HttpTransport => {
    const gated = gatedTransport(inner, provider, until, clock);
    return (request) => {
      if (closed) { request.observer?.transportNotInvoked(); return Promise.reject(new ProviderError(provider, 'config', false)); }
      return gated(request);
    };
  };
  const net: LiveNetwork = {
    ...(opts.network?.liveSocket ? { liveSocket: opts.network.liveSocket } : {}),
    reference: opts.network?.reference ?? createFetchTransport([cloud ? CLOUD_REFERENCE_PROFILE.origin : GEMINI_REFERENCE_PROFILE.endpoint.origin]),
    catalogue: opts.network?.catalogue ?? createFetchTransport([GEMINI_CATALOGUE_PROFILE.origin]),
    qloo: opts.network?.qloo ?? createFetchTransport([`https://${b.qloo.host}`]),
    resolve: opts.network?.resolve ?? nodeResolver,
    pinned: opts.network?.pinned ?? createNodePinnedHttpClient(),
  };
  const referenceUntil = Math.min(financialUntil, b.sourcePolicy.expiresAt, cloud?.expiresAt ?? b.expiresAt);
  const sourcePolicy = boundSourcePolicy(b.sourcePolicy, Math.min(b.expiresAt, cloud?.expiresAt ?? b.expiresAt));
  const baseReference = cloud && cloudOptions
      ? createGeminiCloudReferenceAdapter({ preparation: cloudOptions.preparation, binding: cloud, accessToken: cloudOptions.accessToken,
        transport: runtimeTransport(net.reference, 'gemini', referenceUntil), clock })
      : createGeminiReferenceAdapter({ transport: runtimeTransport(net.reference, 'gemini', referenceUntil), apiKey: referenceKey! });
  const checkLive = () => {
      opts.liveListeningAuthority!();
      if (closed || shutdown.signal.aborted || clock() >= referenceUntil || !sourcePolicy.allowsLiveAudio?.(clock())) throw new ProviderError('gemini', 'config', false);
  };
  const liveReference = b.liveListening ? createGeminiLiveReferenceAdapter({ apiKey: referenceKey!, socket: net.liveSocket, clock, checkAuthority: checkLive }) : null;
  const referenceAdapter = sourceGuarded(
    liveReference ? withLiveReference(baseReference, liveReference) : baseReference,
    sourcePolicy,
    clock,
  );
  // Recording-service capability comes only from the validated, frozen binding: the Apple
  // metadata verifier (and its public host) exists only when the binding enables apple_music.
  const metadataNet = { resolve: net.resolve, http: net.pinned, now: clock };
  const appleEnabled = b.recordingServices.includes('apple_music');
  const sourceResolver = createSourceResolver(metadataNet);
  const sealer = createRecordSealer(sealingKey);
  const catalogue = candidate ? createCandidateCatalogue({
    search: createAppleCatalogueSearch(metadataNet), searchSynthetic: false,
    gate: createAppleMetadataRateGate({ docs, serviceId: b.serviceId, expiresAt: Math.min(financialUntil, b.sourcePolicy.expiresAt), clock }),
    sealer, storefront: candidate.storefront, expiresAt: candidate.expiresAt,
    selector: createGeminiCandidateSelector({ transport: runtimeTransport(net.catalogue, 'gemini', Math.min(financialUntil, b.sourcePolicy.expiresAt)),
      project: candidate.projectId, quotaProject: candidate.quotaProjectId, accessToken: () => loaders.googleAccessToken(candidate!.identityRef) }),
    verifier: gatedVerifier(createAppleMusicVerifier(metadataNet), Math.min(financialUntil, b.sourcePolicy.expiresAt), clock),
  }) : createNativeCatalogue({
    sources: {
      synthetic: false,
      check(source, ctx) {
        if (lapsed()) return Promise.resolve({ ok: false, reason: 'deadline' });
        return sourceResolver.check(source, { ...ctx, signal: AbortSignal.any([ctx.signal, shutdown.signal]), deadlineAt: Math.min(ctx.deadlineAt, financialUntil, b.sourcePolicy.expiresAt) });
      },
    },
    adapter: createGeminiCatalogueAdapter({
      transport: runtimeTransport(net.catalogue, 'gemini', financialUntil),
      project: b.catalogue.projectId,
      quotaProject: b.catalogue.quotaProjectId,
      accessToken: () => loaders.googleAccessToken(b.catalogue.identityRef),
    }),
    verifier: gatedVerifier(createYouTubeVerifier(metadataNet), financialUntil, clock),
    ...(appleEnabled ? { appleVerifier: gatedVerifier(createAppleMusicVerifier(metadataNet), financialUntil, clock) } : {}),
    services: b.recordingServices,
  });
  const qloo = createQlooClient({ transport: runtimeTransport(net.qloo, 'qloo', financialUntil), apiKey: qlooKey, host: b.qloo.host });
  const liveConfig: Config = Object.freeze({
    ...config,
    mode: 'live',
    maxSessions: b.limits.maxSessions,
    maxJourneysPerSession: b.limits.maxJourneysPerSession,
    freeMutation: b.limits.freeMutation,
  });
  const handler = createApiHandler({
    config: liveConfig,
    store,
    referenceAdapter,
    discovery: { qloo, qlooSynthetic: false, catalogue, sealer },
    sourcePolicy,
    shutdown: shutdown.signal,
    ...(b.liveListening ? { liveListeningAuthority: checkLive } : {}),
    ...(preparedConcerts ? { concerts: preparedConcerts } : ticketmaster ? { concerts: createTicketmasterSearch({
      access: () => lapsed() ? null : ticketmaster!.access(),
      admit: createTicketmasterRateGate({ docs, serviceId: b.serviceId, dailyLimit: ticketmaster.dailyLimit, expiresAt: financialUntil, now: clock }),
      transport: createFetchTransport(['https://app.ticketmaster.com']), now: clock,
    }) } : {}),
    now: clock,
  });
  // Final authority refresh before handing out a usable handler.
  const atReturn = lapsed();
  if (atReturn) { await close(); return fail(atReturn); }
  composedStores.add(store);
  const validUntil = Math.min(referenceUntil, candidate?.expiresAt ?? referenceUntil);
  const runtime = Object.freeze({ ok: true as const, handler, store, bindings: b, config: liveConfig, validUntil, close,
    ...(cloud ? { cloudReference: cloud } : {}), ...(candidate ? { candidateCatalogue: candidate } : {}) });
  composedRuntimes.set(runtime, Object.freeze({ config: liveConfig, handler, store, validUntil, clock, lapsed, close }));
  return runtime;
  } catch {
    // Once the managed store was acquired, every failed construction path must revoke and drain it.
    await close().catch(() => {});
    return fail('runtime:construction_failed');
  }
}

/** A plain frozen copy of the base config, read once; null if it is not a plain readable object. */
function snapshotConfig(c: unknown): Config | null {
  try {
    const copy = structuredClone(c) as Config;
    if (typeof copy !== 'object' || copy === null || typeof copy.freeMutation !== 'object' || copy.freeMutation === null) return null;
    Object.freeze(copy.freeMutation);
    return Object.freeze(copy);
  } catch {
    return null;
  }
}

export type LiveServerStart =
  | { readonly ok: true; readonly server: Server; readonly origin: string; readonly close: () => Promise<void> }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Controller-only start seam. Serves a runtime returned by composeLiveRuntime
 * (the exact object; a copy, spoof or failed result is refused) through the
 * one canonical server: same static client, API routing, Host/CSP/content-type
 * handling and timeouts as the ordinary CLI, on the composition's own frozen
 * backend config. Hosted authority additionally requires the exact HTTPS-profile
 * constructor and matching explicit binding. Authority is checked before and after binding the port;
 * the server closes itself when the runtime's validity ends. Nothing in the
 * repository calls this: live remains inactive.
 */
export async function startLiveServer(runtime: unknown, opts: { readonly clientRoot?: string; readonly desktopProbe?: DesktopProbe } = {}): Promise<LiveServerStart> {
  const fail = (...problems: string[]): LiveServerStart => ({ ok: false, problems });
  const auth = typeof runtime === 'object' && runtime !== null ? composedRuntimes.get(runtime) : undefined;
  if (!auth) return fail('runtime:not_composed');
  const storeProblem = liveStoreRefusal(auth.store);
  if (storeProblem) return fail('runtime:store_refused');
  const before = auth.lapsed();
  if (before) {
    if (before !== 'runtime:closed') await auth.close();
    return fail(before);
  }
  if (startClaims.has(auth)) return fail('runtime:already_started');
  startClaims.add(auth); // Claim synchronously, before listen can yield to another caller.
  const server = createWintrServer(auth.config, auth.handler, { clientRoot: opts.clientRoot, desktopProbe: opts.desktopProbe });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    auth.handler.closeLive?.();
    const draining = auth.close(); // Invalidate Store entry before HTTP teardown.
    const stopped = new Promise<void>((done) => {
      clearTimeout(timer);
      if (!server.listening) return done();
      server.close(() => done());
      server.closeAllConnections();
    });
    closing = Promise.all([draining, stopped]).then(() => {});
    return closing;
  };
  try {
    await listen(server, auth.config);
  } catch {
    await auth.close();
    return fail('server:listen_failed');
  }
  const after = auth.lapsed();
  if (after) {
    await close();
    return fail(after);
  }
  const arm = () => {
    const t = auth.clock();
    if (auth.lapsed() || !(t < auth.validUntil)) {
      // Automatic expiry stays fail-closed; the same rejected close promise
      // remains observable to an explicit controller close call.
      void close().catch(() => {});
      return;
    }
    timer = setTimeout(arm, Math.min(auth.validUntil - t, MAX_TIMER_MS));
    timer.unref();
  };
  arm();
  return { ok: true, server, origin: auth.config.origin, close };
}

const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Provider transport gate: checked synchronously at the moment of sending, so
 * expiry during asynchronous preparation (such as a token fetch) can never
 * reach the network. A refusal after durable intent stays held (unknown),
 * never refunded or retried.
 */
export function gatedTransport(inner: HttpTransport, provider: ProviderName, validUntil: number, clock: () => number): HttpTransport {
  return (req) => {
    const t = clock();
    if (!(Number.isSafeInteger(t) && t >= 0 && t < validUntil)) {
      req.observer?.transportNotInvoked(); return Promise.reject(new ProviderError(provider, 'config', false));
    }
    return inner(req);
  };
}

/**
 * Metadata verifier gate. Once the binding or exposure policy has lapsed (or the
 * clock is unusable) no metadata request is made at all: an explicit unavailable
 * gap, never a fallback. The effective validity also bounds the inner operation
 * itself: its deadline is the earlier of the execute's and `validUntil`, so the
 * fetch guard's own re-authorisation after DNS (and before every hop) refuses a
 * connection if validity ended while the lookup was pending. No refresh, retry
 * or extension.
 */
export function gatedVerifier(inner: DestinationVerifier, validUntil: number, clock: () => number): DestinationVerifier {
  return {
    synthetic: inner.synthetic,
    lookup(destination, ctx) {
      const t = clock();
      if (!(Number.isSafeInteger(t) && t >= 0 && t < validUntil)) return Promise.resolve({ ok: false, gap: 'destination_unavailable' });
      return inner.lookup(destination, { ...ctx, deadlineAt: Math.min(ctx.deadlineAt, validUntil) });
    },
  };
}

/** Explicit SDK settings: a project, a database and exactly one explicit auth source. */
type ExplicitSdkSettings = FirestoreSettings & ({ readonly credentials: { readonly client_email: string; readonly private_key: string } } | { readonly authClient: AuthClient });

/** The single place the official SDK is loaded and constructed (only when a controller-invoked factory runs). */
async function constructOfficialFirestore(settings: ExplicitSdkSettings): Promise<ManagedDocStore> {
  const { Firestore } = await import('@google-cloud/firestore');
  return createOwnedFirestoreDocStore(sdkOwnedFirestoreSatisfiesAdapter(new Firestore(settings)));
}

/** Explicit service-account credential fields, supplied by the controller's approved path when the factory runs. */
export interface ExplicitFirestoreCredentials {
  readonly client_email: string;
  readonly private_key: string;
}

/**
 * Firestore factory with explicit service-account credentials. The SDK is
 * imported only when the factory is invoked, with an explicit project,
 * database and credentials, so no Application Default Credentials file or
 * project discovery is used and nothing happens at import or in
 * disabled/synthetic startup.
 */
export function createOfficialFirestoreFactory(loadCredentials: () => Promise<ExplicitFirestoreCredentials>): FirestoreFactory {
  return async (settings) => {
    const credentials = await loadCredentials();
    const ok = (s: unknown) => typeof s === 'string' && s.trim() !== '' && s.length <= 16 * 1024;
    if (!credentials || !ok(credentials.client_email) || !ok(credentials.private_key)) throw new Error('firestore credentials unavailable');
    return constructOfficialFirestore({
      projectId: settings.projectId,
      databaseId: settings.databaseId,
      credentials: { client_email: credentials.client_email, private_key: credentials.private_key },
    });
  };
}

/** A deliberately injected, already-authorised short-lived Google auth client and its typed expiry. */
export interface ShortLivedGoogleAuth {
  readonly client: AuthClient;
  /** Ms epoch at which the injected authorisation ends; the factory refuses at or after it. */
  readonly expiresAt: number;
}

/**
 * Keyless Firestore factory. Firestore 9.3.1 passes its settings to the
 * google-gax client, whose GrpcClient constructs `options.auth || new
 * GoogleAuth(options)`; google-auth-library's GoogleAuth then uses
 * `authClient` as its credential (no credential discovery) and the explicit
 * `projectId` (no project discovery). The client is injected by the
 * controller's approved identity route; this code never creates, looks up,
 * impersonates or refreshes an identity, reads no file and makes no request.
 * Its expiry is checked here; afterwards the SDK fails closed on auth errors.
 */
export function createKeylessFirestoreFactory(loadAuth: () => Promise<ShortLivedGoogleAuth>, clock: () => number = Date.now): FirestoreFactory {
  return async (settings) => {
    const injected = await loadAuth();
    const t = clock();
    const client = injected?.client as { getRequestHeaders?: unknown } | undefined;
    if (typeof client !== 'object' || client === null || typeof client.getRequestHeaders !== 'function') throw new Error('firestore identity unavailable');
    if (!Number.isSafeInteger(injected.expiresAt) || !Number.isSafeInteger(t) || t < 0 || injected.expiresAt <= t) throw new Error('firestore identity expired');
    // Compile-time agreement with the official GoogleAuth options the SDK forwards.
    const auth: GoogleAuthOptions<AuthClient> = { projectId: settings.projectId, authClient: injected.client };
    return constructOfficialFirestore({ projectId: settings.projectId, databaseId: settings.databaseId, authClient: auth.authClient! });
  };
}

/** Explicit ongoing owner approval, with a guarded refreshable client; no ADC discovery. */
export function createPersonalFirestoreFactory(client: AuthClient, checkAuthority: () => void): FirestoreFactory {
  return async settings => {
    checkAuthority();
    const docs = await constructOfficialFirestore({ projectId: settings.projectId, databaseId: settings.databaseId, authClient: client });
    try { checkAuthority(); return docs; }
    catch (error) { await docs.close(); throw error; }
  };
}
