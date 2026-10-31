# Local Firestore integration tests

These optional tests use a local emulator and invented data. Normal tests do not start Firestore.

## Pinned tools

| Component | Required version |
| --- | --- |
| Node / pnpm | Repository `engines` and `packageManager`, installed with the lockfile |
| Existing Firestore server SDK | `9.3.1` (checked before client construction) |
| Existing Google auth library | `11.3.1` (checked before emulator construction) |
| Separately installed Firebase CLI | `15.34.1` |
| Java | JDK `21` or later |
| Official Firestore emulator JAR | `1.22.0` |
| JAR byte count | `136707194` |
| JAR SHA-256 | `9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c` |

The JAR pin comes from the [Firebase CLI 15.34.1 published manifest](https://github.com/firebase/firebase-tools/blob/v15.34.1/src/emulator/downloadableEmulatorInfo.json). Prepare Java, CLI and the verified official JAR outside the repository. No emulator binary, account file, downloaded tool or export belongs in Git. This target adds no application dependency and never installs tools automatically.

## Exact local boundary

The only supported target is `127.0.0.1:8089`, fictional project `demo-wintr-e05`, database `(default)`. The `demo-` project needs no Firebase account or real project; Firebase documents the [demo-project boundary and matching project IDs](https://firebase.google.com/docs/emulator-suite/connect_firestore#choose_a_firebase_project).

`firebase.e05.json` starts Firestore only, disables the UI and binds Firestore, its websocket (`9159`), the emulator hub (`4409`) and the optional logging listener (`4509`) to `127.0.0.1`. No import/export is configured. Its deny-all rules avoid exposing an unauthenticated client database; the server SDK tests use the emulator's administrative transport, so this is not Security Rules acceptance. The [pinned CLI source](https://github.com/firebase/firebase-tools/blob/v15.34.1/src/emulator/controller.ts) passes the Firestore host to its websocket listener too.

Before **any** SDK load or construction, the runner, explicit Vitest config and client factory require:

- `FIRESTORE_EMULATOR_HOST=127.0.0.1:8089` (no scheme, alias or alternate port).
- `GCLOUD_PROJECT=demo-wintr-e05`.
- `WINTR_E05_DATABASE=(default)`.
- Any supplied `GOOGLE_CLOUD_PROJECT`, `GCP_PROJECT`, CLI `FIREBASE_CONFIG` project/database or legacy emulator address must agree.
- `GOOGLE_API_USE_CLIENT_CERTIFICATE` must be absent or exactly `false`. `true` or any other supplied value is refused before SDK loading; the runner does not change global settings.

Missing or conflicting settings fail with a value-free error and nonzero exit. There is no skip, live endpoint fallback, implicit emulator start or synthetic replacement. The emulator-only factory supplies the public `PassThroughClient({projectId, universeDomain:'googleapis.com'})` as `authClient`, and also explicitly sets the SDK/GAX `universeDomain`. These options are checked against public SDK/GoogleAuth types. An exact endpoint and `ssl:false` alone were insufficient to prevent discovery in the initial run. Public-auth regression probes verify the configured universe/project/client without ADC; the SDK must operate without ambient credential discovery. The live credential/keyless factories still require their explicit authorised identity and never use PassThrough auth. [Firebase documents the scheme-free emulator environment](https://firebase.google.com/docs/emulator-suite/connect_firestore#admin_sdks). An unavailable emulator fails the target instead of earning acceptance. An empty test selection also fails.

## Supported Firebase-only orchestration

From the repository root, with the reviewed pinned tools already prepared, check `firebase --version` is exactly `15.34.1` and `java -version` reports Java 21+. Run in a disposable local shell without account credentials. PowerShell:

```powershell
$env:GCLOUD_PROJECT = 'demo-wintr-e05'
$env:WINTR_E05_DATABASE = '(default)'
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8089'
firebase emulators:exec --project demo-wintr-e05 --only firestore --config firebase.e05.json "pnpm test:emulator"
```

Do not add `--ui`, `--import`, `--export-on-exit`, Hosting, Functions or another project. The supported orchestration is **Firebase CLI `emulators:exec`**, which starts the configured emulator and stops it when the command exits. The [official CLI documentation](https://firebase.google.com/docs/emulator-suite/install_and_configure#startup) describes this lifecycle and notes that the non-Hosting emulators need no login. Ordinary `pnpm dev`, synthetic boot and live composition remain unchanged.

## Already running emulator

For a independently managed instance of the same pinned official JAR already listening on the exact loopback target/project, set the same three variables and run:

```powershell
pnpm typecheck:emulator
pnpm test:emulator
```

This command does not download, launch, stop or reconfigure that instance. A separately prepared official JAR must match the configured emulator version and target. Verify its version, fictional project and all listener bindings independently before running tests.

## What the integration target checks

`integration/firestore/store.emulator.test.ts` uses independent real SDK clients and actual emulator transactions for:

- Racing duplicate admissions, conflicting action keys, final reservation slots and one-use intent; instrumented stand-ins prove at most one send is admitted, with no provider call.
- Stop, Clear, session expiry and a delayed expired send grant blocking submission/late commit.
- Discarding and reconstructing SDK/Store objects while the emulator stays running, preserving unknown money/count holds and revocation.
- Recovery of a persisted orphaned running Attempt at its deadline, with one revision change and unchanged accounting.
- Actual SDK persistence of a bounded submission observation, including late accounting after Clear and client reconstruction without releasing held exposure.
- Actual Timestamp/Date conversion, separate complete content documents and cross-client reconstruction.
- Database-side query filtering/limits and invalid query rejection.
- Owned close draining an actual SDK transaction and rejecting Store operations before SDK entry after closure, with idempotent SDK termination. Use the managed shutdown boundary rather than terminating a client during active work.

Each case uses a fresh random service namespace and generated owned handles. The harness records the **exact document paths it writes** and teardown deletes only those paths in bounded transactions through a separately owned pinned client, then closes it through the same managed seam. It never scans or flushes the project, calls an emulator reset endpoint, recursively deletes a collection or imports/exports data. Interrupted runs can leave invented records; they do not justify bulk deletion of unknown data. The next run has a new namespace.

## Application lifecycle ownership

`createOwnedFirestoreDocStore` transfers exclusive termination responsibility to a managed capability. Its owner must not call `terminate()` independently or start raw SDK work alongside managed work during shutdown. `close()` immediately rejects new operations; transaction/read results that cross closure are withheld, admitted operations drain, and SDK termination runs once. A physical database commit already authorised and submitted before closure may finish while draining; close is not a rollback, settlement or refund. Hung underlying SDK work can delay draining; there is no forced unsafe termination shortcut.

The official credential/keyless factories return this managed capability to `composeLiveRuntime`. `runtime.close()` synchronously revokes the handler/provider gate and aborts current local attempts before awaiting DocStore drain/release. `startLiveServer.close()` and expiry use that seam. A closed exact runtime cannot restart; the existing recognised-runtime/binding checks remain in place. Each exact runtime has one listen attempt, claimed before listening yields; duplicate attempts cannot revoke a healthy server. Stop and Clear retain their own immediate authority paths and never wait for SDK termination. No closure changes money/count reservations or clears unresolved intent.

`createFirestoreDocStore` alone is explicitly a **borrowed** compatibility adapter. Existing structural fake factories may keep lending clients to live-composition tests: runtime closure gates their Store operations but does not terminate a client owned elsewhere. An operator supplying a raw client retains its lifetime responsibility; controlled SDK shutdown uses the managed factory/capability, not raw use-after-terminate.

Default `pnpm test` includes only `tests/` and explicitly excludes `integration/`. Its preflight checks use loader probes, never the actual emulator SDK. `pnpm typecheck:emulator` checks the opt-in TypeScript without connecting. SDK-shaped fake fault tests remain separate: they cover deterministic lost acknowledgements, callback delays and transient failures that this target does not manufacture in the official emulator.

Record the exact checkout, pinned versions, command, case counts and result after execution. A successful emulator run would establish local SDK/store compatibility for these cases; it would not prove production provisioning, billing settlement, musical usefulness, devices or device acceptance. If the actual SDK exposes an application defect, report it for a bounded correction before changing application code.
