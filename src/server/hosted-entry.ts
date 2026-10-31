import { lookup } from 'node:dns/promises';
import { createFetchTransport, type HttpTransport } from './providers/http.js';
import { createNodePinnedHttpClient } from './net/safe-fetch.js';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Compute } from 'google-auth-library';
import { loadConfig } from './config.js';
import { createHostedBaseConfig } from './serving-profile.js';
import { validateLiveBindings } from './live-bindings.js';
import { composePreparedCandidateCatalogueRuntime, createPersonalFirestoreFactory, type LiveLoaders } from './live-runtime.js';
import { CANDIDATE_CATALOGUE_PROFILE, createCandidateCataloguePreparation } from './candidate-catalogue-profile.js';
import { ServerSecret } from './providers/secret.js';
import { createWintrServer, listen } from './http-server.js';
import { createJudgeAccess } from './judge-access.js';
import { refuseDuplicateKeys } from './providers/json-keys.js';

/** Configuration is supplied through a private runtime secret, never bundled into the web app. */
export function prepareHostedConfiguration(text: string, port: string) {
  const fail = () => Error('hosted_configuration_refused');
  if (Buffer.byteLength(text) > 131072 || !/^[1-9][0-9]{0,4}$/.test(port)) throw fail();
  refuseDuplicateKeys(text, fail); const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'bindings,serviceAccountEmail,storefront' ||
    typeof raw.serviceAccountEmail !== 'string' || !/^[a-z][a-z0-9-]{4,62}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(raw.serviceAccountEmail) || !/^[a-z]{2}$/.test(raw.storefront)) throw fail();
  const validated = validateLiveBindings(raw.bindings, Date.now());
  if (!validated.ok || !validated.bindings.serving || !validated.bindings.liveListening || !validated.bindings.recordingServices.includes('apple_music')) throw fail();
  const b = validated.bindings;
  if (b.serving!.listenHost !== '0.0.0.0' || b.serving!.listenPort !== Number(port)) throw fail();
  const base = createHostedBaseConfig(loadConfig([], {}), b.serving); if (!base.ok) throw fail();
  const candidate = { ...CANDIDATE_CATALOGUE_PROFILE, bindingVersion: b.bindingVersion, serviceId: b.serviceId, serviceIdentity: b.serviceIdentity,
    sourcePolicyVersion: b.sourcePolicy.version, exposurePolicyVersion: b.exposurePolicy.version, projectId: b.catalogue.projectId,
    quotaProjectId: b.catalogue.quotaProjectId, identityRef: b.catalogue.identityRef, storefront: raw.storefront, expiresAt: Math.min(b.expiresAt, b.sourcePolicy.expiresAt, b.exposurePolicy.expiresAt) };
  const prepared = createCandidateCataloguePreparation(candidate); if (!prepared.ok) throw fail();
  return { rawBindings: raw.bindings, bindings: b, config: base.config, candidate, preparation: prepared.preparation, serviceAccountEmail: raw.serviceAccountEmail as string };
}

async function main() {
  // A Cloud Run service identity is used directly. No Windows profile, user refresh
  // token, service-account private key, ambient ADC file or project discovery.
  if (!process.env.K_SERVICE || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GCE_METADATA_HOST || process.env.GCE_METADATA_IP || process.env.GCE_METADATA_ROOT) throw Error('hosted_identity_refused');
  const file = process.env.WINTR_RUNTIME_CONFIG_FILE;
  if (!file || !file.startsWith('/')) throw Error('hosted_configuration_refused');
  const read = () => { if (!statSync(file).isFile() || statSync(file).size > 131072) throw Error('hosted_configuration_refused'); const bytes = readFileSync(file); if (bytes.length > 131072) throw Error('hosted_configuration_refused'); return bytes.toString('utf8'); };
  const text = read(), prepared = prepareHostedConfiguration(text, process.env.PORT ?? '8080');
  const names = ['WINTR_GEMINI_API_KEY', 'WINTR_QLOO_API_KEY', 'WINTR_SEALING_KEY', 'WINTR_JUDGE_ACCESS_SHA256', 'WINTR_TICKETMASTER_API_KEY'] as const;
  const secrets = Object.fromEntries(names.map(name => [name, process.env[name] ?? '']));
  for (const name of names.slice(0, 4)) if (!secrets[name] || secrets[name]!.length > 16384 || /[\r\n\0]/.test(secrets[name]!)) throw Error('hosted_secret_refused');
  const fingerprint = createHash('sha256').update(text).digest('hex');
  const check = () => { if (createHash('sha256').update(read()).digest('hex') !== fingerprint || names.some(name => (process.env[name] ?? '') !== secrets[name]) || Date.now() >= prepared.candidate.expiresAt) throw Error('hosted_authority_changed'); };
  const identity = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email', { headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!identity.ok || identity.headers.get('metadata-flavor') !== 'Google' || (await identity.text()).trim() !== prepared.serviceAccountEmail) throw Error('hosted_identity_refused');
  check(); const client = new Compute({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const b = prepared.bindings;
  const loaders: LiveLoaders = { firestore: createPersonalFirestoreFactory(client, check),
    secret: async ref => { check(); const value = ref === b.reference.credentialRef ? secrets.WINTR_GEMINI_API_KEY : ref === b.qloo.credentialRef ? secrets.WINTR_QLOO_API_KEY : ref === b.sealing.keyRef ? secrets.WINTR_SEALING_KEY : null; if (!value) throw Error('hosted_secret_refused'); return new ServerSecret(value); },
    googleAccessToken: async ref => { check(); if (ref !== b.catalogue.identityRef) throw Error('hosted_identity_refused'); const token = await client.getAccessToken(); check(); if (!token.token) throw Error('hosted_identity_refused'); return new ServerSecret(token.token); } };
  const guarded = (transport: HttpTransport): HttpTransport => async request => { check(); const result = await transport(request); check(); return result; };
  const pinned = createNodePinnedHttpClient();
  const runtime = await composePreparedCandidateCatalogueRuntime({ config: prepared.config, bindings: prepared.rawBindings, loaders,
    network: { reference: guarded(createFetchTransport(['https://generativelanguage.googleapis.com'])), catalogue: guarded(createFetchTransport(['https://aiplatform.googleapis.com'])), qloo: guarded(createFetchTransport(['https://'+b.qloo.host])), resolve: async host => { check(); const addresses = await lookup(host,{all:true,verbatim:true}); check(); return addresses.map(a=>a.address); }, pinned: async request => { check(); const result = await pinned(request); check(); return result; } },
    catalogueBinding: prepared.candidate, cataloguePreparation: prepared.preparation, liveListeningAuthority: check,
    ...(secrets.WINTR_TICKETMASTER_API_KEY ? { ticketmaster: { access: () => { check(); return { apiKey: secrets.WINTR_TICKETMASTER_API_KEY!, validUntil: prepared.candidate.expiresAt }; }, dailyLimit: 250 } } : {}) });
  if (!runtime.ok) throw Error('hosted_runtime_refused');
  try {
    check(); await runtime.store.recoverExpiredSubmissions(); check();
    // Refuse an absent accounting domain. Startup must not create fresh allowances.
    if (!(await runtime.store.reconciliation().totals())) throw Error('hosted_accounting_unavailable');
    const access = createJudgeAccess(runtime.config, runtime.handler, { tokenHash: secrets.WINTR_JUDGE_ACCESS_SHA256!, sealingKey: secrets.WINTR_SEALING_KEY!, expiresAt: runtime.validUntil, checkAuthority: check });
    const server = createWintrServer(runtime.config, access.api, { web: access.web });
    server.on('upgrade', (req, socket) => { if ((req.url ?? '').split('?')[0] !== '/api/live-reference') socket.destroy(); });
    const close = async () => { access.api.closeLive?.(); const drain = runtime.close(); server.close(); server.closeAllConnections(); await drain; };
    server.once('close', () => { void runtime.close().catch(() => {}); });
    await listen(server, runtime.config); try { check(); } catch { await close(); throw Error('hosted_authority_changed'); }
    const lifetime = setInterval(() => { try { check(); } catch { void close().catch(() => {}); } }, 1000); lifetime.unref();
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { clearInterval(lifetime); void close().finally(() => process.exit()); });
    console.log('[wintr] hosted service ready');
  } catch { await runtime.close(); throw Error('hosted_startup_refused'); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void main().catch(() => { console.error('[wintr] hosted startup refused'); process.exitCode = 1; });
