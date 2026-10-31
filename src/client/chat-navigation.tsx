import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Handle, SafeSnapshot } from '../shared/records.js';
import { initialComposer, type ComposerState } from './draft.js';
import { STANDARD_EASING, ValueTween } from './motion.js';
import { browserFrames, prefersReducedMotion } from './viewport-hooks.js';

/** Local drafts only. A fresh authorised roster prunes deleted chat drafts. */
export function useChatComposer(snapshot: SafeSnapshot | null, wipe: number, hidden: boolean, hiddenChats: readonly Handle[] = []): [ComposerState, Dispatch<SetStateAction<ComposerState>>] {
  const [state, setState] = useState<{ wipe: number; context: string | null; drafts: Map<string, ComposerState> }>(() => ({ wipe, context: null, drafts: new Map() }));
  const context = snapshot?.session?.context ?? null;
  const current = snapshot?.chats?.current;
  const key = context && current ? `${context}:${current}` : 'entry';
  const valid = state.wipe === wipe;
  const drafts = valid ? state.drafts : new Map<string, ComposerState>();
  // The initial unowned draft becomes the first primary chat's draft. A New
  // chat created alongside it gets a separate empty draft.
  const primary = context && snapshot?.chats?.items[0]?.handle;
  const adopted = context && primary && !state.context && drafts.has('entry') && key === `${context}:${primary}` ? drafts.get('entry') : undefined;
  const composer = hidden ? initialComposer(wipe) : drafts.get(key) ?? adopted ?? initialComposer(wipe);
  useLayoutEffect(() => {
    setState(previous => {
      const next = previous.wipe === wipe ? new Map(previous.drafts) : new Map<string, ComposerState>();
      let changed = previous.wipe !== wipe;
      for (const id of next.keys()) if (hiddenChats.some(chat => id.endsWith(':' + chat))) { next.delete(id); changed = true; }
      if (hidden) return changed ? { wipe, context: previous.wipe === wipe ? previous.context : null, drafts: next } : previous;
      // A recovered directory can have no selection after primary deletion.
      // Its first remaining item is not authority to adopt this entry draft.
      if (context && primary && current === primary && previous.context === null && next.has('entry')) {
        if (!next.has(`${context}:${primary}`)) next.set(`${context}:${primary}`, next.get('entry')!);
        next.delete('entry'); changed = true;
      }
      if (context && snapshot?.chats) {
        const keep = new Set(snapshot.chats.items.map(c => `${context}:${c.handle}`));
        for (const id of next.keys()) if (id !== 'entry' && !keep.has(id)) { next.delete(id); changed = true; }
      }
      if (!changed && previous.context === context) return previous;
      return { wipe, context, drafts: next };
    });
  }, [context, current, hidden, hiddenChats, primary, snapshot?.chats, wipe]);
  const setComposer: Dispatch<SetStateAction<ComposerState>> = update => {
    if (hidden) return;
    setState(previous => {
      const before = (previous.wipe === wipe ? previous.drafts.get(key) : undefined) ?? adopted ?? initialComposer(wipe);
      const after = typeof update === 'function' ? update(before) : update;
      if (after === before && previous.wipe === wipe) return previous;
      const next = previous.wipe === wipe ? new Map(previous.drafts) : new Map<string, ComposerState>();
      next.set(key, after);
      return { wipe, context: previous.wipe === wipe ? previous.context : null, drafts: next };
    });
  };
  return [composer, setComposer];
}

/** M07.page:220ms, standard easing,12px incoming; shell never moves. */
export function useChatPageMotion(main: RefObject<HTMLElement | null>, key: string | null, revoked: boolean, wipe: number) {
  const ref = useRef<{ ghost: HTMLElement | null; incoming: ValueTween; outgoing: ValueTween } | null>(null);
  const previous = useRef<string | null>(null);
  const scrolls = useRef(new Map<string, number>());
  const navigating = useRef(false);
  const direction = useRef(1);
  if (!ref.current) {
    const state = { ghost: null as HTMLElement | null, incoming: null as unknown as ValueTween, outgoing: null as unknown as ValueTween };
    state.incoming = new ValueTween({ frames: browserFrames, nominalMs: 220, easing: STANDARD_EASING, reducedMotion: prefersReducedMotion, apply: p => {
      if (main.current) { main.current.style.opacity = String(p); main.current.style.transform = `translateX(${direction.current * 12 * (1 - p)}px)`; }
    } });
    state.outgoing = new ValueTween({ frames: browserFrames, nominalMs: 220, easing: STANDARD_EASING, reducedMotion: prefersReducedMotion, apply: p => {
      if (state.ghost) state.ghost.style.opacity = String(p);
      if (p === 0) { state.ghost?.remove(); state.ghost = null; }
    } });
    ref.current = state;
  }
  const state = ref.current;
  const finish = () => { state.incoming.finish(); state.outgoing.set(0); };
  const begin = (back = false) => {
    const root = document.scrollingElement ?? document.documentElement;
    if (key) scrolls.current.set(key, root.scrollTop);
    navigating.current = true;
    direction.current = back ? -1 : 1;
    const el = main.current;
    if (!el || revoked || prefersReducedMotion() || document.visibilityState === 'hidden') return finish();
    state.ghost?.remove();
    const rect = el.getBoundingClientRect(), picture = el.cloneNode(true) as HTMLElement;
    // Decorative picture only: no focus, navigation, duplicate result anchors
    // or iframe/image loads. Clear/delete/return remove it synchronously.
    picture.removeAttribute('id'); picture.removeAttribute('data-result');
    for (const node of picture.querySelectorAll<HTMLElement>('[id], [data-result]')) { node.removeAttribute('id'); node.removeAttribute('data-result'); }
    for (const node of picture.querySelectorAll('iframe, img')) node.remove();
    picture.inert = true; picture.setAttribute('aria-hidden', 'true'); picture.classList.add('chat-page-ghost');
    Object.assign(picture.style, { position: 'fixed', top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px`, margin: '0', pointerEvents: 'none', zIndex: '1', overflow: 'hidden', transform: 'none' });
    document.body.append(picture); state.ghost = picture;
    state.outgoing.set(Number(el.style.opacity || 1));
    state.outgoing.to(0, { nominalMs: 220, fullPath: 1 });
  };
  useLayoutEffect(() => {
    if (revoked) { finish(); navigating.current = false; }
    if (key && key !== previous.current && navigating.current && !revoked) {
      const root = document.scrollingElement ?? document.documentElement;
      root.scrollTop = scrolls.current.get(key) ?? 0;
      main.current?.querySelector<HTMLElement>('[data-chat-heading]')?.focus({ preventScroll: true });
      state.incoming.set(prefersReducedMotion() || document.visibilityState === 'hidden' ? 1 : 0);
      state.incoming.to(1, { nominalMs: 220, fullPath: 1 });
      navigating.current = false;
    }
    if (key) previous.current = key;
  }, [key, revoked, state]);
  useLayoutEffect(() => { scrolls.current.clear(); finish(); }, [wipe]);
  useEffect(() => {
    const visibility = () => { if (document.visibilityState === 'hidden') finish(); };
    const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const onReduced = () => { if (reduced?.matches) finish(); };
    document.addEventListener('visibilitychange', visibility); reduced?.addEventListener('change', onReduced);
    return () => { document.removeEventListener('visibilitychange', visibility); reduced?.removeEventListener('change', onReduced); state.incoming.cancel(); state.outgoing.cancel(); state.ghost?.remove(); state.ghost = null; };
  }, [state]);
  return { begin };
}
