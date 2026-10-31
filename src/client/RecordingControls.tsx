import { useLayoutEffect, useRef } from 'react';
import type { MusicCaptureSnapshot } from './music-capture.js';
import type { RuntimeMode } from '../shared/records.js';

export interface RecordingControlsProps {
  readonly mode: RuntimeMode;
  readonly selfService?: boolean;
  readonly preparationFailed?: boolean;
  readonly prepared: boolean;
  readonly approved: boolean;
  readonly preparing: boolean;
  readonly onPrepare: () => void;
  readonly snapshot: MusicCaptureSnapshot;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onDiscard: () => void;
  readonly onAnalyse: () => void;
}

const errors: Record<NonNullable<MusicCaptureSnapshot['error']>, string> = {
  permission_denied: 'Microphone access was denied. You can allow it in your browser and choose Record music again.',
  capture_unavailable: 'This browser cannot record here. Use a supported secure browser or paste a YouTube link.',
  permission_timeout: 'Microphone permission was not confirmed in time. Choose Record music to try again.',
  preparation_timeout: 'The recorder did not become ready. Choose Record music to try again.',
  unsupported_sample_rate: 'This device could not provide the supported recording format. Paste a YouTube link instead.',
  capture_failed: 'The recording did not finish. Nothing was sent for analysis. Choose Record music to try again.',
  capture_interrupted: 'Recording was interrupted. Nothing was sent for analysis. Choose Record music to try again.',
  flush_timeout: 'The recording could not be finalised. Nothing was sent for analysis. Choose Record music to try again.',
  ready_expired: 'The unsent recording expired and was discarded. Record a new excerpt.',
  recording_invalid: 'The recorded audio could not be read. Record a new excerpt.',
  recording_too_short: 'That excerpt was under 5 seconds. Record between 5 and 60 seconds.',
  recording_too_long: 'That excerpt was over 60 seconds. Record a shorter excerpt.',
};

/** Current local facts only. No waveform, preview autoplay or provider work is simulated. */
export function RecordingControls(p: RecordingControlsProps) {
  const { phase, durationMs, error } = p.snapshot;
  const action = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (phase === 'recording' || phase === 'ready' || phase === 'error') action.current?.focus({ preventScroll: true }); }, [phase, p.prepared, p.approved, p.preparing]);
  if (phase === 'idle' || phase === 'disposed') return null;
  const active = phase === 'permission' || phase === 'preparing' || phase === 'recording' || phase === 'finalising';
  return <section className="recording-controls" aria-label="Record music">
    <p role="status">{error ? errors[error] : phase === 'permission' ? 'Waiting for microphone permission…'
      : phase === 'preparing' ? 'Getting ready…' : phase === 'recording' ? 'Recording…'
      : phase === 'finalising' ? 'Finishing your recording…'
      : phase === 'ready' ? p.preparing ? 'Preparing your recording…'
        : p.preparationFailed ? 'The recording could not be prepared. Try again.'
        : !p.prepared ? 'Ready to analyse.'
        : !p.approved ? p.selfService ? 'This recording cannot be analysed here. Choose another song.' : 'Recording prepared. Analysis access is not available for this recording.'
        : p.mode === 'synthetic' ? 'Ready. Synthetic mode: no recording is analysed and no provider is called.'
        : p.mode === 'live' ? 'Ready to analyse.' : 'Analysis is unavailable.'
      : 'Record a new excerpt.'}</p>
    {phase === 'ready' && p.selfService && !(p.prepared && !p.approved) && <p className="support">{
      p.mode === 'live' ? 'Analyse sends this recording to Google Gemini.'
        : p.mode === 'synthetic' ? 'Synthetic mode: no recording is analysed and no provider is called.' : 'Analysis is unavailable.'
    }</p>}
    {(phase === 'recording' || phase === 'finalising' || phase === 'ready') && <p className="recording-time" aria-label={`${(durationMs / 1000).toFixed(1)} seconds recorded`}>{(durationMs / 1000).toFixed(1)}s <span className="support">/ 60s</span></p>}
    <div className="action-row">
      {phase === 'recording' && <button ref={action} type="button" className="primary" onClick={event => { event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true }); p.onStop(); }}>Stop recording</button>}
      {phase === 'ready' && <button ref={action} type="button" className="primary" disabled={p.preparing} onClick={event => {
        if (p.selfService && p.prepared && !p.approved) { event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true }); p.onStart(); }
        else if (p.selfService || (p.prepared && p.approved)) { event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true }); p.onAnalyse(); }
        else { event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true }); p.onPrepare(); }
      }}>
        {p.preparing ? 'Preparing recording…' : p.selfService ? p.prepared && !p.approved ? 'Record another song' : 'Analyse recording' : p.prepared && p.approved ? 'Analyse recording' : p.prepared ? 'Check recording' : 'Prepare recording'}
      </button>}
      {phase === 'error' && <button ref={action} type="button" className="secondary" onClick={event => { event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true }); p.onStart(); }}>Record again</button>}
      {(active || phase === 'ready') && <button type="button" className="secondary" onClick={event => {
        event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.querySelector<HTMLButtonElement>('[data-route="record"]')?.focus({ preventScroll: true }); p.onDiscard();
      }}>{active ? 'Cancel recording' : 'Discard recording'}</button>}
    </div>
  </section>;
}
