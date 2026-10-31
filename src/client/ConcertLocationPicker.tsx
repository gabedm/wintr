import { useEffect, useId, useRef, useState } from 'react';
import { loadCityIndex, type CityIndex, type CityOption, type ConcertLocation } from './city-index.js';

export function ConcertLocationPicker({ value, disabled, onApply, onCancel, load = loadCityIndex }: { value: ConcertLocation; disabled: boolean; onApply: (place: ConcertLocation) => void; onCancel: () => void; load?: (signal: AbortSignal) => Promise<CityIndex> }) {
  const [query, setQuery] = useState(value.label), [chosen, setChosen] = useState<ConcertLocation | null>(value.city ? value : null);
  const [index, setIndex] = useState<CityIndex | null>(null), [failed, setFailed] = useState(false), [open, setOpen] = useState(false), [active, setActive] = useState(-1);
  const field = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null), listId = useId(), labelId = useId();
  const matches = index?.search(query) ?? [], expanded = open && matches.length > 0;
  useEffect(() => {
    field.current?.focus(); const abort = new AbortController();
    void load(abort.signal).then(result => { if (!abort.signal.aborted) setIndex(result); }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => abort.abort();
  }, [load]);
  useEffect(() => {
    const menu = list.current, option = menu?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    if (!expanded || !menu || !option) return;
    const bounds = menu.getBoundingClientRect(), row = option.getBoundingClientRect();
    if (row.top < bounds.top) menu.scrollTop -= bounds.top - row.top;
    else if (row.bottom > bounds.bottom) menu.scrollTop += row.bottom - bounds.bottom;
  }, [active, expanded]);
  const select = (option: CityOption) => { const place = { city: option.city, countryCode: option.countryCode, label: option.label }; setChosen(place); setQuery(place.label); setOpen(false); setActive(-1); field.current?.focus(); };
  const apply = () => onApply(chosen ?? { city: query.trim() || null, countryCode: null, label: query.trim() });
  return <div className="concert-filter-editor concert-location-editor" onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onCancel(); } }}>
    <label className="field" htmlFor={labelId}><span>City</span><input ref={field} id={labelId} role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={listId} aria-activedescendant={expanded && active >= 0 && active < matches.length ? `${listId}-${matches[active]!.id}` : undefined} value={query} maxLength={100} placeholder="Search cities" autoComplete="off" onFocus={() => { if (!chosen) setOpen(true); }} onBlur={() => setOpen(false)} onChange={event => { setQuery(event.target.value); setChosen(null); setOpen(true); setActive(-1); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) { event.preventDefault(); setOpen(true); setActive(current => event.key === 'ArrowDown' ? Math.min(current + 1, matches.length - 1) : current < 0 ? matches.length - 1 : Math.max(current - 1, 0)); }
      else if (event.key === 'Enter') { event.preventDefault(); if (expanded) select(matches[active >= 0 && active < matches.length ? active : 0]!); else if (!disabled) apply(); }
      else if (event.key === 'Escape') { event.preventDefault(); if (expanded) { setOpen(false); setActive(-1); } else onCancel(); }
    }} /></label>
    {expanded && <ul ref={list} className="city-suggestions" id={listId} role="listbox" aria-label="Cities">{matches.map((option, i) => <li key={option.id} role="presentation"><button type="button" role="option" id={`${listId}-${option.id}`} aria-selected={active === i} tabIndex={-1} onPointerDown={event => event.preventDefault()} onClick={() => select(option)}><span><strong>{option.label}</strong>{option.region && <small>{option.region}</small>}</span><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg></button></li>)}</ul>}
    <span className="visually-hidden" role="status">{expanded ? `${matches.length} cities available. Use arrow keys to choose.` : chosen ? `${chosen.label} selected` : ''}</span>
    {failed && <p className="support" role="status">City suggestions couldn’t load. You can still enter a city.</p>}
    <div className="location-actions"><button type="button" className="calendar-clear" onClick={() => { setChosen(null); setQuery(''); setActive(-1); setOpen(false); field.current?.focus(); }}>Clear location</button><button type="button" className="primary" disabled={disabled} onClick={apply}>Done</button></div>
  </div>;
}
