import type { Frames } from './motion.js';

const CONTROLS = 'button, input, textarea, select, summary, a[href], [contenteditable="true"]';
const NAVIGATION = new Set(['Tab', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'ArrowUp', 'ArrowDown']);
const editable = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || el.matches('input, textarea'));

/**
 * Protect an actively used, visible control across a native viewport change.
 * This is separate from reading follow and never runs from ordinary document scrolling.
 * Explicit input/read-scroll retires stale focus; no blur, focus change, tween or guessed keyboard timing.
 */
export function retainViewportFocus(deps: {
  shell: HTMLElement;
  dock: HTMLElement;
  frames: Pick<Frames, 'raf' | 'caf'>;
  bounds(): { top: number; bottom: number } | null;
  scrollTop(): number;
  beforeReveal?(): void;
}) {
  let candidate: HTMLElement | null = null;
  let armed = false, stopped = false;
  let resizeScroll: number | null = null, revealScroll: number | null = null;
  let focusFrame: number | null = null, layoutFrame: number | null = null, settleFrame: number | null = null;
  const eligible = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.isConnected &&
    deps.shell.contains(el) && !deps.dock.contains(el) && el.matches(CONTROLS) && !el.matches(':disabled') &&
    !el.closest('[inert], [hidden]') && getComputedStyle(el).visibility !== 'hidden';
  const cancelFrame = (id: number | null) => { if (id !== null) deps.frames.caf(id); };
  const interrupt = () => {
    armed = false; candidate = null;
    resizeScroll = revealScroll = null;
    cancelFrame(focusFrame); cancelFrame(layoutFrame); cancelFrame(settleFrame);
    focusFrame = layoutFrame = settleFrame = null;
  };
  const focus = () => {
    interrupt();
    const el = document.activeElement;
    if (!eligible(el)) return;
    candidate = el;
    // Native focus scrolling precedes animation frames. Arm only a control now wholly visible above the dock.
    focusFrame = deps.frames.raf(() => {
      focusFrame = null;
      if (stopped || candidate !== el || document.activeElement !== el || !eligible(el)) return;
      const bounds = deps.bounds(), rect = el.getBoundingClientRect();
      armed = !!bounds && rect.height > 0 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
    });
  };
  // Only the known native focus/reveal position can echo without retiring focus. No layout reads here.
  const scroll = () => {
    if (focusFrame !== null) return; // arming still requires a wholly visible target after native focus scrolling
    const at = deps.scrollTop();
    if ((layoutFrame !== null && at === resizeScroll) || (settleFrame !== null && at === revealScroll)) return;
    interrupt();
  };
  const pointer = (event: Event) => {
    const el = document.activeElement;
    if (eligible(el) && event.target instanceof Node && el.contains(event.target)) focus();
    else interrupt();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Tab' || (NAVIGATION.has(event.key) && !editable(event.target))) interrupt();
  };
  document.addEventListener('focusin', focus);
  document.addEventListener('focusout', interrupt);
  window.addEventListener('scroll', scroll, { passive: true });
  window.addEventListener('wheel', interrupt, { passive: true });
  window.addEventListener('touchstart', interrupt, { passive: true });
  window.addEventListener('pointerdown', pointer, { passive: true });
  window.addEventListener('keydown', key);

  return {
    changed() {
      if (stopped || !armed || !candidate) return;
      cancelFrame(layoutFrame); cancelFrame(settleFrame); settleFrame = null;
      resizeScroll = deps.scrollTop(); revealScroll = null;
      const el = candidate;
      // Clearance runs in the first frame; its sticky/flow-mode remeasure runs before this second frame.
      layoutFrame = deps.frames.raf(() => {
        if (stopped || !armed || candidate !== el) { layoutFrame = null; return; }
        layoutFrame = deps.frames.raf(() => {
          layoutFrame = null;
          if (stopped || !armed || candidate !== el || document.activeElement !== el || !eligible(el)) return;
          const bounds = deps.bounds(), rect = el.getBoundingClientRect();
          if (bounds && rect.height > 0 && rect.height <= bounds.bottom - bounds.top &&
              (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)) {
            deps.beforeReveal?.();
            const before = deps.scrollTop();
            el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
            const after = deps.scrollTop();
            if (after !== before) {
              revealScroll = after;
              // Only a real movement earns an echo; any different position still cancels synchronously.
              settleFrame = deps.frames.raf(() => { settleFrame = null; revealScroll = null; });
            }
          }
          resizeScroll = null;
        });
      });
    },
    dispose() {
      stopped = true; interrupt();
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', interrupt);
      window.removeEventListener('scroll', scroll);
      window.removeEventListener('wheel', interrupt);
      window.removeEventListener('touchstart', interrupt);
      window.removeEventListener('pointerdown', pointer);
      window.removeEventListener('keydown', key);
    },
  };
}
