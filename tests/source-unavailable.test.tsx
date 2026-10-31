import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Handle, SafePanel, SafeSnapshot } from '../src/shared/records.js';
import { resultAnnouncement } from '../src/client/announce.js';
import { ChoicesPanel, EarlierPanel, RefinePanel } from '../src/client/discovery.js';
import { recordingEvidence } from '../src/client/overlay.js';

// Client presentation of a result the server withholds because its required native
// Search presentation cannot be shown under the current source policy
// ('source_unavailable'). Invented values only; server-rendered markup, no browser.

const H = (s: string) => s.padEnd(24, '0') as Handle;
const BASIS = ['Searched recordings by the 3 artists connected to Invented Seed.'];

const complete: SafePanel = {
  handle: H('panel-complete'),
  synthetic: false,
  role: 'initial',
  mode: null,
  basis: BASIS,
  outcome: 'choices',
  choices: [
    {
      handle: H('choice-1'),
      title: 'Invented Song',
      credits: ['Neighbour X11'],
      unverifiedCredits: 0,
      anchor: 'Neighbour X11',
      playUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
      service: 'youtube',
      fitHypothesis: 'It may keep the groove.',
      sources: [0],
      feedback: { fit: null, familiarity: null, revision: 0 },
    },
  ],
  answer: { text: 'Invented answer.', marks: [] },
  citations: [{ title: 'Invented source 1', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x', domain: 'source1.invalid' }],
  suggestionsUrl: `/api/suggestions/${H('panel-complete')}`,
  gaps: [],
};
// Exactly what the server projects for a withheld result: safe context only.
const hidden: SafePanel = { ...complete, handle: H('panel-hidden'), outcome: 'source_unavailable', choices: [], answer: { text: '', marks: [] }, citations: [], suggestionsUrl: null, gaps: [] };

const snapshotWith = (panel: SafePanel, used: boolean) =>
  ({
    panel,
    brief: { handle: H('brief'), version: 1, relationship: 'invented warmth', source: 'free_text', artists: ['Invented Seed'] },
    refinement: { used },
    connection: { anchors: [{ handle: H('anchor-1'), name: 'Neighbour X11' }] },
  }) as unknown as SafeSnapshot;

const NO_MATCH_WORDING = /No recording could be confirmed|could not confirm a recording|no recording confirmed/i;

describe('withheld (source_unavailable) result presentation', () => {
  it('the result panel shows only a truthful notice with the safe basis and a recovery route: no picks, links, answer, sources or frame', () => {
    const html = renderToStaticMarkup(<ChoicesPanel panel={hidden} />);
    expect(html).toContain('hidden because the Google Search information they must be shown with can no longer be displayed safely');
    expect(html).toContain('not a sign that nothing was found');
    expect(html).toContain('Clear session in the menu');
    expect(html).toContain(BASIS[0]);
    expect(html).not.toMatch(/<iframe|<article|<a |Play |Full answer and sources|proposed recording/);
    expect(html).not.toMatch(NO_MATCH_WORDING);
  });

  it('a complete panel still renders its picks, sources and isolated frame (control)', () => {
    const html = renderToStaticMarkup(<ChoicesPanel panel={complete} />);
    expect(html).toMatch(/<iframe[^>]*src="\/api\/suggestions\//);
    expect(html).toContain('Play on YouTube');
    expect(html).toContain('Invented source 1');
    expect(html).not.toContain('can no longer be displayed safely');
  });

  it('an earlier withheld panel is labelled as hidden, not as a no-match, and reveals nothing when opened', () => {
    const html = renderToStaticMarkup(
      <EarlierPanel panel={hidden}>
        <ChoicesPanel panel={hidden} />
      </EarlierPanel>,
    );
    expect(html).toContain('Earlier choices (hidden: required source information unavailable)');
    expect(html).not.toMatch(NO_MATCH_WORDING);
    expect(html).not.toMatch(/<iframe|Play /);
  });

  it('offers the existing explicit refined search while unused (no automatic action), and states plainly once it is used', () => {
    const open = renderToStaticMarkup(<RefinePanel snapshot={snapshotWith(hidden, false)} disabled={false} onRefine={() => undefined} />);
    expect(open).toContain('Those results are hidden. Try a fresh search.');
    expect(open).toContain('One refinement per song.');
    expect(open).toContain('Find fresh recordings');
    expect(open).not.toMatch(/Nothing fit\?|>Follow /);
    const used = renderToStaticMarkup(<RefinePanel snapshot={snapshotWith(hidden, true)} disabled={false} onRefine={() => undefined} />);
    expect(used).toContain('Refinement used.');
    expect(used).not.toContain('Earlier choices stay above');
    expect(used).not.toContain('Find fresh recordings');
  });

  it('the announcement and the Why sheet name the withheld result instead of claiming a no-match', () => {
    expect(resultAnnouncement(hidden, null)).toBe('The recording result is hidden: its required source information is unavailable.');
    expect(resultAnnouncement({ ...hidden, role: 'refinement' }, null)).toBe('The refined search result is hidden: its required source information is unavailable.');
    const evidence = recordingEvidence({ outcome: 'source_unavailable', count: 0, refined: false, synthetic: false });
    expect(evidence).toContain('its result is hidden');
    expect(evidence).not.toMatch(NO_MATCH_WORDING);
    // Controls: unchanged wording for real outcomes.
    expect(resultAnnouncement(complete, null)).toBe('One recording choice is ready.');
    expect(resultAnnouncement({ ...complete, outcome: 'no_match', choices: [] }, null)).toBe('No recording could be confirmed within these connections.');
  });
});
