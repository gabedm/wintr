import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import type { Familiarity, Fit, Handle, SafePanel, SafeReference, SafeSnapshot } from '../shared/records.js';
import { isRecordedReference, isStreamedReference } from '../shared/records.js';
import { isSafeArtistContext } from '../shared/artist-context.js';
import type { ArtistChoiceInput, FeedbackInput, PreferenceInput, RefineInput } from './api.js';
import type { FreeSaving, PendingAction } from './controller.js';
import { Chip, SelectMark } from './control-hooks.js';
import { Appear, captureVisual, OutgoingPicture, pageHidden, type Rect } from './conversation-motion.js';
import { DECOR, tokenExitDecision } from './decor.js';
import { browserFocusStranded, FocusHandoff } from './handoff.js';
import { STANDARD_EASING } from './motion.js';
import { WHY_TRIGGER_ID } from './overlay.js';
import { prefersReducedMotion } from './viewport-hooks.js';

// Existing conversation surfaces for the relationship choice, artist identity
// checkpoint, connection preview, recording choices with free feedback, and the
// one refined search. "Save", artist choices and fit/familiarity selections are
// always free; "Discover", "Continue discovery", "Follow …" and "Try this
// direction"/"Find fresh recordings" are the only provider-triggering actions.
// Nothing here dispatches on mount, focus, typing, Play clicks, frames or return.

type Snap = SafeSnapshot;
type Analysis = NonNullable<Snap['analysis']>;

/**
 * The reference result. Before a relationship is saved, one concise observation
 * leads and the rest is contextual; once saved, the whole analysis moves behind
 * one disclosure (nothing is dropped or shortened). The synthetic label and any
 * audio-access limitation stay visible either way.
 */
export function AnalysisView({ analysis, saved = false }: { analysis: Analysis; saved?: boolean }) {
  const [first, ...rest] = analysis.observations;
  const full = (
    <>
      {analysis.observations.map((o, i) => (
        <p key={i}>{o}</p>
      ))}
      {saved && analysis.relationships.length > 0 && (
        <>
          <p className="emphasis">What it could keep</p>
          <ul className="support">
            {analysis.relationships.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
  return (
    <section className="assistant message-bubble" aria-label="Reference result" data-result={analysis.handle} tabIndex={-1}>
      {analysis.synthetic && <p className="synthetic-label">Synthetic placeholder, not an analysis of your reference</p>}
      {(analysis.audioAccess === 'unavailable' || analysis.audioAccess === 'refused') && (
        <p>
          {analysis.audioAccess === 'refused'
            ? 'The analysis service declined this reference, so nothing about its sound was described.'
            : 'The audio of this reference could not be analysed, so nothing about its sound was described.'}
        </p>
      )}
      {saved ? (
        (analysis.observations.length > 0 || analysis.relationships.length > 0) && (
          <details className="why">
            <summary>Reference analysis</summary>
            {full}
          </details>
        )
      ) : (
        <>
          {first && <p>{first}</p>}
          {rest.length > 0 && (
            <details className="why">
              <summary>Full reference analysis</summary>
              {full}
            </details>
          )}
        </>
      )}
    </section>
  );
}

/** A previous recording panel kept as short context; the complete panel (answer, sources, Suggestions, feedback) is inside. */
export function EarlierPanel({ panel, children }: { panel: SafePanel; children: ReactNode }) {
  const titles = panel.choices.map((c) => c.title);
  return (
    <details className="why earlier">
      <summary>
        {panel.role === 'refinement' ? 'Earlier refined choices' : 'Earlier choices'}
        {panel.outcome === 'source_unavailable' ? ' (hidden: required source information unavailable)' : titles.length > 0 ? `: ${titles.join(', ')}` : ' (no recording confirmed)'}
      </summary>
      {children}
    </details>
  );
}

interface PrefDraft {
  choice: number | null;
  text: string;
  artist: string;
  favourite: string;
}

const draftFrom = (snap: Snap): PrefDraft => {
  const brief = snap.brief;
  const choice = brief?.source === 'analysis_choice' ? (snap.analysis?.relationships.indexOf(brief.relationship) ?? -1) : -1;
  return {
    choice: choice >= 0 ? choice : null,
    text: brief && choice < 0 ? brief.relationship : '',
    artist: brief?.artists[0] ?? snap.analysis?.proposedArtist ?? '',
    favourite: brief?.artists[1] ?? '',
  };
};

const startingLine = (artists: readonly string[]) => (artists.length > 0 ? `Using ${artists.join(' and ')} as the starting point.` : 'No starting artist yet.');

/**
 * The owned, saved relationship as one compact read-only line: the context kept above the results, and while
 * Discover, Continue or a refinement runs. It has no action and sends nothing; the caller decides when it applies.
 */
export function KeepingContext({ brief, innerRef }: { brief: NonNullable<Snap['brief']>; innerRef?: Ref<HTMLElement> }) {
  return (
    <section ref={innerRef} className="assistant context" aria-label="Your choice" tabIndex={-1}>
      <p>
        <span className="emphasis">Keeping:</span> “{brief.relationship}”{brief.source === 'intake_cue' ? ' (from your note)' : ''}{' '}
        <span className="support">{startingLine(brief.artists)}</span>
      </p>
    </section>
  );
}

export function PreferencePanel(props: {
  snapshot: Snap;
  disabled: boolean;
  /** A free save awaits its acknowledgement: Save holds (aria-disabled, focus kept) and a paid start is unavailable. */
  busy?: boolean;
  onSave: (input: PreferenceInput) => Promise<boolean>;
  onDiscover: (brief: Handle) => void;
  onChooseArtist?: (input: ArtistChoiceInput) => void;
}) {
  const { snapshot, disabled, busy = false } = props;
  const analysis = snapshot.analysis!;
  const brief = snapshot.brief;
  const [editing, setEditing] = useState(brief === null);
  const [draft, setDraft] = useState<PrefDraft>(() => draftFrom(snapshot));
  const [awaitingSave, setAwaitingSave] = useState(false);
  const pendingSave = useRef<object | null>(null);
  const authority = useRef(analysis.handle);
  authority.current = analysis.handle;
  const saveBusy = busy || awaitingSave;
  const frozen = disabled || saveBusy;
  const changeDraft = (change: (d: PrefDraft) => PrefDraft) => { if (!frozen && !pendingSave.current) setDraft(change); };
  // An unambiguous proposed artist is shown as editable context; the fields open only when one is needed.
  const [artistsOpen, setArtistsOpen] = useState(() => draftFrom(snapshot).artist.trim() === '');
  // M07.selection token: the saved choice enters (160 ms, 3 px) only as the result of THIS deliberate Save. A restored,
  // returned or otherwise arrived choice mounts at rest. Set at the gesture (before the reply), consumed by the commit that shows it.
  const enterToken = useRef(false);
  useEffect(() => {
    if (!editing && brief) enterToken.current = false;
  });

  // Explicit Save / Cancel / Edit remove the control that held focus: focus moves deliberately to what survives (the saved
  // choice, or the form's first field). Armed only by those gestures, never by restoration, and never over a control the
  // listener chose meanwhile.
  const tokenRef = useRef<HTMLElement | null>(null);
  const formRef = useRef<HTMLElement | null>(null);
  const artistRef = useRef<HTMLInputElement | null>(null);
  const focusArtists = useRef(false);
  const [toToken] = useState(() => new FocusHandoff());
  const [toForm] = useState(() => new FocusHandoff());
  useLayoutEffect(() => {
    if (!editing && brief && toToken.pending) {
      if (toToken.take(browserFocusStranded())) tokenRef.current?.focus({ preventScroll: true });
    } else if (editing && toForm.pending) {
      if (toForm.take(browserFocusStranded())) {
        const target = focusArtists.current ? artistRef.current : formRef.current?.querySelector<HTMLElement>('button.chip:not(:disabled), input:not(:disabled)');
        target?.focus({ preventScroll: true });
      }
    }
  });

  // M07.selection token_exit: pressing Edit really removes the saved token. Its text leaves as an inert, aria-hidden picture for
  // 120 ms; only the few words it shows are held, and they are dropped with any change of owner or authority.
  const [exiting, setExiting] = useState<{ rect: Rect; opacity: number; line: string; note: boolean; artists: string } | null>(null);
  useLayoutEffect(() => setExiting(null), [analysis.handle, brief?.handle, disabled]);

  // A new analysis or a different saved version resets the in-memory draft (typing never saves).
  useEffect(() => {
    const next = draftFrom(snapshot);
    setDraft(next);
    setArtistsOpen(next.artist.trim() === '');
    setEditing(snapshot.brief === null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis.handle, brief?.handle]);
  // A hand-off belongs to the analysis it was armed for (a new brief version is the expected result of Save itself).
  useEffect(() => {
    pendingSave.current = null;
    setAwaitingSave(false);
    toToken.cancel();
    toForm.cancel();
  }, [analysis.handle, toToken, toForm]);

  const text = draft.text.trim();
  const canSave = !disabled && (draft.choice !== null || text !== '');
  const save = async () => {
    if (!canSave || saveBusy || pendingSave.current) return;
    const ticket = {};
    const analysisHandle = analysis.handle;
    pendingSave.current = ticket;
    setAwaitingSave(true);
    const artists = [draft.artist, draft.favourite].map((a) => a.trim()).filter(Boolean);
    enterToken.current = true;
    toToken.arm();
    let ok = false;
    try {
      ok = await props.onSave({ analysis: analysisHandle, relationship: draft.choice !== null ? { choice: draft.choice } : { text }, artists });
    } catch {
      // The controller reports save failures; a rejected acknowledgement cannot discard this draft.
    }
    if (authority.current !== analysisHandle || pendingSave.current !== ticket) return;
    pendingSave.current = null;
    setAwaitingSave(false);
    if (ok) setEditing(false);
    else {
      enterToken.current = false;
      toToken.cancel();
    }
  };
  const cancelEdit = () => {
    if (frozen || pendingSave.current) return;
    toToken.arm();
    setEditing(false);
  };
  const edit = (artistsOnly = false) => {
    if (frozen || pendingSave.current) return;
    const el = tokenRef.current;
    focusArtists.current = artistsOnly;
    if (artistsOnly) setArtistsOpen(true);
    toForm.arm();
    // The picture continues what is on screen at this instant: its rendered rectangle (an entrance wrapper may still be
    // translated) in the host's coordinates, and its current opacity. Only three short strings and this metadata are kept.
    const seen = !artistsOnly && el && brief ? captureVisual(el) : null;
    if (seen && brief && tokenExitDecision({ edited: true, hasRect: true, opacity: seen.opacity, reducedMotion: prefersReducedMotion(), hidden: pageHidden() })) {
      setExiting({ rect: seen.rect, opacity: seen.opacity, line: brief.relationship, note: brief.source === 'intake_cue', artists: startingLine(brief.artists) });
    }
    setEditing(true);
  };

  if (!editing && brief) {
    const discoverBlocked = brief.artists.length === 0 ? 'Add an artist to start from before discovering.'
      : snapshot.discovery === 'edit_artists' ? 'Change the starting artists before discovering again.'
      : snapshot.discovery === 'unavailable' || (snapshot.discovery === undefined && snapshot.attempt?.kind === 'discover' && snapshot.attempt.outcome !== 'succeeded')
        ? 'This discovery cannot be sent again. You can still edit your choice or clear this session.' : null;
    if (snapshot.identity && (snapshot.stage === 'awaiting_artist' || (snapshot.stage === 'awaiting_preference' && snapshot.identity.awaiting))) return <IdentityPanel
      identity={snapshot.identity} brief={brief.handle} disabled={disabled} busy={saveBusy} discoverBlocked={discoverBlocked} innerRef={tokenRef}
      onChoose={(input) => props.onChooseArtist?.(input)} onContinue={props.onDiscover} onEditArtists={() => edit(true)} />;
    const committed = snapshot.panel !== null;
    const artistsLine = startingLine(brief.artists);
    // Once recordings exist, the choice stays as one short line of context above the results.
    if (committed) return snapshot.panel?.intent !== undefined ? null : <KeepingContext brief={brief} innerRef={tokenRef} />;
    return (
      <Appear play={enterToken.current} enterMs={DECOR.token.enterMs} y={DECOR.token.y} easing={STANDARD_EASING}>
      <section ref={tokenRef} className="assistant" aria-label="Your choice" tabIndex={-1}>
        <p>
          <span className="emphasis">Keeping:</span> “{brief.relationship}”{brief.source === 'intake_cue' ? ' (from your note)' : ''}
        </p>
        <p className="support">{artistsLine}</p>
        {!committed && (
          <>
            <div className="action-row">
              <button type="button" className="secondary" disabled={frozen} onClick={() => edit()}>
                Edit
              </button>
              <button
                type="button"
                className="primary"
                disabled={frozen || discoverBlocked !== null}
                onClick={() => props.onDiscover(brief.handle)}
                aria-describedby={discoverBlocked === null ? undefined : 'discover-help'}
              >
                Discover connections
              </button>
            </div>
            {discoverBlocked !== null && <p id="discover-help" className="support">{discoverBlocked}</p>}
          </>
        )}
      </section>
      </Appear>
    );
  }

  return (
    <>
    {exiting && (
      <OutgoingPicture rect={exiting.rect} from={exiting.opacity} ms={DECOR.token.exitMs} onGone={() => setExiting(null)}>
        <section className="assistant">
          <p>
            <span className="emphasis">Keeping:</span> “{exiting.line}”{exiting.note ? ' (from your note)' : ''}
          </p>
          <p className="support">{exiting.artists}</p>
        </section>
      </OutgoingPicture>
    )}
    <section ref={formRef} className="assistant" aria-label="Choose what to keep">
      {analysis.relationships.length > 0 && (
        <>
          <p className="emphasis">What do you want to keep?</p>
          <div className="chips" role="group" aria-label="Relationship choices">
            {analysis.relationships.map((r, i) => (
              <Chip key={r} pressed={draft.choice === i} disabled={frozen} onClick={() => changeDraft((d) => ({ ...d, choice: d.choice === i ? null : i, text: '' }))}>
                {r}
              </Chip>
            ))}
          </div>
        </>
      )}
      <label className="field">
        <span className="field-label">{analysis.relationships.length > 0 ? 'Or say it your way' : 'What do you want to keep?'}</span>
        <input
          value={draft.text}
          maxLength={1000}
          disabled={frozen}
          onChange={(e) => changeDraft((d) => ({ ...d, text: e.target.value, choice: e.target.value.trim() ? null : d.choice }))}
        />
      </label>
      <details className="why" open={artistsOpen} onToggle={(e) => setArtistsOpen(e.currentTarget.open)}>
        <summary>{draft.artist.trim() ? `Starting from ${draft.artist.trim()}${draft.favourite.trim() ? ` and ${draft.favourite.trim()}` : ''}` : 'Choose the artist to start from'}</summary>
        <div className="focus-row">
          <label className="field">
            <span className="field-label">Start from artist</span>
            <input ref={artistRef} value={draft.artist} maxLength={128} disabled={frozen} onChange={(e) => changeDraft((d) => ({ ...d, artist: e.target.value }))} />
          </label>
          <label className="field">
            <span className="field-label">Another artist you love (optional)</span>
            <input
              value={draft.favourite}
              maxLength={128}
              disabled={frozen}
              onChange={(e) => changeDraft((d) => ({ ...d, favourite: e.target.value }))}
            />
          </label>
        </div>
        {snapshot.analysis?.proposedArtist && (
          <p className="support">Suggested artist.</p>
        )}
      </details>
      <div className="action-row">
        <button type="button" className="primary" disabled={!canSave} aria-disabled={saveBusy || undefined} onClick={save}>
          {saveBusy ? 'Saving…' : 'Save choice'}
        </button>
        {brief && (
          <button type="button" className="secondary" disabled={frozen} onClick={cancelEdit}>
            Cancel
          </button>
        )}
      </div>
    </section>
    </>
  );
}

export function IdentityPanel(props: {
  identity: NonNullable<Snap['identity']>;
  brief: Handle;
  disabled: boolean;
  /** A free save awaits its acknowledgement: choices hold (aria-disabled, focus kept) and Continue is unavailable. */
  busy?: boolean;
  discoverBlocked?: string | null;
  onChoose: (input: ArtistChoiceInput) => void;
  onContinue: (brief: Handle) => void;
  onEditArtists: () => void;
  innerRef?: Ref<HTMLElement>;
}) {
  const { identity, disabled, busy = false } = props;
  const choose = (input: ArtistChoiceInput) => !busy && props.onChoose(input);
  const undecided = identity.slots.some((s) => s.status === 'ambiguous' && s.chosen === null);
  return (
    <section ref={props.innerRef} className="assistant" aria-label="Which artist did you mean?" tabIndex={-1}>
      {identity.slots.map((slot, i) => {
        if (slot.status === 'resolved') {
          return (
            <p key={i} className="support">
              Using {slot.options[0]?.name ?? slot.proposal}.
            </p>
          );
        }
        if (slot.status === 'not_found') {
          return (
            <p key={i} className="support">
              No artist called “{slot.proposal}” was found, so it will not be used.
            </p>
          );
        }
        if (slot.options.length === 0) return null;
        return (
          <div key={i} className="identity-group" role="group" aria-label={`Which “${slot.proposal}” do you mean?`}>
            <p className="emphasis">Which “{slot.proposal}” do you mean?</p>
            {slot.options.map((o) => (
              <div key={o.handle} className="identity-option">
              <button
                type="button"
                className="identity-row"
                aria-pressed={slot.chosen === o.handle}
                aria-label={o.disambiguation ? `${o.name}, ${o.disambiguation}` : o.name}
                disabled={disabled}
                aria-disabled={busy || undefined}
                onClick={() => choose({ checkpoint: identity.handle, slot: i, choice: o.handle })}
              >
                <span className="identity-text">
                  <span>{o.name}</span>
                  {o.disambiguation && <span className="support">{o.disambiguation}</span>}
                </span>
                {/* Only an owned, resolved option can be selected: this mark never shows for an unresolved lookup. */}
                <SelectMark selected={slot.chosen === o.handle} />
              </button>
              {isSafeArtistContext(o.context) && <a className="identity-context" href={o.context.url} target="_blank" rel="noopener noreferrer"
                aria-label={`${o.context.service === 'spotify' ? 'Spotify' : o.context.service === 'musicbrainz' ? 'MusicBrainz' : 'Wikidata'} identity page for ${o.name}`}>
                {o.context.service === 'spotify' ? 'Spotify profile' : o.context.service === 'musicbrainz' ? 'MusicBrainz artist' : 'Wikidata entry'}
              </a>}
              </div>
            ))}
            <button
              type="button"
              className="secondary"
              aria-pressed={slot.status === 'skipped'}
              disabled={disabled}
              aria-disabled={busy || undefined}
              onClick={() => choose({ checkpoint: identity.handle, slot: i, choice: null })}
            >
              {slot.status === 'skipped' ? 'Skipped' : 'Skip this artist'}
            </button>
          </div>
        );
      })}
      {identity.awaiting && (
        <div className="action-row">
          <button type="button" className="secondary" disabled={disabled || busy} onClick={props.onEditArtists}>
            Edit starting artists
          </button>
          <button type="button" className="primary" disabled={disabled || busy || undecided || !!props.discoverBlocked} aria-describedby="identity-continue-help" onClick={() => props.onContinue(props.brief)}>
            Continue discovery
          </button>
        </div>
      )}
      <p id="identity-continue-help" className="support" role="status">
        {busy ? 'Saving your choice…' : props.discoverBlocked ?? 'Choosing, skipping or editing names is free. Continue discovery explores connections for your choice.'}
      </p>
    </section>
  );
}

/** One factual line: the real count, the starting artists and at most two returned names. The full list lives in the Why sheet. */
export function connectionPreview(connection: NonNullable<Snap['connection']>): string {
  const n = connection.artists.length;
  const shown = connection.artists.slice(0, 2);
  const more = n - shown.length;
  const names = more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(' and ');
  return `${n === 1 ? '1 connected artist' : `${n} connected artists`} for ${connection.seeds.join(' and ')}${n > 0 ? `, including ${names}` : ''}.`;
}

/**
 * The artist connection behind the results: a compact factual preview and one
 * directly reachable contextual action. The complete artist list and the actual
 * reasons are in the Why sheet. The synthetic label stays visible.
 */
export function ConnectionPanel({ connection, onWhy }: { connection: NonNullable<Snap['connection']>; onWhy?: () => void }) {
  return (
    <section className="assistant message-bubble connection" aria-label="Artist connection">
      {connection.synthetic && <p className="synthetic-label">Synthetic connection from a local fixture, not from Qloo</p>}
      <p>{connectionPreview(connection)}</p>
      {onWhy && (
        <div className="action-row">
          <button type="button" id={WHY_TRIGGER_ID} className="secondary" onClick={onWhy} aria-haspopup="dialog">
            Why this connection
          </button>
        </div>
      )}
    </section>
  );
}

/** Only exact validated destinations / provider-source citations become links; anything else stays text. */
export function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    if (u.hostname === 'www.youtube.com' && u.pathname === '/watch' && /^[A-Za-z0-9_-]{11}$/.test(u.searchParams.get('v') ?? '')) return u.href;
    if (u.hostname === 'vertexaisearch.cloud.google.com' && u.pathname.startsWith('/grounding-api-redirect/')) return u.href;
    return null;
  } catch {
    return null;
  }
}

/**
 * A listening link only for the exact canonical route of its own service; a
 * YouTube URL labelled Apple Music (or the reverse) or any other page is not a link.
 */
export function listenHref(url: string | null, service: SafePanel['choices'][number]['service']): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return null;
    if (service === 'youtube') return u.hostname === 'www.youtube.com' && u.pathname === '/watch' && /^[A-Za-z0-9_-]{11}$/.test(u.searchParams.get('v') ?? '') ? u.href : null;
    return u.hostname === 'music.apple.com' && /^\/[a-z]{2}\/song\/[1-9][0-9]{0,14}$/.test(u.pathname) && u.search === '' ? u.href : null;
  } catch {
    return null;
  }
}

/** The external button names its actual destination; opening it promises no particular playback access. */
const LISTEN_LABEL: Record<SafePanel['choices'][number]['service'], string> = {
  youtube: 'Play on YouTube',
  apple_music: 'Open in Apple Music',
};

function Citation({ n, citation }: { n: number; citation: SafePanel['citations'][number] }) {
  const href = safeHref(citation.url);
  const label = `${citation.title}${citation.domain ? ` (${citation.domain})` : ''}`;
  return (
    <li value={n + 1}>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      ) : (
        label
      )}
    </li>
  );
}

/** Complete answer text with citation marks inserted at their segment ends; nothing is dropped or rewritten. */
export function AnswerText({ answer }: { answer: SafePanel['answer'] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const mark of answer.marks) {
    const end = Math.min(Math.max(mark.end, at), answer.text.length);
    parts.push(answer.text.slice(at, end));
    parts.push(<sup key={`m${end}`}>{mark.citations.map((c) => `[${c + 1}]`).join('')}</sup>);
    at = end;
  }
  parts.push(answer.text.slice(at));
  return <p className="answer-text">{parts}</p>;
}

const GAP_TEXT: Record<SafePanel['gaps'][number]['reason'], string> = {
  catalogue_search_unavailable: 'the catalogue candidate search was unavailable',
  candidate_set_empty: 'no eligible catalogue candidate was available in this bounded search',
  outside_anchor: 'not credited to a connected artist',
  anchor_not_declared: 'connected artist not credited',
  excluded_artist: 'credited to an excluded artist',
  too_many_credits: 'too many credits to confirm',
  unsupported_destination: 'no supported exact listening link',
  no_native_support: 'no source support for that pick',
  no_identity_support: 'sources did not support its title and credits',
  destination_unavailable: 'link unavailable',
  destination_mismatch: 'the catalogue described a different recording',
  metadata_throttled: 'the catalogue check was unavailable (rate limited)',
  unsafe_redirect: 'unsafe redirect',
  unsafe_address: 'unsafe network address',
  metadata_unreadable: 'details unreadable',
  metadata_cap: 'check limit reached',
  deadline: 'ran out of time',
  title_mismatch: 'title did not match the link',
  version_mismatch: 'link is a different version (live, remix or similar)',
  anchor_not_credited: 'connected artist not confirmed in the link details',
  credits_unconfirmed: 'not every named artist was confirmed in the link details',
  credits_extra: 'the link credits someone else as well',
  uncertain_identity: 'possibly a cover or different version',
  duplicate_recording: 'same recording already listed',
  previously_shown: 'already shown earlier (same recording)',
};

type Choice = SafePanel['choices'][number];

/** Two independent free toggles per recording. Pressing the active option again unsets it. */
function FeedbackControls(props: { panel: Handle; choice: Choice; disabled: boolean; saving: FreeSaving | null; onFeedback: (input: FeedbackInput) => void }) {
  const { choice, disabled, saving } = props;
  const { fit, familiarity } = choice.feedback;
  // One free save at a time. Until the server acknowledges it nothing here is shown as saved, and no second change is
  // accepted (it would be built on a basis that is about to change): the controls hold, visibly, instead of dropping a click.
  const busy = saving !== null;
  const mine = saving?.kind === 'feedback' && saving.target === choice.handle;
  const save = (next: { fit?: Fit; familiarity?: Familiarity }) =>
    !busy && props.onFeedback({ panel: props.panel, choice: choice.handle, fit: next.fit !== undefined ? next.fit : fit, familiarity: next.familiarity !== undefined ? next.familiarity : familiarity });
  const toggle = <T,>(current: T, value: T) => (current === value ? null : value);
  return (
    <div className="feedback" aria-label={`Your feedback on ${choice.title}`}>
      <fieldset className="feedback-question" aria-label="Does it fit?">
        <legend>Does it fit?</legend>
        <div className="chips">
        <Chip pressed={fit === 'like'} disabled={disabled} busy={busy} onClick={() => save({ fit: toggle<Fit>(fit, 'like') })}>
          Like it
        </Chip>
        <Chip pressed={fit === 'not_right'} disabled={disabled} busy={busy} onClick={() => save({ fit: toggle<Fit>(fit, 'not_right') })}>
          Not right
        </Chip>
        </div>
      </fieldset>
      <fieldset className="feedback-question" aria-label="Do you know it?">
        <legend>Do you know it?</legend>
        <div className="chips">
        <Chip pressed={familiarity === 'new'} disabled={disabled} busy={busy} onClick={() => save({ familiarity: toggle<Familiarity>(familiarity, 'new') })}>
          New to me
        </Chip>
        <Chip pressed={familiarity === 'known'} disabled={disabled} busy={busy} onClick={() => save({ familiarity: toggle<Familiarity>(familiarity, 'known') })}>
          Already know it
        </Chip>
        </div>
      </fieldset>
      {(fit !== null || familiarity !== null) && (
        <button type="button" className="secondary" disabled={disabled} aria-disabled={busy || undefined} onClick={() => save({ fit: null, familiarity: null })}>
          Clear feedback
        </button>
      )}
      {mine && (
        <p className="support" role="status">
          Saving…
        </p>
      )}
    </div>
  );
}

export function ChoicesPanel({
  panel,
  disabled = true,
  saving = null,
  onFeedback = () => undefined,
}: {
  panel: SafePanel;
  disabled?: boolean;
  /** The free save awaiting acknowledgement, if any (holds every feedback control; the exact choice shows it). */
  saving?: FreeSaving | null;
  onFeedback?: (input: FeedbackInput) => void;
}) {
  const skipped = panel.gaps.reduce((n, g) => n + g.count, 0);
  // The server withholds the whole result when its required native Search presentation cannot be shown: no picks,
  // answer, sources or frame exist here, and this is neither a success nor a no-match.
  if (panel.outcome === 'source_unavailable') {
    return (
      <section className="assistant" aria-label={panel.role === 'refinement' ? 'Refined recording choices' : 'Recording choices'} data-result={panel.handle} tabIndex={-1}>
        {panel.intent && <KeepingContext brief={panel.intent} />}
        {panel.synthetic && <p className="synthetic-label">Synthetic recordings from a local fixture, not real suggestions</p>}
        {panel.basis.length > 0 && (
          <ul className="support basis" aria-label="How these were found">
            {panel.basis.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        <p>
          The recordings from this search are hidden because the Google Search information they must be shown with can no longer be displayed safely. This is
          not a sign that nothing was found.
        </p>
        <p className="support">To search again, use Clear session in the menu and start over.</p>
      </section>
    );
  }
  return (
    <section className="assistant" aria-label={panel.role === 'refinement' ? 'Refined recording choices' : 'Recording choices'} data-result={panel.handle} tabIndex={-1}>
      {panel.intent && <KeepingContext brief={panel.intent} />}
      {panel.synthetic && <p className="synthetic-label">Synthetic recordings from a local fixture, not real suggestions</p>}
      {panel.basis.length > 0 && (
        <ul className="support basis" aria-label="How these were found">
          {panel.basis.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {panel.outcome === 'no_match' ? (
        <p>No recording could be confirmed within these artist connections, so none is suggested. This is not a sign that none exist.</p>
      ) : (
        <div className="recording-list">{panel.choices.map((c) => {
          const href = listenHref(c.playUrl, c.service);
          return (
            <article key={c.handle} className="choice" aria-label={c.title}>
              <header className="choice-heading">
                <h3 className="choice-title">{c.title}</h3>
                <p className="support choice-credits">
                  {c.credits.join(', ')}
                  {c.unverifiedCredits > 0 ? ` · ${c.unverifiedCredits} other credit${c.unverifiedCredits > 1 ? 's' : ''} not confirmed` : ''}
                </p>
              </header>
              <p className="choice-fit">
                {c.fitHypothesis} <span className="support">(a possibility; Wintr has not listened to it)</span>
              </p>
              <div className="action-row choice-listen">
                {href ? (
                  <a className="primary play" href={href} target="_blank" rel="noopener noreferrer">
                    {LISTEN_LABEL[c.service]}
                    <svg className="destination-arrow" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4 12 12 4M4.5 4H12v7.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </a>
                ) : (
                  <span className="secondary play" aria-disabled="true">
                    {panel.synthetic ? 'Play unavailable (synthetic fixture)' : 'Play unavailable'}
                  </span>
                )}
              </div>
              <FeedbackControls panel={panel.handle} choice={c} disabled={disabled} saving={saving} onFeedback={onFeedback} />
              <details className="choice-details">
                <summary>Details and sources<span className="detail-chevron" aria-hidden="true" /></summary>
                <div className="choice-details-body">
                  <p className="support">Connected through {c.anchor}.</p>
                  {c.identityEvidence === 'first_party_catalogue' && <p className="support">Identity checked against Apple’s catalogue search and exact song lookup.</p>}
                  {c.sources.length > 0 && (
                    <ol className="sources" aria-label={`Sources for the title and credits of ${c.title}`}>
                      {c.sources.map((n) => panel.citations[n] && <Citation key={n} n={n} citation={panel.citations[n]!} />)}
                    </ol>
                  )}
                </div>
              </details>
            </article>
          );
        })}</div>
      )}
      {skipped > 0 && (
        <details className="why">
          <summary>
            {skipped} proposed recording{skipped > 1 ? 's were' : ' was'} not shown
          </summary>
          <ul>
            {panel.gaps.map((g) => (
              <li key={g.reason}>
                {g.count} × {GAP_TEXT[g.reason]}
              </li>
            ))}
          </ul>
        </details>
      )}
      <details className="why panel-evidence">
        <summary>{panel.catalogueMode === 'first_party_candidates' ? 'How these were selected' : 'Full answer and sources'}</summary>
        {panel.catalogueMode === 'first_party_candidates' && <p className="support">A summary of confirmed catalogue identities and tentative fit notes; this is not a Google Search answer.</p>}
        {!panel.synthetic && panel.choices.some((choice) => choice.service === 'youtube') && (
          <p className="support">Title, credits and version are checked; YouTube uploader status is unverified.</p>
        )}
        <AnswerText answer={panel.answer} />
        {panel.citations.length > 0 && (
          <ol className="sources">
            {panel.citations.map((c, n) => (
              <Citation key={n} n={n} citation={c} />
            ))}
          </ol>
        )}
      </details>
      {panel.suggestionsUrl && (
        <iframe
          className="suggestions-frame"
          src={panel.suggestionsUrl}
          title="Search suggestions"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          allow="microphone 'none'; camera 'none'; display-capture 'none'"
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      )}
    </section>
  );
}

/**
 * The one shared refined search. Follow uses a liked recording's connected artist
 * (a new artist lookup); Try this direction / Find fresh recordings reuses the
 * existing connections with zero new artist lookups. Offered directly when nothing
 * fits or everything is familiar, without needing a positive vote.
 */
export function RefinePanel(props: {
  snapshot: Snap;
  disabled: boolean;
  /** A free save awaits its acknowledgement: the paid refinement is unavailable until it is confirmed (it would use an unconfirmed basis). */
  busy?: boolean;
  onRefine: (input: RefineInput) => void;
}) {
  const { snapshot, disabled, busy = false } = props;
  const panel = snapshot.panel;
  const brief = snapshot.brief;
  const [text, setText] = useState('');
  const [leaveOut, setLeaveOut] = useState<Handle[]>([]);
  useEffect(() => {
    setText('');
    setLeaveOut([]);
  }, [panel?.handle]);
  if (!panel || !brief || !snapshot.refinement) return null;
  const hidden = panel.outcome === 'source_unavailable';
  if (snapshot.refinement.used) {
    return (
      <section className="assistant" aria-label="Refined search">
        <p className="support">
          Refinement used.
        </p>
      </section>
    );
  }
  const liked = panel.choices.filter((c) => c.feedback.fit === 'like');
  const noneFit = panel.outcome === 'no_match' || (panel.choices.length > 0 && panel.choices.every((c) => c.feedback.fit === 'not_right'));
  const allKnown = panel.choices.length > 0 && panel.choices.every((c) => c.feedback.familiarity === 'known');
  const anchors = snapshot.connection?.anchors ?? [];
  const changed = text.trim() !== '';
  const remaining = anchors.filter((a) => !leaveOut.includes(a.handle)).length;
  return (
    <section className="assistant" aria-label="Refined search">
      <p className="emphasis">One refinement per song.</p>
      {hidden ? (
        <p>Those results are hidden. Try a fresh search.</p>
      ) : (noneFit || allKnown) && (
        <p>{noneFit ? 'Try another direction.' : 'Know these already? Find something new.'}</p>
      )}
      {liked.length > 0 && (
        <div className="action-row">
          {[...new Map(liked.map((c) => [c.anchor, c])).values()].map((c) => (
            <button
              key={c.handle}
              type="button"
              className="primary"
              disabled={disabled || busy}
              onClick={() => props.onRefine({ mode: 'follow_connection', panel: panel.handle, brief: brief.handle, choice: c.handle })}
            >
              Follow {c.anchor}
            </button>
          ))}
        </div>
      )}
      {liked.length > 0 && <p className="support">Explore this artist’s connections.</p>}
      <label className="field">
        <span className="field-label">Keep something different (optional)</span>
        <input value={text} maxLength={1000} disabled={disabled} onChange={(e) => setText(e.target.value)} />
      </label>
      {anchors.length > 1 && (
        <fieldset className="leave-out">
          <legend className="field-label">Leave out connected artists (optional)</legend>
          {anchors.map((a) => (
            <label key={a.handle} className="check">
              <input
                type="checkbox"
                checked={leaveOut.includes(a.handle)}
                disabled={disabled || (!leaveOut.includes(a.handle) && remaining <= 1)}
                onChange={(e) => setLeaveOut((l) => (e.target.checked ? [...l, a.handle] : l.filter((h) => h !== a.handle)))}
              />
              <span>{a.name}</span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="action-row">
        <button
          type="button"
          className={liked.length > 0 ? 'secondary' : 'primary'}
          disabled={disabled || busy}
          onClick={() =>
            props.onRefine({
              mode: 'correct_direction',
              panel: panel.handle,
              brief: brief.handle,
              ...(changed ? { relationship: { text: text.trim() } } : {}),
              ...(leaveOut.length > 0 ? { excludeArtists: leaveOut } : {}),
            })
          }
        >
          {changed ? 'Try this direction' : 'Find fresh recordings'}
        </button>
      </div>
      <p className="support">
        Finds new recordings within these artist connections.
      </p>
    </section>
  );
}

const DISCOVERY_OUTCOME: Partial<Record<NonNullable<Snap['code']>, string>> = {
  catalogue_failed: 'Recording search did not return a usable answer, so nothing was suggested.',
  catalogue_refused: 'Recording search declined this request, so nothing was suggested.',
  grounding_unavailable: 'Recording search could not provide its required source information, so its picks are not shown.',
  catalogue_not_configured:
    'Song search is unavailable right now.',
  no_seed: 'No starting artist could be identified, so artist connections could not be explored. Edit the artist names and save to try again.',
  pool_empty: 'No connected artists were returned for that start, so nothing was suggested. Try different artists.',
  qloo_failed: 'The artist connection service did not answer usefully, so nothing was suggested.',
  capacity: 'This reference has used its allowed lookups.',
  stale_version: 'Your choice changed while discovery was running, so that run was not used.',
  deadline: 'Discovery ran out of time, so nothing was suggested.',
  // A service answered 429/503: a statement about the service at that moment only, never about the music, the source or any quota or time.
  provider_limited: 'A search service limited this request. No new picks were added.',
  provider_unavailable: 'A search service is unavailable. No new picks were added.',
};

const REFERENCE_OUTCOME: Partial<Record<NonNullable<Snap['code']>, string>> = {
  deadline: 'The reference step ran out of time, so no analysis was added.',
  provider_limited: 'Gemini limited this request. No analysis was added.',
  provider_unavailable: 'Gemini is unavailable. No analysis was added.',
};

/** The in-flow sentence for a failed reference step. A service-side limit or outage is named as exactly that, never as a verdict on the link or the music. */
export function referenceFailure(code: Snap['code'], reference?: SafeReference | null): string {
  const outcome = code && REFERENCE_OUTCOME[code];
  if (outcome) return outcome;
  if (reference && isStreamedReference(reference)) return 'We couldn’t finish analysing that music.';
  if (reference && isRecordedReference(reference)) return 'We couldn’t analyse that recording.';
  return 'The reference step did not finish, so no analysis was added.';
}

/**
 * What truthfully remains on screen after a refinement added nothing: the previous panel exactly as it is presented now.
 * Real choices are "kept above"; a hidden panel (required source information unavailable) stays hidden and is never
 * described as choices; an earlier no-match is described as that result. Nothing is claimed without a panel.
 */
function earlierKept(panel: SafePanel | null | undefined): string {
  if (!panel) return '';
  if (panel.outcome === 'source_unavailable') return ' Previous results stay hidden while sources are unavailable.';
  if (panel.choices.length === 0) return ' Your previous search is still here.';
  return ' Your previous picks are still here.';
}

export function discoveryOutcome(snapshot: Snap): string | null {
  const kind = snapshot.attempt?.kind;
  if ((kind !== 'discover' && kind !== 'refine') || snapshot.attempt?.active) return null;
  if (snapshot.stage === 'cancelled') {
    return kind === 'refine'
      ? `Stopped. Refinement used.${earlierKept(snapshot.panel)}`
      : 'Stopped. Nothing from that discovery will be added.';
  }
  if (snapshot.stage !== 'failed' || !snapshot.code) return null;
  const text = DISCOVERY_OUTCOME[snapshot.code] ?? 'Discovery did not finish, so nothing was suggested.';
  if (kind !== 'refine') return text;
  // A refinement claims the one shared allowance when it is admitted and never gives it back, so a service failure still counts as its use.
  const serviceSide = snapshot.code === 'provider_limited' || snapshot.code === 'provider_unavailable';
  return `${text}${serviceSide ? ' Refinement used.' : ''}${earlierKept(snapshot.panel)}`;
}

/**
 * Honest progress text. The action this page is awaiting decides the kind; the
 * server's stage is used only once it reports an active attempt of that same
 * kind (admitted). An older terminal attempt never overrides the current
 * action, and before admission the text names only what has been sent. With no
 * local action (server-active recovery) the active attempt's own kind applies.
 */
export function workingText(snapshot: Snap | null, action: PendingAction | null): string {
  const active = snapshot?.attempt?.active ? snapshot.attempt : null;
  const admitted = active && (!action || active.kind === action.kind) ? active : null;
  const kind = action?.kind ?? admitted?.kind ?? null;
  if (kind === 'reference') {
    return snapshot?.mode === 'synthetic' ? 'Preparing the reference. Synthetic mode: no provider is contacted.' : 'Preparing your song…';
  }
  const reusing = action?.kind === 'refine' && action.refineMode === 'correct_direction';
  if (admitted) {
    switch (snapshot?.stage) {
      case 'retrieving_taste':
        return 'Exploring artist connections…';
      case 'finding_tracks':
        return reusing ? 'Finding more songs…' : 'Finding and verifying songs…';
      case 'resolving_artists':
        return 'Finding artist connections…';
      default:
        break;
    }
  }
  if (kind === 'refine') return reusing ? 'Starting your refinement…' : 'Starting your refinement…';
  return 'Starting the search…';
}
