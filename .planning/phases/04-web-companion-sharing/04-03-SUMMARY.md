---
phase: 04-web-companion-sharing
plan: 03
subsystem: desktop-host
tags: [rust, tauri, oauth, keychain, zustand, react, web-account]

# Dependency graph
requires:
  - phase: 04-web-companion-sharing/01
    provides: Next.js 15 scaffold with auth endpoint stubs
  - phase: 03-intelligence-layer-ai-authoring-voiceover/03
    provides: keyring crate pattern + keychain commands
provides:
  - storycapture::commands::web_account::{start_web_oauth, complete_web_oauth, get_web_account, disconnect_web_account, get_web_api_token}
  - storycapture::commands::web_account::{WebAccountInfo, WebAccountError}
  - WebAccountPanel React component for Settings > Accounts
  - useWebAccountStore Zustand store for web account state
affects: [04-04-upload, 04-08-sync]

# Tech tracking
tech-stack:
  added:
    - "time 0.3 (formatting) — RFC3339 timestamp for connectedAt"
  patterns:
    - "Localhost OAuth callback server via tokio::net::TcpListener on random port with 30s timeout"
    - "tauri_plugin_opener::OpenerExt for system browser launch"
    - "Keychain-backed token storage under com.storycapture.web service"
    - "Zustand store with Tauri invoke for async actions"

key-files:
  created:
    - apps/desktop/src-tauri/src/commands/web_account.rs
    - apps/desktop/src/features/settings/accounts-panel.tsx
    - apps/desktop/src/stores/web-account-store.ts
    - packages/shared-types/src/web-account.ts
  modified:
    - apps/desktop/src-tauri/Cargo.toml
    - apps/desktop/src-tauri/src/commands/mod.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - apps/desktop/src/features/settings/AccountsPage.tsx
    - packages/shared-types/src/index.ts
    - Cargo.lock

key-decisions:
  - "Used keyring crate directly (not tauri-plugin-keyring) per Phase 1 FOUND-07 and Phase 3 plan 03 pattern"
  - "Localhost TCP server for OAuth callback instead of tauri-plugin-oauth (simpler, no extra dependency)"
  - "WebAccountInfo exported via ipc.ts codegen; standalone web-account.ts not re-exported from index.ts to avoid collision"
  - "Web companion URL configurable via STORYCAPTURE_WEB_URL env var for development"

requirements-completed: [UI-06]

# Metrics
duration: 7min
completed: 2026-04-16
---

# Phase 4 Plan 03: Desktop Settings Accounts Panel + OAuth Flow Summary

**Five Tauri commands for OAuth-based web account linking with keychain token storage, plus React Accounts panel with connect/disconnect UI and Zustand state management**

## Performance

- **Duration:** 7 min
- **Started:** 2026-04-16T06:32:47Z
- **Completed:** 2026-04-16T06:40:25Z
- **Tasks:** 2
- **Files created:** 4
- **Files modified:** 6

## What Was Built

**Task 1 -- Rust commands (`apps/desktop/src-tauri/src/commands/web_account.rs`).**

Five async Tauri commands for the OAuth connect/disconnect lifecycle:

| Command | Signature | Behaviour |
|---|---|---|
| `start_web_oauth` | `(app) -> Result<u16, WebAccountError>` | Binds localhost TcpListener on random port; spawns single-use callback server with 30s timeout; opens system browser via `OpenerExt`; returns port |
| `complete_web_oauth` | `(app) -> Result<WebAccountInfo, WebAccountError>` | Waits for callback via oneshot channel (30s timeout); exchanges session token for API token via POST to `/api/auth/desktop-token`; stores both token and account info in OS keychain |
| `get_web_account` | `() -> Result<Option<WebAccountInfo>, WebAccountError>` | Reads `web_account_info` from keychain; returns `None` if not connected |
| `disconnect_web_account` | `() -> Result<(), WebAccountError>` | Deletes `web_api_token` and `web_account_info` from keychain |
| `get_web_api_token` | `() -> Result<Option<String>, WebAccountError>` | Reads API token from keychain for upload/sync consumers |

`WebAccountError` has six variants: `KeychainUnavailable`, `NotConnected`, `OAuthTimeout`, `TokenExchangeFailed`, `NetworkError`, `ServerError`.

Keychain entries use service `com.storycapture.web` with accounts `web_api_token` and `web_account_info`. Token exchange calls the web companion's `/api/auth/desktop-token` endpoint. Web companion URL defaults to `https://storycapture.app` but is overridable via `STORYCAPTURE_WEB_URL` env var for development.

**Task 2 -- Accounts panel UI + Zustand store.**

- `accounts-panel.tsx`: Three-state UI (disconnected with connect button, connecting with spinner, connected with avatar/email/disconnect). Upload Settings placeholder with connection status badge. Disconnect confirmation dialog with Base UI Dialog.
- `web-account-store.ts`: Zustand v5 store with `fetchAccount`, `connect`, `disconnect` actions wrapping Tauri invoke calls.
- `web-account.ts`: Standalone `WebAccountInfo` type definition (also codegen'd in `ipc.ts`).
- `AccountsPage.tsx`: Updated to include `WebAccountPanel` section above API key management.

## Task Commits

| Task | Message | Hash |
|---|---|---|
| 1 | `feat(04-03): web account OAuth + keychain Tauri commands` | `14d82f4` |
| 2 | `feat(04-03): Accounts panel UI + web account Zustand store` | `a8b983e` |

## Decisions Made

1. **`keyring` crate direct** -- Per Phase 1 FOUND-07 and Phase 3 plan 03 pattern. Using `tauri-plugin-keyring` would introduce a parallel keychain code path.
2. **Localhost TCP server** -- Simpler than `tauri-plugin-oauth` and avoids an extra dependency. Random port + 30s timeout + single-use server satisfies T-04-09 and T-04-11.
3. **Web companion URL via env var** -- `STORYCAPTURE_WEB_URL` env var for development; defaults to `https://storycapture.app` in production.
4. **WebAccountInfo not re-exported from shared-types index** -- The auto-generated `ipc.ts` already exports `WebAccountInfo`. Re-exporting from `web-account.ts` would cause TS2308 collision.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] WebAccountInfo export collision with ipc.ts codegen**
- **Found during:** Task 2 typecheck
- **Issue:** `packages/shared-types/src/index.ts` re-exported `WebAccountInfo` from both `ipc.ts` (codegen) and `web-account.ts` (manual), causing TS2308
- **Fix:** Removed `web-account.ts` re-export from index.ts; ipc.ts codegen provides the type
- **Files modified:** `packages/shared-types/src/index.ts`
- **Commit:** `a8b983e`

**2. [Rule 1 - Bug] Implicit `any` on `.map()` parameter in accounts-panel.tsx**
- **Found during:** Task 2 typecheck
- **Issue:** `account.name.split(" ").map((n) => n[0])` had implicit `any` for parameter `n` under strict TS
- **Fix:** Added explicit type annotation: `.map((part: string) => part[0])`
- **Files modified:** `apps/desktop/src/features/settings/accounts-panel.tsx`
- **Commit:** `a8b983e`

**3. [Rule 2 - Missing Critical] Used OpenerExt instead of direct function call for browser launch**
- **Found during:** Task 1 implementation
- **Issue:** Plan suggested `tauri-plugin-opener::open_url()` as a free function, but the project pattern (see `capture.rs`) uses `app.opener().open_url()` via the `OpenerExt` trait
- **Fix:** Used `OpenerExt` pattern consistent with existing codebase
- **Files modified:** `apps/desktop/src-tauri/src/commands/web_account.rs`
- **Commit:** `14d82f4`

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|---|---|---|
| T-04-09 (Spoofing - localhost OAuth) | mitigated | Random port via `TcpListener::bind("127.0.0.1:0")`; single-use server (accepts exactly one connection); 30s timeout; callback token extracted from query string only |
| T-04-10 (Info Disclosure - API token) | mitigated | Token stored in OS keychain via `keyring::Entry` under `com.storycapture.web` service; never in SQLite, localStorage, or plaintext files |
| T-04-11 (DoS - OAuth timeout) | mitigated | 30-second `tokio::time::timeout` on both TCP accept and oneshot channel; clean shutdown on timeout; `OAuthTimeout` error variant returned to frontend |

## Known Stubs

- **Upload Settings subsection** in `accounts-panel.tsx` is a placeholder showing connection status badge only. Will be wired with actual upload configuration in Plan 04-04.

## Verification

- `cargo check --lib` passes (exit 0)
- `cargo test --lib commands::web_account` passes (5/5 unit tests)
- `pnpm --filter @storycapture/desktop typecheck` -- all new code clean; remaining 3 errors are pre-existing in auto-generated `ipc.ts` (TSend unused, TAURI_CHANNEL conflict, __makeEvents__ unused)
- All 5 commands registered in `ipc_spec.rs` builder
- `WebAccountInfo` and `WebAccountError` types registered for specta codegen

## Self-Check: PASSED

File existence:
- `apps/desktop/src-tauri/src/commands/web_account.rs` -- FOUND
- `apps/desktop/src/features/settings/accounts-panel.tsx` -- FOUND
- `apps/desktop/src/stores/web-account-store.ts` -- FOUND
- `packages/shared-types/src/web-account.ts` -- FOUND
- `apps/desktop/src-tauri/src/commands/mod.rs` (modified) -- FOUND
- `apps/desktop/src-tauri/src/ipc_spec.rs` (modified) -- FOUND
- `apps/desktop/src-tauri/Cargo.toml` (modified) -- FOUND
- `apps/desktop/src/features/settings/AccountsPage.tsx` (modified) -- FOUND
- `packages/shared-types/src/index.ts` (modified) -- FOUND

Commits:
- `14d82f4` (Task 1 feat) -- FOUND
- `a8b983e` (Task 2 feat) -- FOUND

---
*Phase: 04-web-companion-sharing*
*Completed: 2026-04-16*
