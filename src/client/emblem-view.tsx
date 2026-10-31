import { useCallback, useEffect, useId, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { ENV, useEnvEvents } from './conversation-motion.js';
import { EMBLEM, EMBLEM_START, EmblemMotion, emblemStep, type EmblemFacts, type EmblemOutput, type EmblemState } from './emblem.js';
import { SnowflakeLines } from './mobile-icons.js';

// Browser binding and component for the header emblem. It only draws: the facts
// come from the page's own state, and nothing here sends, stops, clears, expires,
// fetches or delays anything. Under reduced motion the same factual rings appear
// at once with no loop.

/** Derives the factual output in render (pure) and draws it from a layout effect, so Stop/Clear/expiry land in the same commit. */
export function useEmblem(facts: EmblemFacts, visible = true): { out: EmblemOutput; attach: (node: SVGSVGElement | null) => void } {
  const state = useRef<EmblemState>(EMBLEM_START);
  const { out } = emblemStep(state.current, facts);
  useLayoutEffect(() => {
    state.current = emblemStep(state.current, facts).state;
  });

  const node = useRef<SVGSVGElement | null>(null);
  const motion = useRef<EmblemMotion | null>(null);
  if (motion.current === null) {
    motion.current = new EmblemMotion(ENV, {
      fill: (rings) => rings.forEach((v, i) => node.current?.style.setProperty(`--ring-${i}`, String(v))),
      breath: (v) => (v === null ? node.current?.style.removeProperty('--emblem-breath') : node.current?.style.setProperty('--emblem-breath', String(v))),
    });
  }
  const m = motion.current;

  const attach = useCallback(
    (el: SVGSVGElement | null) => {
      node.current = el;
      const visible = m.value;
      if (el && visible !== null) for (let i = 0; i < EMBLEM.rings; i++) el.style.setProperty(`--ring-${i}`, String(Math.min(1, Math.max(0, visible - i))));
    },
    [m],
  );

  useLayoutEffect(() => {
    m.visibilityChanged(!visible || ENV.hidden?.() === true);
    m.setSteps(out.steps);
    if (out.halted || !visible) m.finish();
    m.setBusy(out.busy && visible);
  }, [out.steps, out.busy, out.halted, visible, m]);

  useEnvEvents(
    (hidden) => m.visibilityChanged(hidden || !visible),
    () => m.reducedMotionChanged(),
  );
  // Unmount cancels every frame. An effect replay (StrictMode) on the same instance restores the current factual state.
  const latest = useRef({ out, visible });
  latest.current = { out, visible };
  useEffect(() => {
    m.visibilityChanged(!latest.current.visible || ENV.hidden?.() === true);
    m.setSteps(latest.current.out.steps);
    if (!latest.current.visible) m.finish();
    m.setBusy(latest.current.out.busy && latest.current.visible);
    return () => m.dispose();
  }, [m]);
  return { out, attach };
}

const RING_STYLE = (i: number) => ({ '--r': `var(--ring-${i}, 0)` }) as CSSProperties;

/**
 * SVG snowflake silhouette. Normal runs retain the
 * five factual stage bands. The explicit Live variant fills outward during the
 * first five captured seconds: minimum input readiness, never completed analysis.
 */
export function Emblem({ out, attach, listeningMs }: { out: EmblemOutput; attach?: (node: SVGSVGElement | null) => void; listeningMs?: number }) {
  const hollowId = `wintr-hollow-${useId().replaceAll(':', '')}`;
  const captureProgress = listeningMs === undefined ? undefined : Number.isFinite(listeningMs) ? Math.min(1, Math.max(0, listeningMs / 5000)) : 0;
  return (
    <svg
      ref={attach}
      className="emblem"
      viewBox="0 0 128 128"
      role="img"
      aria-label="Wintr"
      data-steps={out.steps}
      data-busy={out.busy || undefined}
      data-found={out.found || undefined}
      data-capture-ready={captureProgress === undefined ? undefined : captureProgress === 1}
      data-capture-progressing={captureProgress !== undefined && captureProgress > 0 && captureProgress < 1 && out.busy || undefined}
    >
      <defs>
        <mask id={hollowId} maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
          <rect x="0" y="0" width="128" height="128" fill="white" />
          <g color="black"><SnowflakeLines inner /></g>
        </mask>
        {captureProgress !== undefined && <clipPath id={`${hollowId}-capture`} clipPathUnits="userSpaceOnUse"><circle className="flake-capture-radius" cx="64" cy="64" r={56 * captureProgress} /></clipPath>}
        {[0, 1, 2, 3, 4].map(i => {
          const r = 12 + i * 12, n = i * 12;
          return <clipPath key={i} id={`${hollowId}-${i}`}><path clipRule="evenodd" d={`M${64-r} 64A${r} ${r} 0 1 0 ${64+r} 64A${r} ${r} 0 1 0 ${64-r} 64Z${n ? `M${64-n} 64A${n} ${n} 0 1 0 ${64+n} 64A${n} ${n} 0 1 0 ${64-n} 64Z` : ''}`} /></clipPath>;
        })}
      </defs>
      {listeningMs !== undefined ? <>
        {out.busy && <g className="live-listening-halo" fill="none" stroke="currentColor"><circle cx="64" cy="64" r="61" strokeWidth=".5" /><circle cx="64" cy="64" r="57" strokeWidth=".35" /></g>}
        <g className="flake-outline" mask={`url(#${hollowId})`}><SnowflakeLines /></g>
        <g className="flake-ready" clipPath={`url(#${hollowId}-capture)`}><SnowflakeLines /></g>
      </> : [0, 1, 2, 3, 4].map(i => <g key={i} className={`ring ring-${i}`} style={RING_STYLE(i)} data-frontier={(out.busy && i === out.steps) || undefined} clipPath={`url(#${hollowId}-${i})`}>
        <g className="flake-outline" mask={`url(#${hollowId})`}><SnowflakeLines /></g>
        <g className="flake-fill"><SnowflakeLines /></g>
      </g>)}
    </svg>
  );
}
