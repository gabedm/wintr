import type { RuntimeMode } from '../shared/records.js';

// Client readiness follows the mode the server reports in its snapshot. It only
// decides whether to offer the action; the server remains the authority and
// refuses provider work in disabled mode or outside its bindings/source policy
// whatever the browser sends.

/** Why Analyse is not offered for this server mode, or null when the server accepts references. */
export function analysisBlockedReason(mode: RuntimeMode | null): string | null {
  switch (mode) {
    case null:
      return 'Connecting…';
    case 'disabled':
      return 'Analysis is unavailable right now.';
    case 'synthetic':
    case 'live':
      return null;
  }
}

/**
 * What the listener must know before Analyse about the focus they choose, for the mode that is actually running.
 * Prospective and short: a focus is a request, not a clip, and live analysis may process more than the selected interval.
 * It claims nothing about physical clipping or input cost. Null when Analyse is not offered.
 */
export function focusDisclosure(mode: RuntimeMode | null): string | null {
  switch (mode) {
    case 'live':
      return 'Gemini may analyse beyond your chosen moment.';
    case 'synthetic':
      return 'Synthetic mode: no video is read or analysed. The focus is only recorded.';
    default:
      return null;
  }
}

export const MODE_COPY: Readonly<Record<RuntimeMode, { readonly note: string; readonly menu: string }>> = {
  disabled: {
    note: 'Providers disabled: analysis and discovery are unavailable in this build.',
    menu: 'Providers are disabled in this build.',
  },
  synthetic: {
    note: 'Synthetic local mode: no provider is called. Results are labelled placeholders.',
    menu: 'Synthetic local mode: Gemini, Qloo, Google Search and recording catalogues are not called. Results are placeholders.',
  },
  live: {
    note: 'Gemini analyses your song. Qloo finds artist connections.',
    menu: 'Analyse shares your link or recording and note with Google Gemini. Unsent audio stays on this device. Gemini may analyse beyond a video’s chosen moment. Artist names go to Qloo; your musical direction and those connections go to Gemini. Google Search or Apple’s catalogue helps find and verify songs. Listening links open the music service.',
  },
};
