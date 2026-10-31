import type { Handle } from '../shared/records.js';

// Recovery only: opaque owner/chat handles, revision and nonce. Never store a
// title, draft, source, answer, cookie secret or snapshot in browser storage.
export interface ChatDeleteIntent {
  readonly id: string;
  readonly context: string;
  readonly chat: Handle;
  readonly revision: number;
}
export interface ChatIntentPort {
  list(): ChatDeleteIntent[];
  add(intent: ChatDeleteIntent): void;
  remove(id: string): void;
  changed(): void;
  subscribe(fn: () => void): () => void;
}
export const CHAT_INTENT_PREFIX = 'wintr.chat-delete.';
const CHANGE_KEY = 'wintr.chat-change';
const handle = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(v);
const valid = (v: unknown): v is ChatDeleteIntent => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 4 &&
  /^[0-9a-f]{16}$/.test((v as ChatDeleteIntent).id) && handle((v as ChatDeleteIntent).context) && handle((v as ChatDeleteIntent).chat) &&
  Number.isSafeInteger((v as ChatDeleteIntent).revision) && (v as ChatDeleteIntent).revision >= 0;

export function memoryChatIntents(): ChatIntentPort {
  const entries = new Map<string, ChatDeleteIntent>();
  return { list: () => [...entries.values()], add: intent => { entries.set(intent.id, intent); }, remove: id => { entries.delete(id); }, changed: () => {}, subscribe: () => () => {} };
}

export function browserChatIntents(): ChatIntentPort {
  const storage = () => { if (!globalThis.localStorage) throw new Error('storage unavailable'); return globalThis.localStorage; };
  return {
    list: () => {
      const s = storage(), entries: ChatDeleteIntent[] = [];
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i);
        if (key?.startsWith(CHAT_INTENT_PREFIX)) {
          const intent: unknown = JSON.parse(s.getItem(key) ?? 'null');
          if (!valid(intent) || key !== CHAT_INTENT_PREFIX + intent.id || entries.length >= 32) throw new Error('unreadable deletion reminder');
          entries.push(intent);
        }
      }
      return entries;
    },
    add: intent => {
      if (!valid(intent)) throw new Error('invalid deletion reminder');
      storage().setItem(CHAT_INTENT_PREFIX + intent.id, JSON.stringify(intent));
    },
    remove: id => storage().removeItem(CHAT_INTENT_PREFIX + id),
    changed: () => {
      // A storage event prompts a fresh read; this non-private stamp is never
      // read as authority, restored as history or used to resume provider work.
      storage().setItem(CHANGE_KEY, String(Date.now()));
      storage().removeItem(CHANGE_KEY);
    },
    subscribe: fn => {
      const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === CHANGE_KEY || e.key.startsWith(CHAT_INTENT_PREFIX)) fn(); };
      globalThis.addEventListener?.('storage', onStorage);
      return () => globalThis.removeEventListener?.('storage', onStorage);
    },
  };
}
