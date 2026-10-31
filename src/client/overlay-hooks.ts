import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { pickFocusTarget } from './focus.js';
import { DrawerPresence, SHEET_MS, type DrawerProgress } from './presence.js';
import { createScrollLock } from './scroll-lock.js';
import { SheetGesture } from './sheet-drag.js';
import { browserFrames, prefersReducedMotion } from './viewport-hooks.js';

// Browser bindings shared by the modal surfaces: the page scroll lock, the focus
// and Escape authority, the contextual sheet's presence and its handle drag.
// None of it carries business authority; all of it is decided synchronously.

let scrollLock: ReturnType<typeof createScrollLock> | null = null;
export const lockPageScroll = () => (scrollLock ??= createScrollLock(document.documentElement))();

/** A control that can actually take focus now (connected, enabled, not inert). */
export function focusable(el: Element): boolean {
  if (!(el instanceof HTMLElement) || !el.isConnected || el.matches(':disabled') || el.closest('[inert], [hidden]')) return false;
  const visibility = getComputedStyle(el).visibility;
  if (visibility === 'hidden' || visibility === 'collapse') return false;
  // A connected opener may have moved into an inactive panel while the modal
  // was open. Choosing it would suppress the valid fallback without restoring
  // visible focus. Check ancestors because display is not inherited.
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

/**
 * Authority of an open modal, applied in the same commit that opens or closes
 * it: the page scroll is locked while it is wanted, Escape closes it, and on
 * close focus returns to the opener (or the fixed fallback trigger) without
 * scrolling. Nothing waits for an animation.
 */
export function useModalAuthority(open: boolean, onClose: () => void, fallbackId: string) {
  const close = useRef(onClose);
  close.current = onClose;
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    // Some browsers do not focus a clicked button (and inert may already have blurred it): then the fallback trigger is the target.
    opener.current = document.activeElement === document.body ? null : document.activeElement;
    const release = lockPageScroll();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      release();
      const target = pickFocusTarget<Element>(opener.current, document.getElementById(fallbackId), focusable);
      if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    };
  }, [open, fallbackId]);
}

function paintSheet(el: HTMLElement, p: DrawerProgress) {
  el.style.setProperty('--sheet-p', String(p.panel));
  el.style.setProperty('--scrim-p', String(p.scrim));
}

/**
 * Presence for the contextual sheet (M06.sheet timings). `open` is the
 * immediate authority; this animates only the picture. The presence object is
 * returned so a drag can take over and so revoked authority can remove the
 * picture at once.
 */
export function useSheetPresence(open: boolean) {
  const [mounted, setMounted] = useState(false);
  const layer = useRef<HTMLElement | null>(null);
  const ref = useRef<DrawerPresence | null>(null);
  if (ref.current === null) {
    ref.current = new DrawerPresence({
      frames: browserFrames,
      ms: SHEET_MS,
      reducedMotion: prefersReducedMotion,
      write: (p) => {
        if (layer.current) paintSheet(layer.current, p);
      },
      onMounted: setMounted,
    });
  }
  const presence = ref.current;

  const attach = useCallback(
    (el: HTMLElement | null) => {
      layer.current = el;
      if (el) paintSheet(el, presence.progress);
    },
    [presence],
  );

  useLayoutEffect(() => {
    if (open) presence.open();
    else presence.close();
  }, [open, presence]);

  useEffect(() => {
    const onVisibility = () => presence.visibilityChanged(document.visibilityState === 'hidden');
    const mql = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const onReduced = () => presence.reducedMotionChanged();
    mql?.addEventListener('change', onReduced);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      mql?.removeEventListener('change', onReduced);
      presence.dispose();
    };
  }, [presence]);

  return { mounted, exiting: mounted && !open, attach, presence };
}

/** Gap between the sheet and the bottom edge (px): part of the bottom-origin travel (100% of own height plus this). */
export const SHEET_BOTTOM_GAP_PX = 8;

/**
 * Handle-only drag. The returned handlers belong on the drag handle element
 * alone, so content scrolling, fields and links can never start a drag.
 * Release decides dismiss (calling `onDismiss` first, synchronously) or return.
 */
export function useSheetDrag(presence: DrawerPresence, sheetRef: RefObject<HTMLElement | null>, onDismiss: () => void, active: boolean) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const [gesture] = useState(() => new SheetGesture(presence, () => sheetRef.current?.getBoundingClientRect().height ?? 0, SHEET_BOTTOM_GAP_PX, () => dismiss.current()));
  const captured = useRef<HTMLElement | null>(null);

  // Real geometry changes (rotation, resize, keyboard, the panel's own height) abandon an active drag and return it to open; no timers.
  useEffect(() => {
    if (!active) return;
    const release = (id: number | null) => {
      if (id === null) return;
      try {
        captured.current?.releasePointerCapture?.(id);
      } catch {
        // The pointer is already gone; nothing is left to release.
      }
    };
    const onViewport = () => release(gesture.invalidate());
    const el = sheetRef.current;
    const observer = el && typeof ResizeObserver === 'function' ? new ResizeObserver(() => release(gesture.heightChanged(el.getBoundingClientRect().height))) : null;
    if (el) observer?.observe(el);
    window.addEventListener('resize', onViewport);
    window.addEventListener('orientationchange', onViewport);
    window.visualViewport?.addEventListener('resize', onViewport);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('orientationchange', onViewport);
      window.visualViewport?.removeEventListener('resize', onViewport);
      release(gesture.invalidate());
    };
  }, [active, gesture, sheetRef]);

  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (!gesture.down(e)) return;
      captured.current = e.currentTarget;
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => gesture.move(e),
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => gesture.up(e),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => gesture.cancel(e.pointerId),
    onLostPointerCapture: (e: ReactPointerEvent<HTMLElement>) => gesture.cancel(e.pointerId),
  };
}
