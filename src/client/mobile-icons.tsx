import { useId } from 'react';

/** SVG geometry for the mobile snowflake mark. */
export function SnowflakeLines({ inner = false }: { inner?: boolean }) {
  return <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">{[0, 60, 120, 180, 240, 300].map(angle => <g key={angle} transform={`rotate(${angle} 64 64)`}>
    <path d="M64 64V14" strokeWidth={inner ? 6 : 12} />
    <path d="M48 26L64 36L80 26" strokeWidth={inner ? 3 : 9} />
  </g>)}</g>;
}
export function SnowflakeIcon({ hollow = false }: { hollow?: boolean }) {
  const id = `nav-mark-${useId().replaceAll(':', '')}`;
  return <svg width="28" height="28" viewBox="0 0 128 128" aria-hidden="true">
    {hollow && <defs><mask id={id}><rect width="128" height="128" fill="white" /><g color="black"><SnowflakeLines inner /></g></mask></defs>}
    <g mask={hollow ? `url(#${id})` : undefined}><SnowflakeLines /></g>
  </svg>;
}
export function LibraryIcon() { return <svg width="26" height="26" viewBox="0 0 28 28" aria-hidden="true"><path d="M3 6h11M3 12h11M3 18h9" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" /><path d="M19 6v14" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" /><path d="M19 6c0 4 6 3 6 8" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" /><ellipse cx="16.5" cy="21" rx="5" ry="3.5" fill="currentColor" transform="rotate(-25 16.5 21)" /></svg>; }
export function TicketIcon() { return <svg width="28" height="26" viewBox="0 0 30 26" aria-hidden="true"><path d="M3 6h24v3a4 4 0 0 0 0 8v3H3v-3a4 4 0 0 0 0-8V6Z" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinejoin="round" /><path d="M9 7v12" stroke="currentColor" strokeWidth="2.3" /></svg>; }
export function SearchIcon() { return <svg width="23" height="23" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6.6" fill="none" stroke="currentColor" strokeWidth="2.3" /><path d="m15 15 5.3 5.3" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" /></svg>; }
export function SettingsIcon() { return <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="m9.7 2-.5 2.5-1.8 1-2.4-.8-2.3 4 1.9 1.7v2.2l-1.9 1.7 2.3 4 2.4-.8 1.8 1 .5 2.5h4.6l.5-2.5 1.8-1 2.4.8 2.3-4-1.9-1.7v-2.2l1.9-1.7-2.3-4-2.4.8-1.8-1-.5-2.5Z" fill="currentColor" /><circle cx="12" cy="11.5" r="3.5" fill="var(--canvas)" /></svg>; }
export function ArrowIcon() { return <svg width="19" height="19" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 4 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
