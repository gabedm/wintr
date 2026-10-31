import type { SafePanel, SafeSnapshot } from '../shared/records.js';

type Analysis = NonNullable<SafeSnapshot['analysis']>;

/**
 * The one polite announcement for a new result, naming what actually happened:
 * a confirmed recording count, an honest no-match, or a reference that could not
 * be analysed. Only confirmed choices are counted (rejected proposals are never
 * announced as results), and no choice titles are read out.
 */
export function resultAnnouncement(panel: Pick<SafePanel, 'outcome' | 'role' | 'choices'> | null, analysis: Pick<Analysis, 'audioAccess'> | null): string {
  if (panel) {
    const n = panel.choices.length;
    const refined = panel.role === 'refinement';
    if (panel.outcome === 'source_unavailable') return `${refined ? 'The refined search result' : 'The recording result'} is hidden: its required source information is unavailable.`;
    if (panel.outcome === 'no_match' || n === 0) {
      return refined ? 'The refined search could not confirm a recording.' : 'No recording could be confirmed within these connections.';
    }
    const count = n === 1 ? 'One recording choice is' : `${n} recording choices are`;
    return `${refined ? 'Refined search: ' : ''}${count} ready.`;
  }
  if (analysis?.audioAccess === 'refused') return 'The analysis service declined this reference.';
  if (analysis?.audioAccess === 'unavailable') return 'The audio of this reference could not be analysed.';
  return 'Reference analysis is ready.';
}
