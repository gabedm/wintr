// Keeps the page behind an open modal from scrolling, and puts back exactly what
// was there before. Only the root element's inline overflow is touched (never
// the scroll position), so the reading position and draft survive. Locks are
// counted, so overlapping surfaces release cleanly and a repeated release is a
// no-op.

export interface ScrollLockTarget {
  readonly style: { overflow: string };
}

export function createScrollLock(target: ScrollLockTarget): () => () => void {
  let holders = 0;
  let previous = '';
  return () => {
    if (holders === 0) {
      previous = target.style.overflow;
      target.style.overflow = 'hidden';
    }
    holders += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holders -= 1;
      if (holders === 0) target.style.overflow = previous;
    };
  };
}
