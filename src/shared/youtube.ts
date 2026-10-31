import { LIMITS, type Focus } from './records.js';

// Strict YouTube reference parsing (H06, D05). The input is treated as data:
// only exact allowlisted hosts and known path forms are accepted, and the
// canonical URL is rebuilt from the validated 11-character ID alone.

export type SourceErrorCode =
  | 'empty'
  | 'too_long'
  | 'malformed'
  | 'scheme'
  | 'credentials'
  | 'port'
  | 'host'
  | 'playlist_only'
  | 'unsupported_path'
  | 'bad_video_id';

export type TimestampResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'valid'; readonly start: number }
  | { readonly kind: 'invalid'; readonly reason: 'malformed' | 'conflict' };

export type YouTubeParse =
  | { readonly ok: true; readonly videoId: string; readonly canonicalUrl: string; readonly timestamp: TimestampResult }
  | { readonly ok: false; readonly code: SourceErrorCode; readonly message: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const SHORT_HOST = 'youtu.be';
const PATH_ID_PREFIXES = ['/shorts/', '/embed/', '/live/'];

const MESSAGES: Record<SourceErrorCode, string> = {
  empty: 'Paste a YouTube link to a single video.',
  too_long: 'That link is too long to be a single YouTube video link.',
  malformed: 'That does not look like a complete web link. Paste the full https:// YouTube link.',
  scheme: 'Use the full https:// YouTube link.',
  credentials: 'Links containing a username or password are not accepted.',
  port: 'Links with a custom port are not accepted.',
  host: 'Only youtube.com and youtu.be links to a single video are supported.',
  playlist_only: 'That is a playlist. Open one video from it and paste that link instead.',
  unsupported_path: 'Only links to a single video are supported (watch, youtu.be, Shorts, embed or live).',
  bad_video_id: 'That link does not contain a valid YouTube video ID.',
};

const fail = (code: SourceErrorCode): YouTubeParse => ({ ok: false, code, message: MESSAGES[code] });

export const canonicalVideoUrl = (videoId: string): string => `https://www.youtube.com/watch?v=${videoId}`;

export function parseYouTubeReference(input: unknown): YouTubeParse {
  if (typeof input !== 'string') return fail('empty');
  if (input.length > LIMITS.sourceUrlChars) return fail('too_long');
  const raw = input.trim();
  if (raw === '') return fail('empty');
  // Printable ASCII only: no whitespace, control characters or Unicode lookalikes.
  if (!/^[\x21-\x7E]+$/.test(raw) || raw.includes('\\')) return fail('malformed');
  if (!/^https:\/\//i.test(raw)) return /^[a-z][a-z0-9+.-]*:/i.test(raw) ? fail('scheme') : fail('malformed');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('malformed');
  }
  if (url.protocol !== 'https:') return fail('scheme');
  if (url.username !== '' || url.password !== '') return fail('credentials');
  if (url.port !== '') return fail('port');

  const host = url.hostname;
  let videoId: string | null;
  if (host === SHORT_HOST) {
    const segment = url.pathname.slice(1);
    if (segment === '' || segment.includes('/')) return fail('unsupported_path');
    videoId = segment;
  } else if (WATCH_HOSTS.has(host)) {
    const path = url.pathname;
    if (path === '/watch') {
      const ids = url.searchParams.getAll('v');
      if (ids.length === 0) return url.searchParams.has('list') ? fail('playlist_only') : fail('bad_video_id');
      if (new Set(ids).size !== 1) return fail('bad_video_id');
      videoId = ids[0]!;
    } else if (path === '/playlist') {
      return fail('playlist_only');
    } else {
      const prefix = PATH_ID_PREFIXES.find((p) => path.startsWith(p));
      if (prefix === undefined || host === 'music.youtube.com') return fail('unsupported_path');
      const segment = path.slice(prefix.length);
      if (segment.includes('/')) return fail('unsupported_path');
      videoId = segment;
    }
  } else {
    return fail('host');
  }

  if (!VIDEO_ID.test(videoId)) return fail('bad_video_id');
  return { ok: true, videoId, canonicalUrl: canonicalVideoUrl(videoId), timestamp: readTimestamp(url) };
}

function readTimestamp(url: URL): TimestampResult {
  const values = [...url.searchParams.getAll('t'), ...url.searchParams.getAll('start')];
  if (url.hash.length > 1) values.push(...new URLSearchParams(url.hash.slice(1)).getAll('t'));
  if (values.length === 0) return { kind: 'none' };
  const parsed = values.map(parseTimestamp);
  if (parsed.some((v) => v === null)) return { kind: 'invalid', reason: 'malformed' };
  if (new Set(parsed).size !== 1) return { kind: 'invalid', reason: 'conflict' };
  return { kind: 'valid', start: parsed[0]! };
}

const HMS = /^(?:(\d{1,9})h)?(?:(\d{1,9})m)?(?:(\d{1,9})s)?$/;
const COLON = /^(\d{1,9}):([0-5]\d)(?::([0-5]\d))?$/;

/** Parses integer seconds, ordered h/m/s components, or a colon time. Returns null when malformed. */
export function parseTimestamp(value: string): number | null {
  if (/^\d{1,9}$/.test(value)) return Number(value);
  const hms = HMS.exec(value);
  if (hms && value !== '') {
    const [, h, m, s] = hms;
    const hours = h === undefined ? 0 : Number(h);
    const minutes = m === undefined ? 0 : Number(m);
    const seconds = s === undefined ? 0 : Number(s);
    if (h !== undefined && minutes >= 60) return null;
    if ((h !== undefined || m !== undefined) && seconds >= 60) return null;
    return safe(hours * 3600 + minutes * 60 + seconds);
  }
  const colon = COLON.exec(value);
  if (colon) {
    const [, a, b, c] = colon;
    return c === undefined ? safe(Number(a) * 60 + Number(b)) : safe(Number(a) * 3600 + Number(b) * 60 + Number(c));
  }
  return null;
}

const safe = (n: number): number | null => (Number.isSafeInteger(n) && n >= 0 ? n : null);

export const defaultFocus = (start = 0): Focus => ({ start, end: start + LIMITS.focusDefaultSeconds });

export type FocusCheck = { readonly ok: true; readonly focus: Focus } | { readonly ok: false; readonly message: string };

export function validateFocus(value: unknown): FocusCheck {
  if (typeof value !== 'object' || value === null) return { ok: false, message: 'Set a start and end time.' };
  const { start, end } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    return { ok: false, message: 'Start and end must be whole seconds.' };
  }
  const s = start as number;
  const e = end as number;
  if (s < 0) return { ok: false, message: 'Start cannot be before the beginning.' };
  if (e <= s) return { ok: false, message: 'End must be after start.' };
  if (e - s > LIMITS.focusMaxSeconds) return { ok: false, message: `Choose at most ${LIMITS.focusMaxSeconds} seconds.` };
  return { ok: true, focus: { start: s, end: e } };
}

export function formatClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
