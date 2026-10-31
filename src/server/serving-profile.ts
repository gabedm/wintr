import { isIP } from 'node:net';
import { loopbackBaseConfigProblem, type Config } from './config.js';

/** Explicit future TLS-terminating host configuration, never inferred from requests or environment. */
export interface HostedServing {
  readonly profile: 'https_proxy_v1';
  readonly publicOrigin: string;
  readonly listenHost: '127.0.0.1' | '::1' | '0.0.0.0' | '::';
  readonly listenPort: number;
}
export type ServingProblem = 'shape' | 'profile' | 'origin' | 'listen_host' | 'listen_port';
const LISTEN_HOSTS = new Set(['127.0.0.1', '::1', '0.0.0.0', '::']);
const KEYS = ['listenHost', 'listenPort', 'profile', 'publicOrigin'];
const CONFIG_KEYS = ['dev', 'freeMutation', 'host', 'hostHeader', 'maxJourneysPerSession', 'maxSessions',
  'mode', 'origin', 'port', 'secureCookie', 'syntheticDelayMs'];
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Capture own data properties once. Accessors, symbols and hidden extra keys never become authority. */
function dataFields(raw: unknown, expected: readonly string[]): Record<string, unknown> | null {
  if (!plain(raw)) return null;
  const keys = Reflect.ownKeys(raw);
  if (keys.some(key => typeof key !== 'string') || (keys as string[]).sort().join(',') !== expected.join(',')) return null;
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const copy: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

/** Closed, canonical HTTPS origin; no DNS request, forwarded-header authority or silent URL normalisation. */
export function parseHostedServing(raw: unknown): { ok: true; serving: HostedServing } | { ok: false; problem: ServingProblem } {
  try { return readHostedServing(raw); } catch { return { ok: false, problem: 'shape' }; }
}
function readHostedServing(raw: unknown): { ok: true; serving: HostedServing } | { ok: false; problem: ServingProblem } {
  raw = dataFields(raw, KEYS);
  if (!plain(raw)) return { ok: false, problem: 'shape' };
  if (raw.profile !== 'https_proxy_v1') return { ok: false, problem: 'profile' };
  if (typeof raw.publicOrigin !== 'string' || raw.publicOrigin.length > 2048) return { ok: false, problem: 'origin' };
  try {
    const u = new URL(raw.publicOrigin);
    const hostname = u.hostname;
    const labels = hostname.split('.');
    if (u.protocol !== 'https:' || raw.publicOrigin !== u.origin || u.username || u.password || (u.port !== '' && Number(u.port) < 1) ||
      isIP(hostname.replace(/^\[|\]$/g, '')) !== 0 || hostname.length > 253 || labels.length < 2 ||
      !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !/^[a-z][a-z0-9-]*$/.test(labels.at(-1)!) || /\.(?:localhost|local|internal)$/.test(hostname)) {
      return { ok: false, problem: 'origin' };
    }
  } catch { return { ok: false, problem: 'origin' }; }
  if (typeof raw.listenHost !== 'string' || !LISTEN_HOSTS.has(raw.listenHost)) return { ok: false, problem: 'listen_host' };
  if (typeof raw.listenPort !== 'number' || !Number.isSafeInteger(raw.listenPort) || raw.listenPort < 1 || raw.listenPort > 65535) {
    return { ok: false, problem: 'listen_port' };
  }
  return { ok: true, serving: Object.freeze({ profile: 'https_proxy_v1', publicOrigin: raw.publicOrigin,
    listenHost: raw.listenHost as HostedServing['listenHost'], listenPort: raw.listenPort }) };
}

const hostedConfigs = new WeakMap<object, HostedServing>();
/** Only the exact immutable object returned by the constructor qualifies; a spread/JSON clone does not. */
export function hostedServingOf(config: unknown): HostedServing | null {
  return typeof config === 'object' && config !== null ? hostedConfigs.get(config) ?? null : null;
}
export function sameHostedServing(a: HostedServing, b: HostedServing): boolean {
  return a.profile === b.profile && a.publicOrigin === b.publicOrigin && a.listenHost === b.listenHost && a.listenPort === b.listenPort;
}

/**
 * Prepares a disabled base only. It does not start a listener, load credentials,
 * contact any service or approve deployment. Live composition must independently
 * validate a matching `serving` field in the complete controller-owned binding.
 */
export function createHostedBaseConfig(base: Config, raw: unknown):
  { ok: true; config: Config } | { ok: false; problems: readonly string[] } {
  const parsed = parseHostedServing(raw);
  if (!parsed.ok) return { ok: false, problems: ['serving:' + parsed.problem] };
  let copy: Config;
  try {
    const captured = dataFields(base, CONFIG_KEYS);
    const freeMutation = captured && dataFields(captured.freeMutation, ['perService', 'perSession', 'windowMs']);
    if (!captured || !freeMutation) {
      return { ok: false, problems: ['config:invalid'] };
    }
    copy = structuredClone({ ...captured, freeMutation }) as unknown as Config;
  } catch { return { ok: false, problems: ['config:invalid'] }; }
  const problem = loopbackBaseConfigProblem(copy);
  if (problem) return { ok: false, problems: [problem] };
  const serving = parsed.serving;
  const config: Config = Object.freeze({ ...copy, host: serving.listenHost, port: serving.listenPort,
    origin: serving.publicOrigin, hostHeader: new URL(serving.publicOrigin).host,
    dev: false, secureCookie: true, freeMutation: Object.freeze(copy.freeMutation) });
  hostedConfigs.set(config, serving);
  return { ok: true, config };
}

/** Recheck the captured copy before loaders, in addition to the exact-object constructor capability. */
export function hostedConfigProblem(config: Config, serving: HostedServing): string | null {
  if (!plain(config) || Object.keys(config).sort().join(',') !== CONFIG_KEYS.join(',')) return 'config:invalid';
  if (config.mode !== 'disabled') return 'config:not_disabled_base';
  if (config.host !== serving.listenHost || config.port !== serving.listenPort) return 'config:listen_mismatch';
  if (config.origin !== serving.publicOrigin) return 'config:origin_mismatch';
  if (config.hostHeader !== new URL(serving.publicOrigin).host) return 'config:host_mismatch';
  if (config.secureCookie !== true) return 'config:cookie_mismatch';
  if (config.dev !== false) return 'config:dev_mode';
  return null;
}
