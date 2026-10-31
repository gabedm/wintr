import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatDirectory, Handle } from '../shared/records.js';
import { Appear } from './conversation-motion.js';
import { DECOR } from './decor.js';

export interface ChatSidebarProps {
  readonly privacyKey: string;
  readonly directory: ChatDirectory | null;
  readonly busy: boolean;
  readonly navigationBlocked: boolean;
  readonly expired?: boolean;
  readonly onNew: () => void;
  readonly onSelect: (chat: Handle) => void;
  readonly onRename: (chat: Handle, title: string, revision: number) => Promise<boolean>;
  readonly onDelete: (chat: Handle, revision: number) => void;
}

/** Recent chats inside a rounded left drawer. */
export function ChatSidebar(p: ChatSidebarProps) {
  const [options, setOptions] = useState<Handle | null>(null);
  const [editing, setEditing] = useState<Handle | null>(null);
  const [title, setTitle] = useState('');
  const input = useRef<HTMLInputElement>(null), section = useRef<HTMLElement>(null), returnFocus = useRef<Handle | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useLayoutEffect(() => {
    if (editing) { input.current?.focus({ preventScroll: true }); input.current?.select(); }
    else if (returnFocus.current) {
      const button = section.current?.querySelector<HTMLElement>(`[data-chat-options="${returnFocus.current}"]`);
      (button ?? section.current?.querySelector<HTMLElement>('[data-new-chat]'))?.focus({ preventScroll: true });
      returnFocus.current = null;
    }
  }, [editing]);
  const cancelRename = () => { returnFocus.current = editing; setEditing(null); setTitle(''); };
  return <section ref={section} className="chat-sidebar" aria-label="Chats in this session">
    <button type="button" className="new-chat-action" data-new-chat disabled={p.busy || p.navigationBlocked} onClick={p.onNew}>
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      New chat
    </button>
    <h3 className="recent-label">Recent chats</h3>
    {p.directory?.items.length ? <ul className="chat-list">{[...p.directory.items].reverse().map(chat => <li key={chat.handle}>
      {editing === chat.handle ? <form className="chat-rename" onSubmit={event => {
        event.preventDefault();
        const value = title.trim();
        if (!value || p.busy) return;
        section.current?.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
        void p.onRename(chat.handle, value, chat.revision).then(ok => { if (ok && live.current) cancelRename(); });
      }}>
        <label htmlFor="chat-rename">Chat name</label>
        <input ref={input} id="chat-rename" maxLength={80} value={title} onChange={event => setTitle(event.target.value)} disabled={p.busy} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelRename(); } }} />
        <div className="chat-row-actions"><button type="submit" disabled={p.busy || !title.trim()}>Save name</button><button type="button" disabled={p.busy} onClick={cancelRename}>Cancel</button></div>
      </form> : <>
        <div className="chat-row">
          <button type="button" className="chat-select" aria-current={p.directory?.current === chat.handle ? 'page' : undefined} disabled={p.navigationBlocked} onClick={() => p.onSelect(chat.handle)}>{chat.title}</button>
          <button type="button" className="chat-options" data-chat-options={chat.handle} aria-label={`Options for ${chat.title}`} aria-expanded={options === chat.handle} disabled={p.busy} onClick={() => setOptions(options === chat.handle ? null : chat.handle)}><span aria-hidden="true">···</span></button>
        </div>
        {options === chat.handle && <div className="chat-row-actions" aria-label={`Manage ${chat.title}`}>
          <button type="button" disabled={p.busy || p.navigationBlocked} onClick={() => { setTitle(chat.title); setEditing(chat.handle); }}>Rename</button>
          <button type="button" disabled={p.busy} onClick={() => { setOptions(null); p.onDelete(chat.handle, chat.revision); }}>Delete chat</button>
        </div>}
      </>}
    </li>)}</ul> : <Appear className="chat-empty" play={p.expired === true} enterMs={DECOR.settled.enterMs} y={0}>
      <p>{p.expired ? 'Your chats have cleared.' : 'Your chats will appear here.'}</p>
      {p.expired && <p className="support">Chats stay for one hour.</p>}
    </Appear>}
  </section>;
}
