import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { validConcertDate } from '../shared/concerts.js';

export interface ConcertDates { from: string; to: string | null }
const DAY = 86400000;
const lastDate = '9999-12-31';
const utc = (date: string) => new Date(`${date}T12:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);
const offset = (date: string, days: number) => iso(new Date(utc(date).getTime() + days * DAY));
const longDate = (date: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utc(date));
function moveMonth(date: string, months: number) {
  const current = utc(date), target = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + months, 1, 12));
  if (target.getUTCFullYear() > 9999) return lastDate;
  const days = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(current.getUTCDate(), days));
  return iso(target);
}

/** Local draft only. Applying is the sole action that passes dates to a search. */
export function ConcertCalendar({ value, minDate, disabled, onApply, onCancel }: { value: ConcertDates; minDate: string; disabled: boolean; onApply: (dates: ConcertDates) => void; onCancel: () => void }) {
  const initial = validConcertDate(value.from) && value.from >= minDate ? value.from : minDate;
  const [start, setStart] = useState<string | null>(value.to ? initial : value.from > minDate ? initial : null);
  const [end, setEnd] = useState<string | null>(value.to && validConcertDate(value.to) && value.to >= initial ? value.to : null);
  const [choosingEnd, setChoosingEnd] = useState(false), [error, setError] = useState<string | null>(null);
  const [focusedDay, setFocusedDay] = useState(initial), [month, setMonth] = useState(initial.slice(0, 7));
  const grid = useRef<HTMLTableElement>(null), focusRequested = useRef(true);
  const headingId = useId(), summaryId = useId();
  useEffect(() => { if (focusRequested.current) { grid.current?.querySelector<HTMLButtonElement>(`button[data-date="${focusedDay}"]`)?.focus(); focusRequested.current = false; } }, [focusedDay]);
  const first = `${month}-01`, monthDate = utc(first), firstDay = monthDate.getUTCDay();
  const days = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0, 12)).getUTCDate();
  const monthLabel = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(utc(first));
  const choose = (date: string) => {
    setError(null); setFocusedDay(date);
    if (!start || !choosingEnd) { setStart(date); setEnd(null); setChoosingEnd(true); return; }
    const from = date < start ? date : start, to = date < start ? start : date;
    if (utc(to).getTime() - utc(from).getTime() > 366 * DAY) { setError('Choose a range up to a year.'); return; }
    setStart(from); setEnd(to); setChoosingEnd(false);
  };
  const navigate = (date: string, focus: boolean) => {
    const next = date < minDate ? minDate : date > lastDate ? lastDate : date;
    focusRequested.current = focus; setFocusedDay(next); setMonth(next.slice(0, 7));
    if (focus && next === focusedDay) grid.current?.querySelector<HTMLButtonElement>(`button[data-date="${next}"]`)?.focus();
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, date: string) => {
    let next: string;
    switch (event.key) {
      case 'ArrowLeft': next = offset(date, -1); break;
      case 'ArrowRight': next = date === lastDate ? date : offset(date, 1); break;
      case 'ArrowUp': next = offset(date, -7); break;
      case 'ArrowDown': next = utc(date).getTime() + 7 * DAY > utc(lastDate).getTime() ? lastDate : offset(date, 7); break;
      case 'Home': next = offset(date, -utc(date).getUTCDay()); break;
      case 'End': next = utc(date).getTime() + (6 - utc(date).getUTCDay()) * DAY > utc(lastDate).getTime() ? lastDate : offset(date, 6 - utc(date).getUTCDay()); break;
      case 'PageUp': next = moveMonth(date, event.shiftKey ? -12 : -1); break;
      case 'PageDown': next = moveMonth(date, event.shiftKey ? 12 : 1); break;
      default: return;
    }
    event.preventDefault(); navigate(next, true);
  };
  const summary = start ? end && end !== start ? `${longDate(start)} – ${longDate(end)}` : longDate(start) : 'Any upcoming date';
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return <section className="concert-calendar" aria-label="Choose concert dates" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onCancel(); } }}>
    <div className="concert-calendar-header"><button type="button" className="calendar-month" aria-label="Previous month" disabled={month <= minDate.slice(0, 7)} onClick={() => navigate(moveMonth(focusedDay, -1), false)}><span aria-hidden="true">‹</span></button><h2 id={headingId} aria-live="polite">{monthLabel}</h2><button type="button" className="calendar-month" aria-label="Next month" disabled={month === '9999-12'} onClick={() => navigate(moveMonth(focusedDay, 1), false)}><span aria-hidden="true">›</span></button></div>
    <table ref={grid} role="grid" aria-multiselectable="true" aria-labelledby={headingId} aria-describedby={summaryId}>
      <thead><tr>{weekdays.map(day => <th key={day} scope="col" abbr={day}>{day.slice(0, 1)}</th>)}</tr></thead>
      <tbody>{Array.from({ length: Math.ceil((firstDay + days) / 7) }, (_, week) => <tr key={week}>{weekdays.map((_, weekday) => {
        const day = week * 7 + weekday - firstDay + 1;
        if (day < 1 || day > days) return <td key={weekday} />;
        const date = `${month}-${String(day).padStart(2, '0')}`, selected = start !== null && date >= start && date <= (end ?? start);
        const range = selected && end && start !== end ? date === start ? 'start' : date === end ? 'end' : 'middle' : undefined;
        return <td key={weekday} aria-selected={selected} data-range={range}><button type="button" className="calendar-day" data-date={date} data-endpoint={date === start || date === end || undefined} aria-label={longDate(date)} aria-current={date === minDate ? 'date' : undefined} disabled={date < minDate} tabIndex={date === focusedDay ? 0 : -1} onFocus={() => setFocusedDay(date)} onKeyDown={event => keyDown(event, date)} onClick={() => choose(date)}>{day}</button></td>;
      })}</tr>)}</tbody>
    </table>
    <p id={summaryId} className="calendar-selection" role="status">{summary}</p>
    {error && <p className="calendar-error" role="alert">{error}</p>}
    <div className="concert-calendar-footer"><button type="button" className="calendar-clear" onClick={() => { setStart(null); setEnd(null); setChoosingEnd(false); setError(null); }}>Clear</button><button type="button" className="primary" disabled={disabled || error !== null} onClick={() => { if (!error) onApply({ from: start ?? minDate, to: start ? end ?? start : null }); }}>Apply</button></div>
  </section>;
}
