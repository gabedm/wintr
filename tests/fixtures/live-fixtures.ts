import type { FirestoreSettings, LiveLoaders } from '../../src/server/live-runtime.js';
import type { ProviderRequest, ProviderResponse } from '../../src/server/providers/http.js';
import { ServerSecret } from '../../src/server/providers/secret.js';
import { catalogueTransport, envelope, fakeNetwork, VID, type AppleEntry, type FixtureChoice, type MetaEntry } from './catalogue-fixtures.js';
import { FakeFirestore, type FakeFirestoreServer } from './fake-firestore.js';

// Shared synthetic live-composition fixtures: an invented complete binding,
// counted loaders and counted synthetic provider transports. Every value is
// invented; nothing here is a real credential, source, account or output.

export const HOUR = 3_600_000;
export const APPROVED = 'invRefAAA01';
export const NOT_APPROVED = 'invRefZZZ99';
export const SECRETS: Record<string, string> = {
  'secrets/invented-reference-key': 'invented-reference-api-key-0001',
  'secrets/invented-qloo-key': 'invented-qloo-api-key-0001',
  'secrets/invented-sealing-key': 'invented-sealing-key-material-00000000000001',
  'secrets/invented-sealing-key-2': 'invented-sealing-key-material-00000000000002',
};
export const BEARER = 'invented-bearer-token-0001';

/**
 * A live binding refuses the reserved XTS test currency, so these synthetic
 * composition fixtures declare EUR with invented amounts. The label carries no
 * pricing or monetary authority; every result here is synthetic.
 */
export const policy = (expiresAt: number, currency = 'EUR') => ({
  version: 'approved-policy-invented-1',
  currency,
  expiresAt,
  service: { capUnits: 1_000_000, concurrency: 8, counts: { qloo: 600, gemini: 400 } },
  session: { capUnits: 100_000, counts: { qloo: 6, gemini: 4 } },
  journey: { capUnits: 100_000, counts: { qloo: 6, gemini: 4 } },
  reservations: {
    reference_analysis: { units: 300, bound: 'estimate_with_residual' },
    qloo_search: { units: 10, bound: 'enforceable' },
    qloo_artist_insights: { units: 10, bound: 'enforceable' },
    qloo_tag_insights: { units: 10, bound: 'enforceable' },
    catalogue_generation: { units: 500, bound: 'estimate_with_residual' },
  },
});

export const binding = (o: Record<string, unknown> = {}) => {
  const t = Date.now();
  return {
    profile: 'live',
    bindingVersion: 'binding-invented-1',
    expiresAt: t + 2 * HOUR,
    serviceId: 'svc-invented-live',
    serviceIdentity: 'runtime-invented',
    settlementOwner: 'owner-invented',
    exposurePolicy: policy(t + 2 * HOUR),
    sourcePolicy: { version: 'sources-invented-1', expiresAt: t + 2 * HOUR, videoIds: [APPROVED, 'invRefAAA02'] },
    limits: { sessionLifetimeMs: HOUR, executeDeadlineMs: 120_000, providerRequestMs: 90_000, maxSessions: 20, maxJourneysPerSession: 3, freeMutation: { perSession: 30, perService: 300, windowMs: 60_000 } },
    firestore: {
      projectId: 'invented-store-project',
      databaseId: '(default)',
      ownedTtl: { collections: ['wintr_owned', 'wintr_owned_content'], field: 'expireAt' },
      reconciliationIndex: { collection: 'wintr_ledger_reservations', fields: ['service', 'state'] },
    },
    reference: { model: 'gemini-3.6-flash', credentialRef: 'secrets/invented-reference-key' },
    catalogue: { model: 'gemini-3.6-flash', location: 'global', projectId: 'invented-catalogue-proj', quotaProjectId: 'invented-quota-proj', identityRef: 'identities/invented-catalogue' },
    qloo: { host: 'hackathon.api.qloo.com', credentialRef: 'secrets/invented-qloo-key' },
    sealing: { keyRef: 'secrets/invented-sealing-key' },
    ...o,
  };
};

export interface LoaderOptions {
  failSecret?: string;
  failIdentity?: boolean;
  /** Runs inside the n-th secret load, before it resolves. */
  onSecret?: (n: number) => void;
  /** Runs inside the n-th access-token load, before it resolves. */
  onToken?: (n: number) => void;
  onFirestore?: () => void;
  client?: (db: FakeFirestoreServer) => FakeFirestore;
}

export function loaders(db: FakeFirestoreServer, o: LoaderOptions = {}) {
  const calls = { secret: [] as string[], token: 0, firestore: [] as FirestoreSettings[] };
  const l: LiveLoaders = {
    secret: async (ref) => {
      calls.secret.push(ref);
      await Promise.resolve();
      o.onSecret?.(calls.secret.length);
      if (ref === o.failSecret || !(ref in SECRETS)) throw new Error(`secret ${ref} unavailable`);
      return new ServerSecret(SECRETS[ref]!);
    },
    googleAccessToken: async () => {
      calls.token += 1;
      await Promise.resolve();
      o.onToken?.(calls.token);
      if (o.failIdentity) throw new Error('identity unavailable for runtime-invented');
      return new ServerSecret(BEARER);
    },
    firestore: async (settings) => {
      calls.firestore.push(settings);
      await Promise.resolve();
      o.onFirestore?.();
      return o.client ? o.client(db) : new FakeFirestore(db);
    },
  };
  return { calls, loaders: l };
}

// ---------------------------------------------------------------------------
// Synthetic provider transports (invented data, counted).

export const uid = (n: number) => `40000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const artist = (n: number, name: string) => ({ entity_id: uid(n), name, subtype: 'urn:entity:artist' });
export const json = (status: number, value: unknown): ProviderResponse => ({ status, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify(value)) });
export const POOL_X = [artist(11, 'Neighbour X11'), artist(12, 'Neighbour X12'), artist(13, 'Neighbour X13')];
export const POOL_F = [artist(11, 'Neighbour X11'), artist(31, 'Neighbour F31'), artist(32, 'Neighbour F32')];
export const metaFor = (anchor: string, title: string) => ({ title: `${anchor} - ${title} (Official Audio)`, author_name: anchor });
export const THREE: FixtureChoice[] = POOL_X.map((a, i) => ({ title: `Invented Song ${i + 1}`, artists: [a.name], anchor: a.name, videoId: VID(i + 1) }));
export const META: Record<string, MetaEntry> = {
  ...Object.fromEntries(THREE.map((c) => [c.videoId, metaFor(c.anchor, c.title)])),
  [VID(31)]: metaFor('Neighbour F31', 'Fresh Song 1'),
};
export const FOLLOW = envelope([{ title: 'Fresh Song 1', artists: ['Neighbour F31'], anchor: 'Neighbour F31', videoId: VID(31) }]);

export function transports(o: { catalogue503?: boolean; initial?: readonly FixtureChoice[]; apple?: Record<string, AppleEntry> } = {}) {
  const reference: ProviderRequest[] = [];
  const qloo: ProviderRequest[] = [];
  const cat = catalogueTransport(() => (o.catalogue503 ? json(503, {}) : cat.calls.length === 1 ? envelope(o.initial ?? THREE) : FOLLOW));
  const net = fakeNetwork(META, {}, o.apple);
  const output = { audio_access: 'accessed', observations: ['An invented close bass line.'], relationships: ['The invented groove', 'The invented vocal'], artist_name: 'Generic Artist' };
  return {
    reference,
    qloo,
    cat,
    net,
    network: {
      reference: async (req: ProviderRequest) => {
        reference.push(req);
        return json(200, { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: JSON.stringify(output) }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 10 } });
      },
      qloo: async (req: ProviderRequest) => {
        qloo.push(req);
        if (req.url.pathname === '/search') {
          const q = (req.url.searchParams.get('query') ?? '').toLowerCase();
          return q === 'generic artist' ? json(200, { results: [artist(1, 'Generic Artist')] }) : q === 'other artist' ? json(200, { results: [artist(2, 'Other Artist')] }) : json(404, {});
        }
        if (req.url.searchParams.get('filter.type') === 'urn:tag') return json(200, { success: true, results: { tags: [] } });
        const follow = (req.url.searchParams.get('signal.interests.entities') ?? '').split(',').some((e) => [uid(11), uid(12), uid(13)].includes(e));
        return json(200, { success: true, results: { entities: follow ? POOL_F : POOL_X } });
      },
      catalogue: cat.transport,
      resolve: net.resolve,
      pinned: net.http,
    },
  };
}
