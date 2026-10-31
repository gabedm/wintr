/**
 * Tab wrap inside a modal. Focus can legitimately sit on something that is not
 * a tabbable control (the dialog itself, or its programmatically focused title);
 * the browser's own order from there would leave the dialog backward, so from
 * any non-control backward goes to the last control and forward to the first.
 * From the last control forward goes to the first, and from the first backward
 * to the last. Null means the browser's own order stays inside the dialog.
 * `container` is accepted for call-site clarity; it is just one such non-control.
 */
export function tabWrapTarget<T>(items: readonly T[], active: T | null, _container: T, shift: boolean): T | null {
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) return null;
  if (active === null || !items.includes(active)) return shift ? last : first;
  if (shift && active === first) return last;
  if (!shift && active === last) return first;
  return null;
}

/**
 * Where focus goes when a modal closes: the element that opened it if it can
 * still take focus, else the stable fallback trigger, else nowhere (focus is
 * never forced onto something dead). Decided at the moment of closing, never
 * after an animation.
 */
export function pickFocusTarget<T>(opener: T | null, fallback: T | null, canFocus: (el: T) => boolean): T | null {
  if (opener !== null && canFocus(opener)) return opener;
  if (fallback !== null && canFocus(fallback)) return fallback;
  return null;
}
