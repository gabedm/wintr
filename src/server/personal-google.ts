import { Impersonated, UserRefreshClient, type AuthClient } from 'google-auth-library';
import { ServerSecret } from './providers/secret.js';
import { ownData, PersonalSetupError, type PersonalProfile } from './personal-profile.js';

export interface PersonalGoogleCredential { readonly clientId: string; readonly clientSecret: ServerSecret; readonly refreshToken: ServerSecret }
/** Accept only the explicit gcloud impersonation format. No file/URL/default-account discovery. */
export function parsePersonalGoogleCredential(raw: unknown, profile: PersonalProfile): PersonalGoogleCredential {
  const a = ownData(raw, ['type', 'service_account_impersonation_url', 'source_credentials'], ['delegates', 'quota_project_id', 'universe_domain', 'service_account_impersonation']);
  const expected = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${profile.runtimeServiceAccount}:generateAccessToken`;
  if (a.type !== 'impersonated_service_account' || a.service_account_impersonation_url !== expected ||
      (a.quota_project_id !== undefined && a.quota_project_id !== profile.quotaProjectId) ||
      (a.universe_domain !== undefined && a.universe_domain !== 'googleapis.com') ||
      (a.delegates !== undefined && (!Array.isArray(a.delegates) || Reflect.ownKeys(a.delegates).join(',') !== 'length')) || a.service_account_impersonation !== undefined) throw new PersonalSetupError('sign_in_required');
  const s = ownData(a.source_credentials, ['type', 'client_id', 'client_secret', 'refresh_token'], ['quota_project_id', 'universe_domain', 'account']);
  if (s.type !== 'authorized_user' || typeof s.client_id !== 'string' || !/^[A-Za-z0-9_-]{5,200}\.apps\.googleusercontent\.com$/.test(s.client_id) ||
      (s.quota_project_id !== undefined && s.quota_project_id !== profile.quotaProjectId) ||
      (s.universe_domain !== undefined && s.universe_domain !== 'googleapis.com') ||
      (s.account !== undefined && (typeof s.account !== 'string' || s.account.length > 254 || /[\r\n\0]/.test(s.account))) ||
      typeof s.client_secret !== 'string' || typeof s.refresh_token !== 'string') throw new PersonalSetupError('sign_in_required');
  try { return Object.freeze({ clientId: s.client_id, clientSecret: new ServerSecret(s.client_secret), refreshToken: new ServerSecret(s.refresh_token) }); }
  catch { throw new PersonalSetupError('sign_in_required'); }
}

class ApprovedImpersonated extends Impersonated {
  constructor(credential: PersonalGoogleCredential, profile: PersonalProfile, private readonly check: () => void) {
    const source = new UserRefreshClient({ clientId: credential.clientId, clientSecret: credential.clientSecret.reveal(), refreshToken: credential.refreshToken.reveal(), forceRefreshOnFailure: false });
    source.quotaProjectId = profile.quotaProjectId;
    super({ sourceClient: source, targetPrincipal: profile.runtimeServiceAccount, delegates: [], lifetime: 3600,
      targetScopes: ['https://www.googleapis.com/auth/cloud-platform'], endpoint: 'https://iamcredentials.googleapis.com', forceRefreshOnFailure: false, universeDomain: 'googleapis.com' });
    this.quotaProjectId = profile.quotaProjectId;
    // Check again between OAuth refresh and impersonation. The SDK's built-in
    // IAM retry policy must not turn a revoked connection into another request.
    const endpoints = new Set(['https://oauth2.googleapis.com/token', `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${profile.runtimeServiceAccount}:generateAccessToken`]);
    source.transporter.interceptors.request.add({ resolved: async options => {
      check(); if (!endpoints.has(String(options.url))) throw new PersonalSetupError('sign_in_required');
      options.retry = false; options.maxRedirects = 0; options.timeout = 15000; return options;
    } });
    source.transporter.interceptors.response.add({ resolved: async response => { check(); return response; } });
  }
  override async getRequestHeaders(url?: string | URL) {
    this.check();
    try { const headers = await super.getRequestHeaders(url); this.check(); return headers; }
    catch { throw new PersonalSetupError('sign_in_required'); }
  }
}

export interface PersonalGoogleIdentity { readonly client: AuthClient; accessToken(): Promise<ServerSecret>; close(): void }
/** Automatic refresh is identity work only. Model/Qloo transports keep zero automatic retries. */
export function createPersonalGoogleIdentity(credential: PersonalGoogleCredential, profile: PersonalProfile, checkAuthority: () => void,
  createClient: (credential: PersonalGoogleCredential, profile: PersonalProfile, check: () => void) => AuthClient = (c, p, check) => new ApprovedImpersonated(c, p, check)): PersonalGoogleIdentity {
  let closed = false;
  const check = () => { if (closed) throw new PersonalSetupError('setup_changed'); checkAuthority(); };
  check(); const client = createClient(credential, profile, check); check();
  return Object.freeze({ client,
    async accessToken() {
      check();
      try { const result = await client.getAccessToken(); check(); if (typeof result.token !== 'string') throw new Error(); return new ServerSecret(result.token); }
      catch { throw new PersonalSetupError('sign_in_required'); }
    },
    close() { closed = true; client.credentials = {}; },
  });
}
