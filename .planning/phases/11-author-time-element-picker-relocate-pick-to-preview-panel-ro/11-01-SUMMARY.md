---
phase: 11
plan: 01
subsystem: desktop-host
tags: [picker, author-driver, tauri, registry, concurrency, fsm]
requires:
  - Phase 10-02 SimulatorRegistry pattern (registry shape)
  - Phase 9-04 author_preview_sessions + resume_author_preview (TODO hook point)
provides:
  - storycapture::author_driver::AuthorDriverState (5-variant enum, D-16)
  - storycapture::author_driver::AuthorDriverRegistry (Arc-managed tokio::Mutex)
  - storycapture::author_driver::AuthorDriverError (typed enum for 11-02+ wiring)
  - storycapture::author_driver::PickerResumeGuard (RAII restore with Pitfall 2 shutdown guard)
  - storycapture::commands::picker::stamp_step_id_impl (testable inner helper)
  - storycapture::commands::picker::PickerStampResultDto (D-04 contract)
affects:
  - apps/desktop/src-tauri/src/lib.rs (Arc<AuthorDriverRegistry> managed)
  - apps/desktop/src-tauri/src/ipc_spec.rs (PickerStampResultDto registered)
  - apps/desktop/src-tauri/src/commands/picker.rs (DTO + impl extraction)
  - apps/desktop/src/ipc/picker.ts (return-type refinement, non-breaking)
tech-stack:
  added: []
  patterns:
    - tokio::sync::Mutex<Enum> registry (shared-lock FSM)
    - RAII Drop-guard with tokio::runtime::Handle::try_current() shutdown-safety
    - Extract #[tauri::command] body into pub fn impl for integration-test driving
key-files:
  created:
    - apps/desktop/src-tauri/src/author_driver.rs
    - apps/desktop/src-tauri/tests/author_driver_state_machine.rs
    - apps/desktop/src-tauri/tests/author_driver_concurrency.rs
    - apps/desktop/src-tauri/tests/picker_stamp_idempotent_source_bytes.rs
  modified:
    - apps/desktop/src-tauri/src/lib.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - apps/desktop/src-tauri/src/commands/picker.rs
    - apps/desktop/src/ipc/picker.ts
decisions:
  - "AuthorDriverRegistry registered Arc-managed (std::sync::Arc) so PickerResumeGuard (11-03) can clone a handle for deferred restore without violating Tauri's State lifetime."
  - "PickerResumeGuard Drop calls tokio::runtime::Handle::try_current().ok() before spawn (Pitfall 2 shutdown safety). Spawned task re-acquires registry mutex inside the async body."
  - "TODO comment in PickerResumeGuard::drop for crate::commands::automation::resume_author_preview(_stream_id) — intentional: 11-03 owns that wiring; Task 1 scope is FSM + guard + registration only."
  - "stamp_step_id_impl is pub (not pub(crate)) because tests/ is an external integration-test crate. This is a structural fix per plan instruction — no #[cfg(test)] tricks."
  - "Default impl for AuthorDriverState = Idle. Registry default() yields Mutex<Idle> which is the correct initial value."
metrics:
  duration: "45m"
  completed: "2026-04-24"
  tasks: 3
  commits: 4  # 1 feat (Task 1), 1 test RED + 1 feat GREEN (Task 2), 1 test (Task 3)
---

# Phase 11 Plan 01: AuthorDriverRegistry + Pitfall 5 regression guard — Summary

**One-liner:** Foundational Wave-1 plan — shipped the shared `AuthorDriverState` 5-variant FSM (D-16) under a `tokio::Mutex` registry that 11-03/simulator will lock against, plus extracted `stamp_step_id_impl` with a new `PickerStampResultDto { step_id, was_freshly_stamped }` contract and two byte-identity regression tests guarding D-04 / Pitfall 5.

## What shipped

### Task 1 — `apps/desktop/src-tauri/src/author_driver.rs` (NEW)

- `pub enum AuthorDriverState` with 5 variants per D-16:
  - `Idle` (Default)
  - `LivePreview { stream_id: StreamId }`
  - `Picking { stream_id: StreamId, resume_to: Option<Box<AuthorDriverState>> }`
  - `SimulatorRunning { session: SimulatorSessionId }`
  - `SimulatorPaused { session: SimulatorSessionId }`
- `AuthorDriverRegistry { state: tokio::sync::Mutex<AuthorDriverState> }` + `new() -> Arc<Self>` helper.
- `AuthorDriverError` (thiserror + serde + specta): `SimulatorBusy` / `AlreadyPicking` / `InvalidTransition { from, to }`. Mirrors 10-02 `SimulatorError` shape for TS consumers.
- Transition helpers on the enum:
  - `can_start_pick(&self) -> Result<(), AuthorDriverError>` — Err on `SimulatorRunning` / `Picking`, Ok on Idle / LivePreview / SimulatorPaused (D-13/D-14/D-15).
  - `can_start_simulator(&self) -> Result<(), AuthorDriverError>` — Err on `Picking`, Ok otherwise (D-15).
  - `begin_pick(&mut self, stream_id: StreamId)` — transitions to `Picking`; boxes prior state into `resume_to` only when prior was `SimulatorPaused` (D-14).
  - `end_pick(&mut self)` — restore from `resume_to` if `Some`, else land in `LivePreview { stream_id }`.
- `PickerResumeGuard` (RAII):
  - Fields: `registry: Arc<AuthorDriverRegistry>`, `stream_id: StreamId`, `restore: std::sync::Mutex<Option<AuthorDriverState>>`.
  - `new(registry, stream_id, restore)` arms the guard with prior state.
  - `disarm(&self)` drops the restore slot — success path.
  - `impl Drop`: if still armed, `tokio::runtime::Handle::try_current().ok()` gate (Pitfall 2 shutdown-safety), then spawn a detached task that re-acquires the registry mutex and writes the prior state back. `resume_author_preview` hook is a TODO comment pointing at 11-03.
- Source-level transition-table doc-comment covering 9 transition arms + 3 invariants (verbatim from 11-RESEARCH.md §Example 4).

### Task 1 — `apps/desktop/src-tauri/src/lib.rs` (EDIT)

- `pub mod author_driver;` added at top level (pub because tests/ imports from it).
- `.setup(...)` block registers the registry Arc-wrapped:
  ```rust
  app.manage(std::sync::Arc::new(
      author_driver::AuthorDriverRegistry::default(),
  ));
  ```
  Placed immediately after the Phase 10-02 `SimulatorRegistry` registration for symmetry.

### Task 2 — `picker.rs` refactor + `picker.ts` DTO (D-04 contract)

- Added `pub struct PickerStampResultDto { step_id: String, was_freshly_stamped: bool }` next to `TargetRecordDto` and registered it in `ipc_spec.rs` for specta TS codegen.
- Extracted the full body of `picker_stamp_step_id` into `pub fn stamp_step_id_impl(...)` (same file) — the `#[tauri::command]` wrapper is now a one-line delegate. Visibility is `pub` (not `pub(crate)`) because integration tests in `tests/` are external consumers.
- Return type changed from `Result<String, AppError>` to `Result<PickerStampResultDto, AppError>`:
  - `Some(existing_id)` → `(id, false)` — no source rewrite, targets.json still seeded (D-04).
  - `None` → fresh `Uuid::now_v7()`, `format_story` + `fs::write`, `(new_id, true)`.
- TS wrapper `pickerStampStepId` now returns `Promise<PickerStampResult>` with camelCase `{ stepId, wasFreshlyStamped }`. Existing call site (`apps/desktop/src/features/recorder/pick-element-button.tsx:139`) is fire-and-forget via `.catch()`, so the return-type refinement is non-breaking.

### Task 2 — Pitfall 5 audit

**Audit result: PASS.** The source-rewrite (`std::fs::write(&path, formatted)`) is reachable only from the `None` arm of `match existing_id`; the `Some` arm returns the existing UUID directly without touching the filesystem. Code as shipped in Phase 7-04c is structurally correct — the regression tests guard against any future refactor moving the write out of the `None` arm.

### Task 3 — FSM + concurrency test suites

- `apps/desktop/src-tauri/tests/author_driver_state_machine.rs` — 9 sync tests covering D-13/D-14/D-15/D-16.
- `apps/desktop/src-tauri/tests/author_driver_concurrency.rs` — 4 tokio tests covering registry-level race (CC-1), Drop-guard restore (CC-2a), disarm semantics (CC-2b), host-layer simulator guard (CC-3 / Pitfall 6).
- `apps/desktop/src-tauri/tests/picker_stamp_idempotent_source_bytes.rs` — 2 sync tests: byte-identity on re-stamp (D-04 / Pitfall 5) + source-rewrite on fresh stamp.

**All 15 tests pass:**
```
cargo test -p storycapture --test picker_stamp_idempotent_source_bytes
                           --test author_driver_state_machine
                           --test author_driver_concurrency
→ 15 passed (3 suites)
```

## Commits

| Task | Commit   | Type    | Summary                                                |
| ---- | -------- | ------- | ------------------------------------------------------ |
| 1    | 086aa69  | feat    | AuthorDriverRegistry FSM + PickerResumeGuard + .manage |
| 2a   | cf57859  | test    | RED: failing Pitfall 5 regression test                 |
| 2b   | 136f566  | feat    | GREEN: PickerStampResultDto + stamp_step_id_impl       |
| 3    | 2f6482e  | test    | FSM + concurrency test suites (13 tests)               |

## Deviations from Plan

### Environmental setup (Rule 3 — blocking)

**[Rule 3 - Blocking Issue] Symlinked missing sidecar binaries into worktree**

- **Found during:** Task 1 (initial `cargo check`)
- **Issue:** The parallel-worktree harness did not copy the gitignored Tauri sidecar binaries (`ffmpeg-aarch64-apple-darwin`, `playwright-sidecar-aarch64-apple-darwin`, `playwright-sidecar-modules/`) from the main checkout. The Tauri build script (`tauri-build`) hard-fails with `resource path 'binaries/ffmpeg-aarch64-apple-darwin' doesn't exist` on every `cargo check`.
- **Fix:** `ln -sf` from `.../StoryCapture/apps/desktop/src-tauri/binaries/*` into the worktree's `binaries/` directory. Symlinks are not committed (matched by existing `.gitignore`).
- **Files modified:** None tracked — only the symlinks in `apps/desktop/src-tauri/binaries/`, which remain gitignored.
- **Commit:** N/A (env-only change).

### Minor implementation choices

**[Rule 2 - Test surface] `stamp_step_id_impl` is `pub`, not `pub(crate)`**

- **Plan said:** `pub(crate) fn stamp_step_id_impl`.
- **Why changed:** Integration tests in `apps/desktop/src-tauri/tests/` are a separate crate from `pub mod` code — `pub(crate)` makes the symbol invisible to them. The plan's "structural fix — no `#[cfg(test)]` tricks" directive requires this to be publicly importable. `pub fn` is the minimal visibility that satisfies external-test access. The Tauri command boundary remains the single external entry point for production callers.

**[Rule 2 - Auto-added] `PickerResumeGuard::new` constructor and `disarm()` visibility**

- **Plan said:** "`impl PickerResumeGuard { pub fn disarm(&self) { ... } }` with `impl Drop`".
- **Why added:** The plan's example used struct-literal construction inside the picker command. Since the struct fields include a `std::sync::Mutex<Option<AuthorDriverState>>` (non-`Default`, non-public initialisation), I added `pub fn new(registry, stream_id, restore) -> Self` to encapsulate the wrap. Standard Rust idiom. No behavior change.

**[Rule 2 - Test coverage] Added 5 extra SM tests beyond the plan's 6**

- **Plan said:** SM-1 through SM-6 (6 tests).
- **Why added:** SM-7 (can_start_pick happy paths on Idle/LivePreview/SimulatorPaused — D-14 explicitly), SM-8 (can_start_simulator happy paths), SM-9 (defensive end_pick no-op) cover the complement of the Err-path tests. These are cheap and document the allow-paths so downstream maintainers can't accidentally tighten the guards. Plan explicitly allows at its own discretion.

## Authentication Gates

None.

## Threat Model — Disposition check

All 5 registered threats (T-11-01-01 through T-11-01-05) from the plan's `<threat_model>` are either **mitigated by this plan** or **explicitly accepted**:

| Threat       | Disposition | This plan's mitigation                                                                            |
| ------------ | ----------- | ------------------------------------------------------------------------------------------------- |
| T-11-01-01   | mitigate    | `Handle::try_current().ok()` gate in `PickerResumeGuard::drop` (Pitfall 2)                        |
| T-11-01-02   | mitigate    | FSM helpers are sync; the async mutex is scope-held only for state mutation (Pattern 1 honored)   |
| T-11-01-03   | mitigate    | Byte-identity + mtime-identity tests in `picker_stamp_idempotent_source_bytes.rs`                 |
| T-11-01-04   | mitigate    | Path-traversal guard in `stamp_step_id_impl` (unchanged from picker.rs:200-206)                   |
| T-11-01-05   | accept      | Per plan — no changes here                                                                        |

## Success Criteria

- [x] `AuthorDriverRegistry` is registered on the Tauri app (`grep -c "AuthorDriverRegistry::default" lib.rs` = 1).
- [x] State machine enforces D-13/D-14/D-15/D-16 at the host layer (15 tests prove it).
- [x] Pitfall 5 regression test green; `picker_stamp_step_id` provably preserves source bytes + mtime on re-pick.
- [x] No changes to sidecar, no changes to Phase 9-04 surfaces, no changes to `commands/simulator.rs`.
- [x] `cargo check -p storycapture --lib` passes.
- [x] No `#[ignore]`, no `#[cfg(test)]`-only production code paths.
- [x] Transition-table doc-comment present (`grep "Transition table" author_driver.rs`).

## What this unblocks

- **11-02 (Wave 1 parallel):** record-path `self_heal=false` flip — can proceed in parallel; does not depend on this plan's surfaces.
- **11-03 (Wave 2):** `picker_start_author` command will:
  1. Acquire `State<'_, Arc<AuthorDriverRegistry>>`.
  2. Call `can_start_pick()?` + `begin_pick(stream_id)` inside the mutex scope.
  3. Construct `PickerResumeGuard::new(registry, stream_id, prior_state)`.
  4. Drop the mutex guard; perform awaited sidecar RPC.
  5. On success: re-acquire + call `end_pick()` + `guard.disarm()`.
  6. Fill the TODO in `PickerResumeGuard::drop` with the `crate::commands::automation::resume_author_preview(stream_id)` call.
- **11-04 (Wave 3):** `PreviewPickerButton.tsx` can read `PickerStampResult.wasFreshlyStamped` to dispatch first-pick vs re-pick toasts per UI-SPEC.

## Known Stubs

None. Every symbol introduced in this plan has a production call path planned (FSM helpers → 11-03; DTO → 11-04). The single `TODO` comment in `PickerResumeGuard::drop` documents the 11-03 handoff explicitly and is intentional per the Task 1 `<action>` step 6 note.

## Self-Check: PASSED

Files created:
- [x] `apps/desktop/src-tauri/src/author_driver.rs` — FOUND
- [x] `apps/desktop/src-tauri/tests/author_driver_state_machine.rs` — FOUND
- [x] `apps/desktop/src-tauri/tests/author_driver_concurrency.rs` — FOUND
- [x] `apps/desktop/src-tauri/tests/picker_stamp_idempotent_source_bytes.rs` — FOUND

Files modified:
- [x] `apps/desktop/src-tauri/src/lib.rs` — FOUND (pub mod + .manage)
- [x] `apps/desktop/src-tauri/src/ipc_spec.rs` — FOUND (PickerStampResultDto .typ)
- [x] `apps/desktop/src-tauri/src/commands/picker.rs` — FOUND (DTO + impl)
- [x] `apps/desktop/src/ipc/picker.ts` — FOUND (return-type refinement)

Commits in `git log`:
- [x] 086aa69 (Task 1) — FOUND
- [x] cf57859 (Task 2 RED) — FOUND
- [x] 136f566 (Task 2 GREEN) — FOUND
- [x] 2f6482e (Task 3) — FOUND
