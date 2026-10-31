import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { tabWrapTarget } from './focus.js';
import { MIC_TRIGGER_ID } from './overlay.js';
import { useModalAuthority, useSheetDrag, useSheetPresence } from './overlay-hooks.js';
import { SheetLayer, WhyFooter, type WhyActions } from './WhySheet.js';
import { RecordingControls, type RecordingControlsProps } from './RecordingControls.js';

// The voice-input chooser: the one microphone control in the composer opens this
// existing-style bottom sheet with two DISTINCT routes, "Record music" (a musical
// note) and "Transcribe voice" (three sound-wave strokes). Opening the chooser
// never captures. A music capability is supplied by its local owner; explicit
// Record starts it, Stop finalises locally and Analyse is a separate transfer.
// Without that capability it remains unavailable. Transcription is unavailable.

export type VoiceRoute = 'record' | 'transcribe';

export interface VoiceRouteInfo {
  readonly id: VoiceRoute;
  readonly label: string;
  /** False until the real capability exists and has its own accepted evidence. */
  readonly available: boolean;
  /** One short line shown with the option. */
  readonly status: string;
  /** The honest explanation shown when the unavailable route is chosen. */
  readonly explanation: string;
}

export const VOICE_ROUTES: readonly VoiceRouteInfo[] = [
  {
    id: 'record',
    label: 'Record music',
    available: false,
    status: 'Unavailable',
    explanation: 'Recording music is not available in this version. No microphone permission was requested and nothing was recorded. Paste a YouTube link to continue.',
  },
  {
    id: 'transcribe',
    label: 'Transcribe voice',
    available: false,
    status: 'Unavailable',
    explanation: 'Voice transcription is not available in this version. No microphone permission was requested and nothing was recorded. Type or paste your link instead.',
  },
];

/** A musical note (Record music). Original thin-stroke geometry. */
export function NoteIcon() {
  return (
    <svg className="voice-icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="16.5" cy="16" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Three sound-wave strokes (Transcribe voice). Static: it never animates and shows no audio. */
export function WaveIcon() {
  return (
    <svg className="voice-icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 9.5v5M12 5.5v13M18 8.5v7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** One monochrome microphone control, inheriting the white composer ink. Opening it never captures. */
export function MicButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" id={MIC_TRIGGER_ID} className="mic" aria-haspopup="dialog" aria-label="Add music" onClick={onOpen}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <rect x="8" y="2.5" width="6" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M4.5 10.5a6.5 6.5 0 0 0 13 0M11 17v3M8 20h6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

/** The two routes. An unavailable route is aria-disabled (still focusable and explainable), never activates anything. */
export function VoiceRoutes({ recording, onListen }: { readonly recording?: RecordingControlsProps; readonly onListen?: () => void } = {}) {
  const [explained, setExplained] = useState<VoiceRoute | null>(null);
  const chooser = useRef<HTMLUListElement>(null), wasRecording = useRef(false);
  const choosing = !recording || recording.snapshot.phase === 'idle' || recording.snapshot.phase === 'disposed';
  useLayoutEffect(() => {
    if (recording && choosing && wasRecording.current && !chooser.current?.closest('[inert]')) chooser.current?.querySelector<HTMLButtonElement>('[data-route="record"]')?.focus({ preventScroll: true });
    wasRecording.current = !choosing;
  }, [choosing, recording]);
  const info = VOICE_ROUTES.find((r) => r.id === explained);
  return (
    <>
      {recording?.mode === 'synthetic' && choosing && <p className="support">Synthetic mode: no provider is called. Results are placeholders.</p>}
      {choosing && <ul ref={chooser} className="voice-routes" aria-label="Voice input routes">
        {onListen && <li><button type="button" className="voice-route" data-route="listen" onClick={onListen}>
          <WaveIcon /><span className="voice-text"><span className="voice-label">Listen live</span><span className="support">Streams music to Google Gemini · up to 20s</span></span>
        </button></li>}
        {VOICE_ROUTES.filter(r => r.id === 'record' || (recording?.mode !== 'live' && !onListen)).map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className="voice-route"
              data-route={r.id}
              aria-disabled={!(r.id === 'record' && recording) || undefined}
              aria-describedby={`voice-${r.id}-status`}
              onClick={event => { if (r.id === 'record' && recording) {
                event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
                setExplained(null); recording.onStart();
              } else setExplained(r.id); }}
            >
              {r.id === 'record' ? <NoteIcon /> : <WaveIcon />}
              <span className="voice-text">
                <span className="voice-label">{r.label}</span>
                <span id={`voice-${r.id}-status`} className="support">
                  {r.id === 'record' && recording ? '5–60 seconds' : r.status}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>}
      <p className="voice-explanation" role="status" hidden={!choosing}>
        {info?.explanation ?? ''}
      </p>
      {recording && <RecordingControls {...recording} />}
    </>
  );
}

const inertAction = () => {};
/** Only scalar display facts survive ordinary exit; no audio, receipt or live callback is retained. */
function recordingPicture(p: RecordingControlsProps | undefined): RecordingControlsProps | undefined {
  if (!p) return undefined;
  return { mode: p.mode, selfService: p.selfService, preparationFailed: p.preparationFailed, prepared: p.prepared,
    approved: p.approved, preparing: p.preparing,
    snapshot: { phase: p.snapshot.phase, durationMs: p.snapshot.durationMs, error: p.snapshot.error },
    onPrepare: inertAction, onStart: inertAction, onStop: inertAction, onDiscard: inertAction, onAnalyse: inertAction };
}

/**
 * `open` owns immediate cancellation/focus/background release. Only its last safe
 * picture animates out on ordinary dismissal; revocation or a changed scope
 * removes that picture immediately, including during an already-started exit.
 */
export function InputSheet(p: WhyActions & { readonly open: boolean; readonly revoked: boolean; readonly scope?: string; readonly recording?: RecordingControlsProps; readonly onListen?: () => void }) {
  const { open, onClose, revoked } = p;
  const { mounted, exiting, attach, presence } = useSheetPresence(open);
  useModalAuthority(open, onClose, MIC_TRIGGER_ID);
  const panel = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const handle = useSheetDrag(presence, panel, open ? onClose : inertAction, mounted && open);
  const held = useRef<{ scope?: string; recording?: RecordingControlsProps; working: boolean; stopping: boolean; notice?: string | null; onListen?: () => void } | null>(null);
  const revokedPicture = revoked || (!open && held.current !== null && held.current.scope !== p.scope);
  if (revokedPicture || (!mounted && !open)) held.current = null;
  if (open && !revokedPicture) held.current = { scope: p.scope, recording: recordingPicture(p.recording), working: p.working, stopping: p.stopping, notice: p.notice, ...(p.onListen ? { onListen: inertAction } : {}) };
  const picture = open ? p : held.current;
  const recording = picture?.recording;
  const active = open ? p : { onClose: inertAction, onStop: inertAction, onClear: inertAction };

  useLayoutEffect(() => {
    if (revokedPicture) presence.hardClose();
  }, [revokedPicture, presence]);

  useEffect(() => {
    if (mounted && !exiting) title.current?.focus({ preventScroll: true });
  }, [mounted, exiting]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open || e.key !== 'Tab' || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]')];
    const next = tabWrapTarget<Element | null>(items, document.activeElement, panel.current, e.shiftKey);
    if (next instanceof HTMLElement) {
      e.preventDefault();
      next.focus();
    }
  };

  if (!mounted || revokedPicture || !picture) return null;
  return (
    <SheetLayer
      attach={attach}
      exiting={exiting}
      title={picture.onListen ? 'Add music' : recording && (recording.mode === 'live' || (recording.snapshot.phase !== 'idle' && recording.snapshot.phase !== 'disposed')) ? 'Record music' : 'Voice input'}
      notice={picture.notice}
      titleId="sheet-input-title"
      bodyLabel="Voice input options"
      onClose={active.onClose}
      handle={handle}
      panelRef={panel}
      titleRef={title}
      onKeyDown={onKeyDown}
      footer={<><WhyFooter working={picture.working} stopping={picture.stopping} onStop={active.onStop} onClear={active.onClear} />
        {!picture.working && recording && recording.snapshot.phase !== 'idle' && <div className="sheet-foot action-row"><button type="button" className="secondary" onClick={active.onClear}>Clear session</button></div>}
      </>}
    >
      <VoiceRoutes recording={recording} onListen={picture.onListen} />
    </SheetLayer>
  );
}
