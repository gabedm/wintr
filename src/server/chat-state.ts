import type { Handle, Session, ChatSummary } from '../shared/records.js';
import { LIMITS } from '../shared/records.js';

// Only a bounded directory and record handles live in the session root. Model
// output remains in its existing individual owned records/content documents.
export const CHAT_LIMIT = 20;
export const CHAT_TITLE_LIMIT = 80;
export const CHAT_CLEANUP_KINDS = ['journey', 'analysis', 'analysistext', 'attempt', 'brief', 'search', 'checkpoint', 'pool', 'plan', 'panel', 'panelcontent', 'feedback', 'capture'] as const;
export const MANIFEST_KEYS = ['journey', 'analysis', 'attempt', 'briefs', 'searches', 'checkpoints', 'pools', 'plans', 'panels', 'feedback', 'captures'] as const;
export interface ChatManifest {
  captures?: string[];
  journey: string | null;
  analysis: string | null;
  attempt: string | null;
  briefs: string[];
  searches: string[];
  checkpoints: string[];
  pools: string[];
  plans: string[];
  panels: string[];
  feedback: string[];
}
export interface ChatEntry extends ChatSummary { manifest: ChatManifest }
export interface ChatState {
  revision: number;
  /** Once null, the legacy primary chat is deleted for this Session forever. */
  primary: ChatSummary | null;
  others: ChatEntry[];
  /** Id-only receipts, already inaccessible, awaiting physical deletion. */
  cleanup: string[];
}
export const emptyManifest = (): ChatManifest => ({ journey: null, analysis: null, attempt: null, briefs: [], searches: [], checkpoints: [], pools: [], plans: [], panels: [], feedback: [] });
export const initialChat = (session: Session): ChatSummary => ({ handle: session.id, title: 'New chat', createdAt: session.createdAt, revision: 0 });
export const initialChatState = (session: Session): ChatState => ({ revision: 0, primary: initialChat(session), others: [], cleanup: [] });
export const chatItems = (state: ChatState | undefined, session: Session): ChatSummary[] => state
  ? [...(state.primary ? [state.primary] : []), ...state.others.map(({ manifest: _, ...item }) => item)]
  : [initialChat(session)];
export const manifestCount = (m: ChatManifest) => MANIFEST_KEYS.reduce((n, key) => n + (Array.isArray(m[key]) ? (m[key] as string[]).length : m[key] ? 1 : 0), 0);
export function manifestIds(m: ChatManifest): string[] {
  return [
    ...(m.journey ? [`journey_${m.journey}`] : []), ...(m.analysis ? [`analysis_${m.analysis}`, `analysistext_${m.analysis}`] : []),
    ...(m.attempt ? [`attempt_${m.attempt}`] : []), ...m.briefs.map(h => `brief_${h}`), ...m.searches.map(h => `search_${h}`),
    ...m.checkpoints.map(h => `checkpoint_${h}`), ...m.pools.map(h => `pool_${h}`), ...m.plans.map(h => `plan_${h}`),
    ...m.panels.flatMap(h => [`panel_${h}`, `panelcontent_${h}`]), ...m.feedback.map(h => `feedback_${h}`), ...(m.captures ?? []).map(h => `capture_${h}`),
  ];
}
export function manifestOf(source: ChatManifest): ChatManifest {
  return Object.fromEntries(MANIFEST_KEYS.filter(k => k !== 'captures' || Object.hasOwn(source, k)).map(k => [k, source[k]])) as unknown as ChatManifest;
}
export const validChatTitle = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= CHAT_TITLE_LIMIT && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v);

const handle = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v);
const safe = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const summary = (v: unknown, session: Session): v is ChatSummary => exact(v, ['handle', 'title', 'createdAt', 'revision']) && handle(v.handle) && validChatTitle(v.title) && safe(v.createdAt) && v.createdAt >= session.createdAt && v.createdAt < session.expiresAt && safe(v.revision);

/** Strict legacy-or-extension parsing; never coerce a partial chat state. */
export function parseChatState(raw: unknown, session: Session, primary: ChatManifest): ChatState {
  if (!exact(raw, ['revision', 'primary', 'others', 'cleanup']) || !safe(raw.revision) || !Array.isArray(raw.others) || !Array.isArray(raw.cleanup)) throw new Error('invalid chat state');
  if (raw.primary !== null && (!summary(raw.primary, session) || raw.primary.handle !== session.id)) throw new Error('invalid primary chat');
  if (raw.primary === null && manifestCount(primary) !== 0) throw new Error('deleted primary manifest');
  if (raw.others.length + (raw.primary ? 1 : 0) > CHAT_LIMIT || raw.cleanup.length > 256 || raw.cleanup.some(v => typeof v !== 'string' || !/^[a-z]{4,16}_[A-Za-z0-9_-]{16,64}$/.test(v) || !(CHAT_CLEANUP_KINDS as readonly string[]).includes(v.slice(0, v.indexOf('_'))))) throw new Error('invalid chat bound');
  const ids = new Set([session.id]);
  const records = new Set(manifestIds(primary));
  let count = manifestCount(primary) + (raw.primary ? 1 : 0) + raw.cleanup.filter(id => !(id as string).startsWith('analysistext_') && !(id as string).startsWith('panelcontent_')).length;
  let briefs = primary.briefs.length + raw.cleanup.filter(id => (id as string).startsWith('brief_')).length;
  for (const entry of raw.others) {
    if (!exact(entry, ['handle', 'title', 'createdAt', 'revision', 'manifest'])) throw new Error('invalid chat entry');
    const { manifest, ...item } = entry;
    const keys = manifest && typeof manifest === 'object' && Object.hasOwn(manifest, 'captures') ? MANIFEST_KEYS : MANIFEST_KEYS.filter(k => k !== 'captures');
    if (!summary(item, session) || ids.has(item.handle) || !exact(manifest, keys)) throw new Error('invalid chat entry');
    ids.add(item.handle);
    for (const k of MANIFEST_KEYS) {
      if (k === 'captures' && !Object.hasOwn(manifest, k)) continue;
      const v = manifest[k];
      if (['journey', 'analysis', 'attempt'].includes(k)) { if (v !== null && !handle(v)) throw new Error('invalid chat pointer'); }
      else if (!Array.isArray(v) || v.length > LIMITS.liveRecordsPerSession || v.some(h => !handle(h)) || new Set(v).size !== v.length) throw new Error('invalid chat handles');
    }
    const m = manifest as unknown as ChatManifest;
    for (const id of manifestIds(m)) { if (records.has(id)) throw new Error('shared chat record'); records.add(id); }
    count += 1 + manifestCount(m); briefs += m.briefs.length;
  }
  if (count > LIMITS.liveRecordsPerSession || briefs > LIMITS.briefVersionsPerSession || new Set(raw.cleanup).size !== raw.cleanup.length || raw.cleanup.some(id => records.has(id))) throw new Error('invalid aggregate chat bound');
  return structuredClone(raw) as unknown as ChatState;
}

export type ChatChange = { kind: 'create' } | { kind: 'rename'; chat: Handle; title: string; expectedRevision: number } | { kind: 'delete'; chat: Handle; expectedRevision: number };
export type ChatChangeResult = { kind: 'ok' | 'replay'; chat: Handle | null; revokedAttemptId: Handle | null } | { kind: 'rejected'; code: 'no_session' | 'not_found' | 'stale_version' | 'action_conflict' | 'capacity' | 'rate_limited' | 'unavailable' };
