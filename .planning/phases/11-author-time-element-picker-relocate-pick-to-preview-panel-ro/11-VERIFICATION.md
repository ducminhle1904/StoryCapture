---
phase: 11-author-time-element-picker-relocate-pick-to-preview-panel-ro
verified: 2026-04-24T16:30:00Z
status: human_needed
score: 14/14 must-haves verified (2 previously-partial now VERIFIED)
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 12/14
  previous_verified: 2026-04-24T09:48:00Z
  gaps_closed:
    - "PHASE-11.1: Both commands/picker.rs and commands/simulator.rs acquire the same AuthorDriverRegistry lock — closed by commits 8904353..811d471 + roadmap/summary 7930f2a/bc05e77. simulator.rs now has 7 AuthorDriverRegistry references (was 0)."
    - "PHASE-11.8: Host-layer state machine enforces concurrency (can_start_simulator rejects when Picking) — closed by 811d471 which calls can_start_simulator() at simulator.rs:330 under the registry lock before begin_simulator()."
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "11-SMOKE.md §1 Lazy-start pick (D-09) — 11-HUMAN-UAT.md Test 1"
    expected: "Pick click from a dormant session toggles Live Preview on, author browser boots, overlay picks an element, DSL line inserted, correct UI-SPEC toast fires, .story.targets.json seeded."
    why_human: "Requires TCC-granted macOS host, real Playwright sidecar Chromium launch, human interaction with the author viewport. Cannot be scripted inside the verifier."
  - test: "11-SMOKE.md §2 Same-line re-pick (D-04 / Pitfall 5) — 11-HUMAN-UAT.md Test 2"
    expected: ".story mtime unchanged after re-pick; .story.targets.json mtime updated; toast reads 'Updated fallback for step N' (NOT 'Added …')."
    why_human: "Mtime + toast disambiguation requires a live browser session and human-driven click on a second element."
  - test: "11-SMOKE.md §3 Cmd-Shift-P / Ctrl-Shift-P keymap (UI-SPEC §6) — 11-HUMAN-UAT.md Test 3"
    expected: "Keyboard shortcut activates Pick identically to button click; Esc cancels silently; banner dismisses."
    why_human: "OS-level keybinding behavior + focus routing through CodeMirror 6 is empirically verified; automated tests can't prove the end-to-end keyboard path against a real editor instance."
  - test: "11-SMOKE.md §4a Simulator paused → Pick permitted (D-14 restore) — 11-HUMAN-UAT.md Test 4"
    expected: "Picker enters Picking with resume_to=SimulatorPaused; on pick completion, simulator banner returns (registry restores to SimulatorPaused). Previously flagged as expected-to-fail in the v1 verification; 11-05 has wired simulator.rs, so this should now PASS. Update 11-HUMAN-UAT.md known_risk accordingly on first operator run."
    why_human: "Requires real Chromium + simulator timeline + human-driven pause/resume choreography."
  - test: "11-SMOKE.md §4b Simulator running → Pick disabled (D-13) — 11-HUMAN-UAT.md Test 5"
    expected: "Pick button disabled with tooltip 'Simulator running — cancel to pick'; click is no-op at host layer. Host-side gate is NOW wired via 811d471 — bypasses of the UI gate return SimulatorBusy from the command. Previously flagged as advisory-only; now two-layer defense is real."
    why_human: "Requires real simulator run + intentional UI-gate bypass (or race) to probe host enforcement."
  - test: "11-SMOKE.md §4c Pick active → Simulator start blocked (D-15) — 11-HUMAN-UAT.md Test 6"
    expected: "Simulator start via Cmd-. during active pick is rejected with AlreadyPicking error. Previously expected-to-fail; 811d471 now calls can_start_simulator() at simulator.rs:330, so this should PASS. Update 11-HUMAN-UAT.md known_risk accordingly."
    why_human: "Requires real pick + concurrent simulator-start invocation against a running host."
  - test: "11-SMOKE.md §5 Record-path read-only (D-06) — 11-HUMAN-UAT.md Test 7"
    expected: "Record run with stale primary raises HUD destructive block with UI-SPEC copy + 'Open in Simulator →' link; .story.targets.json mtime unchanged."
    why_human: "Requires TCC-granted macOS host and a recording project with a seeded stale selector."
  - test: "11-SMOKE.md §7 Unsaved-buffer warning (D-10 W-5 fix) — 11-HUMAN-UAT.md Test 8"
    expected: "Dirty buffer fires toast 'Unsaved changes — Pick will use the last saved version. Save first?' before Picking banner; user can proceed; replay uses on-disk bytes."
    why_human: "Requires an interactive editor buffer with unsaved modifications + live pick flow. Note: editorController.markSaved remains a documented Known Stub — 11-05 did NOT address this (out of scope). isDirty() likely still returns false until a save-hook is wired; the toast may not fire and the test may be UX-blocked by that stub."
---

# Phase 11: Author-time element picker relocate-Pick-to-Preview-panel Verification Report

**Phase Goal:** The element picker lives in the Preview panel (not the recording toolbar), routes clicks through the Phase 9-04 author-session with a shared AuthorDriverState FSM that coordinates with the Phase 10 simulator, and the recording path becomes a strictly read-only consumer of .story + .story.targets.json — self-healing is deferred to Simulator + Promote-to-fallback only.

**Verified:** 2026-04-24T16:30:00Z
**Status:** human_needed (all 14 must-haves automated-verified; operator smoke matrix in `11-HUMAN-UAT.md` pending TCC-granted host — 11-SMOKE.md §4a/§4b/§4c should now pass per 11-05 closure, other items require real Chromium + human interaction)
**Re-verification:** Yes — after gap closure via commits 8904353..bc05e77 + roadmap doc 7930f2a

## Re-verification summary

The v1 verification (2026-04-24T09:48:00Z) identified ONE root-cause gap producing two partial must-haves (PHASE-11.1, PHASE-11.8):

> `commands/simulator.rs` had ZERO references to `AuthorDriverRegistry`, rendering host-side D-13/D-14/D-15 gates inert and the D-14 `resume_to` box dead code end-to-end.

Plan 11-05 shipped in four commits and was merged:

| Commit | Type | What shipped |
|--------|------|--------------|
| 8904353 | test | RED: SM-10..SM-17 failing tests for simulator FSM helpers |
| 258b004 | feat | GREEN: begin_simulator / pause_simulator / end_simulator helpers (author_driver.rs:141-171) |
| e22ce49 | test | SL-1..SL-8 integration tests (new file author_driver_simulator_lifecycle.rs) |
| 811d471 | feat | Wire AuthorDriverRegistry into commands/simulator.rs (D-13/D-14/D-15) |
| bc05e77 | docs | 11-05 SUMMARY |
| 7930f2a | docs | ROADMAP.md flip to "Code-complete" for Phase 11 |

All 7 spot-checks from the re-verification brief pass (see Spot-check table below). Both previously-partial truths flip to VERIFIED. No regressions.

## Goal Achievement

### Observable Truths — Re-verification Focus (Truths #4 and #9)

| # | Truth | v1 Status | v2 Status | Evidence |
|---|-------|-----------|-----------|----------|
| 4 | FSM coordinates with Phase 10 simulator (both commands acquire the same lock) | PARTIAL (gap) | **VERIFIED** | `simulator.rs:313 author_registry: State<'_, Arc<AuthorDriverRegistry>>`; `simulator.rs:328-333` acquires the lock, calls `can_start_simulator()?` then `begin_simulator(session_id)` atomically — mirror of `picker.rs:460-465`. simulator_step_to (line 489) and simulator_cancel (line 553) also carry the registry param. Forwarder receives `author_registry: Arc<AuthorDriverRegistry>` at line 209 and calls `pause_simulator()` on `RunPaused` (lines 267-270) + `end_simulator(prior.clone())` on `StoryEnded` (Task 2 Step 4). |
| 9 | Host-layer FSM gates can_start_pick / can_start_simulator | PARTIAL (gap) | **VERIFIED** | `can_start_simulator` is invoked from production code at `simulator.rs:330` under the `author_registry.state.lock().await` scope. Error is mapped to `AppError::Automation(e.to_string())` (carrying `AlreadyPicking` display string). SL-1 integration test proves the Picking-state rejection; SL-2 proves the LivePreview happy transition; SL-3 proves picker's side of D-13; SL-4 proves D-14 round-trip. |

### Observable Truths — Regression Check (Truths #1-#3, #5-#8, #10-#15, already VERIFIED in v1)

All 12 v1-VERIFIED truths regressed to PASS — no code changes to the picker/recorder/HUD surfaces were expected from 11-05, and `cargo test` confirms:

| # | Truth | v1 Status | Regression Check |
|---|-------|-----------|------------------|
| 1 | Picker lives in Preview panel (not recording toolbar) | VERIFIED | Unchanged (11-05 touched only host-side simulator + FSM layers) |
| 2 | Picker routes through Phase 9-04 author-session via picker_start_author | VERIFIED | Unchanged — `picker_start_author_impl` still the orchestration (covered by regression SL-3/SL-4 which invoke it directly) |
| 3 | Shared AuthorDriverState FSM exists with 5 variants (D-16) | VERIFIED | Still 5 variants at `author_driver.rs:33-49`; 3 new helpers (begin_simulator/pause_simulator/end_simulator) added without changing the variants |
| 5 | Recording path is read-only consumer of .story + .story.targets.json | VERIFIED | `record_path_self_heal_false` 2 tests pass (unchanged) |
| 6 | Primary-miss during recording raises typed error with UI-SPEC copy | VERIFIED | Unchanged |
| 7 | HUD surfaces D-06 copy + "Open in Simulator →" action | VERIFIED | Unchanged |
| 8 | picker_stamp_step_id byte-idempotent on re-pick | VERIFIED | `picker_stamp_idempotent_source_bytes` 2 tests pass (unchanged) |
| 10 | Picking from SimulatorPaused carries resume_to box | VERIFIED (in-code), formerly untestable in-practice | **Now testable end-to-end** — SL-4 proves `picker_start_author_impl` from SimulatorPaused round-trips back to SimulatorPaused. The runtime branch is no longer dead code because simulator.rs now writes SimulatorPaused via the forwarder's `pause_simulator()` at line 269. |
| 11 | resume_author_preview invoked on all exit paths (D-12) | VERIFIED | `author_driver_picker_pause_resume` 6 tests pass (unchanged) |
| 12 | replay_navigate_verbs walks story AST up to cursor_line + meta.app fallback | VERIFIED | `replay_navigate_verbs` 5 tests pass (unchanged) |
| 13 | Cmd-Shift-P / Ctrl-Shift-P triggers pick via CodeMirror keymap | VERIFIED | Unchanged (renderer-side, untouched by 11-05) |
| 14 | Recorder-side picker deleted | VERIFIED | Unchanged |
| 15 | 11-SMOKE.md supersedes 07-03b / 07-04c record-path sections | VERIFIED | Unchanged |

**Score:** 14/14 truths VERIFIED (was 12/14 VERIFIED + 2 PARTIAL in v1). Two formerly-partial truths (#4, #9) now fully pass; truth #10 flips from "in-code verified, end-to-end dead" to "end-to-end tested live" via SL-4.

### Spot-check matrix — closure confirmation

| # | Check | Expected (per re-verification brief) | Actual | Status |
|---|-------|--------------------------------------|--------|--------|
| 1 | `grep -c "AuthorDriverRegistry" apps/desktop/src-tauri/src/commands/simulator.rs` | ≥3 (was 0) | **7** | PASS |
| 2 | simulator_start calls `can_start_simulator()` AND `begin_simulator()` under registry lock | Yes | `simulator.rs:328-333` — both calls inside `let mut g = author_registry_arc.state.lock().await { ... }` scope | PASS |
| 3 | spawn_run forwarder calls `pause_simulator()` on RunPaused and `end_simulator(prior)` on StoryEnded | Yes | `simulator.rs:267-270` (pause_simulator inside registry.state.lock under RunPaused arm); StoryEnded arm restores via `end_simulator(prior.clone())` for `Some(prior)` forwarder capture | PASS |
| 4 | simulator_cancel restores via `end_simulator(prior)` from a stashed `prior_author_driver_state` on ResumableSession | Yes | `simulator.rs:581-584` — `end_simulator(session.prior_author_driver_state.clone())` under the registry lock | PASS |
| 5 | New integration test file `author_driver_simulator_lifecycle.rs` exists with ≥8 tests | Yes | 11.6K file present with 8 `#[tokio::test]` entries (SL-1 through SL-8) | PASS |
| 6 | `cargo test -p storycapture --test author_driver_simulator_lifecycle` exits 0 | Yes | `cargo test: 8 passed (1 suite, 0.00s)` | PASS |
| 7 | Full Phase 11 regression matrix (7 suites) passes | ≥44 tests pass | `cargo test: 44 passed (7 suites, 0.03s)` (17 state-machine + 4 concurrency + 8 SL + 6 pause-resume + 5 navigate + 2 stamp + 2 record-path) | PASS |

All 7 brief-level spot-checks PASS. Gap closed.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/desktop/src-tauri/src/author_driver.rs` | FSM + registry + guard + 3 new simulator helpers | VERIFIED | 3 new `pub fn` helpers at lines 141-171: `begin_simulator`, `pause_simulator`, `end_simulator`. No-op guard on pause (line 155) and end (line 169) enforces T-11-05-01/04 race protection. |
| `apps/desktop/src-tauri/src/commands/simulator.rs` | Acquires AuthorDriverRegistry, gates on can_start_simulator, writes SimulatorRunning/SimulatorPaused/restore | **VERIFIED (gap closed)** | 7 AuthorDriverRegistry references. simulator_start registry gate + early-error restore via `simulator_start_inner`. Forwarder writeback on RunPaused + restore on StoryEnded. simulator_step_to threads registry through. simulator_cancel restores via `session.prior_author_driver_state`. |
| `apps/desktop/src-tauri/tests/author_driver_simulator_lifecycle.rs` | NEW — 8+ integration tests for D-13/D-14/D-15 | VERIFIED | 11.6K. 8 `#[tokio::test]` tests: SL-1 reject-during-pick, SL-2 happy-transition, SL-3 picker-rejected-while-running, SL-4 pick-from-paused-round-trips, SL-5 can-start-simulator-rejects-picking, SL-6 pause-writeback, SL-7 end-simulator-restores-live-preview, SL-8 end-simulator-idempotent. All pass. |
| `apps/desktop/src-tauri/tests/author_driver_state_machine.rs` | Extended SM-10..SM-17 for simulator helpers | VERIFIED | 17 passed (9 legacy SM-1..SM-9 + 8 new SM-10..SM-17). SM-10/11 (begin_simulator Idle/LivePreview), SM-12 (pause Running→Paused), SM-13 (pause no-op on non-Running), SM-14/15 (end restore), SM-16 (end no-op), SM-17 (full D-14 round-trip). |
| All v1-verified artifacts | Unchanged | VERIFIED | No regressions — full Phase 11 test matrix green (44/44). |

### Key Link Verification — gap-closed links

| From | To | Via | v1 Status | v2 Status |
|------|----|----|-----------|-----------|
| `simulator.rs simulator_start` | `AuthorDriverRegistry` | `State<'_, Arc<AuthorDriverRegistry>>` + `can_start_simulator()` + `begin_simulator()` under lock | **NOT WIRED (gap)** | **WIRED** — lines 313, 327-333 |
| `simulator.rs simulator_step_to` | `AuthorDriverRegistry` | `State` param threaded to spawn_run (does NOT mutate FSM state) | N/A | WIRED — line 489 |
| `simulator.rs simulator_cancel` | `AuthorDriverRegistry` | `State` param + `end_simulator(session.prior_author_driver_state)` under lock | **NOT WIRED (gap)** | **WIRED** — lines 553, 581-584 |
| `spawn_run` forwarder | `AuthorDriverRegistry` | Closure-captured `Arc<AuthorDriverRegistry>` + `Option<AuthorDriverState>` for prior; `pause_simulator()` on RunPaused + `end_simulator(prior.clone())` on StoryEnded | **NOT WIRED (gap)** | **WIRED** — lines 209-210, 267-270, 283-303 |
| `ResumableSession` | `AuthorDriverState` | New `prior_author_driver_state` field captured at simulator_start_inner sessions.insert | N/A | WIRED — field populated in simulator_start_inner, read by simulator_cancel |

All 4 new/closed links WIRED. 11 previously-WIRED links from v1 remain WIRED (grep-confirmed — no regressions).

### Data-Flow Trace (Level 4) — updated post-11-05

| Artifact | Data Variable | Source | Produces Real Data | Status (v2) |
|----------|---------------|--------|--------------------|-------------|
| `AuthorDriverRegistry.state` — SimulatorRunning variant | Written by simulator_start's `begin_simulator(session_id)` under lock | simulator.rs line 332 | Yes — production code path via Tauri command | **FLOWING** (was HOLLOW in v1) |
| `AuthorDriverRegistry.state` — SimulatorPaused variant | Written by forwarder `pause_simulator()` on ExecutorEvent::RunPaused | simulator.rs line 269 | Yes — real executor event | **FLOWING** (was HOLLOW in v1) |
| `AuthorDriverRegistry.state` — restore to prior on StoryEnded | `end_simulator(prior)` inside StoryEnded forwarder arm | simulator.rs (forwarder StoryEnded match arm) | Yes — captured Option<AuthorDriverState> from simulator_start | **FLOWING** (was HOLLOW in v1) |
| `AuthorDriverRegistry.state` — restore on simulator_cancel | `end_simulator(session.prior_author_driver_state)` | simulator.rs:581-584 | Yes — snapshot stashed at simulator_start_inner | **FLOWING** (new wiring) |
| `PreviewPickerButton.tsx` variant + streamId | Same as v1 | Unchanged | Yes | FLOWING (no regression) |
| `editorController.isDirty()` | `lastSavedSource` vs live doc | `markSaved()` caller — STILL NOT WIRED | No | **STATIC (Known Stub — out of scope for 11-05)** |
| `editorController.getStepOrdinalForLine()` | `stepOrdinalLookup` registered fn | `setStepOrdinalLookup` caller — STILL NOT WIRED | No | **STATIC (Known Stub — out of scope for 11-05)** |

The three previously-HOLLOW branches of AuthorDriverRegistry (SimulatorRunning / SimulatorPaused / restore) are now FLOWING end-to-end. The two Known Stubs from 11-04 (markSaved, setStepOrdinalLookup) are explicitly out of scope for 11-05 (documented in 11-05 SUMMARY "Known Stubs (still out of scope, tracked for follow-up)") — they do not affect the FSM gap closure.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Simulator FSM lifecycle (SL-1..SL-8) | `cargo test -p storycapture --test author_driver_simulator_lifecycle` | 8 passed (1 suite, 0.00s) | **PASS (new)** |
| FSM + registry + guard tests (now 17 SM + 4 CC) | `cargo test -p storycapture --test author_driver_state_machine --test author_driver_concurrency` | 17 + 4 = 21 passed | PASS |
| Picker stamp byte idempotence (D-04 / Pitfall 5) | `cargo test -p storycapture --test picker_stamp_idempotent_source_bytes` | 2 passed | PASS |
| Record-path self_heal=false invariance | `cargo test -p storycapture --test record_path_self_heal_false` | 2 passed | PASS |
| Navigate-replay (D-10) | `cargo test -p storycapture --test replay_navigate_verbs` | 5 passed | PASS |
| Pause/resume all exit paths (D-12) | `cargo test -p storycapture --test author_driver_picker_pause_resume` | 6 passed | PASS |
| **Full Phase 11 regression matrix** | `cargo test -p storycapture --test author_driver_state_machine --test author_driver_concurrency --test author_driver_simulator_lifecycle --test author_driver_picker_pause_resume --test replay_navigate_verbs --test picker_stamp_idempotent_source_bytes --test record_path_self_heal_false` | **44 passed (7 suites, 0.03s)** | PASS |

All automated checks green. Zero regressions across 7 test binaries.

### Requirements Coverage

| Requirement | Source Plan | Description (abbrev.) | v1 Status | v2 Status | Evidence |
|-------------|-------------|----------------------|-----------|-----------|----------|
| PHASE-11.1 | 11-01, 11-05 | Shared AuthorDriverRegistry acquired by BOTH picker.rs AND simulator.rs | PARTIAL | **SATISFIED** | simulator.rs:313 (simulator_start), 489 (simulator_step_to), 553 (simulator_cancel), 209 (forwarder). All three command paths + forwarder acquire the registry. |
| PHASE-11.2 | 11-01 | PickerResumeGuard RAII cleanup + Pitfall 2 shutdown-safety | SATISFIED | SATISFIED | author_driver.rs:179-186 — unchanged |
| PHASE-11.3 | 11-02 | Record path passes self_heal=false | SATISFIED | SATISFIED | Unchanged |
| PHASE-11.4 | 11-02 | AutomationError::PrimaryMissNoHeal raised | SATISFIED | SATISFIED | Unchanged |
| PHASE-11.5 | 11-02 | HUD surfaces D-06 copy + "Open in Simulator →" | SATISFIED | SATISFIED | Unchanged |
| PHASE-11.6 | 11-03 | Sidecar pickElement.start streamId routing | SATISFIED | SATISFIED | Unchanged |
| PHASE-11.7 | 11-01 | picker_stamp_step_id byte-idempotent on re-pick | SATISFIED | SATISFIED | Unchanged |
| PHASE-11.8 | 11-01, 11-05 | Host-layer FSM enforces can_start_pick + can_start_simulator gates | PARTIAL | **SATISFIED** | can_start_simulator called at simulator.rs:330 under the registry lock. SL-1/SL-5 integration tests prove the gate rejects Picking; SL-3 proves the reverse (picker rejects SimulatorRunning). |
| PHASE-11.9 | 11-03 | picker_start_author orchestrates acquire → replay → pause → pick → resume | SATISFIED | SATISFIED | Unchanged |
| PHASE-11.10 | 11-03 | replay_navigate_verbs walks AST ≤ cursor_line | SATISFIED | SATISFIED | Unchanged |
| PHASE-11.11 | 11-03 | author.navigateTo sidecar RPC with bounded networkidle | SATISFIED | SATISFIED | Unchanged |
| PHASE-11.12 | 11-04 | PreviewPickerButton mounted with 5 visual states + verbatim copy | SATISFIED | SATISFIED | Unchanged |
| PHASE-11.13 | 11-04 | Cmd-Shift-P / Ctrl-Shift-P via CodeMirror 6 keymap | SATISFIED | SATISFIED | Unchanged |
| PHASE-11.14 | 11-04 | Recorder picker files deleted; 11-SMOKE.md supersedes | SATISFIED | SATISFIED | Unchanged |

**All 14 PHASE-11.* requirements SATISFIED.** Orphaned requirements: none.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/desktop/src-tauri/src/author_driver.rs` | 181-183 | TODO comment for `resume_author_preview` wiring from PickerResumeGuard::drop | Info | Unchanged from v1. Orchestration fires resume on the happy path; Drop path restores FSM only. Low-risk corner case, remains Known Stub (explicitly out of scope per 11-05 SUMMARY). |
| `apps/desktop/src/features/editor/controller.ts` | markSaved/setStepOrdinalLookup | Added but never called from any caller (Known Stubs per 11-04 SUMMARY) | Warning | Unchanged from v1. Explicitly out of scope for 11-05; remains a follow-up for a future plan. Does not affect FSM/simulator gap closure. |
| `apps/desktop/src-tauri/src/commands/simulator.rs` | — | Missing AuthorDriverRegistry integration | **CLOSED** | Was Blocker in v1; **resolved by 811d471**. No new anti-patterns introduced. |

No new anti-patterns from 11-05. Two pre-existing Known Stubs (markSaved wiring, Drop-path resume re-fire) persist but are documented and out of scope.

### Human Verification Required

See `human_verification` in frontmatter. Eight items require operator walkthrough on a TCC-granted macOS host, persisted in `11-HUMAN-UAT.md`:

1. **Test 1 (11-SMOKE.md §1)** — Lazy-start pick with real Chromium.
2. **Test 2 (11-SMOKE.md §2)** — Same-line re-pick mtime + disambiguation toast.
3. **Test 3 (11-SMOKE.md §3)** — Cmd-Shift-P / Ctrl-Shift-P keymap.
4. **Test 4 (11-SMOKE.md §4a)** — D-14 Pick from SimulatorPaused. **Previously expected-to-fail, now expected-to-pass** post-11-05. Registry writes SimulatorPaused via forwarder pause_simulator; end_pick round-trips restore through resume_to. Operator should update `known_risk` in 11-HUMAN-UAT.md on first pass.
5. **Test 5 (11-SMOKE.md §4b)** — D-13 Pick disabled during simulator running. Host-side gate is now wired; UI gate remains primary defense. Two-layer defense realized.
6. **Test 6 (11-SMOKE.md §4c)** — D-15 Simulator start blocked during Pick. **Previously expected-to-fail, now expected-to-pass** post-11-05. simulator_start's can_start_simulator() returns AlreadyPicking under the registry lock; renderer gate + host gate both active.
7. **Test 7 (11-SMOKE.md §5)** — Record-path read-only HUD flow.
8. **Test 8 (11-SMOKE.md §7)** — Unsaved-buffer warning. **Known risk persists** — `editorController.markSaved` remains a stub per 11-04 SUMMARY / 11-05 Known Stubs; explicitly out of scope for this closure. Toast may not fire until a save-hook is wired.

### Re-verification delta summary

- **Gaps closed:** 2 (PHASE-11.1 partial → SATISFIED, PHASE-11.8 partial → SATISFIED).
- **Regressions:** 0 across 44 tests in 7 suites.
- **Score movement:** 12/14 VERIFIED + 2 PARTIAL → 14/14 VERIFIED.
- **New automated coverage:** +16 tests (8 SM-10..SM-17 unit + 8 SL-1..SL-8 integration).
- **Status movement:** `gaps_found` → `human_needed` (all automated gates green; operator smoke matrix remains as the only outstanding gate, and it was never scheduled to run inside this verifier per the v1 frontmatter and 11-HUMAN-UAT.md).
- **New architectural artifact:** `ResumableSession.prior_author_driver_state` field as authoritative restore snapshot (avoids stream_id-based prior inference).

### Gaps Summary

**No open gaps.** The sole v1 gap (simulator.rs ↔ AuthorDriverRegistry integration) is closed by plan 11-05 commits 8904353..811d471 + docs bc05e77/7930f2a. Pitfall 6 two-layer defense is real: host-side FSM gate enforces D-13/D-14/D-15 alongside the renderer-side authorDriverStore gate.

Known Stubs carried forward (documented in 11-04 SUMMARY + 11-05 SUMMARY "Known Stubs still out of scope"):

1. **`editorController.markSaved` wiring** (D-10 dirty-buffer toast) — out of scope for 11-05, future follow-up.
2. **`setStepOrdinalLookup` wiring** (re-pick toast ordinal) — out of scope, future follow-up.
3. **`PickerResumeGuard::drop` panic-path `resume_author_preview` re-fire** — low-risk polish, out of scope.

These do not block phase verification — they are UX polish items tracked in documentation, not violations of any PHASE-11.* requirement.

---

_Verified: 2026-04-24T16:30:00Z (re-verification)_
_Prior verification: 2026-04-24T09:48:00Z (gaps_found, 12/14)_
_Verifier: Claude (gsd-verifier)_
