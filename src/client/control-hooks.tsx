import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { CONTROL, isPressable, PressManager, Toggle } from './control.js';
import { ENV, useEnvEvents } from './conversation-motion.js';

// Browser bindings for control and selection motion (M03.control, M07.selection).
// They only draw: activation, focus, aria state and every request are decided by
// the page from real state, never by a pointer animation or its completion.

/** The existing controls that press; a disabled or aria-disabled one never does. */
const PRESSABLE = 'button.send, button.mic, button.chip, button.suggestion, button.primary, button.secondary, button.icon-button, button.identity-row, button.new-answer, button.session-trigger, button.intro-start, a.primary, a.secondary';

function paintPress(el: HTMLElement, scale: number) {
  if (scale >= 1) {
    el.removeAttribute('data-pressing');
    el.style.removeProperty('--press');
  } else {
    el.setAttribute('data-pressing', '');
    el.style.setProperty('--press', String(scale));
  }
}

/**
 * One delegated pointer binding for every existing control: scale 1 -> 0.97 over
 * 80 ms on press and back over 120 ms on release. Pointer cancel, leaving the
 * control, a lost window, a hidden page and reduced motion restore scale 1.
 * Keyboard activation never involves it. Mounted once, by the page.
 */
export function useControlPress() {
  const manager = useRef<PressManager<HTMLElement> | null>(null);
  if (manager.current === null) manager.current = new PressManager<HTMLElement>(ENV, paintPress);
  const m = manager.current;

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const target = e.target instanceof Element ? e.target.closest<HTMLElement>(PRESSABLE) : null;
      if (target && isPressable(target)) m.down(target);
    };
    const onOut = (e: PointerEvent) => {
      const from = e.target instanceof Element ? e.target.closest<HTMLElement>(PRESSABLE) : null;
      if (from && !(e.relatedTarget instanceof Node && from.contains(e.relatedTarget))) m.up(from);
    };
    const release = () => m.up();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerout', onOut, true);
    for (const type of ['pointerup', 'pointercancel', 'dragstart', 'contextmenu']) document.addEventListener(type, release, true);
    window.addEventListener('blur', release);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerout', onOut, true);
      for (const type of ['pointerup', 'pointercancel', 'dragstart', 'contextmenu']) document.removeEventListener(type, release, true);
      window.removeEventListener('blur', release);
      m.restoreAll();
    };
  }, [m]);

  useEnvEvents(
    (hidden) => hidden && m.restoreAll(),
    () => ENV.reducedMotion() && m.restoreAll(),
  );
}

/**
 * A 0..1 state value written to `--t` on the attached element: seeded at first
 * appearance (no motion) and crossfaded over `ms` from the current value when the
 * semantic state changes. A hidden page or a live reduced-motion change finishes it.
 * The picture follows the state; the state never waits for the picture.
 */
export function useToggle(on: boolean, ms: number) {
  const el = useRef<HTMLElement | null>(null);
  const latest = useRef(on);
  latest.current = on;
  const ref = useRef<Toggle | null>(null);
  if (ref.current === null) ref.current = new Toggle(ENV, ms, (t) => el.current?.style.setProperty('--t', String(t)));
  const toggle = ref.current;

  const attach = useCallback(
    (node: HTMLElement | null) => {
      el.current = node;
      if (node) node.style.setProperty('--t', String(toggle.attach(latest.current)));
    },
    [toggle],
  );

  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    toggle.set(on);
  }, [on, toggle]);

  useEnvEvents(
    (hidden) => hidden && toggle.finish(),
    () => ENV.reducedMotion() && toggle.finish(),
  );
  useEffect(() => () => toggle.dispose(), [toggle]);
  return attach;
}

/**
 * The selected mark in a reserved end slot: its space is always there, so selecting
 * never changes width or wrapping, and only the mark crossfades (160 ms). `selected`
 * must come from owned, confirmed state; an unresolved choice is never passed as selected.
 */
export function SelectMark({ selected }: { selected: boolean }) {
  const attach = useToggle(selected, CONTROL.toggleMs);
  return (
    <span ref={attach} className="select-mark" data-on={selected || undefined} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 14 14">
        <path d="M2.5 7.5 5.5 10.5 11.5 3.5" pathLength={1} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** A toggle chip: `aria-pressed` is the semantic state (immediate); the mark only draws it. */
export function Chip({ pressed, disabled, busy, onClick, children }: { pressed: boolean; disabled?: boolean; busy?: boolean; onClick: () => void; children: ReactNode }) {
  // `busy` (a save awaiting its acknowledgement) is aria-disabled, not disabled: the control that holds focus keeps it, and a click does nothing.
  return (
    <button type="button" className="chip" aria-pressed={pressed} disabled={disabled} aria-disabled={busy || undefined} onClick={busy ? undefined : onClick}>
      {children}
      <SelectMark selected={pressed} />
    </button>
  );
}
