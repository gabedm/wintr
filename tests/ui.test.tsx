// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import type { Handle, SafePanel, SafeSnapshot } from '../src/shared/records.js';
import { MenuSheet, ShellLayout, SourceDetails, sourceSummary } from '../src/client/App.js';
import { AnalysisView, ChoicesPanel, ConnectionPanel, EarlierPanel, PreferencePanel, RefinePanel } from '../src/client/discovery.js';
import { resultAnnouncement } from '../src/client/announce.js';
import { isSubmitKey, shouldDismissKeyboard } from '../src/client/keys.js';
import { analysisBlockedReason, MODE_COPY } from '../src/client/readiness.js';
import { expandedMenu } from './fixtures/expanded-menu.js';

const h = (s: string) => s.padEnd(24, '0') as Handle;
const choice = (n: number, fit: 'like' | 'not_right' | null, familiarity: 'new' | 'known' | null): SafePanel['choices'][number] => ({
  handle: h(`choice${n}`),
  title: `Invented Song ${n}`,
  credits: [`Neighbour X${n}`],
  unverifiedCredits: 0,
  anchor: `Neighbour X${n}`,
  playUrl: null,
  service: 'youtube',
  fitHypothesis: 'It may keep the groove.',
  sources: [],
  feedback: { fit, familiarity, revision: fit || familiarity ? 1 : 0 },
});
const panel = (choices: SafePanel['choices'], o: Partial<SafePanel> = {}): SafePanel => ({
  handle: h('panel'),
  synthetic: true,
  role: 'initial',
  mode: null,
  basis: [],
  outcome: choices.length > 0 ? 'choices' : 'no_match',
  choices,
  answer: { text: 'Invented answer.', marks: [] },
  citations: [],
  suggestionsUrl: null,
  gaps: [],
  ...o,
});
const snapWith = (p: SafePanel, used = false): SafeSnapshot => ({
  mode: 'synthetic',
  session: { context: 'ctx', expiresAt: 1 },
  stage: 'complete',
  revision: 1,
  status: 'choices_ready',
  attempt: null,
  reference: null,
  listenerCue: null,
  analysis: null,
  brief: { handle: h('brief'), version: 1, relationship: 'the groove', source: 'analysis_choice', artists: ['Generic Artist'] },
  identity: null,
  connection: {
    synthetic: true,
    seeds: ['Generic Artist'],
    artists: ['Neighbour X1', 'Neighbour X2'],
    anchors: [
      { handle: h('anchor1'), name: 'Neighbour X1' },
      { handle: h('anchor2'), name: 'Neighbour X2' },
    ],
    tags: [],
    capability: 'artists_only',
    attribution: 'seed_mix',
    why: [],
  },
  panel: p,
  history: [],
  refinement: { used },
  code: null,
});

describe('feedback and refinement controls', () => {
  it('shows independent fit and familiarity toggles per recording, with a clear option once set', () => {
    const html = renderToStaticMarkup(<ChoicesPanel panel={panel([choice(1, 'like', 'known'), choice(2, null, null)])} disabled={false} />);
    expect(html).toMatch(/aria-label="Does it fit\?"/);
    expect(html).toMatch(/aria-label="Do you know it\?"/);
    // A known recording can still be liked: both toggles are pressed independently.
    expect(html).toMatch(/aria-pressed="true"[^>]*>Like it/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Already know it/);
    expect(html.match(/Clear feedback/g)).toHaveLength(1);
    expect(html).toContain('Play unavailable (synthetic fixture)');
  });

  it('offers Follow only for liked recordings, correction directly when nothing fits, and an honest used state', () => {
    const liked = renderToStaticMarkup(<RefinePanel snapshot={snapWith(panel([choice(1, 'like', 'known'), choice(2, 'not_right', null)]))} disabled={false} onRefine={() => {}} />);
    expect(liked).toContain('Follow Neighbour X1');
    expect(liked).not.toContain('Follow Neighbour X2');
    expect(liked).toContain('Find fresh recordings');
    expect(liked).toContain('One refinement per song');

    const none = renderToStaticMarkup(<RefinePanel snapshot={snapWith(panel([choice(1, 'not_right', null), choice(2, 'not_right', 'known')]))} disabled={false} onRefine={() => {}} />);
    expect(none).not.toMatch(/>Follow /);
    expect(none).toContain('Try another direction');
    expect(none).toMatch(/class="primary"[^>]*>Find fresh recordings/);
    expect(none).toContain('Leave out connected artists');

    const empty = renderToStaticMarkup(<RefinePanel snapshot={snapWith(panel([]))} disabled={false} onRefine={() => {}} />);
    expect(empty).toContain('Try another direction');

    const used = renderToStaticMarkup(<RefinePanel snapshot={snapWith(panel([choice(1, 'like', null)]), true)} disabled={false} onRefine={() => {}} />);
    expect(used).toContain('Refinement used');
    expect(used).not.toMatch(/>Follow |Find fresh recordings/);
  });

  it('shows a refined panel’s factual basis', () => {
    const html = renderToStaticMarkup(
      <ChoicesPanel panel={panel([choice(3, null, null)], { role: 'refinement', mode: 'correct_direction', basis: ['The artist connections from the earlier search were reused; no new artist lookup was made.'] })} />,
    );
    expect(html).toContain('aria-label="Refined recording choices"');
    expect(html).toContain('no new artist lookup was made');
  });
});

describe('source details layout', () => {
  it('is a compact disclosure with a named Edit action, and forced open when something needs attention', () => {
    const closed = renderToStaticMarkup(<SourceDetails compact summary="Focus 00:12–00:57" attention={false}><input aria-label="field" /></SourceDetails>);
    expect(closed).toContain('Focus 00:12–00:57');
    expect(closed).toMatch(/Edit<span class="visually-hidden"> focus and note<\/span>/);
    expect(closed).not.toMatch(/<details[^>]* open/);
    // The fields stay in the DOM (reachable by Edit), not removed.
    expect(closed).toContain('aria-label="field"');
    // Invalid or unclear input is never hidden.
    expect(renderToStaticMarkup(<SourceDetails compact summary="Set the focus" attention><input /></SourceDetails>)).toMatch(/<details[^>]* open/);
    expect(renderToStaticMarkup(<SourceDetails compact={false} summary="x" attention={false}><input aria-label="field" /></SourceDetails>)).not.toContain('<details');
  });

  it('summarises the focus and note on one short line without losing the full note', () => {
    expect(sourceSummary('Focus 0:00–0:45', '')).toBe('Focus 0:00–0:45');
    expect(sourceSummary('Focus 0:00–0:45', '  The groove ')).toBe('Focus 0:00–0:45 · “The groove”');
    const long = 'x'.repeat(200);
    const s = sourceSummary('Focus 0:00–0:45', long);
    expect(s.length).toBeLessThan(80);
    expect(s).toContain('…');
  });

  it('lets narrow fields shrink and wrap instead of clipping', () => {
    const css = readFileSync('src/client/styles.css', 'utf8');
    expect(css).toMatch(/\.focus-row \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.field \{[^}]*min-width: 0/);
    expect(css).toMatch(/\.field input \{[^}]*width: 100%;[^}]*min-width: 0/);
  });
});

describe('workflow context collapses once results exist, without losing content', () => {
  const analysis = {
    handle: h('analysis'),
    synthetic: true,
    audioAccess: 'accessed' as const,
    observations: ['First invented observation.', 'Second invented observation.'],
    relationships: ['The invented groove', 'The invented vocal'],
    proposedArtist: 'Generic Artist',
  };
  const brief = { handle: h('brief'), version: 1, relationship: 'the groove', source: 'intake_cue' as const, artists: ['Generic Artist'] };
  const connection = snapWith(panel([])).connection!;
  const detailsOf = (html: string) => html.slice(html.indexOf('<details'));

  it('leads with one observation before a relationship is saved, with the rest contextual', () => {
    const html = renderToStaticMarkup(<AnalysisView analysis={analysis} />);
    const visible = html.slice(0, html.indexOf('<details'));
    expect(visible).toContain('First invented observation.');
    expect(visible).not.toContain('Second invented observation.');
    expect(detailsOf(html)).toContain('Second invented observation.');
  });

  it('keeps the whole analysis, behind a disclosure, once saved; limits and the synthetic label stay visible', () => {
    const html = renderToStaticMarkup(<AnalysisView analysis={{ ...analysis, audioAccess: 'unavailable' }} saved />);
    const visible = html.slice(0, html.indexOf('<details'));
    expect(visible).toContain('Synthetic placeholder');
    expect(visible).toContain('could not be analysed');
    expect(visible).not.toContain('First invented observation.');
    for (const text of [...analysis.observations, ...analysis.relationships]) expect(detailsOf(html)).toContain(text);
  });

  it('shows the saved choice as one line of context once recordings exist, with no pre-search actions', () => {
    const before = renderToStaticMarkup(<PreferencePanel snapshot={{ ...snapWith(panel([])), analysis, brief, panel: null }} disabled={false} onSave={async () => true} onDiscover={() => {}} />);
    expect(before).toContain('Discover connections');
    expect(before).toContain('(from your note)');
    const after = renderToStaticMarkup(<PreferencePanel snapshot={{ ...snapWith(panel([choice(1, null, null)])), analysis, brief }} disabled={false} onSave={async () => true} onDiscover={() => {}} />);
    expect(after).toContain('Keeping:');
    expect(after).toContain('Generic Artist');
    expect(after).not.toMatch(/Discover connections|<button/);
  });

  it('offers an unambiguous proposed artist as editable context, and opens the fields when none is known', () => {
    const unsaved = (proposedArtist: string | null) => ({ ...snapWith(panel([])), analysis: { ...analysis, proposedArtist }, brief: null, panel: null });
    const proposed = renderToStaticMarkup(<PreferencePanel snapshot={unsaved('Generic Artist')} disabled={false} onSave={async () => true} onDiscover={() => {}} />);
    expect(proposed).toContain('Starting from Generic Artist');
    expect(proposed).toMatch(/value="Generic Artist"/);
    expect(proposed).not.toMatch(/<details[^>]* open/);
    const none = renderToStaticMarkup(<PreferencePanel snapshot={unsaved(null)} disabled={false} onSave={async () => true} onDiscover={() => {}} />);
    expect(none).toMatch(/<details[^>]* open/);
    expect(none).toContain('Choose the artist to start from');
  });

  it('keeps the connection compact: a factual preview with the synthetic label and one direct Why trigger (reasons and the full list live in the Why sheet)', () => {
    const html = renderToStaticMarkup(<ConnectionPanel connection={{ ...connection, why: ['An invented reason.'] }} onWhy={() => {}} />);
    expect(html).toContain('Synthetic connection');
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Why this connection<\/button>/);
    expect(html).toContain('Neighbour X1 and Neighbour X2');
    expect(html).not.toContain('An invented reason.');
    expect(html).not.toContain('<details');
    expect(renderToStaticMarkup(<ConnectionPanel connection={connection} />)).not.toContain('Why this connection');
  });

  it('keeps an earlier panel whole inside a titled disclosure', () => {
    const earlier = panel([choice(1, 'like', null), choice(2, null, null)], { role: 'initial', answer: { text: 'Complete invented earlier answer.', marks: [] } });
    const html = renderToStaticMarkup(
      <EarlierPanel panel={earlier}>
        <ChoicesPanel panel={earlier} disabled={false} />
      </EarlierPanel>,
    );
    expect(html).toMatch(/<summary>Earlier choices: Invented Song 1, Invented Song 2<\/summary>/);
    expect(html).toContain('Complete invented earlier answer.');
    expect(html).toContain('Full answer and sources');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Like it/);
    expect(renderToStaticMarkup(<EarlierPanel panel={panel([])}>x</EarlierPanel>)).toContain('no recording confirmed');
  });
});

describe('composer Enter guard', () => {
  const base = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 };
  it('submits on plain Enter only', () => {
    expect(isSubmitKey(base)).toBe(true);
    expect(isSubmitKey({ ...base, shiftKey: true })).toBe(false);
    expect(isSubmitKey({ ...base, key: 'a', keyCode: 65 })).toBe(false);
  });
  it('never submits while an IME composition is being confirmed', () => {
    expect(isSubmitKey({ ...base, isComposing: true })).toBe(false);
    expect(isSubmitKey({ ...base, keyCode: 229 })).toBe(false);
  });
});

describe('menu sheet', () => {
  it('makes the background inert and renders the dialog outside it', () => {
    const open = renderToStaticMarkup(
      <ShellLayout menuOpen sheet={<div role="dialog">sheet</div>}>
        <button type="button">background</button>
      </ShellLayout>,
    );
    expect(open).toBe('<div class="app" inert=""><button type="button">background</button></div><div role="dialog">sheet</div>');
    const closed = renderToStaticMarkup(
      <ShellLayout menuOpen={false} sheet={null}>
        <button type="button">background</button>
      </ShellLayout>,
    );
    expect(closed).toBe('<div class="app"><button type="button">background</button></div>');
  });

  it('describes session scope in the expanded privacy panel without promising browser-free or exact-hour deletion', async () => {
    const html = await expandedMenu({ mode: 'synthetic', onClose() {}, onClear() {} });
    expect(html).toMatch(/short-lived session cookie/);
    expect(html).toMatch(/No Wintr account or permanent chat history/);
    expect(html).toMatch(/New chats share that expiry/);
    expect(html).toMatch(/Expired records are removed during cleanup/);
    expect(html).not.toMatch(/nothing is kept in your browser/i);
    expect(html).toMatch(/aria-modal="true"/);
  });
});

describe('readiness and copy follow the server-reported mode', () => {
  it('offers Analyse in synthetic and live, refuses disabled with a reason, waits before the first snapshot', () => {
    expect(analysisBlockedReason('synthetic')).toBeNull();
    expect(analysisBlockedReason('live')).toBeNull();
    expect(analysisBlockedReason('disabled')).toBe('Analysis is unavailable right now.');
    expect(analysisBlockedReason(null)).toBe('Connecting…');
  });

  it('labels a live snapshot as live in the expanded privacy panel, and says what is sent where', async () => {
    const live = await expandedMenu({ mode: 'live', onClose() {}, onClear() {} });
    expect(live).toContain(MODE_COPY.live.menu);
    expect(live).not.toMatch(/disabled|Synthetic/i);
    expect(MODE_COPY.live.note).not.toMatch(/disabled|synthetic/i);
    expect(MODE_COPY.live.menu).toMatch(/Google Gemini/);
    expect(MODE_COPY.live.menu).toMatch(/Qloo/);
    expect(MODE_COPY.live.menu).toMatch(/Google Search/);
    const disabled = await expandedMenu({ mode: 'disabled', onClose() {}, onClear() {} });
    expect(disabled).toContain('Providers are disabled in this build.');
    const synthetic = await expandedMenu({ mode: 'synthetic', onClose() {}, onClear() {} });
    expect(synthetic).toContain(MODE_COPY.synthetic.menu);
  });

  it('links the shipped font and software notices from the expanded menu', async () => {
    const html = await expandedMenu({ mode: 'live', onClose() {}, onClear() {} });
    const links = [...html.matchAll(/href="(\/licenses\/[^"]+)"/g)].map((m) => m[1]!);
    expect(links).toEqual(['/licenses/Inter-OFL.txt', '/licenses/Software-NOTICES.txt', '/licenses/Asset-NOTICES.txt']);
    for (const l of links.filter(l=>l!=='/licenses/Asset-NOTICES.txt')) expect(readFileSync(`src/client/public${l}`, 'utf8')).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
    expect(readFileSync('src/client/public/licenses/Asset-NOTICES.txt','utf8')).toContain('Apple');
  });

  it('does not call a non-synthetic recording without a link a synthetic fixture', () => {
    const real = renderToStaticMarkup(<ChoicesPanel panel={panel([choice(1, null, null)], { synthetic: false })} />);
    expect(real).toContain('Play unavailable');
    expect(real).not.toMatch(/synthetic/i);
    const fixture = renderToStaticMarkup(<ChoicesPanel panel={panel([choice(1, null, null)])} />);
    expect(fixture).toContain('Play unavailable (synthetic fixture)');
  });
});

describe('result announcement names the actual outcome', () => {
  it('counts only confirmed choices, says no-match plainly, and never reads out titles', () => {
    expect(resultAnnouncement(panel([choice(1, null, null), choice(2, null, null)]), null)).toBe('2 recording choices are ready.');
    expect(resultAnnouncement(panel([choice(1, null, null)]), null)).toBe('One recording choice is ready.');
    expect(resultAnnouncement(panel([choice(1, null, null)]), null)).not.toContain('Invented Song');
    const none = resultAnnouncement(panel([]), null);
    expect(none).toMatch(/No recording could be confirmed/);
    expect(none).not.toMatch(/ready|choices/i);
    // A no-match outcome is never announced as success even if stale choices were present.
    expect(resultAnnouncement(panel([choice(1, null, null)], { outcome: 'no_match' }), null)).toMatch(/No recording could be confirmed/);
    expect(resultAnnouncement(panel([choice(1, null, null)], { role: 'refinement' }), null)).toBe('Refined search: One recording choice is ready.');
    expect(resultAnnouncement(panel([], { role: 'refinement' }), null)).toMatch(/refined search could not confirm/);
  });

  it('is honest about a reference that was declined or could not be analysed', () => {
    expect(resultAnnouncement(null, { audioAccess: 'refused' })).toMatch(/declined/);
    expect(resultAnnouncement(null, { audioAccess: 'unavailable' })).toMatch(/could not be analysed/);
    expect(resultAnnouncement(null, { audioAccess: 'accessed' })).toBe('Reference analysis is ready.');
    expect(resultAnnouncement(null, { audioAccess: 'synthetic_not_accessed' })).toBe('Reference analysis is ready.');
  });
});

describe('touch Send dismisses the keyboard only when it should', () => {
  const base = { sent: true, composing: false, via: 'button' as const, pointerType: 'touch', coarsePrimary: true };
  it('dismisses for an accepted touch Send', () => {
    expect(shouldDismissKeyboard(base)).toBe(true);
    expect(shouldDismissKeyboard({ ...base, via: 'enter', pointerType: undefined })).toBe(true);
    // Older engines report no pointer type: the coarse, hover-less primary input decides.
    expect(shouldDismissKeyboard({ ...base, pointerType: undefined })).toBe(true);
  });
  it('keeps focus for mouse, pen, keyboard activation and desktop Enter', () => {
    expect(shouldDismissKeyboard({ ...base, pointerType: 'mouse', coarsePrimary: false })).toBe(false);
    expect(shouldDismissKeyboard({ ...base, pointerType: 'pen' })).toBe(false);
    expect(shouldDismissKeyboard({ ...base, pointerType: '' })).toBe(false);
    expect(shouldDismissKeyboard({ ...base, pointerType: undefined, coarsePrimary: false })).toBe(false);
    expect(shouldDismissKeyboard({ ...base, via: 'enter', pointerType: undefined, coarsePrimary: false })).toBe(false);
  });
  it('never dismisses during composition or when nothing was sent', () => {
    expect(shouldDismissKeyboard({ ...base, composing: true })).toBe(false);
    expect(shouldDismissKeyboard({ ...base, via: 'enter', composing: true })).toBe(false);
    expect(shouldDismissKeyboard({ ...base, sent: false })).toBe(false);
    expect(shouldDismissKeyboard({ ...base, via: 'enter', sent: false })).toBe(false);
  });
});

describe('listening button names its actual destination', () => {
  const real = (c: SafePanel['choices'][number]) => renderToStaticMarkup(<ChoicesPanel panel={panel([c], { synthetic: false })} />);
  it('labels Apple Music and YouTube links by service and links only each service\'s exact canonical route', () => {
    const appleUrl = 'https://music.apple.com/us/song/9100000001';
    const a = real({ ...choice(1, null, null), service: 'apple_music', playUrl: appleUrl });
    expect(a).toContain(`href="${appleUrl}"`);
    expect(a).toContain('Open in Apple Music');
    expect(a).not.toMatch(/Play on YouTube|free|full song/i);
    const y = real({ ...choice(2, null, null), service: 'youtube', playUrl: 'https://www.youtube.com/watch?v=invVid00001' });
    expect(y).toContain('Play on YouTube');
    // A URL of the other service, a non-canonical Apple route or another page is never shown as a link.
    for (const [service, url] of [
      ['youtube', appleUrl],
      ['apple_music', 'https://www.youtube.com/watch?v=invVid00001'],
      ['apple_music', 'https://music.apple.com/us/album/x/9000000001?i=9100000001'],
      ['apple_music', 'https://music.apple.com/us/artist/x/9100000001'],
      ['apple_music', `${appleUrl}#x`],
    ] as const) {
      const html = real({ ...choice(3, null, null), service, playUrl: url });
      expect(html).not.toContain('href=');
      expect(html).toContain('Play unavailable');
    }
  });
});
