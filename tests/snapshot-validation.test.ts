import { describe, expect, it } from 'vitest';
import { createApi, describeError, type TransportDeps } from '../src/client/api.js';
import { isSafeSnapshot } from '../src/client/snapshot-validation.js';
const blank = () => ({ mode: 'synthetic', session: null, stage: 'idle', revision: 0, status: null, attempt: null, reference: null,
  listenerCue: null, analysis: null, brief: null, identity: null, connection: null, panel: null, history: [], refinement: null, code: null });
const api = (data: unknown, status = 200) => createApi({ fetch: async () => new Response(JSON.stringify(data), { status }),
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: t => clearTimeout(t as ReturnType<typeof setTimeout>), controlTimeoutMs: 1000 } as TransportDeps);

describe('untrusted successful reply cannot break recovery UI', () => {
  it.each([
    {}, { ...blank(), mode: 'unknown' }, { ...blank(), history: {} }, { ...blank(), reference: {} },
    { ...blank(), session: { context: 'invented-context-00000001', expiresAt: 'later' } },
    { ...blank(), analysis: { observations: null } }, { ...blank(), connection: { anchors: {} } },
    { ...blank(), code: {} }, { ...blank(), refinement: { used: 'false' } },
    { ...blank(), history: [null] }, { ...blank(), panel: { choices: {} } },
  ])('refuses malformed snapshot %j before installation', async data => {
    await expect(api(data).state()).rejects.toMatchObject({ code: 'network' });
  });
  it('accepts empty legacy and additive example snapshots', async () => {
    expect(isSafeSnapshot(blank())).toBe(true);
    await expect(api({ ...blank(), exampleSource: true }).state()).resolves.toMatchObject({ exampleSource: true });
  });
  it('cannot deliver an object as a rendered error message', async () => {
    const error = await api({ error: {}, message: {} }, 500).state().catch(e => e);
    expect(typeof describeError(error)).toBe('string');
    expect(error.code).toBe('internal');
  });
  it('keeps malformed Clear replies unconfirmed', async () => {
    await expect(api({}).clear()).rejects.toMatchObject({ code: 'unconfirmed' });
  });
});

describe('nested recording result validation', () => {
  const h = 'invented-handle-000000001';
  const result = () => ({ ...blank(), session: { context: h, expiresAt: 10000 }, panel: {
    handle: h, synthetic: true, catalogueMode: 'first_party_candidates', role: 'initial', mode: null, basis: [], outcome: 'choices',
    choices: [{ handle: h, title: 'Invented Song', credits: ['Invented Artist'], unverifiedCredits: 0, anchor: 'Invented Artist',
      playUrl: 'https://music.apple.com/us/song/9000000001', service: 'apple_music', fitHypothesis: 'A possible direction.',
      identityEvidence: 'first_party_catalogue', sources: [], feedback: { fit: null, familiarity: null, revision: 0 } }],
    answer: { text: 'A possible direction.', marks: [] }, citations: [], suggestionsUrl: null, gaps: [],
  } });
  it('accepts valid candidate and historical native discriminators', () => {
    expect(isSafeSnapshot(result())).toBe(true);
    const native: any = result(); delete native.panel.catalogueMode; delete native.panel.choices[0].identityEvidence;
    expect(isSafeSnapshot(native)).toBe(true);
  });
  it('accepts a bounded optional exact-track cover, never an unrelated URL or hidden extra', () => {
    const s: any = result(), choice = s.panel.choices[0];
    choice.artwork = { url: 'https://is1-ssl.mzstatic.com/image/thumb/Music001/v4/invented/100x100bb.jpg', storeUrl: choice.playUrl };
    expect(isSafeSnapshot(s)).toBe(true);
    choice.artwork.storeUrl = 'https://music.apple.com/us/song/9000000002'; expect(isSafeSnapshot(s)).toBe(false);
    choice.artwork.storeUrl = choice.playUrl; choice.artwork.previewUrl = 'https://invalid.example/audio'; expect(isSafeSnapshot(s)).toBe(false);
  });
  it.each([
    (s: any) => { s.panel.choices[0].credits = null; },
    (s: any) => { s.panel.choices[0].feedback.fit = {}; },
    (s: any) => { s.panel.choices[0].playUrl = 'javascript:alert(1)'; },
    (s: any) => { s.panel.suggestionsUrl = '//outside.invalid'; },
    (s: any) => { s.panel.suggestionsUrl = '/api/suggestions/other-owner-00000001'; },
    (s: any) => { s.panel.answer.marks = [{ end: 0.5, citations: [] }]; },
    (s: any) => { s.panel.citations = [{ title: 'Invented', url: 'https://example.invalid/', domain: null }]; },
    (s: any) => { s.panel.choices[0].sources = [1]; },
    (s: any) => { s.panel.choices[0].identityEvidence = 'native_sources'; },
    (s: any) => { s.panel.outcome = 'source_unavailable'; },
  ])('rejects malformed nested content or attribution mixing', mutate => {
    const s = result(); mutate(s); expect(isSafeSnapshot(s)).toBe(false);
  });
});

describe('native zero-based citation projection', () => {
  const native = (index: number) => ({ ...blank(), panel: {
    handle: 'invented-panel-000000001', synthetic: true, catalogueMode: 'native_google', role: 'initial', mode: null,
    basis: [], outcome: 'no_match', choices: [], answer: { text: 'Evidence.', marks: [{ end: 9, citations: [index] }] },
    citations: [{ title: 'Source', url: 'https://example.invalid/source', domain: 'example.invalid' }], suggestionsUrl: null, gaps: [],
  } });
  it('accepts the first citation at index zero', () => expect(isSafeSnapshot(native(0))).toBe(true));
  it('rejects an index equal to citation count', () => expect(isSafeSnapshot(native(1))).toBe(false));
});

it('bounds derived discovery availability and rejects a fabricated permission object', () => {
  for (const discovery of ['available', 'edit_artists', 'unavailable']) expect(isSafeSnapshot({ ...blank(), discovery })).toBe(true);
  for (const discovery of [null, true, { allowed: true }, 'retry', 'AVAILABLE']) expect(isSafeSnapshot({ ...blank(), discovery })).toBe(false);
});

it('validates identity context as an exact service-bound public route, including final control characters', () => {
  const option = (context: unknown) => ({ ...blank(), identity: { handle: 'invented-checkpoint-00001', revision: 0, awaiting: true,
    slots: [{ proposal: 'Invented', status: 'ambiguous', chosen: null, options: [{ handle: 'invented-artist-000000001', name: 'Invented', disambiguation: null, context }] }] } });
  const good = { service: 'spotify', url: 'https://open.spotify.com/artist/' + '1'.repeat(22) };
  expect(isSafeSnapshot(option(good))).toBe(true);
  for (const context of [
    { ...good, url: good.url + '\n' }, { ...good, url: good.url + '?tracking=x' }, { ...good, url: good.url + '#x' },
    { ...good, url: 'https://open.spotify.com.evil.invalid/artist/' + '1'.repeat(22) }, { ...good, url: 'javascript:alert(1)' },
    { ...good, service: 'musicbrainz' }, { ...good, extra: true }, { service: '__proto__', url: good.url }, null,
  ]) expect(isSafeSnapshot(option(context))).toBe(false);
});
