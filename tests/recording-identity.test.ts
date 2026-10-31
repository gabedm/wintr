import { describe, expect, it } from 'vitest';
import { matchFirstPartyIdentity, matchRecordingIdentity, recordingExclusionKeys, type IdentityProposal } from '../src/server/recording-identity.js';

// Invented names/titles only. These compare evidence through the actual identity
// seams; they are not recordings, provider responses or listening outcomes.
const checks = [
  { name: 'YouTube', match: (p: IdentityProposal, anchor: string, title: string, artist: string) =>
    matchRecordingIdentity(p, anchor, { title: `${artist} - ${title}`, channelName: 'Invented uploader' }) },
  { name: 'first-party', match: (p: IdentityProposal, anchor: string, title: string, artist: string) =>
    matchFirstPartyIdentity(p, anchor, { trackName: title, artistName: artist }) },
];

describe.each(checks)('$name exact recording identity across writing systems', ({ match }) => {
  it.each([
    ['different title', 'Invented lantern 東京', 'Invented Artist', 'Invented lantern 大阪', 'Invented Artist', 'title_mismatch'],
    ['different version', 'Invented lantern (東京)', 'Invented Artist', 'Invented lantern (大阪)', 'Invented Artist', 'version_mismatch'],
    ['different credited artist', 'Invented lantern', 'Invented 東京', 'Invented lantern', 'Invented 大阪', 'anchor_not_credited'],
    ['undeclared extra credit', 'Invented lantern', 'Invented Artist', 'Invented lantern', 'Invented Artist & 未知', 'credits_extra'],
    ['Indic vowel mark', 'Invented किरन', 'Invented Artist', 'Invented करन', 'Invented Artist', 'title_mismatch'],
    ['Japanese voicing mark', 'Invented が', 'Invented Artist', 'Invented か', 'Invented Artist', 'title_mismatch'],
    ['Cyrillic distinct letter', 'Invented Й', 'Invented Artist', 'Invented И', 'Invented Artist', 'title_mismatch'],
    ['Greek tone mark', 'Invented ά', 'Invented Artist', 'Invented α', 'Invented Artist', 'title_mismatch'],
  ])('rejects %s instead of deleting its distinguishing text', (_label, proposed, anchor, title, artist, gap) => {
    expect(match({ title: proposed!, artists: [anchor!] }, anchor!, title!, artist!)).toEqual({ ok: false, gap });
  });

  it.each([
    ['仮想の灯', '架空の演奏者'],
    ['Invented किरण', 'Invented कलाकार'],
    ['가상의 빛', '가상 연주자'],
    ['Invented όραμα', 'Invented όνομα'],
  ])('accepts matching title and complete credits: %s', (title, artist) => {
    const p = { title, artists: [artist] };
    expect(match(p, artist, title.normalize('NFD'), artist.normalize('NFD'))).toMatchObject({ ok: true, credits: [artist] });
  });

  it('keeps distinct title, credit and version keys distinct for shown-recording exclusion', () => {
    const pairs = [
      ['Invented lantern 東京', 'Invented Artist'],
      ['Invented lantern 大阪', 'Invented Artist'],
      ['Invented lantern 東京', 'Invented Artist 東京'],
      ['Invented lantern 東京', 'Invented Artist 大阪'],
      ['Invented lantern (東京)', 'Invented Artist'],
      ['Invented lantern (大阪)', 'Invented Artist'],
    ];
    const keys = pairs.map(([title, artist]) => {
      const result = match({ title: title!, artists: [artist!] }, artist!, title!, artist!);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Invented exact evidence was not accepted');
      return result.recordingKey;
    });
    expect(new Set(keys).size).toBe(pairs.length);
  });

  it('retains existing Latin accent/case/punctuation matching and refuses a mark-only title', () => {
    expect(match({ title: 'Invented Café & Light', artists: ['Invented Solá'] }, 'Invented Solá', 'INVENTED CAFE AND LIGHT', 'invented sola'))
      .toMatchObject({ ok: true, credits: ['Invented Solá'] });
    expect(match({ title: '\u093e', artists: ['Invented Artist'] }, 'Invented Artist', '\u093e', 'Invented Artist'))
      .toEqual({ ok: false, gap: 'title_mismatch' });
  });
});

it('keeps canonical Unicode recording identity equal across destination services', () => {
  const p = { title: 'Invented が (東京)', artists: ['Invented 架空', 'Invented Guests'] };
  const results = checks.map(({ match }) => match(p, p.artists[0]!, p.title.normalize('NFD'), p.artists.join(' & ')));
  expect(results.every(r => r.ok)).toBe(true);
  if (results[0]?.ok && results[1]?.ok) expect(results[0].recordingKey).toBe(results[1].recordingKey);
});

it('preserves admitted opaque keys and recovers a shown identity without rewriting it or excluding a distinct title', () => {
  const shown = Object.freeze({
    key: 'invented lantern|invented artist|', title: 'Invented lantern 東京',
    credits: Object.freeze(['Invented Artist']), videoId: 'invVid00001',
  });
  const exclusions = Object.freeze({ known: Object.freeze(['opaque-known-key']), shown: Object.freeze([shown]) });
  const before = JSON.stringify(exclusions);
  const keys = recordingExclusionKeys(exclusions);
  expect(keys.has(shown.key)).toBe(true);
  expect(keys.has('opaque-known-key')).toBe(true);
  for (const { match } of checks) {
    const same = match({ title: shown.title, artists: shown.credits }, 'Invented Artist', shown.title, 'Invented Artist');
    const different = match({ title: 'Invented lantern 大阪', artists: shown.credits }, 'Invented Artist', 'Invented lantern 大阪', 'Invented Artist');
    expect(same.ok && keys.has(same.recordingKey)).toBe(true);
    expect(different.ok && keys.has(different.recordingKey)).toBe(false);
  }
  expect(JSON.stringify(exclusions)).toBe(before);
});
