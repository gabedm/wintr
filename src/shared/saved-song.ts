import type { SafePanel } from './records.js';
import { isAppleArtwork, type AppleArtwork } from './apple-artwork.js';

/** Public recording metadata only. No session, chat, model prose, votes or handles. */
export interface SavedSong {
  readonly url: string;
  readonly service: 'youtube' | 'apple_music';
  readonly title: string;
  readonly artists: readonly string[];
  readonly foundAt: number;
  readonly artwork?: AppleArtwork;
}
export const LIBRARY_LIMIT = 1000;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
export function isSongUrl(v: unknown, service: unknown): v is string {
  return typeof v === 'string' && (service === 'youtube' ? /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(v)
    : service === 'apple_music' && /^https:\/\/music\.apple\.com\/[a-z]{2}\/song\/[1-9][0-9]{0,19}$/.test(v));
}
export function isSavedSong(v: unknown): v is SavedSong {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return false;
  const d = Object.getOwnPropertyDescriptors(v), keys = ['url', 'service', 'title', 'artists', 'foundAt'];
  if (Object.hasOwn(d, 'artwork')) keys.push('artwork');
  if (Reflect.ownKeys(d).length !== keys.length || !keys.every(k => Object.hasOwn(d, k) && Object.hasOwn(d[k]!, 'value'))) return false;
  const r = v as Record<string, unknown>;
  return isSongUrl(r.url, r.service) && (!Object.hasOwn(r, 'artwork') || (r.service === 'apple_music' && isAppleArtwork(r.artwork, r.url))) && text(r.title, 300) && Array.isArray(r.artists) && r.artists.length > 0 && r.artists.length <= 8 &&
    Object.keys(r.artists).length === r.artists.length && Array.from({ length: r.artists.length }, (_, i) => i).every(i => { const d = Object.getOwnPropertyDescriptor(r.artists, i); return !!d && Object.hasOwn(d, 'value') && text(d.value, 300); }) && Number.isSafeInteger(r.foundAt) && (r.foundAt as number) > 0 && (r.foundAt as number) <= 8_640_000_000_000_000;
}
/** The live, currently accepted panel supplies these fields. Never persist its private explanation or handles. */
export function songsFromPanel(panel: SafePanel, receivedAt: number): readonly SavedSong[] {
  if (panel.synthetic !== false || panel.outcome !== 'choices') return [];
  const foundAt = panel.foundAt ?? receivedAt;
  return panel.choices.flatMap(c => {
    const song = { url: c.playUrl, service: c.service, title: c.title, artists: [...c.credits], foundAt, ...(c.artwork ? { artwork: c.artwork } : {}) };
    return c.unverifiedCredits === 0 && isSavedSong(song) ? [song] : [];
  });
}
export function searchSongs(songs: readonly SavedSong[], query: string): readonly SavedSong[] {
  const words = query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return songs.filter(s => { const haystack = `${s.title} ${s.artists.join(' ')}`.normalize('NFKC').toLocaleLowerCase(); return words.every(w => haystack.includes(w)); });
}
export function songDateGroup(foundAt: number, now = Date.now()): string {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const date = new Date(foundAt), yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (date >= today) return 'Today';
  if (date >= yesterday) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) }).format(date);
}
