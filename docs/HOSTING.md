# Live setup with your own services

The repository provides a Node HTTP/WebSocket application and a Cloud Run-specific hosted entry. It includes no keys, private database or hosted service access. The synthetic preview in the README works without provider credentials; live setup is an operator/developer task.

## Requirements

1. Your own Google Cloud project, Firestore database and least-privilege runtime service account. Enable the Google services required by the selected Gemini/Vertex AI profiles and allow the runtime to access its Firestore records and model endpoints.
2. Your own Gemini Developer API and Qloo credentials. Check the model/API profiles in `src/server/providers/` against your account's available services. Ticketmaster is optional.
3. A stable record-sealing key, a canonical HTTPS origin and the complete configuration described below.

The current hosted entry uses Cloud Run's attached service identity and metadata server (`K_SERVICE`), not a downloaded service-account private key or a developer's Windows login. It will not run unchanged on a generic Node host such as Render. Adapting another platform requires its own identity/configuration integration.

## Build

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm build
docker build -t wintr .
```

The Dockerfile runs the compiled hosted entry as an unprivileged user. It serves the UI, API and WebSocket endpoint together. The image contains no runtime configuration or credentials.

The container pins its Node base image by digest and builds with `VITE_HOSTED_ARTWORK=placeholder`. Hosted Home and Library show neutral record-sleeve artwork while keeping verified Apple Music links; they do not load Apple cover images. The ordinary local build retains its existing artwork behaviour. This build flag is public UI configuration, not a credential.

## Configure the server

`deploy/runtime.example.json` describes the outer configuration: `bindings`, `serviceAccountEmail` and `storefront`. Its `bindings: null` is intentionally **not runnable**. Create your real file outside the repository, then mount it from Secret Manager and set `WINTR_RUNTIME_CONFIG_FILE` to the absolute mounted path.

The binding schema and validation are in [live-bindings.ts](../src/server/live-bindings.ts). Supply all required fields for your own installation:

- A stable service ID, symbolic runtime identity and settlement owner, binding version and future expiry.
- Your Firestore project/database and catalogue project/quota-project/identity reference.
- Secret references for Gemini, Qloo and sealing, the allowed Qloo host and `apple_music` recording service.
- The explicit live-listening model profile, source policy and durable exposure policy, including units, rates, bounds and concurrency. Match the exact adapter constants and declared limits; do not use synthetic pricing or copy test fixtures as production configuration.
- An `https_proxy_v1` serving profile with your final canonical HTTPS origin, listen host `0.0.0.0`, and a listen port matching the platform's `PORT`.

[source-policy.ts](../src/server/source-policy.ts), [policy.ts](../src/server/ledger/policy.ts), [serving-profile.ts](../src/server/serving-profile.ts) and [hosted-entry.ts](../src/server/hosted-entry.ts) define the additional validation. The hosted entry validates the complete configuration before loading live credentials. This export does not provide a production binding generator or a one-click live installer.

Inject these server-only values from Secret Manager:

| Variable | Value to supply |
| --- | --- |
| `WINTR_GEMINI_API_KEY` | Your Gemini Developer API key |
| `WINTR_QLOO_API_KEY` | Your Qloo API key |
| `WINTR_SEALING_KEY` | Your stable record-sealing secret |
| `WINTR_JUDGE_ACCESS_SHA256` | SHA-256 digest of your own random share-link token |
| `WINTR_TICKETMASTER_API_KEY` | Your concert API key, optional |

These values are read by the hosted entry, not automatically from `.env`. Never put them in a `VITE_` variable, build argument, image, public issue or tracked file. The runtime's `serviceAccountEmail` must match the attached Cloud Run identity. The entry deliberately refuses an ambient `GOOGLE_APPLICATION_CREDENTIALS` file.

## Database and access

The hosted startup requires an existing durable accounting domain. A new installation must explicitly provision its own policy/accounting state before startup. Inspect [ledger.ts](../src/server/ledger/ledger.ts) and the [persistence layer](../src/server/persistence/) when implementing that provisioning; the production entry does not automatically seed or reset allowances. Do not reuse another deployment's private ledger or regenerate a service namespace to bypass existing accounting.

The included hosted entry supports a random share link, `https://your-host/#access=TOKEN`. Generate a cryptographically random 32-byte base64url token locally and configure only its SHA-256 digest on the server. Keep the actual token outside Git. Link redemption creates a Secure, HttpOnly access cookie; individual visitors get separate music Sessions. Anyone holding the token can use the deployment.

Configure Cloud Run ingress/IAM so requests can reach the application gate; IAM-only ingress requires Google sign-in instead. Use HTTPS, support HTTP/1 WebSocket upgrades, allow a request timeout longer than the bounded 150-second work, and verify microphone permissions from a real phone. Do not enable request-body logging.

Before sharing, test the actual deployment's fresh-visitor journey, missing/invalid access, live capture, Stop/Clear, separate Sessions, Library persistence and concert failures. Build/test success does not establish hosted API access or recommendation quality. Check current provider terms, quotas, pricing and artwork/attribution requirements for your use.
