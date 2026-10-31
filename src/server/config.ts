// Ordinary CLI configuration stays disabled or labelled synthetic on loopback.
// Controller-only composition requires separate explicit provider/store/source
// and exposure bindings. No environment flag promotes this config to live.

/**
 * 'live' is never produced by loadConfig (CLI/environment): only the
 * server-only live composition (live-runtime.ts) can create it, from an
 * explicit validated controller binding.
 */
export type ServerMode = 'disabled' | 'synthetic' | 'live';

export interface Config {
  readonly mode: ServerMode;
  readonly host: string;
  readonly port: number;
  /** Exact browser Origin accepted for mutations. */
  readonly origin: string;
  /** Exact Host header accepted (guards DNS rebinding). */
  readonly hostHeader: string;
  readonly dev: boolean;
  /** False only for isolated loopback development; the explicit HTTPS profile requires Secure cookies. */
  readonly secureCookie: boolean;
  readonly syntheticDelayMs: number;
  readonly maxSessions: number;
  readonly maxJourneysPerSession: number;
  /** Synthetic local free-mutation limiter (per session / service, fixed window). Not a live binding. */
  readonly freeMutation: { readonly perSession: number; readonly perService: number; readonly windowMs: number };
}

const LOOPBACK = new Set(['127.0.0.1', '::1']);

export class ConfigError extends Error {}

/** Exact agreement with the ordinary disabled loopback base, before any live loader. */
export function loopbackBaseConfigProblem(c: Config): string | null {
  if (c.mode !== 'disabled') return 'config:not_disabled_base';
  if (!LOOPBACK.has(c.host)) return 'config:not_loopback';
  if (!Number.isSafeInteger(c.port) || c.port < 1 || c.port > 65535) return 'config:port_invalid';
  const hostHeader = `${c.host.includes(':') ? `[${c.host}]` : c.host}:${c.port}`;
  if (c.hostHeader !== hostHeader) return 'config:host_mismatch';
  if (c.origin !== `http://${hostHeader}`) return 'config:origin_mismatch';
  if (c.secureCookie !== false) return 'config:cookie_mismatch';
  if (c.dev !== false) return 'config:dev_mode';
  return null;
}

export function loadConfig(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Config {
  const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const modeRaw = flag('mode') ?? env.WINTR_MODE ?? 'disabled';
  if (modeRaw === 'live') {
    throw new ConfigError(
      'Live mode is unavailable: controller-owned provider credentials, shared Firestore admission and exposure bindings are not configured in this build.',
    );
  }
  // Rejected settings may contain mistakenly pasted private material; never echo their values.
  if (modeRaw !== 'disabled' && modeRaw !== 'synthetic') throw new ConfigError('Unknown mode. Use disabled or synthetic.');

  const host = env.WINTR_HOST ?? '127.0.0.1';
  if (!LOOPBACK.has(host)) throw new ConfigError('This build only binds to a loopback address (127.0.0.1 or ::1).');
  const portRaw = env.WINTR_PORT ?? '8787';
  const port = Number(portRaw);
  if (!/^\d{1,5}$/.test(portRaw) || port < 1 || port > 65535) throw new ConfigError('WINTR_PORT must be 1-65535.');

  const hostHeader = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  return {
    mode: modeRaw,
    host,
    port,
    origin: `http://${hostHeader}`,
    hostHeader,
    dev: argv.includes('--dev'),
    secureCookie: false,
    syntheticDelayMs: 1500,
    maxSessions: 200,
    maxJourneysPerSession: 3,
    freeMutation: { perSession: 30, perService: 300, windowMs: 60_000 },
  };
}
