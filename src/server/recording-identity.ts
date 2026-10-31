import type { CandidateGap, ShownRecording } from '../shared/records.js';

// Conservative exact recording identity from deterministic upload metadata.
// - Titles must be equal after removing only an explicit allowlist of upload
//   decorations ("Official Audio", "[Official Music Video]", "| Visualizer"…) and
//   credit decorations (feat./ft./featuring/with). Containment is never enough:
//   "Sky" does not match "Sky High".
// - Every other bracketed/piped/dashed title decoration is a version marker (live,
//   remix, remaster, acoustic, edit…). Version markers must match the proposal
//   exactly in both directions, so a live/remix upload never stands in for the
//   proposed studio recording. Punctuation within a complete declared credit
//   remains part of the artist name rather than a recording version.
// - Credits must be complete: every declared artist appears in the metadata
//   credit text and nothing else does. Credits come from the uploaded title;
//   only when the title names no credit is the uploader name used. A channel
//   string never establishes official status or resolves a namesake on its own.
// - The recording key is built from the canonical title, the complete credit
//   set (order-independent) and the matched versions, so different declared
//   subsets cannot mint different keys for one recording.
// - First-party catalogue metadata (Apple Music) is matched field by field:
//   title from the track name, credits from the artist field, never a reading
//   that treats part of the title as a credit.

/**
 * Matching only, never display: retain Unicode letters/numbers and attached
 * marks while folding case, compatibility forms and the existing Latin accents.
 * Erasing other scripts can turn a different title or artist into an exact match.
 */
export const matchForm = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})[\u0300-\u036f]+/gu, '$1')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)?.join(' ') ?? '';

/** Upload decorations that do not change which recording this is. */
const ALLOWED_DECORATIONS = new Set(
  [
    'official audio',
    'official video',
    'official music video',
    'official visualizer',
    'official visualiser',
    'official lyric video',
    'official',
    'audio',
    'video',
    'music video',
    'visualizer',
    'visualiser',
    'lyric video',
    'hd',
    'hq',
    '4k',
    'explicit',
  ].map(matchForm),
);

const CREDIT_DECORATION = /^(?:feat\.?|ft\.?|featuring|with)\s+(.+)$/i;
const INLINE_FEAT = /\s(?:feat\.?|ft\.?|featuring)\s+(.+)$/i;
const DASH = /\s+[-–—]\s+/;
const CREDIT_JOINERS = new Set(['and', 'x', 'with', 'feat', 'ft', 'featuring', 'vs']);
const UNCERTAIN = /\b(cover|karaoke|tribute|reaction|tutorial|lesson|nightcore|sped up|slowed|8d audio|remake|parody|fan made)\b/;
const TOPIC = /\s+-\s+topic$/i;

/** All balanced groups, including nested groups, within already-bounded metadata. */
function enclosedSpans(raw: string): { start: number; end: number }[] {
  const stack: { open: string; start: number }[] = [];
  const enclosed: { start: number; end: number }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char === '(' || char === '[') stack.push({ open: char, start: i });
    else if (char === ')' || char === ']') {
      const last = stack.at(-1);
      if (last && last.open === (char === ')' ? '(' : '[')) {
        stack.pop();
        enclosed.push({ start: last.start, end: i });
      } else stack.length = 0;
    }
  }
  return enclosed;
}

/** Spaced dashes inside balanced credit/version/feature groups are content. */
function uploadFields(raw: string): string[] {
  const enclosed = enclosedSpans(raw);
  const fields: string[] = [];
  let start = 0;
  for (const match of raw.matchAll(new RegExp(DASH.source, 'g'))) {
    if (enclosed.some(range => range.start < match.index && match.index < range.end)) continue;
    fields.push(raw.slice(start, match.index));
    start = match.index + match[0].length;
  }
  fields.push(raw.slice(start));
  return fields;
}

interface TitleParts {
  /** Matching form of the bare title. */
  readonly core: string;
  /** Matching forms of version decorations, sorted. */
  readonly versions: readonly string[];
  /** Raw credit texts found in feat./with decorations. */
  readonly feat: readonly string[];
}

/** Separate complete outer groups without destroying nested punctuation. */
function decorations(raw: string): { base: string; segments: string[] } {
  const segments: string[] = [];
  let base = '', cursor = 0;
  // Consume complete outer groups. Removing only an inner group can expose a
  // version's dash as a title delimiter or break a nested featured artist name.
  for (const group of enclosedSpans(raw).sort((a, b) => a.start - b.start)) {
    if (group.start < cursor) continue;
    base += raw.slice(cursor, group.start) + ' ';
    segments.push(raw.slice(group.start + 1, group.end).trim());
    cursor = group.end + 1;
  }
  base += raw.slice(cursor);
  const piped = base.split(/\s+\|\s+/);
  base = piped[0] ?? '';
  segments.push(...piped.slice(1));
  return { base: base.replace(/\s+/g, ' ').trim(), segments };
}

/** Extract a top-level inline credit before its own name punctuation is parsed. */
function inlineCredit(raw: string, declared: readonly string[]): { base: string; feat: string[] } {
  const enclosed = enclosedSpans(raw);
  for (const marker of raw.matchAll(/\s(?:feat\.?|ft\.?|featuring)\s+/gi)) {
    if (enclosed.some(group => group.start < marker.index && marker.index < group.end)) continue;
    let credit = raw.slice(marker.index + marker[0].length).trim();
    if (credit === '') continue;
    if (explainCredits([credit], declared).extra) {
      // Only explicit upload decorations may be discarded from a feature name.
      // An unknown suffix such as (Special - Duo) remains part of that credit.
      let cleaned = '', cursor = 0;
      for (const group of enclosedSpans(credit).sort((a, b) => a.start - b.start)) {
        if (group.start < cursor) continue;
        cleaned += credit.slice(cursor, group.start);
        const inner = credit.slice(group.start + 1, group.end);
        cleaned += ALLOWED_DECORATIONS.has(matchForm(inner)) ? ' ' : credit.slice(group.start, group.end + 1);
        cursor = group.end + 1;
      }
      cleaned += credit.slice(cursor);
      credit = cleaned.split(/\s+\|\s+/).filter((part, i) => i === 0 || !ALLOWED_DECORATIONS.has(matchForm(part))).join(' | ').trim();
    }
    return { base: raw.slice(0, marker.index), feat: [credit] };
  }
  return { base: raw, feat: [] };
}

/** Inspect nested groups too: explicit credits cannot hide inside a version. */
function decompose(raw: string, declared: readonly string[] = []): { base: string; feat: string[]; versions: string[] } {
  const inline = inlineCredit(raw, declared);
  const root = decorations(inline.base);
  const segments = [...root.segments];
  const feat: string[] = [...inline.feat];
  const versions: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const credit = CREDIT_DECORATION.exec(seg);
    // Preserve the whole credited name, including its own parentheses/dashes.
    // Complete-credit validation later rejects any unexplained material.
    if (credit) feat.push(credit[1]!);
    else {
      const inline = inlineCredit(seg, declared);
      feat.push(...inline.feat);
      const nested = decorations(inline.base);
      segments.push(...nested.segments);
      // A version can also contain an inline feat./ft./featuring credit. Use
      // the same extraction as a bare title so that it cannot omit an artist.
      const parts = titleParts(nested.base, [], []);
      feat.push(...parts.feat);
      const version = parts.core;
      if (version !== '' && !ALLOWED_DECORATIONS.has(version)) versions.push(version);
    }
  }
  return { base: root.base, feat, versions };
}

function titleParts(base: string, feat: readonly string[], versions: readonly string[]): TitleParts {
  const inline = INLINE_FEAT.exec(base);
  const bare = inline ? base.slice(0, inline.index) : base;
  return {
    core: matchForm(bare),
    versions: [...versions].filter(Boolean).sort(),
    feat: inline ? [...feat, inline[1]!] : [...feat],
  };
}

const recordingKey = (parts: TitleParts, credits: readonly string[]) =>
  `${parts.core}|${credits.map(matchForm).sort().join(';')}|${parts.versions.join(';')}`;

/** A proposed/catalogue title contains no uploader credit prefix. */
function recordingTitle(raw: string, declared: readonly string[] = []): TitleParts {
  const parsed = decompose(raw, declared);
  const [title = '', ...tail] = parsed.base.split(DASH);
  return titleParts(title, parsed.feat, [...parsed.versions, ...tail.map(matchForm).filter(t => !ALLOWED_DECORATIONS.has(t))]);
}

/**
 * Preserve opaque admitted keys and add the current identity of each owned shown
 * recording. Earlier writers may have erased non-Latin text from their keys;
 * the immutable displayed title and complete credits still distinguish it.
 * Never apply the old lossy form to a new candidate: that would exclude distinct
 * recordings again. No stored key, record or feedback is rewritten here.
 */
export function recordingExclusionKeys(exclusions: { readonly shown: readonly ShownRecording[]; readonly known: readonly string[] }): Set<string> {
  const keys = new Set([...exclusions.known, ...exclusions.shown.map(r => r.key)]);
  for (const shown of exclusions.shown) {
    const parts = recordingTitle(shown.title, shown.credits);
    if (parts.core !== '' && shown.credits.length > 0 && shown.credits.every(c => matchForm(c) !== '')) {
      keys.add(recordingKey(parts, shown.credits));
    }
  }
  return keys;
}

/**
 * Checks the credit text is fully explained by the declared artists. Returns the
 * declared artists found and whether any unexplained (extra) credit remains.
 */
function explainCredits(texts: readonly string[], declared: readonly string[]): { found: Set<string>; extra: boolean } {
  const found = new Set<string>();
  let extra = false;
  // Match each independent credit field separately. A connector is harmless
  // only BETWEEN two matched names, never as a trailing/standalone artist.
  const marker = '\u0001'; // matchForm cannot produce this token.
  const ordered = [...declared].sort((a, b) => matchForm(b).length - matchForm(a).length);
  for (const text of texts) {
    // Preserve explicit separators so an artist named And is distinguishable
    // from the conjunction in "Alpha and Beta".
    const separator = '\u0002';
    const creditTokens = (value: string) => value.split(/[&,;]/).flatMap((part, i) => [...(i ? [separator] : []), ...matchForm(part).split(' ').filter(Boolean)]);
    const tokens = creditTokens(text);
    for (const artist of ordered) {
      const f = matchForm(artist);
      if (f === '') continue;
      const words = creditTokens(artist.replace(/&/g, ' and '));
      for (let i = 0; i <= tokens.length - words.length; i++) {
        if (!words.every((word, j) => tokens[i + j] === word || (words.length > 1 && word === 'and' && tokens[i + j] === separator))) continue;
        if (CREDIT_JOINERS.has(f) && i !== 0 && i + words.length !== tokens.length && tokens[i - 1] !== separator && tokens[i + words.length] !== separator) continue;
        found.add(artist);
        tokens.splice(i, words.length, marker);
      }
    }
    if (tokens.some((t, i) => t !== marker && !((t === separator || CREDIT_JOINERS.has(t)) && tokens[i - 1] === marker && tokens[i + 1] === marker))) extra = true;
  }
  return { found, extra };
}

export interface IdentityProposal {
  readonly title: string;
  readonly artists: readonly string[];
}

export interface UploadMetadata {
  readonly title: string;
  readonly channelName: string;
}

export type IdentityMatch =
  | {
      readonly ok: true;
      readonly credits: string[];
      readonly versions: readonly string[];
      readonly creditSource: 'title' | 'uploader_name';
      readonly topic: boolean;
      readonly recordingKey: string;
    }
  | { readonly ok: false; readonly gap: CandidateGap };

/** Separate first-party catalogue fields for one exact track (never a combined uploader string). */
export interface FirstPartyMetadata {
  readonly trackName: string;
  readonly artistName: string;
}

export type FirstPartyMatch =
  | { readonly ok: true; readonly credits: string[]; readonly versions: readonly string[]; readonly recordingKey: string }
  | { readonly ok: false; readonly gap: CandidateGap };

/**
 * Exact identity against first-party track fields. The title comes only from the
 * track name (with its own feat./version decorations and a dashed version tail,
 * never an "Artist - Title" reading); credits come only from the artist field
 * plus feat. credits written in the track name. Every declared artist must be
 * present and nothing else; versions must match in both directions. The
 * recording key has the same form as for an upload, so one recording is one key
 * across providers, storefronts and uploads.
 */
export function matchFirstPartyIdentity(proposal: IdentityProposal, anchorName: string, meta: FirstPartyMetadata): FirstPartyMatch {
  const declared = proposal.artists;
  const prop = recordingTitle(proposal.title, declared);
  if (prop.core === '') return { ok: false, gap: 'title_mismatch' };
  if (prop.feat.length > 0 && explainCredits(prop.feat, declared).extra) return { ok: false, gap: 'credits_unconfirmed' };

  const uncertain = UNCERTAIN.exec(matchForm(meta.trackName));
  if (uncertain && !prop.core.includes(uncertain[1]!) && !prop.versions.some((v) => v.includes(uncertain[1]!))) {
    return { ok: false, gap: 'uncertain_identity' };
  }
  const track = recordingTitle(meta.trackName, declared);
  if (track.core !== prop.core) return { ok: false, gap: 'title_mismatch' };
  if (track.versions.join('|') !== prop.versions.join('|')) return { ok: false, gap: 'version_mismatch' };
  const { found, extra } = explainCredits([meta.artistName, ...track.feat], declared);
  if (![...found].some((a) => matchForm(a) === matchForm(anchorName))) return { ok: false, gap: 'anchor_not_credited' };
  if (found.size < declared.length) return { ok: false, gap: 'credits_unconfirmed' };
  if (extra) return { ok: false, gap: 'credits_extra' };
  const credits = [...declared];
  return { ok: true, credits, versions: track.versions, recordingKey: recordingKey(track, credits) };
}

export function matchRecordingIdentity(proposal: IdentityProposal, anchorName: string, meta: UploadMetadata): IdentityMatch {
  const declared = proposal.artists;
  const prop = recordingTitle(proposal.title, declared);
  if (prop.core === '') return { ok: false, gap: 'title_mismatch' };
  // A credit written into the proposed title must itself be declared.
  if (prop.feat.length > 0 && explainCredits(prop.feat, declared).extra) return { ok: false, gap: 'credits_unconfirmed' };

  const uncertain = UNCERTAIN.exec(matchForm(meta.title));
  if (uncertain && !prop.core.includes(uncertain[1]!) && !prop.versions.some((v) => v.includes(uncertain[1]!))) {
    return { ok: false, gap: 'uncertain_identity' };
  }

  const topic = TOPIC.test(meta.channelName);
  const uploader = meta.channelName.replace(TOPIC, '');
  // Separate candidate credit/title fields before classifying decorations: a
  // bracket inside a complete declared artist name is not a recording version.
  const parts = uploadFields(meta.title);
  // Interpretations: "Credits - Title" (usual), "Title - Credits", or a bare title credited by the uploader name.
  const readings: { credit: string | null; title: string; tail: string[] }[] =
    parts.length >= 2
      ? [
          { credit: parts[0]!, title: parts[1]!, tail: parts.slice(2) },
          { credit: parts[1]!, title: parts[0]!, tail: parts.slice(2) },
          // "Title - Remastered 2011" on an uploader-credited upload: the tail is a version marker.
          { credit: null, title: parts[0]!, tail: parts.slice(1) },
        ]
      : [{ credit: null, title: parts[0] ?? '', tail: [] }];

  let firstGap: CandidateGap | null = null;
  for (const r of readings) {
    const title = decompose(r.title, declared);
    const credit = r.credit !== null && explainCredits([r.credit], declared).extra
      ? decompose(r.credit, declared) : { base: r.credit ?? '', feat: [], versions: [] };
    const tails = r.tail.map(tail => decompose(tail, declared));
    const tailVersions = tails.map(t => matchForm(t.base)).filter(t => t !== '' && !ALLOWED_DECORATIONS.has(t));
    const upload = titleParts(title.base, [...title.feat, ...credit.feat, ...tails.flatMap(t => t.feat)],
      [...title.versions, ...credit.versions, ...tails.flatMap(t => t.versions), ...tailVersions]);
    const gap = ((): CandidateGap | null => {
      if (upload.core !== prop.core) return 'title_mismatch';
      if (upload.versions.join('|') !== prop.versions.join('|')) return 'version_mismatch';
      const creditTexts = [r.credit === null ? uploader : credit.base, ...upload.feat];
      const { found, extra } = explainCredits(creditTexts, declared);
      if (![...found].some((a) => matchForm(a) === matchForm(anchorName))) return 'anchor_not_credited';
      if (found.size < declared.length) return 'credits_unconfirmed';
      if (extra) return 'credits_extra';
      return null;
    })();
    if (gap === null) {
      const credits = [...declared];
      return {
        ok: true,
        credits,
        versions: upload.versions,
        creditSource: r.credit === null ? 'uploader_name' : 'title',
        topic,
        recordingKey: recordingKey(upload, credits),
      };
    }
    firstGap ??= gap;
  }
  return { ok: false, gap: firstGap ?? 'title_mismatch' };
}
