import { createApiHandler, type ApiHandler } from './app.js';
import type { Config } from './config.js';
import { createNativeCatalogue } from './native-catalogue.js';
import { createQlooClient } from './providers/qloo.js';
import { ServerSecret } from './providers/secret.js';
import { createSyntheticReferenceAdapter } from './reference.js';
import { createEphemeralSealer } from './seal.js';
import { MemoryStore } from './store.js';
import { createSyntheticCatalogue } from './synthetic-catalogue.js';
import { createSyntheticQlooTransport } from './synthetic-qloo.js';

/**
 * The ordinary CLI composition: disabled, or clearly labelled synthetic over
 * local fixtures and the synthetic-only MemoryStore. It takes no credentials,
 * loaders or SDK factory and constructs no network transport, so it cannot
 * reach a provider. Live is composed only by live-runtime.ts from an explicit
 * controller binding; this function refuses it.
 */
export function createLocalApi(config: Config): ApiHandler {
  if (config.mode === 'live') throw new Error('live mode is composed only from an explicit controller binding');
  const synthetic = config.mode === 'synthetic';
  return createApiHandler({
    config,
    store: new MemoryStore(config),
    referenceAdapter: synthetic ? createSyntheticReferenceAdapter(config.syntheticDelayMs) : null,
    // Synthetic mode only: the genuine Qloo client over a labelled local fixture transport (no network, no credential).
    discovery: synthetic
      ? {
          qloo: createQlooClient({
            transport: createSyntheticQlooTransport(),
            apiKey: new ServerSecret('synthetic-local-fixture-not-a-credential'),
            host: 'hackathon.api.qloo.com',
          }),
          qlooSynthetic: true,
          // Genuine catalogue adapter, parser and verifier over the labelled local fixture.
          catalogue: createNativeCatalogue(createSyntheticCatalogue()),
          sealer: createEphemeralSealer(),
        }
      : null,
  });
}
