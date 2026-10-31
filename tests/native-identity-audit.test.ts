import { describe, expect, it } from 'vitest';
import type { Handle, InvestigationPlan, QlooCandidatePool, RecordingService } from '../src/shared/records.js';
import { buildCatalogueHandoff } from '../src/server/catalogue.js';
import { parseCatalogueAnswer } from '../src/server/catalogue-format.js';
import { createNativeCatalogue } from '../src/server/native-catalogue.js';
import { createGeminiCatalogueAdapter } from '../src/server/providers/gemini-catalogue.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { createSourceResolver } from '../src/server/source-resolver.js';
import { createAppleMusicVerifier, createYouTubeVerifier } from '../src/server/verifier.js';
import { AID, buildAnswer, catalogueTransport, envelope, fakeNetwork, VID } from './fixtures/catalogue-fixtures.js';

// Actual native adapter, source resolver and both verifier implementations over
// invented in-process responses. No listener, account, DNS or HTTP service is used.
const h = (value: string) => value.repeat(24) as Handle;
async function run(service: RecordingService, artists: string[], actualCredits: string, artistsLine?: string, title = 'Invented Song', actualTitle = title, uploadTitle?: string) {
  const now = Date.now(), anchor = artists[0]!;
  const plan: InvestigationPlan = {
    id: h('p'), sessionId: h('s'), epoch: 1, createdAt: now, expiresAt: now + 3_600_000,
    journeyId: h('j'), briefId: h('b'), briefVersion: 1, poolId: h('o'),
    relationship: 'Invented relationship', seedNames: ['Invented Seed'],
    anchors: [{ handle: h('a'), name: anchor }], associations: [], exclusions: [],
    recordingExclusions: { shown: [], known: [] }, priorities: [], refinementMode: null, refinement: null,
    attribution: 'seed_mix', provenance: { analysisId: h('r'), analysisReuse: 'same_source_focus', poolSourceBriefId: h('b'), poolReuse: 'created' },
  };
  const choice = { title, artists, anchor, videoId: VID(1), artistsLine,
    ...(service === 'apple_music' ? { listen: `https://music.apple.com/us/song/${AID(1)}` } : {}) };
  const net = fakeNetwork({ [VID(1)]: { title: uploadTitle ?? `${actualCredits} - ${actualTitle}`, author_name: anchor } }, {},
    { [AID(1)]: { trackName: actualTitle, artistName: actualCredits } });
  const deps = { resolve: net.resolve, http: net.http, now: Date.now };
  const transport = catalogueTransport(() => envelope([choice]));
  const catalogue = createNativeCatalogue({
    adapter: createGeminiCatalogueAdapter({ transport: transport.transport, project: 'invented-project', quotaProject: 'invented-quota', accessToken: async () => new ServerSecret('invented-probe-token') }),
    sources: createSourceResolver(deps, true), verifier: createYouTubeVerifier(deps, true), appleVerifier: createAppleMusicVerifier(deps, true),
    services: ['youtube', 'apple_music'],
  });
  const signal = new AbortController().signal;
  const result = await catalogue.investigate(buildCatalogueHandoff(plan), { plan, pool: {} as QlooCandidatePool }, {
    signal, now: Date.now, deadlineAt: now + 120_000, newHandle: () => h('n'), authorizeMetadata: async () => true,
    dispatchGemini: fn => fn(signal),
  });
  if (result.kind !== 'panel') throw new Error('Invented native result did not produce a panel');
  return { panel: result.panel, metadata: net.metadataRequests, calls: transport.calls };
}

describe.each(['youtube', 'apple_music'] as const)('native exact credit representation (%s)', service => {
  it('never manufactures a declared And artist from a trailing separator', async () => {
    const result = await run(service, ['Invented Alpha', 'And'], 'Invented Alpha &');
    expect(result.panel.choices).toEqual([]);
    expect(result.metadata).toHaveLength(1);
    expect(result.calls).toHaveLength(1);
  });
  it('accepts the exact legacy single-band semicolon name supplied by the owned plan', async () => {
    const band = 'Invented Alpha ; The Band';
    const result = await run(service, [band], band);
    expect(result.panel.choices).toHaveLength(1);
    expect(result.panel.choices[0]!.credits).toEqual([band]);
    expect(result.metadata).toHaveLength(1);
    expect(result.calls).toHaveLength(1);
  });
  it('accepts an unambiguous JSON list with punctuation inside a band and an outside collaborator', async () => {
    const band = 'Invented Alpha ; The Band', guest = 'Invented Guest';
    const result = await run(service, [band, guest], `${band} & ${guest}`, JSON.stringify([band, guest]));
    expect(result.panel.choices).toHaveLength(1);
    expect(result.panel.choices[0]!.credits).toEqual([band, guest]);
    expect(result.metadata).toHaveLength(1);
    expect(result.calls).toHaveLength(1);
  });
  it.each(['["Invented ; Band"]', '[Invented Band]', 'Invented (Special) Band'])('does not treat the declared credit %s as a recording version', async band => {
    const artists = [band, 'Invented Guest'];
    const result = await run(service, artists, `${band} & Invented Guest`, JSON.stringify(artists));
    expect(result.panel.choices).toHaveLength(1);
    expect(result.panel.choices[0]!.credits).toEqual(artists);
    expect(result.metadata).toHaveLength(1);
  });
  it.each([['Invented Song', 'Invented Song (Live)'], ['Invented Song (Live)', 'Invented Song']])('keeps actual title versions distinct: %s versus %s', async (title, actualTitle) => {
    const artists = ['[Invented Band]', 'Invented Guest'];
    const result = await run(service, artists, '[Invented Band] & Invented Guest', JSON.stringify(artists), title!, actualTitle!);
    expect(result.panel.choices).toEqual([]);
    expect(result.metadata).toHaveLength(1);
  });
});

describe('native upload field delimiters respect enclosed content', () => {
  it.each(['(Live - Invented Hall)', '[Live – Invented Hall]', '(Live — Invented Hall)'])('retains the exact version %s', async version => {
    const title = `Invented Song ${version}`, artists = ['Invented Alpha'];
    const result = await run('youtube', artists, artists[0]!, JSON.stringify(artists), title);
    expect(result.panel.choices).toHaveLength(1);
    expect(result.metadata).toHaveLength(1);
  });
  it('retains a dash inside a title-side featured credit', async () => {
    const artists = ['Invented Alpha', 'Invented Guest - Duo'];
    const result = await run('youtube', artists, artists[0]!, JSON.stringify(artists), 'Invented Song',
      'Invented Song (feat. Invented Guest - Duo)');
    expect(result.panel.choices).toHaveLength(1);
    expect(result.panel.choices[0]!.credits).toEqual(artists);
    expect(result.metadata).toHaveLength(1);
  });
  it('retains a dash inside the exact declared parenthesized band', async () => {
    const artists = ['Invented (Special - Band)', 'Invented Guest'];
    const result = await run('youtube', artists, `${artists[0]} & ${artists[1]}`, JSON.stringify(artists));
    expect(result.panel.choices).toHaveLength(1);
    expect(result.metadata).toHaveLength(1);
  });
  it.each([
    ['Invented Song', 'Invented Alpha - Invented Song (Live - Invented Hall)'],
    ['Invented Song (Live - Invented Hall)', 'Invented Alpha - Invented Song (Live - Another Hall)'],
    ['Invented Song', 'Invented Alpha - Invented Song (feat. Invented Guest - Duo)'],
    ['Invented Song', 'Invented Alpha - Invented Song - Invented Guest'],
  ])('rejects a differing version or undeclared credit: %s / %s', async (title, uploadTitle) => {
    const artists = ['Invented Alpha'];
    const result = await run('youtube', artists, artists[0]!, JSON.stringify(artists), title!, title!, uploadTitle!);
    expect(result.panel.choices).toEqual([]);
    expect(result.metadata).toHaveLength(1);
  });
});

describe.each(['youtube', 'apple_music'] as const)('nested title identity (%s)', service => {
  it.each(['(Live feat. Invented Guest (Special - Duo))', '[Remastered ft. Invented Guest [Special - Duo]]',
    '(Live featuring Invented Guest (Special - Duo))', 'feat. Invented Guest (Special - Duo)'])('preserves the complete inline name in %s', async group => {
    const guest = group.includes('[Special') ? 'Invented Guest [Special - Duo]' : 'Invented Guest (Special - Duo)';
    const title = `Invented Song ${group}`, artists = ['Invented Alpha', guest];
    const complete = await run(service, artists, artists[0]!, JSON.stringify(artists), title);
    expect(complete.panel.choices).toHaveLength(1);
    expect(complete.panel.choices[0]!.credits).toEqual(artists);
    const shortened = ['Invented Alpha', 'Invented Guest'];
    const incomplete = await run(service, shortened, shortened[0]!, JSON.stringify(shortened), title);
    expect(incomplete.panel.choices).toEqual([]);
    expect(complete.metadata).toHaveLength(1);
    expect(incomplete.metadata).toHaveLength(1);
  });
  it('keeps the explicit allowlisted upload decoration after an inline guest', async () => {
    const artists = ['Invented Alpha', 'Invented Guest'];
    const result = await run(service, artists, artists[0]!, JSON.stringify(artists), 'Invented Song',
      'Invented Song ft. Invented Guest [Official Video]');
    expect(result.panel.choices).toHaveLength(1);
  });
  it('does not interpret ordinary With words in a title as a featured artist', async () => {
    const artists = ['Invented Alpha'];
    const result = await run(service, artists, artists[0]!, JSON.stringify(artists), 'Invented With Tomorrow');
    expect(result.panel.choices).toHaveLength(1);
  });
  it.each(['(Live feat. Invented Guest)', '[Remastered ft. Invented Guest]', '(Live featuring Invented Guest)'])('does not omit an inline feature inside %s', async group => {
    const artists = ['Invented Alpha'], title = `Invented Song ${group}`;
    const result = await run(service, artists, artists[0]!, JSON.stringify(artists), title);
    expect(result.panel.choices).toEqual([]);
    expect(result.metadata).toHaveLength(1);
  });
  it.each(['(Live feat. Invented Guest)', '[Remastered ft. Invented Guest]', '(Live featuring Invented Guest)'])('accepts all declared inline feature credits inside %s', async group => {
    const artists = ['Invented Alpha', 'Invented Guest'], title = `Invented Song ${group}`;
    const result = await run(service, artists, artists[0]!, JSON.stringify(artists), title);
    expect(result.panel.choices).toHaveLength(1);
    expect(result.panel.choices[0]!.credits).toEqual(artists);
    expect(result.metadata).toHaveLength(1);
  });
  it.each(['(Live (feat. Invented Guest))', '[Remaster (with Invented Guest)]', '((feat. Invented Guest))'])('requires every explicit nested credit in %s', async group => {
    const artists = ['Invented Alpha'], title = `Invented Song ${group}`;
    const result = await run(service, artists, artists[0]!, JSON.stringify(artists), title);
    expect(result.panel.choices).toEqual([]);
    expect(result.metadata).toHaveLength(1);
  });
  it.each(['(Live (feat. Invented Guest))', '[Remaster (with Invented Guest)]', '((feat. Invented Guest))'])('accepts complete declared nested credits in %s', async group => {
    const artists = ['Invented Alpha', 'Invented Guest'], title = `Invented Song ${group}`;
    const result = await run(service, artists, artists[0]!, JSON.stringify(artists), title);
    expect(result.panel.choices).toHaveLength(1);
    expect(result.panel.choices[0]!.credits).toEqual(artists);
    expect(result.metadata).toHaveLength(1);
  });
  it.each(['(Live - Hall [Remaster])', '[Live – Hall (Remaster)]'])('accepts an exact nested version %s', async version => {
    const artists = ['Invented Alpha'], title = `Invented Song ${version}`;
    const result = await run(service, artists, artists[0]!, JSON.stringify(artists), title);
    expect(result.panel.choices).toHaveLength(1);
    expect(result.metadata).toHaveLength(1);
  });
  it('retains a complete nested featured band name', async () => {
    const artists = ['Invented Alpha', 'Invented Guest (Special - Duo)'];
    const result = await run(service, artists, artists[0]!, JSON.stringify(artists), 'Invented Song',
      'Invented Song (feat. Invented Guest (Special - Duo))');
    expect(result.panel.choices).toHaveLength(1);
    expect(result.panel.choices[0]!.credits).toEqual(artists);
  });
  it.each([
    ['Invented Song', 'Invented Song (Live - Hall [Remaster])'],
    ['Invented Song (Live - Hall [Remaster])', 'Invented Song (Live - Other Hall [Remaster])'],
    ['Invented Song (Live - Hall [Remaster])', 'Invented Song (Live - Hall [Original])'],
  ])('rejects differing nested versions: %s / %s', async (title, actualTitle) => {
    const artists = ['Invented Alpha'];
    const result = await run(service, artists, artists[0]!, JSON.stringify(artists), title!, actualTitle!);
    expect(result.panel.choices).toEqual([]);
    expect(result.metadata).toHaveLength(1);
  });
});

describe('unambiguous native Artists value with unchanged source bytes', () => {
  const answer = (artistsLine: string, anchor = 'Invented Alpha') => buildAnswer([
    { title: 'Invented Song', artists: [anchor], artistsLine, anchor, videoId: VID(1) },
  ]).text;
  it.each(['[', '[]', '[null]', '[1]', '[{}]', '[[]]', '[""]', '["Invented Alpha",]',
    JSON.stringify(['\nInvented Alpha']), JSON.stringify(['Invented Alpha\t']),
    JSON.stringify(['x'.repeat(129)]), JSON.stringify(Array.from({ length: 13 }, (_, i) => `Invented ${i}`)),
  ])('rejects malformed, unbounded or control-bearing array %j without delimiter fallback', value => {
    expect(() => parseCatalogueAnswer(answer(value))).toThrow();
  });
  it('decodes escaped punctuation while retaining the complete raw Artists range', () => {
    const band = 'Invented "Quoted" ; Band', line = JSON.stringify([band, 'Invented Guest']);
    const text = answer(line, band), parsed = parseCatalogueAnswer(text, new Set([band]));
    expect(parsed.kind).toBe('choices');
    if (parsed.kind !== 'choices') return;
    const block = parsed.blocks[0]!;
    expect(block.artists).toEqual([band, 'Invented Guest']);
    expect(Buffer.from(text).subarray(block.ranges.artists.start, block.ranges.artists.end).toString()).toBe(line);
  });
  it('requires the supplied owned name for the legacy single-band exception', () => {
    const band = 'Invented Alpha ; The Band', text = answer(band, band);
    const unowned = parseCatalogueAnswer(text, new Set(['Another invented anchor']));
    const owned = parseCatalogueAnswer(text, new Set([band]));
    expect(unowned.kind === 'choices' && unowned.blocks[0]!.artists).toEqual(['Invented Alpha', 'The Band']);
    expect(owned.kind === 'choices' && owned.blocks[0]!.artists).toEqual([band]);
  });
  it.each(['[Invented ; Band', '["Invented ; Band"]'])('retains an exact owned literal name %s before interpreting syntax', band => {
    const parsed = parseCatalogueAnswer(answer(band, band), new Set([band]));
    expect(parsed.kind === 'choices' && parsed.blocks[0]!.artists).toEqual([band]);
  });
});
