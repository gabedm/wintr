import { describe, expect, it } from 'vitest';
import { isSavedSong, isSongUrl, searchSongs, songDateGroup, songsFromPanel, type SavedSong } from '../src/shared/saved-song.js';
import type { SafePanel } from '../src/shared/records.js';
const song: SavedSong = { url: 'https://music.apple.com/us/song/123456', service: 'apple_music', title: 'Invented Night', artists: ['Invented Artist'], foundAt: Date.UTC(2026, 9, 30, 12) };
const panel = (): SafePanel => ({ handle: 'P'.repeat(24) as any, foundAt: song.foundAt, synthetic: false, role: 'initial', mode: null, basis: [], outcome: 'choices', choices: [{ handle: 'C'.repeat(24) as any, title: song.title, credits: song.artists, unverifiedCredits: 0, anchor: song.artists[0]!, playUrl: song.url, service: song.service, fitHypothesis: 'Private model prose must not persist', sources: [], feedback: { fit: 'like', familiarity: 'new', revision: 1 } }], answer: { text: 'Private answer', marks: [] }, citations: [], suggestionsUrl: null, gaps: [] });
describe('device library privacy boundary', () => {
  it('projects only approved public song metadata and the server discovery date', () => { const result = songsFromPanel(panel(), Date.now()); expect(result).toEqual([song]); expect(JSON.stringify(result)).not.toMatch(/Private|handle|feedback|like|familiarity|anchor|answer/); });
  it.each([{ synthetic: true }, { outcome: 'source_unavailable' }, { outcome: 'no_match' }])('does not save an unpresentable or synthetic panel %j', change => { expect(songsFromPanel({ ...panel(), ...change } as SafePanel, Date.now())).toEqual([]); });
  it('rejects an unverified credit, missing destination, or wrong-service destination', () => { for (const patch of [{ unverifiedCredits: 1 }, { playUrl: null }, { service: 'youtube' }]) expect(songsFromPanel({ ...panel(), choices: [{ ...panel().choices[0]!, ...patch } as any] }, Date.now())).toEqual([]); });
  it('rejects additional private fields, inherited fields and accessors without evaluating them', () => {
    expect(isSavedSong({ ...song, note: 'private' })).toBe(false);
    expect(isSavedSong(Object.assign(Object.create({ url: song.url }), { service: song.service, title: song.title, artists: song.artists, foundAt: song.foundAt }))).toBe(false);
    let reads = 0; const value = { ...song }; Object.defineProperty(value, 'title', { get() { reads++; return 'unsafe'; } }); expect(isSavedSong(value)).toBe(false); expect(reads).toBe(0);
  });
  it('rejects corrupt arrays, dates, control text and unbounded metadata', () => {
    for (const patch of [{ artists: Array(2) }, { artists: [] }, { foundAt: NaN }, { foundAt: 0 }, { foundAt: Number.MAX_SAFE_INTEGER }, { foundAt: 8_640_000_000_000_001 }, { title: 'x\nsecret' }, { title: 'x'.repeat(301) }]) expect(isSavedSong({ ...song, ...patch })).toBe(false);
  });
  it('admits only date values safe for the Library date and ISO rendering boundary', () => {
    for (const foundAt of [1, song.foundAt, 8_640_000_000_000_000]) {
      expect(isSavedSong({ ...song, foundAt })).toBe(true);
      expect(() => songDateGroup(foundAt)).not.toThrow();
      expect(() => new Date(foundAt).toISOString()).not.toThrow();
    }
    expect(songsFromPanel({ ...panel(), foundAt: Number.MAX_SAFE_INTEGER }, Date.now())).toEqual([]);
  });
  it.each(['https://music.apple.com.evil.test/us/song/123456', 'https://user:secret@music.apple.com/us/song/123456', 'https://music.apple.com/us/song/123456?token=secret', 'javascript:alert(1)', 'http://music.apple.com/us/song/123456', 'https://music.apple.com/us/artist/123456'])('does not retain a noncanonical recording destination %s', url => expect(isSongUrl(url, 'apple_music')).toBe(false));
  it('searches title and all credits without modifying stored song metadata', () => { const songs = [song, { ...song, title: 'Other', artists: ['Guest Name'] }]; expect(searchSongs(songs, 'night artist')).toEqual([song]); expect(searchSongs(songs, 'GUEST')).toEqual([songs[1]]); expect(searchSongs(songs, '')).toEqual(songs); expect(song.title).toBe('Invented Night'); });
  it('uses local calendar groups across midnight rather than elapsed 24-hour buckets', () => { const now = new Date(2026, 9, 30, 0, 1).getTime(); expect(songDateGroup(new Date(2026, 9, 29, 23, 59).getTime(), now)).toBe('Yesterday'); expect(songDateGroup(now, now)).toBe('Today'); });
});
