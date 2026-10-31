/** Optional public display metadata from the already verified exact-track lookup.
 * Never identity evidence, a model input, an audio URL or a server fetch target. */
export interface AppleArtwork {
  readonly url: string;
  /** The corresponding first-party trackViewUrl, preserved rather than invented. */
  readonly storeUrl: string;
}

const clean = (v: unknown): v is string => typeof v === 'string' && v.length <= 2048 && !/[\s\\\u0000-\u001f\u007f]/.test(v);
const track = /^https:\/\/music\.apple\.com\/([a-z]{2})\/song\/([1-9][0-9]{0,14})$/;
function correspondingStoreUrl(raw: unknown, canonical: string): boolean {
  if (!clean(raw)) return false;
  const wanted = track.exec(canonical);
  const path = /^https:\/\/music\.apple\.com\/([a-z]{2})\/(song|album)\/(?:([^/?#]+)\/)?([1-9][0-9]{0,14})(?:\?((?:i=[1-9][0-9]{0,14}|uo=[0-9]{1,3})(?:&(?:i=[1-9][0-9]{0,14}|uo=[0-9]{1,3}))?))?$/.exec(raw);
  if (!wanted || !path || path[1] !== wanted[1]) return false;
  try {
    const u = new URL(raw), slug = decodeURIComponent(path[3] ?? '');
    if (u.href !== raw || /[\s\/\\\u0000-\u001f\u007f]/.test(slug) || slug === '.' || slug === '..') return false;
    const keys = [...u.searchParams.keys()];
    if (new Set(keys).size !== keys.length) return false;
    return path[2] === 'song' ? path[4] === wanted[2] && !u.searchParams.has('i') : u.searchParams.get('i') === wanted[2];
  } catch { return false; }
}
function artworkUrl(raw: unknown): raw is string {
  // Only the bounded, unmodified thumbnail sizes returned by the lookup. No
  // quality/host rewriting, query tokens, redirects, proxying or media previews.
  if (!clean(raw) || !/^https:\/\/is1-ssl\.mzstatic\.com\/image\/thumb\/[A-Za-z0-9_~./-]+\/(?:60x60bb|100x100bb)\.(?:jpg|png|webp)$/.test(raw)) return false;
  const u = new URL(raw);
  return u.href === raw && !u.pathname.split('/').some(s => s === '.' || s === '..');
}
export function isAppleArtwork(v: unknown, canonical: string): v is AppleArtwork {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return false;
  const d = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(d).length !== 2 || !['url', 'storeUrl'].every(k => Object.hasOwn(d, k) && Object.hasOwn(d[k]!, 'value'))) return false;
  return artworkUrl(d.url!.value) && correspondingStoreUrl(d.storeUrl!.value, canonical);
}
/** Invalid or missing optional display data never turns a verified song into a gap. */
export function appleArtwork(url: unknown, storeUrl: unknown, canonical: string): AppleArtwork | undefined {
  const value = { url, storeUrl };
  return isAppleArtwork(value, canonical) ? Object.freeze(value) : undefined;
}
