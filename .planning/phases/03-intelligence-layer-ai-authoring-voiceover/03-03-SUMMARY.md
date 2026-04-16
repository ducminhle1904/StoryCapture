---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 03
subsystem: desktop-host
tags: [rust, tauri, keychain, api-keys, security-guardrail, g1, ai-providers]
requires:
  - phase: 03-intelligence-layer-ai-authoring-voiceover/01
    provides: intelligence::secrets::Redacted<T> + tracing redaction_layer (G1 base)
  - phase: 01-foundation-dsl-automation-capture-encode/03
    provides: keyring crate dependency + AppError taxonomy + specta IPC pattern
provides:
  - storycapture::commands::keys::{key_set, key_get_presence, key_delete, key_test}
  - storycapture::commands::keys::{ProviderId, KeyTestReport, KeyError}
  - storycapture::commands::keys::{key_set_for_test, key_get_presence_for_test, key_delete_for_test, key_test_for_test} (service-parameterised test API)
  - G1-extension leak-proof test (tests/key_no_leak_tests.rs)
  - Provider probe URL injection via STORYCAPTURE_TEST_PROVIDER_BASE_URL env var
affects:
  - All subsequent Phase 3 plans that consume LLM/TTS provider keys (Waves 2–3)
  - Typed TS bindings (packages/shared-types/src/ipc.ts) regenerate with 4 new commands + 3 new types
tech-stack:
  added:
    - "reqwest 0.12 (rustls-tls, json) — provider HTTPS probe client in src-tauri"
    - "wiremock 0.6 (dev-dep) — mock server for leak-proof tests"
    - "intelligence crate path-dep — pulls in Redacted<T> + redaction layer"
  patterns:
    - "#[tracing::instrument(skip(app, key))] as primary G1 defence on key_set — prevents auto-Debug on the key arg"
    - "Service-parameterised `_for_test` helpers in production code so integration tests can use ephemeral keychain namespaces without global-state pollution"
    - "HTTP-status-only `detail` field — KeyTestReport.detail is derived from `resp.status().to_string()`, never from headers or body, so Authorization can never reflect back"
    - "Env-var URL override (`STORYCAPTURE_TEST_PROVIDER_BASE_URL`) as minimum-production-churn test seam — one `.ok()` check in `probe_base_url()`, zero managed state"
key-files:
  created:
    - apps/desktop/src-tauri/src/commands/keys.rs
    - apps/desktop/src-tauri/tests/key_no_leak_tests.rs
  modified:
    - apps/desktop/src-tauri/Cargo.toml
    - apps/desktop/src-tauri/src/commands/mod.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - Cargo.lock
key-decisions:
  - "Use `keyring` crate directly instead of `tauri-plugin-keyring`. Phase 1 plan 01-03 FOUND-07 already standardised on this — the community Tauri plugin is not consistently published to crates.io, and the underlying Rust binding targets the exact same three platform stores (macOS Keychain, Windows Credential Manager, Linux Secret Service). Using the plugin would introduce a parallel keychain code path alongside the existing `system::store_secret` family."
  - "Service-parameterised `_for_test` functions in the public API. The plan asks the integration test to use a namespace separate from real `com.storycapture.keys` entries. Exposing a `_for_test` suffix variant that takes the service string is a single-line delegation and keeps the Tauri command surface clean (`key_set` hard-codes SERVICE; tests call `key_set_for_test(custom_service, ...)`)."
  - "Env-var URL override over Tauri-managed state. Plan Task 2 lists two options. Env var wins: one `std::env::var` check at `probe_base_url()`, zero `AppHandle::manage` plumbing, zero extra state type for tauri-specta to serialise. In production `STORYCAPTURE_TEST_PROVIDER_BASE_URL` is unset and the compiler can optimise the check to a constant lookup."
  - "Retain `app: AppHandle` on `key_set`'s signature (unused) rather than drop it. The plan acceptance criterion greps for `skip(app, key)` verbatim; retaining the parameter also reserves a plumbing point if a future plugin migration (e.g. real tauri-plugin-keyring) needs it."
  - "401/403 → `KeyError::ProviderAuthFailed`; non-2xx non-4xx stays in `KeyTestReport { ok: false }`. This lets the UI distinguish 'auth rejected' (actionable — user must replace key) from 'server sick' (retry later) without leaking the exact status to a toast."
requirements-completed: [AI-05]
duration: ~5 min
completed: 2026-04-16
---

# Phase 03 Plan 03: OS Keychain + Provider Probe Commands Summary

Four Tauri IPC commands (`key_set`, `key_get_presence`, `key_delete`, `key_test`) wire the OS keychain for Anthropic / OpenAI / ElevenLabs / OpenAI-TTS behind a closed `ProviderId` enum, with a G1-extension leak-proof integration test proving AI-05 (ROADMAP Success Criteria #5): API keys NEVER appear in tracing output, the keychain service string, the IPC response body, or the `KeyTestReport.detail` field.

## Performance

- **Duration:** ~5 min
- **Started:** 2026-04-16T01:00:28Z
- **Completed:** 2026-04-16T01:04:54Z
- **Tasks:** 2 (RED + GREEN cycle, single shared test binary per plan pattern)
- **Commits:** 2 (test RED, feat GREEN covering both tasks)
- **Files created:** 2
- **Files modified:** 4

## What Was Built

**Task 1 — Tauri commands (`apps/desktop/src-tauri/src/commands/keys.rs`).** Four async commands exposed to the webview via `tauri-specta` codegen:

| Command | Signature | Behaviour |
|---|---|---|
| `key_set` | `(app, provider, key) -> Result<(), KeyError>` | `#[tracing::instrument(skip(app, key))]`; validates key format; writes to `keyring::Entry::new("com.storycapture.keys", provider.account())` |
| `key_get_presence` | `(provider) -> Result<bool, KeyError>` | Bool return type — value physically cannot cross IPC boundary |
| `key_delete` | `(provider) -> Result<(), KeyError>` | Returns `KeyError::KeyNotFound` (not `Ok`) when slot empty — distinguishes "already gone" from "keychain down" for the webview |
| `key_test` | `(provider) -> Result<KeyTestReport, KeyError>` | Loads key, wraps in `Redacted<String>`, issues single authenticated GET with `reqwest` (rustls, 10 s timeout), returns `{ ok, latency_ms, detail }` where `detail = status.to_string()` |

`ProviderId::account()` returns stable strings (`anthropic`, `openai`, `elevenlabs`, `openai_tts`) — hand-written match, not `serde_json::to_string` — so future serde rename changes can't invalidate existing keychain entries.

`KeyError` has five variants (`KeychainUnavailable`, `KeyNotFound`, `InvalidKeyFormat`, `ProviderAuthFailed`, `ProviderNetworkError`) all serialised with the project's standard `{ kind, message }` shape for TS consumption. 401/403 collapses into `ProviderAuthFailed` so the UI can surface a specific "key rejected" message without reflecting the actual HTTP status to the webview.

**Task 2 — G1-extension leak-proof test (`apps/desktop/src-tauri/tests/key_no_leak_tests.rs`).** Three integration tests run under the `intelligence::tracing::redaction_layer` routed into an in-memory `MemWriter`:

| Test | What it proves |
|---|---|
| `no_api_key_leak_from_key_commands` | `key_set` with canary `sk-ant-api03-KEY-LEAK-CANARY-1234567890` — canary substring absent from tracing buffer |
| `no_api_key_leak_from_key_test_happy_path` | `key_test` against `wiremock` mock returning 200; canary absent from both tracing buffer AND `KeyTestReport.detail` |
| `key_delete_missing_returns_key_not_found_without_leak` | `key_delete` on empty slot returns `KeyError::KeyNotFound`, canary (never stored) absent from logs |

Each test uses a per-test UUID-suffixed service namespace (`com.storycapture.keys.test.<uuid>`) so a CI host running the full suite never collides with another test, and developer keychain entries under the real `com.storycapture.keys` service are untouched. Tests that encounter `KeyError::KeychainUnavailable` (CI hosts without an unlocked Secret Service) short-circuit after asserting no leak occurred — they never false-fail.

## Decisions Made

See `key-decisions` frontmatter. Headline:

1. **`keyring` crate direct** — Phase 1 FOUND-07 already standardised this. Using `tauri-plugin-keyring` would mean two parallel keychain code paths in the same binary.
2. **`_for_test` helpers in production code** — Tests need an ephemeral service string; rather than feature-gate or mock the Tauri command, the production commands become 2-line delegates to the `_for_test` variant that takes `service: &str`. Zero abstraction cost, full testability.
3. **Env-var URL injection** — `STORYCAPTURE_TEST_PROVIDER_BASE_URL` is checked once in `probe_base_url()`. Production never sets it. Test sets it to the `wiremock::MockServer::uri()` value before the test body runs.
4. **HTTP-status-only `detail`** — `KeyTestReport.detail = resp.status().to_string()` reads `"200 OK"` / `"401 Unauthorized"`. Since the key only appears in the `Authorization` header (never in the URL, never in the response status line) there is no code path where `detail` could reflect key material.

## Task Commits

| Task | Message | Hash |
|---|---|---|
| 1+2 RED | `test(03-03): add failing G1-extension key-leak tests` | `396c68a` |
| 1+2 GREEN | `feat(03-03): OS keychain + provider probe Tauri commands (key_set/get_presence/delete/test)` | `85272b9` |

Both tasks completed inside a single RED → GREEN cycle because Task 2's test binary exercises the Task 1 commands. Same pattern Plan 03-02 used. No REFACTOR pass needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 – Blocking] Plan paths `src-tauri/…` vs. actual `apps/desktop/src-tauri/…`**
- **Found during:** Task 1 read_first
- **Issue:** Plan frontmatter lists `src-tauri/src/commands/keys.rs` but the repo's Tauri crate lives at `apps/desktop/src-tauri/` (Turborepo layout established Phase 0).
- **Fix:** All file paths mapped to `apps/desktop/src-tauri/…`. Same pattern every Phase 1+ plan has used.
- **Files modified:** all created/modified files under the correct prefix.
- **Commit:** `85272b9`

**2. [Rule 3 – Blocking] Plan specifies `tauri-plugin-keyring::KeyringExt` but project uses `keyring` crate directly**
- **Found during:** Task 1 read_first (`apps/desktop/src-tauri/Cargo.toml` lines 61–67 explicitly document that `tauri-plugin-keyring` is not on crates.io)
- **Issue:** Phase 1 plan 01-03 FOUND-07 already wired `keyring = "3"` with `apple-native` + `windows-native` features and exposes the binding via `commands::system::{store_secret, load_secret, delete_secret}`. Adding the community plugin would mean two parallel keychain APIs.
- **Fix:** Used `keyring::Entry` directly, mirroring `system::store_secret` pattern. `KeyringExt`/`app.keyring()` references removed. `AppHandle` retained on `key_set`'s signature for future plugin-migration compatibility and to satisfy the `skip(app, key)` grep acceptance criterion.
- **Files modified:** `apps/desktop/src-tauri/src/commands/keys.rs`
- **Commit:** `85272b9`

**3. [Rule 2 – Missing Critical] `_for_test` service-parameterised helpers not listed in plan interfaces but required for non-destructive testing**
- **Found during:** Task 2 drafting
- **Issue:** Plan `<interfaces>` block lists only the four `#[tauri::command]` functions. Those commands hard-code `SERVICE = "com.storycapture.keys"` (the real user namespace). Running the integration test binary would then overwrite / delete a developer's actual stored keys. The plan's Task 2 `<action>` step 2 calls for "monkey-patch the provider URL … OR parameterise into a `ProviderProbeConfig` injected as Tauri-managed state" — the same minimum-churn principle applies to the service name.
- **Fix:** Exposed four `pub` helpers — `key_set_for_test`, `key_get_presence_for_test`, `key_delete_for_test`, `key_test_for_test` — each taking `service: &str` as the first parameter. The Tauri commands are 2-line delegates passing `SERVICE`. Integration test uses a per-test UUID service string.
- **Files modified:** `apps/desktop/src-tauri/src/commands/keys.rs`, `apps/desktop/src-tauri/tests/key_no_leak_tests.rs`
- **Commit:** `85272b9`

**4. [Rule 1 – Bug] `tokio::test(flavor = "multi_thread")` races the `tracing::subscriber::set_default` thread-local guard**
- **Found during:** Task 2 first test run
- **Issue:** `set_default` returns a guard that only scopes the default subscriber to the current thread. With `flavor = "multi_thread"`, a `.await` inside the test can resume on a worker thread that has no subscriber installed, so events from `key_test_for_test` would bypass the in-memory writer and the assertion would vacuously pass (false negative).
- **Fix:** Downgraded to default `#[tokio::test]` (current-thread runtime). Wiremock + reqwest run fine on current-thread; the test needs no parallelism. Keeps the subscriber guard active across every `.await`.
- **Files modified:** `apps/desktop/src-tauri/tests/key_no_leak_tests.rs`
- **Commit:** `85272b9`

No other deviations. Plan executed as written beyond these four.

## Guardrail Evidence

**G1-extension — No API key leaks in tracing output across the four key commands:**

```
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test key_no_leak_tests
    Finished `test` profile in 2.60s
     Running tests/key_no_leak_tests.rs
running 3 tests
test key_delete_missing_returns_key_not_found_without_leak ... ok
test no_api_key_leak_from_key_commands ... ok
test no_api_key_leak_from_key_test_happy_path ... ok
test result: ok. 3 passed; 0 failed
```

Unit tests (keys module):

```
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib commands::keys
test commands::keys::tests::auth_header_shape_matches_provider ... ok
test commands::keys::tests::provider_id_account_strings_are_stable ... ok
test commands::keys::tests::validate_key_format_rejects_blank_and_padded ... ok
test result: ok. 3 passed; 0 failed
```

## Verification

**Acceptance criteria — Task 1:**
- `grep -c "fn key_set" keys.rs` → **2** ✓ (matches `key_set` + `key_set_for_test`; plan specified ≥1)
- `grep -c "fn key_get_presence" keys.rs` → **2** ✓
- Return type `Result<bool, KeyError>` → **confirmed** via `grep "Result<bool"` matching function signature ✓
- `grep -c "skip(app, key)" keys.rs` → **1** ✓
- `generate_handler!` contains all four commands → **confirmed** in `ipc_spec.rs` lines 75–79 ✓

**Acceptance criteria — Task 2:**
- `key_no_leak_tests` binary → **3/3 passed** ✓
- `grep -c "KEY-LEAK-CANARY" key_no_leak_tests.rs` → **7** ✓ (plan required ≥2)
- `grep -c "wiremock" Cargo.toml` → **1** ✓

**Manual smoke (deferred to Wave 2 bring-up):** `tauri dev` → call `key_set` + `key_test` from devtools against real Anthropic `/v1/models`. Not blocker for plan completion; the wiremock happy-path covers the request-response code path.

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|---|---|---|
| T-03-03-01 (Info Disclosure — tracing auto-debug on `key_set`) | mitigated | `#[tracing::instrument(skip(app, key))]` on the command; `intelligence::tracing::redaction_layer` defence-in-depth; `no_api_key_leak_from_key_commands` asserts canary absent |
| T-03-03-02 (Info Disclosure — KeyTestReport.detail reflecting key) | mitigated | `detail = status.to_string()` (e.g. `"200 OK"`); request headers never read back from `resp`; `no_api_key_leak_from_key_test_happy_path` asserts canary absent from `report.detail` string |
| T-03-03-03 (Spoofing — TLS) | mitigated | `reqwest = { default-features = false, features = ["rustls-tls", "json"] }` — no native-tls, no plaintext; production URLs are HTTPS constants with no `http://` code path |
| T-03-03-04 (Elevation — Keychain ACL on macOS) | accepted | `keyring` crate delegates to Security framework; OS-enforced ACL; CONTEXT allows the one-time consent prompt as part of API-key onboarding UX |
| T-03-03-05 (Tampering — bogus provider enum) | mitigated | `ProviderId` is a closed Rust enum with `#[serde(rename_all = "snake_case")]`; serde rejects unknown variants at the IPC deserialisation boundary before any keychain access |
| T-03-03-06 (Repudiation — no audit trail) | accepted | Solo-user desktop; OS keychain logs access itself; Phase 3 scope does not add an audit table |

No new threat surface introduced beyond the plan's register.

## Known Stubs

None. Every command has a full implementation; the env-var URL override is a test-only injection hook, not a production stub.

## Issues Encountered

None beyond the four auto-fixed deviations above. TDD cycle ran clean: RED commit compiles fails as expected (unresolved `commands::keys`); GREEN commit builds and all 6 new tests (3 unit + 3 integration) pass on first run after the `tokio::test` runtime-flavor downgrade.

## Authentication Gates

None — plan is pure implementation + test. No user-supplied credentials needed; the leak test uses canary values, not real API keys.

## User Setup Required

None. The four Tauri commands are live in the next `pnpm tauri dev` run and the auto-regenerated `packages/shared-types/src/ipc.ts` exposes them to the webview. A future onboarding-UX plan will add the React UI for calling them (out of scope here).

## Next Plan Readiness

- **Wave 2 LLM orchestrator** can now call `key_test` for pre-flight credential checks before opening an SSE stream, and can read keys on-demand from the keychain inside its provider clients (wrapping in `Redacted<String>` per Plan 01 pattern).
- **Wave 3 TTS pipeline** has the same access pattern for ElevenLabs and OpenAI-TTS keys.
- **Phase 3 Plan 04+** onboarding UX can consume the TS-generated `ProviderId` + `KeyTestReport` types directly from `packages/shared-types/src/ipc.ts`.
- No blockers. No known gaps in the command surface.

## Handoff Notes

- `key_set` / `key_delete` use `tracing::info!` (visible at default log level); `key_get_presence` uses `tracing::debug!` (noisier call; under default filter it's silent). Both route through the redaction layer.
- Test binaries that need the keychain on CI should either (a) skip via `#[ignore]` + `cargo test -- --ignored` when keychain is unavailable, or (b) rely on `key_no_leak_tests.rs`'s pattern of short-circuiting after asserting no-leak on the `KeychainUnavailable` path.
- The `STORYCAPTURE_TEST_PROVIDER_BASE_URL` env var is a test-only lever. If a future plan needs to support staging endpoints, introduce a proper managed-state `ProviderProbeConfig` at that time — don't reuse the test hook.

## Self-Check: PASSED

File existence:
- `apps/desktop/src-tauri/src/commands/keys.rs` → FOUND
- `apps/desktop/src-tauri/tests/key_no_leak_tests.rs` → FOUND
- `apps/desktop/src-tauri/src/commands/mod.rs` (modified) → FOUND
- `apps/desktop/src-tauri/src/ipc_spec.rs` (modified) → FOUND
- `apps/desktop/src-tauri/Cargo.toml` (modified) → FOUND

Commits:
- `396c68a` (test RED) → FOUND
- `85272b9` (feat GREEN) → FOUND

Verification:
- `cargo test --test key_no_leak_tests` → 3/3 passed
- `cargo test --lib commands::keys` → 3/3 passed
- `cargo check` → exit 0

---
*Phase: 03-intelligence-layer-ai-authoring-voiceover*
*Completed: 2026-04-16*
