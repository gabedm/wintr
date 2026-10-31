import type { Handle } from '../shared/records.js';

/** URL contains an opaque selector only, never a title, draft or credential. */
export function chatFromLocation(): Handle | null {
  const values = new URL(window.location.href).searchParams.getAll('chat');
  return values.length === 1 && /^[A-Za-z0-9_-]{24}$/.test(values[0]!) ? values[0] as Handle : null;
}

export function writeChatLocation(chat: Handle | null, replace = false): void {
  const url = new URL(window.location.href);
  if (chat) url.searchParams.set('chat', chat); else url.searchParams.delete('chat');
  const next = url.pathname + url.search + url.hash;
  if (next === window.location.pathname + window.location.search + window.location.hash) return;
  if (replace) window.history.replaceState(null, '', next);
  else window.history.pushState(null, '', next);
}
