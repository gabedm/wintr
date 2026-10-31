import { describe, expect, it } from 'vitest';
import { appleArtwork, isAppleArtwork } from '../src/shared/apple-artwork.js';
import { isSavedSong } from '../src/shared/saved-song.js';

const canonical = 'https://music.apple.com/us/song/9100000001';
const artwork = { url: 'https://is1-ssl.mzstatic.com/image/thumb/Music001/v4/invented/100x100bb.jpg', storeUrl: 'https://music.apple.com/us/album/invented/9100000090?i=9100000001&uo=4' };
describe('optional exact-recording artwork display boundary', () => {
  it('preserves the returned public thumbnail and corresponding store link without inventing URLs', () => {
    expect(appleArtwork(artwork.url, artwork.storeUrl, canonical)).toEqual(artwork);
    expect(isAppleArtwork({ ...artwork, storeUrl: canonical }, canonical)).toBe(true);
    expect(isAppleArtwork({ ...artwork, url: artwork.url.replace('100x100', '60x60') }, canonical)).toBe(true);
  });
  it.each([
    { url: 'https://is1-ssl.mzstatic.com.evil.invalid/image/thumb/invented/100x100bb.jpg' },
    { url: artwork.url.replace('https:', 'http:') }, { url: artwork.url + '?token=private' }, { url: artwork.url + '#x' },
    { url: artwork.url.replace('is1-ssl', 'is2-ssl') }, { url: artwork.url.replace('100x100bb.jpg', 'preview.m4a') },
    { url: artwork.url.replace('100x100', '3000x3000') }, { url: artwork.url.replace('/invented/', '/../invented/') },
    { url: artwork.url.replace('/invented/', '/%2e%2e/invented/') }, { url: artwork.url.replace('.com/', '.com:443/') },
    { storeUrl: artwork.storeUrl.replace('i=9100000001', 'i=9100000002') },
    { storeUrl: artwork.storeUrl.replace('/us/', '/gb/') }, { storeUrl: artwork.storeUrl + '&token=private' },
    { storeUrl: artwork.storeUrl + '&uo=4' }, { storeUrl: artwork.storeUrl.replace('/album/', '/artist/') },
    { storeUrl: artwork.storeUrl.replace('music.apple.com/', 'user:secret@music.apple.com/') },
    { storeUrl: artwork.storeUrl + '\n' }, { storeUrl: artwork.storeUrl.replace('invented/', '%2funsafe/') },
    { previewUrl: 'https://invalid.example/audio.m4a' },
  ])('drops unsafe, unrelated or unbounded optional display data %j', patch => {
    expect(isAppleArtwork({ ...artwork, ...patch }, canonical)).toBe(false);
  });
  it('does not invoke an accessor or accept an inherited field', () => {
    let reads = 0; const value = { ...artwork }; Object.defineProperty(value, 'url', { get() { reads++; return artwork.url; } });
    expect(isAppleArtwork(value, canonical)).toBe(false); expect(reads).toBe(0);
    expect(isAppleArtwork(Object.assign(Object.create({ url: artwork.url }), { storeUrl: artwork.storeUrl }), canonical)).toBe(false);
    expect(isAppleArtwork({ ...artwork, [Symbol('private')]: 'private' }, canonical)).toBe(false);
  });
  it('keeps historical saved songs valid and binds new artwork to that exact song only', () => {
    const song = { url: canonical, service: 'apple_music', title: 'Invented song', artists: ['Invented artist'], foundAt: 1 };
    expect(isSavedSong(song)).toBe(true); expect(isSavedSong({ ...song, artwork })).toBe(true);
    expect(isSavedSong({ ...song, url: canonical.replace('0001', '0002'), artwork })).toBe(false);
    expect(isSavedSong({ ...song, artwork: { ...artwork, note: 'private' } })).toBe(false);
    expect(isSavedSong({ ...song, artwork: undefined })).toBe(false);
  });
});
