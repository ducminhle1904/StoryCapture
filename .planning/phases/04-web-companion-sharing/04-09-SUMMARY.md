---
phase: 04-web-companion-sharing
plan: 09
subsystem: sync
tags: [sse, trpc, subscriptions, offline-queue, jwt, recording-status, metadata-sync, zustand]

# Dependency graph
requires:
  - phase: 04-02
    provides: "JWT utilities (mintJwt, verifyJwt) and protectedProcedure"
  - phase: 04-04
    provides: "Upload pipeline pattern with reqwest + keychain token"
  - phase: 04-06
    provides: "Workspace RBAC, WorkspaceMember model"
  - phase: 04-08
    provides: "Analytics router pattern, _app.ts registration"
provides:
  - Sync tRPC router with pushMetadata, updateRecordingStatus mutations
  - SSE subscriptions (onRecordingStatus, onProjectUpdates) with tracked() reconnection
  - listProjects query (polling fallback)
  - mint-sse-jwt API endpoint for web client SSE auth
  - Desktop sync commands (sync_project_metadata, update_recording_status, flush_sync_queue, get_sync_status)
  - Offline queue in app.sqlite sync_queue table
  - RecordingStatus and ProjectMirror React components
  - Sync dashboard page at /(dashboard)/sync
  - useWebSyncStore Zustand store for desktop frontend
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "tRPC SSE subscriptions with tracked() for reconnection from last event ID"
    - "JWT auth via input params for SSE (Pitfall 7: EventSource can't send custom headers)"
    - "30-second keepalive pings on SSE to prevent Vercel timeout (T-04-33)"
    - "SSE-to-polling fallback after 3 consecutive failures (Hobby tier degradation)"
    - "3-phase flush pattern for rusqlite !Send safety: read pending, async HTTP, delete sent"
    - "EventEmitter-based sync event bus (in-memory, per-process)"

key-files:
  created:
    - apps/web/src/trpc/routers/sync.ts
    - apps/web/src/components/recording-status.tsx
    - apps/web/src/components/project-mirror.tsx
    - apps/web/src/app/(dashboard)/sync/page.tsx
    - apps/web/src/app/api/auth/mint-sse-jwt/route.ts
    - apps/desktop/src-tauri/src/commands/web_sync.rs
    - apps/desktop/src/stores/web-sync-store.ts
  modified:
    - apps/web/src/trpc/routers/_app.ts
    - apps/desktop/src-tauri/src/commands/mod.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs

key-decisions:
  - "Used EventEmitter (node:events) for in-memory sync event bus instead of external pub/sub — sufficient for single-process Vercel deployment"
  - "SSE subscriptions use publicProcedure with JWT verified from input (not protectedProcedure) because EventSource can't send custom headers"
  - "Recording status updates are fire-and-forget: not queued on failure since stale status is not useful"
  - "3-phase flush approach for rusqlite !Send: read rows sync, HTTP calls async, delete rows sync — avoids holding Connection across .await"
  - "mint-sse-jwt endpoint mints 15-min JWTs; client refreshes every 14 minutes"

patterns-established:
  - "SSE subscription auth via input token: publicProcedure + verifyJwt(input.token) + workspace membership check"
  - "Offline queue pattern: sync_queue table in app.sqlite with pending/sent status"
  - "SSE-to-polling fallback: after 3 consecutive SSE reconnect failures, switch to 5s polling with subtle (polling) indicator"

requirements-completed: [WEB-08]

# Metrics
duration: 7min
completed: 2026-04-16
---

# Phase 4 Plan 09: Desktop-Web SSE Sync Summary

**tRPC SSE subscriptions for live recording status push, metadata sync mutations with offline queue in SQLite, and JWT-authenticated SSE with polling fallback**

## Performance

- **Duration:** 7 min
- **Started:** 2026-04-16T07:30:26Z
- **Completed:** 2026-04-16T07:37:50Z
- **Tasks:** 2
- **Files created:** 7
- **Files modified:** 3

## Accomplishments

- Complete desktop-to-web sync channel: metadata push via HTTP mutations, live recording status via tRPC SSE subscriptions
- Sync tRPC router with 2 mutations (pushMetadata, updateRecordingStatus), 2 SSE subscriptions (onRecordingStatus, onProjectUpdates), 1 query (listProjects)
- SSE subscriptions authenticate via JWT in input params (Pitfall 7 workaround) with 15-min expiry (D-07)
- tracked() enables automatic reconnection from last event ID
- 30-second keepalive pings prevent Vercel timeout (T-04-33)
- Hobby tier graceful degradation: after 3 SSE failures, components switch to 5s polling with "(polling)" indicator
- Desktop offline queue in app.sqlite sync_queue table; flushes on startup/reconnect
- Recording status updates are fire-and-forget (ephemeral, not queued on failure)
- RecordingStatus component shows pulsing red dot with "Step N of M" during active recording
- ProjectMirror component shows synced projects with read-only story source (D-07)
- Zustand store (useWebSyncStore) wraps all Tauri sync commands

## Task Commits

1. **Task 1: Sync tRPC router with SSE subscriptions + web UI** - `da03ec0` (feat)
2. **Task 2: Desktop sync commands with offline queue** - `d6a68b1` (feat)

## Files Created/Modified

- `apps/web/src/trpc/routers/sync.ts` - Sync router: pushMetadata, updateRecordingStatus, onRecordingStatus, onProjectUpdates, listProjects
- `apps/web/src/components/recording-status.tsx` - Live recording status with pulsing indicator + SSE-to-polling fallback
- `apps/web/src/components/project-mirror.tsx` - Synced project list with read-only story source + status badges
- `apps/web/src/app/(dashboard)/sync/page.tsx` - Sync dashboard with connection indicator
- `apps/web/src/app/api/auth/mint-sse-jwt/route.ts` - Mints 15-min SSE JWTs for authenticated web users
- `apps/web/src/trpc/routers/_app.ts` - Added syncRouter
- `apps/desktop/src-tauri/src/commands/web_sync.rs` - 4 Tauri commands: sync_project_metadata, update_recording_status, flush_sync_queue, get_sync_status
- `apps/desktop/src-tauri/src/commands/mod.rs` - Added web_sync module
- `apps/desktop/src-tauri/src/ipc_spec.rs` - Registered 4 commands + 4 types for specta codegen
- `apps/desktop/src/stores/web-sync-store.ts` - Zustand store with initialize, syncProject, flushQueue, updateRecordingStatus actions

## Decisions Made

1. **EventEmitter for sync event bus** -- In-memory Node.js EventEmitter is sufficient for single-process Vercel deployment. No external pub/sub needed for v1.
2. **publicProcedure + JWT input for SSE** -- SSE subscriptions can't use protectedProcedure (no session in SSE context) or custom headers (Pitfall 7). JWT is passed in the subscription input and verified at subscription start.
3. **Fire-and-forget recording status** -- Recording status is ephemeral; stale status is worse than no status. Not queued on network failure.
4. **3-phase flush for !Send safety** -- rusqlite::Connection is !Send, so flush_sync_queue reads rows sync, does HTTP async, then deletes rows sync. Each phase opens/drops its own connection.
5. **mint-sse-jwt endpoint** -- Separate API endpoint for web clients to get SSE tokens (desktop clients use their long-lived API token directly).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed rusqlite !Send across .await in flush_sync_queue**
- **Found during:** Task 2 cargo check
- **Issue:** `rusqlite::Connection` is !Send, cannot be held across `.await` points in Tauri async commands
- **Fix:** Restructured to 3-phase approach: read pending items (sync block, conn dropped), HTTP calls (async), delete sent items (sync block, new conn)
- **Files modified:** apps/desktop/src-tauri/src/commands/web_sync.rs
- **Committed in:** d6a68b1

**2. [Rule 1 - Bug] Fixed rusqlite Statement borrow lifetime in block expression**
- **Found during:** Task 2 cargo check (second attempt)
- **Issue:** `stmt` temporary outlived block scope due to Rust's expression temporary rules
- **Fix:** Bound query result to local variable `rows` before returning from block
- **Files modified:** apps/desktop/src-tauri/src/commands/web_sync.rs
- **Committed in:** d6a68b1

**3. [Rule 2 - Missing Critical] Added mint-sse-jwt API endpoint**
- **Found during:** Task 1 implementation
- **Issue:** Plan mentions "Requests JWT from a useEffect that calls a /api/auth/mint-sse-jwt endpoint or similar" but the endpoint was not explicitly listed in task files
- **Fix:** Created apps/web/src/app/api/auth/mint-sse-jwt/route.ts with auth check + mintJwt call
- **Files modified:** apps/web/src/app/api/auth/mint-sse-jwt/route.ts
- **Committed in:** da03ec0

---

**Total deviations:** 3 auto-fixed (2 bugs, 1 missing critical)
**Impact on plan:** No scope creep. Bugs were Rust compile errors; missing endpoint was implied by the plan.

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|-----------|-------------|---------|
| T-04-30 (Spoofing - SSE subscription) | mitigated | JWT verified on subscription start via verifyJwt(); 15-min expiry; workspace membership checked |
| T-04-31 (Tampering - metadata push) | mitigated | protectedProcedure on mutations; workspace membership verified; last-write-wins (desktop authoritative per D-07) |
| T-04-32 (Info Disclosure - story source) | accepted | Story source visible to workspace members (read-only per D-07). Not publicly accessible. |
| T-04-33 (DoS - SSE connections) | mitigated | 30s keepalive pings; Vercel 60s timeout; tRPC auto-reconnect; polling fallback after 3 failures |

## Verification

- `cargo check` passes (exit 0) for desktop Rust
- `npx tsc --noEmit` passes (exit 0) for web TypeScript
- Desktop TypeScript: 3 pre-existing errors in auto-generated ipc.ts only (same as 04-03)
- Sync router has all 5 procedures (2 mutations + 2 subscriptions + 1 query)
- All 4 desktop commands registered in ipc_spec.rs with types

## Self-Check: PASSED

All 7 created files and 3 modified files verified present. Both commit hashes (da03ec0, d6a68b1) verified in git log.

---
*Phase: 04-web-companion-sharing*
*Completed: 2026-04-16*
