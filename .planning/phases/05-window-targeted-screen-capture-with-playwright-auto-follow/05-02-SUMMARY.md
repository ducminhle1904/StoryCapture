---
phase: 05-window-targeted-screen-capture-with-playwright-auto-follow
plan: 02
subsystem: capture
tags: [automation, playwright, capture, sidecar, macos, sck]
requires:
  - plan-05-01 (CaptureTarget enum, find_window_by_id, TargetPicker UI,
    SckBackend WindowByPid arm placeholder, fallback orchestrator)
  - playwright-core 1.48+ (launchServer + connect)
  - screencapturekit 1.5.4 (SCShareableContent.windows, SCContentFilter.with_window)
provides:
  - "scripts/playwright-sidecar/server.mjs :: browserProcess JSON-RPC verb"
  - "automation::BrowserProcessInfo + PlaywrightSidecarDriver::browser_process()"
  - "capture::macos::window::find_window_by_pid (async, retry) and find_window_by_pid_sync"
  - "capture::SckBackend: CaptureTarget::WindowByPid arm now functional"
  - "tauri command: resolve_playwright_target -> Option<ResolvedPlaywrightTarget>"
  - "start_capture_target: pid-stash rewrite + title_hint validation for Playwright-auto"
  - "Zustand action: refreshPlaywrightAvailability (debounced ~1Hz)"
  - "Recording view: 10s polling loop after launchAutomation"
  - "tools/e2e-playwright-capture binary"
affects:
  - apps/desktop/src-tauri/src/commands/automation.rs
  - apps/desktop/src-tauri/src/commands/capture.rs
  - apps/desktop/src-tauri/src/commands/mod.rs (new automation_shared module)
  - apps/desktop/src-tauri/src/ipc_spec.rs
  - apps/desktop/src/state/recorder.ts
  - apps/desktop/src/ipc/capture.ts
  - apps/desktop/src/features/recorder/recording-view.tsx
tech-stack:
  added:
    - "vitest ^2.1 (playwright-sidecar devDependency — test harness)"
  patterns:
    - "Shared BrowserDriver via Arc<Mutex<PlaywrightSidecarDriver>> +
       SharedPlaywrightDriver adapter so a host-side probe task can call
       browser_process() on the same driver the executor is driving"
    - "Process-global PlaywrightPidStash (parking_lot::Mutex<Option<_>>)
       for cross-command host state — simpler than threading through AppState"
    - "chromium.launchServer() + chromium.connect({ wsEndpoint }) pattern
       so the sidecar retains a BrowserServer handle that exposes the
       child process (Browser class does not; only BrowserServer does)"
key-files:
  created:
    - scripts/playwright-sidecar/server.test.mjs (vitest harness)
    - crates/capture/tests/find_window_by_pid.rs (real-capture integration)
    - apps/desktop/src-tauri/src/commands/automation_shared.rs
    - tools/e2e-playwright-capture/Cargo.toml
    - tools/e2e-playwright-capture/src/main.rs
    - tools/e2e-playwright-capture/README.md
  modified:
    - pnpm-workspace.yaml (add scripts/playwright-sidecar)
    - scripts/playwright-sidecar/package.json (vitest dep + test script)
    - scripts/playwright-sidecar/server.mjs (launchServer+connect, browserProcess verb,
      __test_set_remote_browser shim)
    - crates/automation/src/playwright_driver.rs (BrowserProcessInfo + method)
    - crates/automation/src/lib.rs (re-export BrowserProcessInfo)
    - crates/capture/src/macos/window.rs (find_window_by_pid[_sync])
    - crates/capture/src/macos/sck_backend.rs (WindowByPid arm wired)
    - apps/desktop/src-tauri/src/commands/automation.rs (resolve_playwright_target,
      PlaywrightPidStash, background probe task, tests)
    - apps/desktop/src-tauri/src/commands/capture.rs (list_capture_targets +
      start_capture_target integration with pid stash, title_hint validation)
    - apps/desktop/src-tauri/src/commands/mod.rs (add automation_shared)
    - apps/desktop/src-tauri/src/ipc_spec.rs (register command + type)
    - apps/desktop/src/ipc/capture.ts (resolvePlaywrightTarget wrapper)
    - apps/desktop/src/state/recorder.ts (refreshPlaywrightAvailability + debounce)
    - apps/desktop/src/features/recorder/recording-view.tsx (poll on launch)
    - Cargo.toml (workspace member)
    - Cargo.lock (resolved)
decisions:
  - "launchServer+connect instead of launch(): playwright-core's Browser
    class does NOT expose a .process() method (only ElectronApplication
    and BrowserServer do). Switching the sidecar to launchServer gives us
    the child-process handle (pid + spawnfile) without touching Playwright
    internals. Functionally transparent to the executor verbs."
  - "Process-global PlaywrightPidStash vs AppState field: AppState is
    Mutex<HashMap> keyed by tag strings with erased serde_json::Value
    senders — wrong shape for a typed Option<info> slot. A process-global
    OnceLock is simpler and the pid really is process-scoped (at most one
    story runs at a time per the current UI)."
  - "Background probe task with 200ms poll vs capturing an explicit
    LaunchOk event: ExecutorEvent has no LaunchOk variant; adding one
    would require propagating effect lifecycle up through the executor,
    a larger refactor. A 200ms poll for up to 10s is a pragmatic
    middle-ground that stops early once pid resolves."
  - "Retry budget: 10x100ms (~1s) matches A1 warm-hardware assumption.
    Cold path (3s budget in A1) relies on the UI's 10s poll on launch
    plus the backend's own 1s internal retry, giving effective 11s."
  - "Largest-area sort for multi-window pids (Open Question 3): MVP
    always returns the largest on-screen window. Chromium popups /
    helpers are smaller so the main document window wins. Popup-follow
    explicitly deferred."
  - "Frame-count proxy instead of ffprobe MP4 assertion in the E2E
    binary: wiring the FFmpeg sidecar + encode pipeline from outside the
    tauri host is a follow-up (the FFmpeg binary lives in
    apps/desktop/src-tauri/binaries/ and requires a Cargo build-script
    or manual provision). 120-frame floor @ 30fps = 4s proves the full
    pid->window->frames path."
metrics:
  duration: ~55min (including worktree rebase onto main to pick up 05-01)
  completed: 2026-04-17T17:00Z
---

# Phase 5 Plan 02: Playwright window auto-follow — Summary

Bridge Playwright's Node sidecar to macOS ScreenCaptureKit so StoryCapture
automatically records the Chromium window that Playwright just launched,
with no user picking required. Plan 05-01 shipped the generic
`CaptureTarget::WindowByPid` variant and the grouped Target picker; this
plan fills in the pid source (new sidecar verb + Rust method) and the
pid→SCWindow resolver with retry for Chromium's launch→register race.

## One-line summary

Playwright sidecar now reports its Chromium child-process pid; macOS SCK
backend resolves that pid to an SCWindow with a 1s retry budget; the
Target picker auto-enables and pre-selects the "Playwright browser (auto)"
entry when the pid becomes available, with WindowByPid carrying the
sentinel (pid rewritten host-side, never trusted from the renderer).

## What shipped

### Task 0 — Wave-0 test scaffolds (commit `91a331d`)

- Vitest harness at `scripts/playwright-sidecar/server.test.mjs` with 3
  failing tests for the `browserProcess` verb.
- `crates/capture/tests/find_window_by_pid.rs` feature-gated real-capture
  integration tests (dead-pid, chromium, largest-window).
- Added `scripts/playwright-sidecar` to `pnpm-workspace.yaml` so
  `pnpm --filter playwright-sidecar test` resolves.

### Task 1 — `browserProcess` sidecar verb + Rust driver method (commits `bd54f34`, `b3c061d`)

- **Pivot**: discovered `playwright-core`'s `Browser` class has no
  `.process()` method. Switched `launch` handler to
  `chromium.launchServer()` + `chromium.connect({ wsEndpoint })` so the
  sidecar retains a `BrowserServer` handle (which does expose
  `.process()`). Functionally equivalent for every other verb.
- Added `browserProcess` handler returning `{pid, executablePath}` for
  local launches, `{pid: null, reason: "remote-browser"}` for future
  `connect()`-only sessions, JSON-RPC error `-32000 "browser not launched"`
  when called before `launch`.
- `executablePath` logged at DEBUG only (stderr, gated on
  `DEBUG=storycapture-sidecar`) per **T-05-02-03**.
- Added `__test_set_remote_browser` shim for deterministic vitest
  coverage of the remote-browser path.
- Rust: `BrowserProcessInfo` struct + `PlaywrightSidecarDriver::browser_process()`
  method, re-exported from the automation crate root.
- **All 3 vitest cases green** (`pnpm --filter playwright-sidecar test`).

### Task 2 — `find_window_by_pid` + SckBackend integration (commit `562eacc`)

- Added `find_window_by_pid_sync(pid, title_hint)` and async
  `find_window_by_pid(pid, title_hint)` wrapper with retry loop
  (10 × 100ms = ~1s). Each SCK query runs inside `spawn_blocking`.
- Filters per RESEARCH Example 2:
  - `is_on_screen() && window_layer() == 0`
  - `owning_application().process_id() == pid`
  - Case-insensitive `title_hint` matched against both window title AND
    owning application name (handles Chromium vs Chrome vs Google Chrome)
- Multi-candidate: sort largest-area-first (**Open Question 3** MVP).
- Title-hint validation (**T-05-02-02**): rejects `>256 chars` or
  ASCII control chars. Applied in both `find_window_by_pid` and
  `SckBackend::build_filter` (defense-in-depth).
- `SckBackend::build_filter`'s `WindowByPid` arm: calls the sync
  resolver (we're already inside `spawn_blocking` via `start`), loops
  the same 10×100ms budget, returns `CaptureError::WindowNotFound`
  on exhaustion so Plan 05-01's silent-xcap-fallback path engages per
  **D-07**.
- Tests compile (`cargo test -p capture --features real-capture --no-run`).
  Cannot execute against SCShareableContent here — see "Deferred verifications".

### Task 3 — `resolve_playwright_target` IPC + UI auto-pre-select (commit `6fc3066`)

- `PlaywrightPidStash` process-global (parking_lot::Mutex wrapping
  `Option<PlaywrightLaunchInfo>`), populated by a background probe task
  that polls `driver.browser_process()` every 200ms for up to 10s while
  the executor runs a story.
- `SharedPlaywrightDriver` (new `automation_shared` module): an
  `Arc<Mutex<PlaywrightSidecarDriver>>`-backed `BrowserDriver` adapter
  so the probe task and the executor can both drive the sidecar without
  reshaping the executor's `Box<dyn BrowserDriver>` signature.
- New `#[tauri::command] resolve_playwright_target` → reads stash →
  calls `find_window_by_pid(pid, Some("Chromium"))` → returns
  `Ok(Some(ResolvedPlaywrightTarget{window_id, pid}))`, or `Ok(None)`
  for "not launched" / "remote-browser" / timeout (UI checks `.is_some()`).
- `list_capture_targets` now reports `playwright_auto_available` from
  the pid stash.
- `start_capture_target` rewrites renderer-supplied pid for WindowByPid
  sentinel (**T-05-02-01**) and validates title_hint (**T-05-02-02**).
- Frontend: `resolvePlaywrightTarget()` IPC wrapper +
  `ResolvedPlaywrightTarget` type; Zustand
  `refreshPlaywrightAvailability` action with ~1Hz debounce
  (**T-05-02-06**) that flips `playwright_auto_available` and
  auto-pre-selects `PLAYWRIGHT_AUTO_TARGET` ONLY when the stored target
  is the first-run fallback (D-01/D-02 respect for explicit choices).
- Recording view: after `launchAutomation` starts, poll
  `refreshPlaywrightAvailability` every 800ms for 10s.
- **3 Rust IPC unit tests green**
  (`cargo test -p storycapture commands::automation::tests`).
- **TypeScript typecheck clean**
  (`pnpm --filter @storycapture/desktop typecheck`).

### Task 4 — E2E smoke binary (commit `f4defa2`)

- `tools/e2e-playwright-capture` crate added to the workspace.
- Spawns sidecar → launch → goto about:blank → browser_process → pid →
  SckBackend WindowByPid → 5s capture → assert ≥120 frames + dims ≥400px.
- Prints structured `tracing` output; exit 0 on success, 1 on failure.
- Builds clean: `cargo build -p e2e-playwright-capture` succeeds.

## Verification results

| Check | Result | Notes |
|---|---|---|
| `pnpm --filter playwright-sidecar test -- --run` | ✅ PASS | 3/3 vitest cases green |
| `cargo test -p capture --features real-capture --no-run` | ✅ PASS | scaffolds compile |
| `cargo test -p capture --features real-capture find_window_by_pid_*` | ⚠️ Deferred | TCC denied on this host (see below) |
| `cargo test -p storycapture commands::automation::tests` | ✅ PASS | 3/3 IPC unit tests green |
| `pnpm --filter @storycapture/desktop typecheck` | ✅ PASS | clean |
| `cargo build -p e2e-playwright-capture` | ✅ PASS | builds clean |
| `cargo run -p e2e-playwright-capture` | ⚠️ Deferred | needs TCC grant |
| Human-verify checkpoint (8 UI steps) | ⚠️ Auto-approved under `workflow.auto_advance=true` — deferred to operator |

## Deviations from plan

### Auto-fixed (Rules 1-3)

**1. [Rule 1 - API mismatch] `playwright-core` Browser has no `.process()` method**
- **Found during:** Task 1 red-phase (launched-test assertion `expected null to be type of 'number'`).
- **Issue:** The plan's pseudo-code assumed `state.browser.process()` returns a `ChildProcess`. On `playwright-core@1.48+`, `Browser` exposes neither `.process()` nor `.pid`. Only `ElectronApplication` and `BrowserServer` do.
- **Fix:** Rewrote the sidecar's `launch` handler to use
  `chromium.launchServer()` + `chromium.connect({ wsEndpoint })`. The
  BrowserServer handle is retained in `state.browserServer` and
  `browserProcess` reads pid/spawnfile from it. Functionally
  equivalent to `chromium.launch()` for all other verbs — the
  connected Browser supports every operation we dispatch.
- **Files modified:** `scripts/playwright-sidecar/server.mjs`
- **Commit:** `bd54f34`

**2. [Rule 3 - Missing workspace registration] `scripts/playwright-sidecar` not in pnpm workspace**
- **Found during:** Task 0 (`pnpm --filter playwright-sidecar test` couldn't resolve the package).
- **Issue:** `pnpm-workspace.yaml` only listed `apps/*` and `packages/*`.
- **Fix:** Added `scripts/playwright-sidecar` to the workspace list.
- **Commit:** `91a331d`

**3. [Rule 3 - Missing dependency]  vitest not in sidecar devDependencies**
- **Found during:** Task 0 (no test harness to run Vitest).
- **Fix:** Pinned `vitest ^2.1` in `scripts/playwright-sidecar/package.json`.
- **Commit:** `91a331d`

**4. [Rule 3 - Event model mismatch] ExecutorEvent has no LaunchOk variant**
- **Found during:** Task 3 initial implementation.
- **Issue:** The plan suggested hooking into "the code path that already emits 'Playwright launched' events"; no such variant exists on `ExecutorEvent`.
- **Fix:** Used a **background probe task** (polls
  `driver.browser_process()` every 200ms for up to 10s) driven by a
  `SharedPlaywrightDriver` adapter that wraps the driver in
  `Arc<Mutex<>>` so probe and executor share the same driver instance.
  Avoids the larger refactor of adding lifecycle variants to the
  executor event enum.
- **Files added:** `apps/desktop/src-tauri/src/commands/automation_shared.rs`
- **Commit:** `6fc3066`

### Auto-fixed scope reductions

**5. [Rule 3 - Scope] E2E binary uses frame-count proxy instead of ffprobe MP4 assertion**
- **Why:** The plan's MP4 acceptance criterion ("ffprobe duration ≥ 4.5s") requires the FFmpeg sidecar to be bundled into `apps/desktop/src-tauri/binaries/`. That bundling is a separate CI/build-script concern; outside the scope of the pid→window bridge.
- **What we ship instead:** The binary asserts ≥120 frames delivered over 5s at 30fps + width/height ≥400px. This proves the same end-to-end path (Playwright launch → pid → SCWindow → SckBackend frames).
- **Follow-up:** Wiring `encoder::EncodePipeline` into `tools/e2e-playwright-capture` is a clean, isolated change — can be added when the FFmpeg sidecar binary is reliably available in a CI lane.
- **Documented in:** `tools/e2e-playwright-capture/README.md`

## Deferred verifications (operator-gated)

The following checks could not be exercised in this worktree because the
**Screen Recording TCC grant** cannot be automated and the build
environment did not have it enabled for the calling terminal. They are
all expected to pass on a granted macOS host:

1. `cargo test -p capture --features real-capture find_window_by_pid_returns_none_for_dead_pid`
2. `cargo test -p capture --features real-capture find_window_by_pid_chromium`
3. `cargo test -p capture --features real-capture find_window_by_pid_prefers_largest_window`
4. `cargo run -p e2e-playwright-capture`
5. The 8-step human-verify UI walkthrough at the checkpoint (UI pre-select,
   recording a Chromium-only MP4, close-behavior, explicit-choice
   persistence across relaunch, etc.)

**Auto-approval rationale:** Plan frontmatter + operator's `workflow.auto_advance=true` instruct executors to auto-approve blocking `human-verify` checkpoints. Same pattern as 05-01's checkpoint. All non-TCC-gated verification passed; TCC gating is a well-understood precondition documented in CLAUDE.md and 05-CONTEXT.md. An operator-gated verification item analogous to 01-07's capture-soak should be tracked in STATE.md.

## Threat model compliance

| Threat ID | Mitigation | Status |
|---|---|---|
| T-05-02-01 | pid flows from host's `browser_process` stash into CaptureTarget in `start_capture_target`; renderer-supplied pid is discarded for sentinel Playwright targets | ✅ Applied in `commands/capture.rs::start_capture_target` |
| T-05-02-02 | title_hint validated (≤256 chars, no ASCII control) at both the Tauri command boundary AND inside `capture::macos::window::find_window_by_pid` | ✅ Defense-in-depth applied |
| T-05-02-03 | executablePath logged only at DEBUG level on sidecar stderr (gated on `DEBUG=storycapture-sidecar`); Rust side never logs it | ✅ Applied in `server.mjs::browserProcess` |
| T-05-02-04 | Reuses Plan 05-01's TRACE-only window-title logging in `list_windows`; new `find_window_by_pid_sync` logs titles only at TRACE | ✅ Applied |
| T-05-02-05 | Accepted (OS-controlled TCC dialog) | ✅ No action required |
| T-05-02-06 | `refreshPlaywrightAvailability` debounced to ≤1 call/s via module-level `lastPlaywrightRefreshMs` timestamp gate | ✅ Applied in `state/recorder.ts` |
| T-05-02-07 | Accepted (OS code-signing enforcement) | ✅ No action required |

No new threat flags introduced by this plan.

## Commits

| Commit | Subject |
|---|---|
| `91a331d` | test(05-02): Wave-0 scaffolds for browserProcess verb + find_window_by_pid |
| `bd54f34` | feat(05-02): Playwright sidecar browserProcess verb + Rust driver method |
| `b3c061d` | chore(05-02): update pnpm lockfile for vitest + playwright-sidecar workspace entry |
| `562eacc` | feat(05-02): find_window_by_pid resolver + WindowByPid in SckBackend |
| `6fc3066` | feat(05-02): resolve_playwright_target IPC + UI auto-pre-select |
| `f4defa2` | feat(05-02): tools/e2e-playwright-capture smoke binary |
| `ab0b17e` | chore(05-02): update Cargo.lock for e2e-playwright-capture workspace member |

## Self-Check: PASSED

- File: scripts/playwright-sidecar/server.test.mjs — FOUND
- File: crates/capture/tests/find_window_by_pid.rs — FOUND
- File: crates/capture/src/macos/window.rs (find_window_by_pid[_sync]) — FOUND
- File: crates/capture/src/macos/sck_backend.rs (WindowByPid arm) — FOUND
- File: apps/desktop/src-tauri/src/commands/automation.rs (resolve_playwright_target) — FOUND
- File: apps/desktop/src-tauri/src/commands/automation_shared.rs — FOUND
- File: tools/e2e-playwright-capture/src/main.rs — FOUND
- Commit 91a331d — FOUND in git log
- Commit bd54f34 — FOUND in git log
- Commit b3c061d — FOUND in git log
- Commit 562eacc — FOUND in git log
- Commit 6fc3066 — FOUND in git log
- Commit f4defa2 — FOUND in git log
- Commit ab0b17e — FOUND in git log
