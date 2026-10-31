import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import { validateLiveBindings } from '../src/server/live-bindings.js';
import { composeLiveRuntime, type LiveLoaders } from '../src/server/live-runtime.js';
import { binding } from './fixtures/live-fixtures.js';

// Pure in-process controller-input regressions. All values are invented and no
// loader, SDK, DNS, HTTP listener or provider is used.
function replace(raw: unknown, path: string, value: unknown) {
  const parts = path.split('.');
  let target = raw as Record<string, unknown>;
  for (const key of parts.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[parts.at(-1)!] = value;
}

const undefinedPaths = [
  'profile', 'serviceId', 'serviceIdentity', 'settlementOwner', 'expiresAt',
  'reference.model', 'reference.credentialRef', 'catalogue.model', 'catalogue.location',
  'catalogue.projectId', 'catalogue.quotaProjectId', 'catalogue.identityRef',
  'qloo.host', 'qloo.credentialRef', 'sealing.keyRef',
  'limits.sessionLifetimeMs', 'limits.executeDeadlineMs', 'limits.providerRequestMs',
  'limits.maxSessions', 'limits.maxJourneysPerSession', 'limits.freeMutation.perSession',
  'firestore.projectId', 'firestore.databaseId', 'firestore.ownedTtl.field',
  'firestore.ownedTtl.collections', 'firestore.reconciliationIndex.collection',
] as const;

describe('complete own-data live binding boundary', () => {
  it.each(['recordingServices', 'credentialRef'] as const)('does not read ambient prototype authority for an absent %s', field => {
    const raw = binding();
    if (field === 'credentialRef') delete (raw.reference as Partial<typeof raw.reference>).credentialRef;
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, field);
    let reads = 0;
    try {
      Object.defineProperty(Object.prototype, field, { configurable: true, get: () => {
        reads += 1;
        return field === 'recordingServices' ? ['youtube', 'apple_music'] : 'secrets/invented-reference-key';
      } });
      const result = validateLiveBindings(raw, Date.now());
      expect(reads).toBe(0);
      if (field === 'recordingServices') {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.bindings.recordingServices).toEqual(['youtube']);
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.problems).toContain('reference.credentialRef:missing');
      }
    } finally {
      if (previous) Object.defineProperty(Object.prototype, field, previous);
      else Reflect.deleteProperty(Object.prototype, field);
    }
  });

  it.each(['firestore.ownedTtl.collections', 'firestore.reconciliationIndex.fields'])('rejects coerced arrays at %s', path => {
    const raw = binding();
    const values = path.endsWith('collections') ? raw.firestore.ownedTtl.collections : raw.firestore.reconciliationIndex.fields;
    replace(raw, path, values.map(value => [value]));
    expect(validateLiveBindings(raw, Date.now()).ok).toBe(false);
  });

  it.each(['firestore.ownedTtl.collections', 'firestore.reconciliationIndex.fields'])('fails closed without coercing objects at %s', path => {
    const raw = binding();
    replace(raw, path, [{ toString: 'not callable' }, 'invented']);
    expect(() => validateLiveBindings(raw, Date.now())).not.toThrow();
    expect(validateLiveBindings(raw, Date.now()).ok).toBe(false);
  });

  it.each(undefinedPaths)('refuses explicit undefined at %s before any loader', async path => {
    const raw = binding();
    replace(raw, path, undefined);
    expect(validateLiveBindings(raw, Date.now()).ok).toBe(false);
    let calls = 0;
    const forbidden = async (): Promise<never> => { calls += 1; throw new Error('unexpected invented loader'); };
    const loaders: LiveLoaders = { secret: forbidden, googleAccessToken: forbidden, firestore: forbidden };
    const runtime = await composeLiveRuntime({ config: loadConfig([], {}), bindings: raw, loaders });
    expect(runtime.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it.each(['top level', 'nested provider', 'nested source policy', 'nested exposure policy'])('refuses %s inherited fields', level => {
    const raw = binding();
    const value = level === 'top level' ? Object.create(raw) : raw;
    if (level === 'nested provider') raw.reference = Object.create(raw.reference);
    if (level === 'nested source policy') raw.sourcePolicy = Object.create(raw.sourcePolicy);
    if (level === 'nested exposure policy') raw.exposurePolicy = Object.create(raw.exposurePolicy);
    expect(validateLiveBindings(value, Date.now()).ok).toBe(false);
  });

  it.each(['reference', 'sourcePolicy', 'exposurePolicy', 'limits'])('refuses accessors in %s without evaluating them', field => {
    const raw = binding();
    const nested = raw[field as keyof typeof raw] as Record<string, unknown>;
    const key = Object.keys(nested)[0]!;
    const original = nested[key];
    let reads = 0;
    Object.defineProperty(nested, key, { enumerable: true, get: () => { reads += 1; return original; } });
    expect(validateLiveBindings(raw, Date.now()).ok).toBe(false);
    expect(reads).toBe(0);
  });

  it('refuses array accessors without evaluating them, symbols, hidden extras and cyclic input', () => {
    let reads = 0;
    const accessor = binding();
    Object.defineProperty(accessor.sourcePolicy.videoIds, '0', { enumerable: true, get: () => { reads += 1; return 'invRefAAA01'; } });
    expect(validateLiveBindings(accessor, Date.now()).ok).toBe(false);
    expect(reads).toBe(0);
    const symbol = binding();
    Object.defineProperty(symbol.reference, Symbol('invented-private-extra'), { value: true });
    expect(validateLiveBindings(symbol, Date.now()).ok).toBe(false);
    const hidden = binding();
    Object.defineProperty(hidden.reference, 'invented-private-extra', { value: true });
    expect(validateLiveBindings(hidden, Date.now()).ok).toBe(false);
    const cyclic = binding() as unknown as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(validateLiveBindings(cyclic, Date.now()).ok).toBe(false);
  });

  it.each(['top level', 'nested'])('unknown %s property names never enter diagnostics', level => {
    const raw = binding() as unknown as Record<string, unknown>;
    const target = level === 'top level' ? raw : raw.reference as Record<string, unknown>;
    target['invented-private-material-as-field-name'] = 'invented-private-value';
    const result = validateLiveBindings(raw, Date.now());
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('invented-private');
    expect(result).toMatchObject({ problems: [level === 'top level' ? 'binding:extra' : 'reference:extra'] });
  });

  it('accepts and snapshots plain valid data, including safely shared nested objects', () => {
    const raw = binding();
    raw.exposurePolicy.journey = raw.exposurePolicy.session;
    const result = validateLiveBindings(raw, Date.now());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    raw.reference.credentialRef = 'secrets/invented-replacement';
    expect(result.bindings.reference.credentialRef).toBe('secrets/invented-reference-key');
    expect(Object.isFrozen(result.bindings)).toBe(true);
  });
});
