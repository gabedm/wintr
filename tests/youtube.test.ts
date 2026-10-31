import { describe, expect, it } from 'vitest';
import { defaultFocus, formatClock, parseTimestamp, parseYouTubeReference, validateFocus } from '../src/shared/youtube.js';

const ID = 'dQw4w9WgXcQ';
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`;

function ok(input: string) {
  const r = parseYouTubeReference(input);
  if (!r.ok) throw new Error(`expected ok for ${input}, got ${r.code}`);
  return r;
}

function code(input: unknown) {
  const r = parseYouTubeReference(input);
  return r.ok ? 'ok' : r.code;
}

describe('parseYouTubeReference: accepted forms', () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`,
    `  https://youtu.be/${ID}  `,
  ])('accepts %s and rebuilds the canonical URL from the ID only', (input) => {
    const r = ok(input);
    expect(r.videoId).toBe(ID);
    expect(r.canonicalUrl).toBe(CANONICAL);
  });

  it('drops playlist, tracking and other parameters from the canonical URL', () => {
    const r = ok(`https://www.youtube.com/watch?v=${ID}&list=PLabc&index=3&si=tracking&feature=share`);
    expect(r.canonicalUrl).toBe(CANONICAL);
    expect(r.timestamp).toEqual({ kind: 'none' });
  });

  it('accepts repeated identical v values', () => {
    expect(ok(`https://www.youtube.com/watch?v=${ID}&v=${ID}`).videoId).toBe(ID);
  });
});

describe('parseYouTubeReference: rejections', () => {
  it.each([
    [undefined, 'empty'],
    ['', 'empty'],
    ['   ', 'empty'],
    [`http://www.youtube.com/watch?v=${ID}`, 'scheme'],
    [`javascript:alert(1)//https://youtu.be/${ID}`, 'scheme'],
    [`ftp://youtu.be/${ID}`, 'scheme'],
    [`www.youtube.com/watch?v=${ID}`, 'malformed'],
    [`https:youtu.be/${ID}`, 'scheme'],
    [`https://user:pass@www.youtube.com/watch?v=${ID}`, 'credentials'],
    [`https://user@youtu.be/${ID}`, 'credentials'],
    [`https://www.youtube.com:8443/watch?v=${ID}`, 'port'],
    [`https://www.youtube.com.evil.example/watch?v=${ID}`, 'host'],
    [`https://evilyoutube.com/watch?v=${ID}`, 'host'],
    [`https://youtu.be.evil.example/${ID}`, 'host'],
    [`https://www.youtube.com./watch?v=${ID}`, 'host'],
    [`https://127.0.0.1/watch?v=${ID}`, 'host'],
    [`https://localhost/watch?v=${ID}`, 'host'],
    [`https://[::1]/watch?v=${ID}`, 'host'],
    [`https://169.254.169.254/watch?v=${ID}`, 'host'],
    [`https://www.youtube-nocookie.com/embed/${ID}`, 'host'],
    [`https://evil.example\\@www.youtube.com/watch?v=${ID}`, 'malformed'],
    [`https://www.youtube.com/watch?v=${ID} extra`, 'malformed'],
    [`https://www.yоutube.com/watch?v=${ID}`, 'malformed'],
    ['https://www.youtube.com/playlist?list=PLabcdef', 'playlist_only'],
    ['https://www.youtube.com/watch?list=PLabcdef', 'playlist_only'],
    ['https://www.youtube.com/watch', 'bad_video_id'],
    ['https://www.youtube.com/watch?v=short', 'bad_video_id'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQQ', 'bad_video_id'],
    ['https://www.youtube.com/watch?v=dQw4w9WgX%2FQ', 'bad_video_id'],
    [`https://www.youtube.com/watch?v=${ID}&v=aaaaaaaaaaa`, 'bad_video_id'],
    ['https://youtu.be/dQw4w9WgX!Q', 'bad_video_id'],
    [`https://youtu.be/${ID}/extra`, 'unsupported_path'],
    ['https://youtu.be/', 'unsupported_path'],
    ['https://www.youtube.com/channel/UCabcdefghijk', 'unsupported_path'],
    [`https://www.youtube.com/shorts/${ID}/x`, 'unsupported_path'],
    [`https://music.youtube.com/shorts/${ID}`, 'unsupported_path'],
    [`https://www.youtube.com/attribution_link?u=/watch?v=${ID}`, 'unsupported_path'],
  ])('rejects %s as %s', (input, expected) => {
    expect(code(input)).toBe(expected);
  });

  it('rejects URLs over 2,048 characters before parsing', () => {
    expect(code(`https://youtu.be/${ID}?x=${'a'.repeat(2048)}`)).toBe('too_long');
  });

  it('returns a human message with every rejection', () => {
    const r = parseYouTubeReference('https://example.com/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/youtube/i);
  });
});

describe('timestamps and focus', () => {
  it.each([
    ['12', 12],
    ['12s', 12],
    ['1m12s', 72],
    ['1h2m3s', 3723],
    ['2m', 120],
    ['1h', 3600],
    ['1:12', 72],
    ['01:02:03', 3723],
    ['0', 0],
  ])('parses %s as %i seconds', (value, seconds) => {
    expect(parseTimestamp(value)).toBe(seconds);
  });

  it.each(['', 'abc', '1m72s', '1h60m', '12x', '-5', '1.5', '1:5', '1:60', 's', '1s2m', '1234567890'])('rejects malformed %j', (v) => {
    expect(parseTimestamp(v)).toBeNull();
  });

  it('prefills t=12 and t=1m12s focus values', () => {
    expect(ok(`https://youtu.be/${ID}?t=12`).timestamp).toEqual({ kind: 'valid', start: 12 });
    expect(ok(`https://www.youtube.com/watch?v=${ID}&t=1m12s`).timestamp).toEqual({ kind: 'valid', start: 72 });
    expect(defaultFocus(12)).toEqual({ start: 12, end: 57 });
    expect(formatClock(72)).toBe('01:12');
    expect(formatClock(117)).toBe('01:57');
  });

  it('reads start= and #t= fragment forms', () => {
    expect(ok(`https://www.youtube.com/embed/${ID}?start=30`).timestamp).toEqual({ kind: 'valid', start: 30 });
    expect(ok(`https://www.youtube.com/watch?v=${ID}#t=1:12`).timestamp).toEqual({ kind: 'valid', start: 72 });
  });

  it('accepts repeated values that agree after normalisation', () => {
    expect(ok(`https://www.youtube.com/watch?v=${ID}&t=72&start=1m12s#t=1:12`).timestamp).toEqual({ kind: 'valid', start: 72 });
  });

  it('flags conflicting or malformed supplied values instead of resetting to zero', () => {
    expect(ok(`https://www.youtube.com/watch?v=${ID}&t=12&start=30`).timestamp).toEqual({ kind: 'invalid', reason: 'conflict' });
    expect(ok(`https://youtu.be/${ID}?t=soon`).timestamp).toEqual({ kind: 'invalid', reason: 'malformed' });
    expect(ok(`https://youtu.be/${ID}?t=`).timestamp).toEqual({ kind: 'invalid', reason: 'malformed' });
  });

  it('validates focus bounds', () => {
    expect(validateFocus({ start: 0, end: 45 })).toEqual({ ok: true, focus: { start: 0, end: 45 } });
    expect(validateFocus({ start: 10, end: 70 }).ok).toBe(true);
    expect(validateFocus({ start: 10, end: 71 }).ok).toBe(false);
    expect(validateFocus({ start: 10, end: 10 }).ok).toBe(false);
    expect(validateFocus({ start: -1, end: 10 }).ok).toBe(false);
    expect(validateFocus({ start: 1.5, end: 10 }).ok).toBe(false);
    expect(validateFocus({ start: '1', end: 10 }).ok).toBe(false);
    expect(validateFocus({ start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER + 1 }).ok).toBe(false);
    expect(validateFocus(null).ok).toBe(false);
  });
});
