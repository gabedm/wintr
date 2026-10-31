import { describe, expect, it } from 'vitest';
import { matchFirstPartyIdentity, matchRecordingIdentity } from '../src/server/recording-identity.js';

describe('complete credits include artists whose names resemble separators', () => {
  const title = 'Invented Song', anchor = 'Invented Alpha';
  it.each(['X', 'With', 'And', 'Vs'])('does not discard the credited artist %s', artist => {
    const incomplete = { title, artists: [anchor] };
    expect(matchFirstPartyIdentity(incomplete, anchor, { trackName: title, artistName: `${anchor} & ${artist}` }).ok).toBe(false);
    expect(matchRecordingIdentity(incomplete, anchor, { title: `${anchor} feat. ${artist} - ${title}`, channelName: anchor }).ok).toBe(false);
    const complete = { title, artists: [anchor, artist] };
    expect(matchFirstPartyIdentity(complete, anchor, { trackName: title, artistName: `${anchor} & ${artist}` }).ok).toBe(true);
    expect(matchRecordingIdentity(complete, anchor, { title: `${anchor} feat. ${artist} - ${title}`, channelName: anchor }).ok).toBe(true);
  });
  it('requires featured credits declared in the proposed title', () => {
    expect(matchFirstPartyIdentity({ title: `${title} (feat. X)`, artists: [anchor] }, anchor, { trackName: `${title} (feat. X)`, artistName: anchor }).ok).toBe(false);
  });
  it('does not manufacture an extra artist from a connector', () => {
    expect(matchFirstPartyIdentity({ title, artists: [anchor, 'Invented Beta', 'And'] }, anchor, { trackName: title, artistName: `${anchor} and Invented Beta` }).ok).toBe(false);
  });
  it('preserves an ampersand inside a declared band name', () => {
    const band = 'Invented Alpha & Beta';
    expect(matchFirstPartyIdentity({ title, artists: [band] }, band, { trackName: title, artistName: band }).ok).toBe(true);
  });
  it.each(['x', '&', 'feat.', ',', 'with'])('preserves a separator between two complete names: %s', separator => {
    expect(matchFirstPartyIdentity({ title, artists: [anchor, 'Invented Beta'] }, anchor, { trackName: title, artistName: `${anchor} ${separator} Invented Beta` }).ok).toBe(true);
  });
});

describe('consistent explicit recording versions', () => {
  const artists = ['Invented Alpha'];
  it.each(['Live', 'Remastered 2011', 'Acoustic'])('accepts matching dashed %s versions across metadata providers', version => {
    const title = `Invented Song - ${version}`;
    const apple = matchFirstPartyIdentity({ title, artists }, artists[0]!, { trackName: title, artistName: artists[0]! });
    const youtube = matchRecordingIdentity({ title, artists }, artists[0]!, { title: `${artists[0]} - ${title}`, channelName: artists[0]! });
    expect(apple.ok).toBe(true); expect(youtube.ok).toBe(true);
    if (apple.ok && youtube.ok) expect(apple.recordingKey).toBe(youtube.recordingKey);
  });
  it('never substitutes a studio recording for live, or live for studio', () => {
    for (const [proposed, actual] of [['Invented Song', 'Invented Song - Live'], ['Invented Song - Live', 'Invented Song']]) {
      expect(matchFirstPartyIdentity({ title: proposed!, artists }, artists[0]!, { trackName: actual!, artistName: artists[0]! }).ok).toBe(false);
    }
  });
});

describe('punctuation inside a declared artist name', () => {
  it.each([',', ';'])('accepts exact names containing %s in both metadata routes', punctuation => {
    const band = `Invented Alpha${punctuation} The Band`, title = 'Invented Song';
    const proposal = { title, artists: [band] };
    expect(matchFirstPartyIdentity(proposal, band, { trackName: title, artistName: band }).ok).toBe(true);
    expect(matchRecordingIdentity(proposal, band, { title: `${band} - ${title}`, channelName: band }).ok).toBe(true);
    expect(matchFirstPartyIdentity(proposal, band, { trackName: title, artistName: `${band} & X` }).ok).toBe(false);
  });
});

it.each([['&', 'and'], ['and', '&']])('matches declared %s band with metadata %s symmetrically', (declared, actual) => {
  const artist = `Invented Alpha ${declared} The Band`, metadata = `Invented Alpha ${actual} The Band`;
  const proposal = { title: 'Invented Song', artists: [artist] };
  expect(matchFirstPartyIdentity(proposal, artist, { trackName: proposal.title, artistName: metadata }).ok).toBe(true);
  expect(matchRecordingIdentity(proposal, artist, { title: `${metadata} - ${proposal.title}`, channelName: metadata }).ok).toBe(true);
});
